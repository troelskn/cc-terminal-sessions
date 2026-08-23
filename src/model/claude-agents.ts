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
 * Model-layer singleton for probing Claude Code session status.
 * Shells out to `claude agents --json` via the Rust backend.
 */
class ClaudeAgentsModel {
  async probe(): Promise<ClaudeAgent[]> {
    const raw = await invoke<string>("list_claude_agents");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error("expected a JSON array from claude agents --json");
    }
    return data.map(parseAgent);
  }
}

export const claudeAgents = new ClaudeAgentsModel();
