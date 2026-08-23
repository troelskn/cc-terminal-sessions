import { invoke } from "@tauri-apps/api/core";
import { probePaths, readFileSlice, slugify } from "./backend";

/** How much of a transcript head to scan for continuation links. */
const LINK_SCAN_BYTES = 131072;
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Statuses observed from `claude agents --json`; the CLI may add more. */
export type AgentStatus = "idle" | "busy" | (string & {});

export type AuthMode = "api" | "subscription" | "unknown";

export interface ClaudeAgent {
  pid: number;
  cwd: string;
  kind: "interactive" | (string & {});
  /** Epoch milliseconds. */
  startedAt: number;
  sessionId: string;
  name: string;
  status: AgentStatus;
  /** Pid of the terminal-attached process for this session: its own pid
   * for interactive sessions, the hidden twin's pid for a deduped
   * background continuation, null when daemon-only. */
  terminalPid: number | null;
  /** How the session bills: API key in its env, or the claude.ai login. */
  auth: AuthMode;
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
  return {
    pid,
    cwd,
    kind,
    startedAt,
    sessionId,
    name,
    status,
    terminalPid: kind === "interactive" ? pid : null,
    auth: "unknown",
  };
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
  /** Auth mode per pid; a process env cannot change after launch. */
  #auth = new Map<number, AuthMode>();

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
    const agents = await this.#dedupe(data.map(parseAgent));
    await this.#resolveAuth(agents);
    return agents;
  }

  async #resolveAuth(agents: ClaudeAgent[]): Promise<void> {
    await Promise.all(
      agents.map(async (agent) => {
        let auth = this.#auth.get(agent.pid);
        if (auth === undefined) {
          try {
            auth = await invoke<AuthMode>("probe_auth", { pid: agent.pid });
            this.#auth.set(agent.pid, auth);
          } catch {
            auth = "unknown";
          }
        }
        agent.auth = auth;
      }),
    );
  }

  /**
   * Opening the agents view hands a conversation off to a background
   * session with a new id; the CLI then lists both it and the original
   * interactive session. The continuation's transcript head still contains
   * the original session id (in migrated-history entries such as snapshot
   * paths), so hide any *listed* session whose id appears there.
   */
  async #dedupe(agents: ClaudeAgent[]): Promise<ClaudeAgent[]> {
    const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
    const hidden = new Set<string>();
    await Promise.all(
      agents
        .filter((agent) => agent.kind === "background")
        .map(async (agent) => {
          for (const id of await this.#linkedSessions(agent)) {
            const twin = byId.get(id);
            if (twin === undefined) {
              continue;
            }
            hidden.add(id);
            // The twin's terminal is where this session is being viewed.
            if (agent.terminalPid === null && twin.kind === "interactive") {
              agent.terminalPid = twin.pid;
            }
          }
        }),
    );
    return agents.filter((agent) => !hidden.has(agent.sessionId));
  }

  /** Brings the Terminal tab hosting this session to the front. */
  async focusTerminal(agent: ClaudeAgent): Promise<void> {
    if (agent.terminalPid === null) {
      return;
    }
    await invoke("focus_terminal_tab", { pid: agent.terminalPid });
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
      for (const match of slice.content.matchAll(UUID_RE)) {
        if (match[0] !== agent.sessionId) {
          found.add(match[0]);
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
