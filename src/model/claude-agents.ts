import { invoke } from "@tauri-apps/api/core";
import { probePaths, readFileSlice, slugify } from "./backend";

/** How much of a transcript head to scan for continuation links. */
const LINK_SCAN_BYTES = 131072;
const SESSION_ID_RE =
  /"sessionId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;

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
  /** Session ids referenced by a continuation's transcript head. */
  #links = new Map<string, Set<string>>();

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
    return this.#dedupe(data.map(parseAgent));
  }

  /**
   * Opening the agents view hands a conversation off to a background
   * session with a new id; the CLI then lists both it and the original
   * interactive session. The continuation's transcript head still carries
   * entries stamped with the original session id (migrated history), so
   * hide any listed session that a background session references.
   */
  async #dedupe(agents: ClaudeAgent[]): Promise<ClaudeAgent[]> {
    const hidden = new Set<string>();
    await Promise.all(
      agents
        .filter((agent) => agent.kind === "background")
        .map(async (agent) => {
          for (const id of await this.#linkedSessions(agent)) {
            hidden.add(id);
          }
        }),
    );
    return agents.filter((agent) => !hidden.has(agent.sessionId));
  }

  async #linkedSessions(agent: ClaudeAgent): Promise<Set<string>> {
    const cached = this.#links.get(agent.sessionId);
    if (cached !== undefined) {
      return cached;
    }
    const found = new Set<string>();
    try {
      const paths = await probePaths();
      const path = `${paths.claudeHome}/projects/${slugify(agent.cwd)}/${agent.sessionId}.jsonl`;
      const slice = await readFileSlice(path, 0, LINK_SCAN_BYTES);
      for (const match of slice.content.matchAll(SESSION_ID_RE)) {
        if (match[1] !== undefined && match[1] !== agent.sessionId) {
          found.add(match[1]);
        }
      }
      // Cache only once conclusive: links were found, or the scan window
      // was filled without any. A short transcript may still be growing.
      if (found.size > 0 || slice.content.length >= LINK_SCAN_BYTES) {
        this.#links.set(agent.sessionId, found);
      }
    } catch {
      // Transcript missing or unreadable; retry on the next poll.
    }
    return found;
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
