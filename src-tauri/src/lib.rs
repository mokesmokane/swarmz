pub mod agents;
pub mod commands;
pub mod paste;
pub use swarmz_tool::pty;
pub mod registry;
pub mod remote;
pub mod session;
pub mod sync;
pub mod toolbin;
pub use swarmz_tool::{tailscale, workspace};

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::list_terminals,
            commands::write_terminal,
            commands::resize_terminal,
            commands::rename_terminal,
            commands::close_terminal,
            commands::restart_terminal,
            commands::load_workspace,
            commands::save_workspace,
            commands::ssh_check,
            commands::ssh_open_master,
            commands::ssh_list_dir,
            commands::terminal_foreground_busy,
            commands::terminal_cwd,
            commands::set_terminal_cwd,
            commands::tailscale_status,
            commands::tailscale_open,
            commands::workspace_pull,
            commands::workspace_push,
            commands::workspace_stat,
            commands::agents_install_local,
            commands::agents_install_remote,
            commands::tool_remote_ready,
            commands::remote_tile_info,
            commands::remote_tile_close,
            commands::local_sessions,
            commands::close_session,
            commands::phones,
            commands::revoke_phone,
            commands::host_keys,
            commands::agents_watch,
            commands::agents_unwatch,
            commands::paste_image_to_remote,
        ])
        .setup(|_app| {
            let _ = remote::ensure_ssh_dir();
            // Install the tool in the background so a slow disk never delays the window.
            std::thread::spawn(|| {
                if let Err(e) = toolbin::ensure_installed() {
                    eprintln!("swarmz: {e}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Log watchers are child processes (tail / ssh tail); dropping them here kills them
            // so a quit does not leave orphans behind, which would otherwise outlive the app.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.watchers.lock().unwrap().clear();
                    // Tiles live in their holders: quitting only detaches from them.
                    state.sessions.lock().unwrap().clear();
                }
            }
        });
}
