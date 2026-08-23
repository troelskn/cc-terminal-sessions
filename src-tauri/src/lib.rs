use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Runs `claude agents --json` and returns its raw stdout. Goes through the
/// user's login shell because a bundled .app doesn't inherit the terminal
/// PATH (claude typically lives in ~/.local/bin).
#[tauri::command]
async fn list_claude_agents() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let output = std::process::Command::new(shell)
            .args(["-lc", "claude agents --json"])
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
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![list_claude_agents])
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
