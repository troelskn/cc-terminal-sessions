# cc-terminal-sessions

A tiny macOS heads-up display for your [Claude Code](https://code.claude.com)
terminal sessions. Summon it with a global hotkey, see every running session
at a glance, and jump straight to the Terminal tab a session lives in.

## Architecture

Built with Tauri v2 — a frameless, dark, auto-sizing panel with a TypeScript
frontend and a thin Rust backend.

The model layer polls two kinds of sources every 3 seconds and publishes to
the view only when something actually changed:

- `claude agents --json` — the documented-ish CLI surface: pid, cwd,
  session id, name, status.
- Claude Code's on-disk state — **undocumented internals**, read
  incrementally (byte offsets into append-only files, size/mtime caches for
  rewritable ones):
  - `~/.claude/projects/<slug>/<session>.jsonl` — transcripts, for context
    size (last usage block) and cost (accumulated usage × model rates)
  - `~/.claude/projects/<slug>/<session>/subagents/` — sub-agent transcripts
  - `~/.claude/tasks/<session>/` — task lists
  - `~/.claude/jobs/<id>/state.json` — live shell fan for background jobs
  - `/private/tmp/claude-<uid>/<slug>/<session>/tasks/` — shell output files

Sessions opened through the CLI's agents view are deduplicated: the
background continuation's transcript still references the original session
id, so the original interactive twin is hidden and its terminal is used as
the focus target.

The Rust side is deliberately small: run the CLI, list/read files (locked to
`~/.claude` and the claude temp dir), probe a process env, and AppleScript
Terminal.app to select a tab by tty.

Because most of this reads unstable internals, a Claude Code release can
break the detail rows at any time — the app degrades to the plain session
list when it does.

## Requirements

- macOS (Terminal.app for the focus-a-session feature; first use prompts
  for Automation permission)
- The `claude` CLI on your login shell's PATH
- Rust ≥ 1.77 and Node for development

## Building

`npm install && npm run bundle` produces a release build. The script detects
the machine's real architecture (via `sysctl`, so it isn't fooled by a
Rosetta shell) and runs `tauri build` for it; the finished app lands in
`src-tauri/target/<arch>-apple-darwin/release/bundle/macos/cc-terminal-sessions.app`
(a `.dmg` is written next to it). Drag the `.app` to `/Applications` — the
build is unsigned, so on first launch you may need to right-click → Open.

## Development

```bash
npm install
npm run tauri dev      # run the app with hot reload
npm run typecheck      # tsc
npm run bundle         # release build, see Building above
```

The app icon is generated from `src-tauri/icons/source.svg` via
`npx tauri icon <1024px png>`.
