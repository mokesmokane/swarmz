pub mod commands;
pub mod pty;
pub mod registry;
pub mod workspace;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
