import { invoke } from "@tauri-apps/api/core";
import { type ClaudeAgent, claudeAgents } from "./claude-agents";

interface ProbePaths {
  claudeHome: string;
  tmpBase: string;
}

interface DirEntry {
  name: string;
  size: number;
  modifiedMs: number;
  isDir: boolean;
}

interface FileSlice {
  content: string;
  size: number;
}

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
}

export type DetailsListener = (details: Map<string, SessionDetails>) => void;

const EXIT_MARKER = /\[exited with code -?\d+\]/;
/** A sub-agent transcript untouched for this long counts as finished. */
const SUBAGENT_ACTIVE_WINDOW_MS = 30_000;
/** Longest prefix of the exit marker that could straddle a read boundary. */
const CARRY_LENGTH = 40;

/** Claude Code's project-directory encoding of a cwd. */
function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

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
  #paths: ProbePaths | null = null;

  /** Byte offset already consumed, per append-only output file. */
  #offsets = new Map<string, number>();
  /** Tail of the previous read, to catch markers straddling a boundary. */
  #carry = new Map<string, string>();
  /** Output files whose exit marker has been seen; never read again. */
  #exited = new Set<string>();
  /** Task JSON files, cached by size + mtime. */
  #taskCache = new Map<string, TaskFileCache>();

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
      this.#paths ??= await invoke<ProbePaths>("probe_paths");
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
    const paths = this.#paths as ProbePaths;
    const slug = slugify(agent.cwd);
    const [subagents, tasks] = await Promise.all([
      this.#listSubagents(
        `${paths.claudeHome}/projects/${slug}/${agent.sessionId}/subagents`,
      ),
      this.#probeTasks(`${paths.claudeHome}/tasks/${agent.sessionId}`),
    ]);
    const shells = await this.#probeShells(
      `${paths.tmpBase}/${slug}/${agent.sessionId}/tasks`,
      subagents.ids,
    );
    return {
      sessionId: agent.sessionId,
      shells,
      subagentCount: subagents.active,
      tasks,
    };
  }

  /**
   * Returns all sub-agent ids ever spawned (needed to exclude their output
   * files from shell counting) plus the number considered active, judged by
   * transcript mtime recency — finished agents simply stop appending.
   */
  async #listSubagents(
    dir: string,
  ): Promise<{ ids: Set<string>; active: number }> {
    const entries = await invoke<DirEntry[]>("list_session_dir", { path: dir });
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
   * Counts background shells by their .output files. Files belonging to
   * sub-agents (same id) are excluded; a shell is "completed" once its
   * output contains the exit marker.
   */
  async #probeShells(
    dir: string,
    subagentIds: Set<string>,
  ): Promise<ShellCounts> {
    const entries = await invoke<DirEntry[]>("list_session_dir", { path: dir });
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
    const slice = await invoke<FileSlice>("read_file_slice", { path, offset });
    this.#offsets.set(path, slice.size);
    const haystack = (this.#carry.get(path) ?? "") + slice.content;
    this.#carry.set(path, haystack.slice(-CARRY_LENGTH));
    return EXIT_MARKER.test(haystack);
  }

  async #probeTasks(dir: string): Promise<TaskCounts> {
    const entries = await invoke<DirEntry[]>("list_session_dir", { path: dir });
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
          const slice = await invoke<FileSlice>("read_file_slice", {
            path,
            offset: 0,
          });
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
