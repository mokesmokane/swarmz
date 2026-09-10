use crate::pty::{PtySession, SpawnSpec};
use crate::registry::{TerminalInfo, TerminalRegistry};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    pub registry: Mutex<TerminalRegistry>,
    pub sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    code: Option<i32>,
}

fn spawn_for(app: &AppHandle, state: &AppState, info: &TerminalInfo, cols: u16, rows: u16) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let spec = SpawnSpec {
        program: shell,
        args: vec!["-l".to_string()],
        cwd: info.cwd.clone(),
        env: vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("SWARMZ_TERMINAL_ID".into(), info.id.clone()),
            ("SWARMZ_TERMINAL_NAME".into(), info.name.clone()),
        ],
        cols,
        rows,
    };

    let data_app = app.clone();
    let data_topic = format!("pty:data:{}", info.id);
    let exit_app = app.clone();
    let exit_id = info.id.clone();

    let session = PtySession::spawn(
        spec,
        move |bytes| {
            let _ = data_app.emit(&data_topic, BASE64.encode(&bytes));
        },
        move |code| {
            if let Some(st) = exit_app.try_state::<AppState>() {
                st.registry.lock().unwrap().set_exited(&exit_id, code, None);
                st.sessions.lock().unwrap().remove(&exit_id);
            }
            let _ = exit_app.emit(&format!("pty:exit:{exit_id}"), ExitPayload { code });
        },
    )?;

    state.sessions.lock().unwrap().insert(info.id.clone(), Arc::new(session));
    Ok(())
}

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    name: Option<String>,
) -> Result<TerminalInfo, String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let info = state.registry.lock().unwrap().add(id, name, cwd);
    match spawn_for(&app, &state, &info, cols, rows) {
        Ok(()) => Ok(info),
        Err(e) => {
            let mut reg = state.registry.lock().unwrap();
            reg.set_exited(&info.id, Some(-1), Some(e));
            Ok(reg.get(&info.id).cloned().unwrap_or(info))
        }
    }
}

#[tauri::command]
pub fn list_terminals(state: State<'_, AppState>) -> Vec<TerminalInfo> {
    state.registry.lock().unwrap().list()
}

#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("terminal {id} is not running"))?;
    session.write(data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().get(&id).cloned();
    match session {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn rename_terminal(state: State<'_, AppState>, id: String, name: String) -> Result<TerminalInfo, String> {
    state.registry.lock().unwrap().rename(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().remove(&id) {
        session.kill();
    }
    state.registry.lock().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn restart_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let info = {
        let mut reg = state.registry.lock().unwrap();
        let current = reg.get(&id).cloned().ok_or_else(|| format!("no terminal with id {id}"))?;
        if current.exited.is_none() {
            return Err("terminal is still running".to_string());
        }
        reg.clear_exited(&id);
        reg.get(&id).cloned().unwrap()
    };
    match spawn_for(&app, &state, &info, cols, rows) {
        Ok(()) => Ok(info),
        Err(e) => {
            let mut reg = state.registry.lock().unwrap();
            reg.set_exited(&id, Some(-1), Some(e));
            Ok(reg.get(&id).cloned().unwrap())
        }
    }
}
