import {
  type DirEntry,
  listSessionDir,
  probePaths,
  readFileSlice,
  slugify,
} from "./backend";
import { type ClaudeAgent, claudeAgents } from "./claude-agents";

export interface ShellCounts {
  running: number;
  completed: number;
}

export interface TaskCounts {
  total: number;
  completed: number;
}

export interface SessionDetails {
  sessionId: string;
  shells: ShellCounts;
  /** Sub-agents whose transcript was written to recently. There is no
   * liveness field on disk, so recency is the best available signal. */
  subagentCount: number;
  tasks: TaskCounts;
  /** Tokens in context per the transcript's last assistant usage block. */
  contextTokens: number | null;
}

export type DetailsListener = (details: Map<string, SessionDetails>) => void;

const EXIT_MARKER = /\[exited with code -?\d+\]/;
/** A sub-agent transcript untouched for this long counts as finished. */
const SUBAGENT_ACTIVE_WINDOW_MS = 30_000;
/** Longest prefix of the exit marker that could straddle a read boundary. */
const CARRY_LENGTH = 40;

interface TaskFileCache {
  size: number;
  modifiedMs: number;
  status: string;
}

/**
 * Model-layer singleton enriching sessions with detail read from Claude
 * Code's on-disk state (undocumented internals — degrade gracefully).
 * Incremental: append-only files are read from a remembered byte offset,
 * task files are re-read only when size/mtime changes.
 */
class SessionDetailsModel {
  #details = new Map<string, SessionDetails>();
  #listeners = new Set<DetailsListener>();
  #timer: number | null = null;
  #inFlight = false;
  #lastKey = "";

  /** Byte offset already consumed, per append-only output file. */
  #offsets = new Map<string, number>();
  /** Tail of the previous read, to catch markers straddling a boundary. */
  #carry = new Map<string, string>();
  /** Output files whose exit marker has been seen; never read again. */
  #exited = new Set<string>();
  /** Task JSON files, cached by size + mtime. */
  #taskCache = new Map<string, TaskFileCache>();
  /** Context tokens per transcript path, cached by file size. */
  #contextCache = new Map<string, { size: number; tokens: number | null }>();

  get details(): Map<string, SessionDetails> {
    return this.#details;
  }

  subscribe(listener: DetailsListener): () => void {
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

  async #tick(): Promise<void> {
    if (this.#inFlight) {
      return;
    }
    this.#inFlight = true;
    try {
      const agents = claudeAgents.state.agents;
      const details = new Map<string, SessionDetails>();
      await Promise.all(
        agents.map(async (agent) => {
          details.set(agent.sessionId, await this.#probeSession(agent));
        }),
      );
      this.#publish(details);
    } catch (error) {
      console.error("session details probe failed:", error);
    } finally {
      this.#inFlight = false;
    }
  }

  async #probeSession(agent: ClaudeAgent): Promise<SessionDetails> {
    const paths = await probePaths();
    const slug = slugify(agent.cwd);
    const [subagents, tasks, contextTokens] = await Promise.all([
      this.#listSubagents(
        `${paths.claudeHome}/projects/${slug}/${agent.sessionId}/subagents`,
      ),
      this.#probeTasks(`${paths.claudeHome}/tasks/${agent.sessionId}`),
      this.#probeContext(
        `${paths.claudeHome}/projects/${slug}`,
        agent.sessionId,
      ),
    ]);
    const shells = await this.#probeShells(
      `${paths.tmpBase}/${slug}/${agent.sessionId}/tasks`,
      subagents.ids,
      agent,
    );
    return {
      sessionId: agent.sessionId,
      shells,
      subagentCount: subagents.active,
      tasks,
      contextTokens,
    };
  }

  /**
   * Context size = the usage block of the newest assistant entry in the
   * session transcript (input + cache tokens). Reads only the transcript
   * tail, and only when the file has grown.
   */
  async #probeContext(
    projectDir: string,
    sessionId: string,
  ): Promise<number | null> {
    const entries = await listSessionDir(projectDir);
    const entry = entries.find((e) => e.name === `${sessionId}.jsonl`);
    if (entry === undefined) {
      return null;
    }
    const path = `${projectDir}/${entry.name}`;
    const cached = this.#contextCache.get(path);
    if (cached !== undefined && cached.size === entry.size) {
      return cached.tokens;
    }
    const offset = Math.max(0, entry.size - 65536);
    const slice = await readFileSlice(path, offset);
    const lines = slice.content.split("\n");
    let tokens: number | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined || !line.includes('"usage"')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== "assistant") {
          continue;
        }
        const message = parsed.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage === undefined) {
          continue;
        }
        const count = (key: string): number =>
          typeof usage[key] === "number" ? usage[key] : 0;
        tokens =
          count("input_tokens") +
          count("cache_read_input_tokens") +
          count("cache_creation_input_tokens");
        break;
      } catch {
        // Partial or foreign line; keep scanning backwards.
      }
    }
    this.#contextCache.set(path, { size: entry.size, tokens });
    return tokens;
  }

  /**
   * Returns all sub-agent ids ever spawned (needed to exclude their output
   * files from shell counting) plus the number considered active, judged by
   * transcript mtime recency — finished agents simply stop appending.
   */
  async #listSubagents(
    dir: string,
  ): Promise<{ ids: Set<string>; active: number }> {
    const entries = await listSessionDir(dir);
    const ids = new Set<string>();
    let active = 0;
    const now = Date.now();
    for (const entry of entries) {
      const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
      if (match?.[1] === undefined) {
        continue;
      }
      ids.add(match[1]);
      if (now - entry.modifiedMs < SUBAGENT_ACTIVE_WINDOW_MS) {
        active += 1;
      }
    }
    return { ids, active };
  }

  /**
   * The live task list a background job's state.json maintains — the
   * authoritative "running" set. Null when unavailable (interactive
   * sessions, unreadable file), in which case the caller falls back to
   * the exit-marker heuristic.
   */
  async #runningShellIds(agent: ClaudeAgent): Promise<Set<string> | null> {
    if (agent.jobId === null) {
      return null;
    }
    try {
      const paths = await probePaths();
      const slice = await readFileSlice(
        `${paths.claudeHome}/jobs/${agent.jobId}/state.json`,
        0,
      );
      const parsed: unknown = JSON.parse(slice.content);
      const fan = (parsed as Record<string, unknown>).fan;
      if (!Array.isArray(fan)) {
        return new Set();
      }
      const ids = new Set<string>();
      for (const entry of fan) {
        const record = entry as Record<string, unknown>;
        if (record.kind === "shell" && typeof record.id === "string") {
          ids.add(record.id);
        }
      }
      return ids;
    } catch {
      return null;
    }
  }

  /**
   * Counts background shells by their .output files. Files belonging to
   * sub-agents (same id) are excluded. Running is judged by the job's live
   * task list when available; otherwise a shell counts as completed once
   * its output contains the exit marker (which a killed shell never gets —
   * the fallback can overcount running).
   */
  async #probeShells(
    dir: string,
    subagentIds: Set<string>,
    agent: ClaudeAgent,
  ): Promise<ShellCounts> {
    const fanIds = await this.#runningShellIds(agent);
    const entries = await listSessionDir(dir);
    if (fanIds !== null) {
      let running = 0;
      let completed = 0;
      for (const entry of entries) {
        const match = /^(.+)\.output$/.exec(entry.name);
        if (entry.isDir || match?.[1] === undefined) {
          continue;
        }
        if (subagentIds.has(match[1])) {
          continue;
        }
        if (fanIds.has(match[1])) {
          running += 1;
        } else {
          completed += 1;
        }
      }
      return { running, completed };
    }
    let running = 0;
    let completed = 0;
    for (const entry of entries) {
      const match = /^(.+)\.output$/.exec(entry.name);
      if (entry.isDir || match?.[1] === undefined) {
        continue;
      }
      if (subagentIds.has(match[1])) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
      if (this.#exited.has(path)) {
        completed += 1;
        continue;
      }
      if (await this.#sawExitMarker(path, entry.size)) {
        this.#exited.add(path);
        this.#offsets.delete(path);
        this.#carry.delete(path);
        completed += 1;
      } else {
        running += 1;
      }
    }
    return { running, completed };
  }

  async #sawExitMarker(path: string, sizeOnDisk: number): Promise<boolean> {
    let offset = this.#offsets.get(path) ?? 0;
    if (sizeOnDisk < offset) {
      // Truncated/rewritten; start over.
      offset = 0;
      this.#carry.delete(path);
    }
    if (sizeOnDisk === offset) {
      return false;
    }
    const slice = await readFileSlice(path, offset);
    this.#offsets.set(path, slice.size);
    const haystack = (this.#carry.get(path) ?? "") + slice.content;
    this.#carry.set(path, haystack.slice(-CARRY_LENGTH));
    return EXIT_MARKER.test(haystack);
  }

  async #probeTasks(dir: string): Promise<TaskCounts> {
    const entries = await listSessionDir(dir);
    let total = 0;
    let completed = 0;
    for (const entry of entries) {
      if (entry.isDir || !entry.name.endsWith(".json")) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
      const cached = this.#taskCache.get(path);
      let status: string;
      if (
        cached !== undefined &&
        cached.size === entry.size &&
        cached.modifiedMs === entry.modifiedMs
      ) {
        status = cached.status;
      } else {
        try {
          const slice = await readFileSlice(path, 0);
          const parsed: unknown = JSON.parse(slice.content);
          status =
            typeof parsed === "object" &&
            parsed !== null &&
            typeof (parsed as Record<string, unknown>).status === "string"
              ? ((parsed as Record<string, unknown>).status as string)
              : "unknown";
        } catch {
          // File may be mid-write; skip it this round without caching.
          continue;
        }
        this.#taskCache.set(path, {
          size: entry.size,
          modifiedMs: entry.modifiedMs,
          status,
        });
      }
      total += 1;
      if (status === "completed") {
        completed += 1;
      }
    }
    return { total, completed };
  }

  #publish(details: Map<string, SessionDetails>): void {
    const key = JSON.stringify([...details.entries()]);
    if (key === this.#lastKey) {
      return;
    }
    this.#lastKey = key;
    this.#details = details;
    for (const listener of this.#listeners) {
      listener(details);
    }
  }
}

export const sessionDetails = new SessionDetailsModel();
