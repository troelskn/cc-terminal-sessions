import { invoke } from "@tauri-apps/api/core";

export interface ProbePaths {
  claudeHome: string;
  tmpBase: string;
}

export interface DirEntry {
  name: string;
  size: number;
  modifiedMs: number;
  isDir: boolean;
}

export interface FileSlice {
  content: string;
  size: number;
}

/** Claude Code's project-directory encoding of a cwd. */
export function slugify(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

let paths: Promise<ProbePaths> | null = null;

export function probePaths(): Promise<ProbePaths> {
  paths ??= invoke<ProbePaths>("probe_paths");
  return paths;
}

export function listSessionDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_session_dir", { path });
}

export function readFileSlice(
  path: string,
  offset: number,
  limit?: number,
): Promise<FileSlice> {
  return invoke<FileSlice>("read_file_slice", { path, offset, limit });
}
