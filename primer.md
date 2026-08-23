# Handoff: Claude Code multi-session status dashboard

## Goal
Build a small utility/dashboard showing the status of all running Claude Code sessions on this Mac. Troels runs multiple CC sessions in parallel, each in its own **Terminal.app tab**. The dashboard should show per session: which project, current state (working / idle / waiting for input or permission), and ideally offer a "jump to that tab" action. Preferred languages: Ruby, PHP, JS/TS.

## Key findings

### 1. No push/subscribe notification API — hooks are the mechanism
Claude Code has no event-stream/webhook API, but **hooks** fire shell commands on lifecycle events with a JSON payload on stdin (`session_id`, `cwd`, `transcript_path`, event-specific fields). Relevant events:

- `SessionStart` / `SessionEnd` — session opened/closed
- `Notification` — session needs attention (permission prompt, "waiting for your input" idle prompt) → the "needs me" signal
- `Stop` — Claude finished its turn → session idle
- `UserPromptSubmit` / `PreToolUse` — session active again

Configure in `~/.claude/settings.json` (machine-wide):

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-report.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/bin/cc-status-report.sh" }] }
    ]
  }
}
```

Verify exact `Notification` payload fields against the installed version: https://code.claude.com/docs/en/hooks

**Suggested architecture:** each hook writes its payload to a state file keyed by session_id (e.g. `~/.cc-dashboard/sessions/<id>.json`) or POSTs to a tiny local server; dashboard renders from that. State machine: SessionStart → working, Stop → idle, Notification → waiting-for-you, SessionEnd → gone.

### 2. Supplementary data sources
- `claude agents --json` — poll for `state`/`status`/`waitingFor` per session; good reconciliation pass (e.g. sessions killed without SessionEnd). Oriented around daemon/background sessions — verify how well it sees plain interactive tabs.
- Transcripts: `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl` — file mtime = last-activity signal; contents = what the session is doing.
- Statusline API (in-tab display) and OTEL telemetry (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, cost/token metrics) exist but aren't core here.

### 3. Terminal.app tab identification & switching (VERIFIED on this Mac)
The bridge between a PID and a Terminal tab is the **tty**:

- `ps -o tty= -p <pid>` → e.g. `ttys001`; Terminal's tab property is `/dev/ttys001`.
- Verified live: `claude` (PID 34471) on `ttys001` matched Terminal window id 74, tab `tty=/dev/ttys001`. AppleScript can enumerate `windows` → `tabs` with `tty`, `selected`, `busy`, `processes` properties.
- `claude` keeps the tab's tty as controlling terminal, so the mapping is direct (no parent-chain walking needed; for nested children walk `ps -o ppid=` up to a process with a real tty).
- tty is stable for the life of the tab → cache pid→tty mapping.

Working switch script (`focus-tab.scpt`, call `osascript focus-tab.scpt <pid>`):

```applescript
on run argv
	set targetTty to "/dev/" & (do shell script "ps -o tty= -p " & (item 1 of argv) & " | tr -d ' '")
	tell application "Terminal"
		repeat with w in windows
			repeat with t in tabs of w
				if (tty of t) is targetTty then
					set selected of t to true
					set index of w to 1
					set frontmost of w to true
					activate
					return
				end if
			end repeat
		end repeat
	end tell
end run
```

Gotcha: first run triggers a one-time macOS Automation permission prompt (System Settings → Privacy & Security → Automation) for whatever process runs osascript.

## Suggested next steps
1. Write the hook script (`cc-status-report.sh` or a Node one-liner) that dumps stdin JSON to `~/.cc-dashboard/sessions/<session_id>.json` with the event name and timestamp.
2. Register it in `~/.claude/settings.json` for SessionStart, SessionEnd, Stop, Notification, UserPromptSubmit.
3. Build the dashboard (terminal TUI or small local web page) reading the state dir; add pid→tty resolution and the AppleScript jump-to-tab action per row.
4. Add a reconciliation pass: prune sessions whose PID is dead / check `claude agents --json`.
