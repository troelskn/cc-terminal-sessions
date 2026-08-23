import { invoke } from "@tauri-apps/api/core";

/** Statuses observed from `claude agents --json`; the CLI may add more. */
export type AgentStatus = "idle" | "busy" | (string & {});

export interface ClaudeAgent {
  pid: number;
  cwd: string;
  kind: "interactive" | (string & {});
  /** Epoch milliseconds. */
  startedAt: number;
  sessionId: string;
  name: string;
  status: AgentStatus;
}

export interface AgentsState {
  agents: ClaudeAgent[];
  /** Set when the last probe failed; previous agents list is retained. */
  error: string | null;
}

export type AgentsListener = (state: AgentsState) => void;

function parseAgent(value: unknown): ClaudeAgent {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected agent object, got ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  const { pid, cwd, kind, startedAt, sessionId, name, status } = record;
  if (
    typeof pid !== "number" ||
    typeof cwd !== "string" ||
    typeof kind !== "string" ||
    typeof startedAt !== "number" ||
    typeof sessionId !== "string" ||
    typeof name !== "string" ||
    typeof status !== "string"
  ) {
    throw new Error(`malformed agent entry: ${JSON.stringify(value)}`);
  }
  return { pid, cwd, kind, startedAt, sessionId, name, status };
}

/**
 * Model-layer singleton for Claude Code session status.
 * Polls `claude agents --json` (via the Rust backend) and notifies
 * subscribers whenever the observed state changes.
 */
class ClaudeAgentsModel {
  #state: AgentsState = { agents: [], error: null };
  #listeners = new Set<AgentsListener>();
  #timer: number | null = null;
  #inFlight = false;
  #lastKey = "";

  get state(): AgentsState {
    return this.#state;
  }

  /** Registers a listener; returns an unsubscribe function. */
  subscribe(listener: AgentsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts polling (immediately, then every `intervalMs`). Idempotent. */
  start(intervalMs = 3000): void {
    if (this.#timer !== null) {
      return;
    }
    void this.#tick();
    this.#timer = window.setInterval(() => void this.#tick(), intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Single probe of `claude agents --json`, parsed and validated. */
  async probe(): Promise<ClaudeAgent[]> {
    const raw = await invoke<string>("list_claude_agents");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error("expected a JSON array from claude agents --json");
    }
    return data.map(parseAgent);
  }

  async #tick(): Promise<void> {
    if (this.#inFlight) {
      return;
    }
    this.#inFlight = true;
    try {
      const agents = await this.probe();
      this.#publish({ agents, error: null });
    } catch (error) {
      this.#publish({ agents: this.#state.agents, error: String(error) });
    } finally {
      this.#inFlight = false;
    }
  }

  #publish(state: AgentsState): void {
    const key = JSON.stringify(state);
    if (key === this.#lastKey) {
      return;
    }
    this.#lastKey = key;
    this.#state = state;
    for (const listener of this.#listeners) {
      listener(state);
    }
  }
}

export const claudeAgents = new ClaudeAgentsModel();
