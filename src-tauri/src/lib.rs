use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Runs `claude agents --json` and returns its raw stdout. Goes through the
/// user's login shell because a bundled .app doesn't inherit the terminal
/// PATH (claude typically lives in ~/.local/bin).
///
/// The shell is run interactive *and* login (`-ilc`): a bare login shell
/// (`-lc`) sources ~/.zprofile/~/.zlogin but not ~/.zshrc, which is where
/// many setups (including PATH additions for ~/.local/bin) actually live.
/// Without `-i`, a Finder-launched .app resolves `claude` as not-found even
/// though it works from the terminal.
#[tauri::command]
async fn list_claude_agents() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let output = std::process::Command::new(shell)
            .args(["-ilc", "claude agents --json"])
            .output()
            .map_err(|e| format!("failed to run claude: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "claude agents exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        String::from_utf8(output.stdout).map_err(|e| format!("invalid utf-8: {e}"))
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Best-effort auth-mode detection for a session process: an
/// ANTHROPIC_API_KEY in its environment means API-key billing; otherwise a
/// claude.ai login in ~/.claude.json means subscription.
#[tauri::command]
async fn probe_auth(pid: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new("ps")
            .args(["eww", "-o", "command=", "-p", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
        if String::from_utf8_lossy(&output.stdout).contains("ANTHROPIC_API_KEY=") {
            return Ok("api".to_string());
        }
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        let config = std::fs::read_to_string(format!("{home}/.claude.json")).unwrap_or_default();
        if config.contains("\"oauthAccount\"") {
            Ok("subscription".to_string())
        } else {
            Ok("unknown".to_string())
        }
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbePaths {
    /// ~/.claude
    claude_home: String,
    /// /private/tmp/claude-<uid>
    tmp_base: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryInfo {
    name: String,
    size: u64,
    modified_ms: u64,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSlice {
    content: String,
    /// File size at read time; use as the offset for the next read.
    size: u64,
}

fn claude_roots() -> Result<(PathBuf, PathBuf), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let claude_home = Path::new(&home).join(".claude");
    let uid = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(&home).map_err(|e| e.to_string())?.uid()
    };
    let tmp_base = PathBuf::from(format!("/private/tmp/claude-{uid}"));
    Ok((claude_home, tmp_base))
}

/// Only files under ~/.claude or the claude temp dir may be read.
fn ensure_allowed(path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve {}: {e}", path.display()))?;
    let (claude_home, tmp_base) = claude_roots()?;
    let claude_home = claude_home.canonicalize().unwrap_or(claude_home);
    let tmp_base = tmp_base.canonicalize().unwrap_or(tmp_base);
    if canonical.starts_with(&claude_home) || canonical.starts_with(&tmp_base) {
        Ok(())
    } else {
        Err(format!("path outside allowed roots: {}", canonical.display()))
    }
}

#[tauri::command]
fn probe_paths() -> Result<ProbePaths, String> {
    let (claude_home, tmp_base) = claude_roots()?;
    Ok(ProbePaths {
        claude_home: claude_home.to_string_lossy().into_owned(),
        tmp_base: tmp_base.to_string_lossy().into_owned(),
    })
}

/// Lists a directory under the allowed roots. A missing directory is not an
/// error — it just means the session has no such state yet.
#[tauri::command]
fn list_session_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    ensure_allowed(&dir)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            size: meta.len(),
            modified_ms,
            is_dir: meta.is_dir(),
        });
    }
    Ok(entries)
}

/// Reads a file from `offset` to EOF, or at most `limit` bytes when given.
/// Returns the position after the read so the caller can resume from there;
/// a size smaller than the caller's stored offset means the file was
/// truncated and should be re-read from zero.
#[tauri::command]
async fn read_file_slice(
    path: String,
    offset: u64,
    limit: Option<u64>,
) -> Result<FileSlice, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_path = PathBuf::from(&path);
        ensure_allowed(&file_path)?;
        let mut file = std::fs::File::open(&file_path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let start = offset.min(len);
        file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        match limit {
            Some(limit) => {
                file.take(limit)
                    .read_to_end(&mut buf)
                    .map_err(|e| e.to_string())?;
            }
            None => {
                file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            }
        }
        Ok(FileSlice {
            content: String::from_utf8_lossy(&buf).into_owned(),
            size: start + buf.len() as u64,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Brings the Terminal.app tab hosting `pid`'s controlling tty to the front.
#[tauri::command]
async fn focus_terminal_tab(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new("ps")
            .args(["-o", "tty=", "-p", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;
        let tty = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if tty.is_empty() || tty == "??" {
            return Err(format!("pid {pid} has no controlling tty"));
        }
        let script = format!(
            r#"tell application "Terminal"
    repeat with w in windows
        repeat with t in tabs of w
            if tty of t is "/dev/{tty}" then
                set selected of t to true
                set index of w to 1
                activate
                return
            end if
        end repeat
    end repeat
end tell"#
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "osascript failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Cmd+Shift+D on macOS (SUPER maps to the command key)
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(toggle_shortcut)
                .expect("failed to parse toggle shortcut")
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed || *shortcut != toggle_shortcut {
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let focused = window.is_focused().unwrap_or(false);
                        let visible = window.is_visible().unwrap_or(false);
                        if focused && visible {
                            // Hide the whole app, not just the window: macOS
                            // then restores focus to the previously active app.
                            let _ = app.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            list_claude_agents,
            probe_paths,
            list_session_dir,
            read_file_slice,
            focus_terminal_tab,
            probe_auth
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
