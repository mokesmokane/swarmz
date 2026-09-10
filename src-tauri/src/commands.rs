use crate::pty::{PtySession, SpawnSpec};
use crate::registry::{TerminalInfo, TerminalRegistry};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    pub registry: Mutex<TerminalRegistry>,
    pub sessions: Mutex<HashMap<String, (u64, Arc<PtySession>)>>,
    pub next_gen: AtomicU64,
}

/// Removes the session for `id` only if its recorded generation matches `gen`.
/// Returns true if it removed the entry (i.e. this caller's session was the live one).
fn take_if_current(sessions: &mut HashMap<String, (u64, Arc<PtySession>)>, id: &str, gen: u64) -> bool {
    if let Some((g, _)) = sessions.get(id) {
        if *g == gen {
            sessions.remove(id);
            return true;
        }
    }
    false
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

    let gen = state.next_gen.fetch_add(1, Ordering::SeqCst);

    let data_app = app.clone();
    let data_topic = format!("pty:data:{}", info.id);
    let exit_app = app.clone();
    let exit_id = info.id.clone();

    // Hold the sessions lock across the spawn call (and the subsequent
    // insert) so the child's exit callback - which runs on another thread
    // and can fire before this function returns for very short-lived
    // processes - can never observe the (gen, session) tuple missing from
    // the map. The callback blocks on the same mutex until the insert
    // below lands, then finds and removes its own entry via
    // `take_if_current`. Without this, a child that exits before the
    // insert would cause the exit callback to no-op (its generation isn't
    // in the map yet) and the insert that follows would then add a
    // dead/zombie session that never gets cleaned up.
    let mut sessions = state.sessions.lock().unwrap();

    let session = PtySession::spawn(
        spec,
        move |bytes| {
            let _ = data_app.emit(&data_topic, BASE64.encode(&bytes));
        },
        move |code| {
            if let Some(st) = exit_app.try_state::<AppState>() {
                let mine = take_if_current(&mut st.sessions.lock().unwrap(), &exit_id, gen);
                if !mine {
                    return;
                }
                st.registry.lock().unwrap().set_exited(&exit_id, code, None);
            }
            let _ = exit_app.emit(&format!("pty:exit:{exit_id}"), ExitPayload { code });
        },
    )?;

    sessions.insert(info.id.clone(), (gen, Arc::new(session)));
    drop(sessions);
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
        .map(|(_, s)| s.clone())
        .ok_or_else(|| format!("terminal {id} is not running"))?;
    session.write(data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().get(&id).map(|(_, s)| s.clone());
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
    if let Some((_, session)) = state.sessions.lock().unwrap().remove(&id) {
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
        TerminalInfo { exited: None, error: None, ..current }
    };
    match spawn_for(&app, &state, &info, cols, rows) {
        Ok(()) => Ok(info),
        Err(e) => {
            let mut reg = state.registry.lock().unwrap();
            reg.set_exited(&id, Some(-1), Some(e));
            Ok(reg.get(&id).cloned().unwrap_or(info))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::SpawnSpec;

    fn dummy_session() -> Arc<PtySession> {
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 5".to_string()],
            cwd: "/".to_string(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        Arc::new(PtySession::spawn(spec, |_| {}, |_| {}).unwrap())
    }

    #[test]
    fn take_if_current_only_removes_matching_generation() {
        let mut sessions: HashMap<String, (u64, Arc<PtySession>)> = HashMap::new();
        let session = dummy_session();
        sessions.insert("a".to_string(), (1, session.clone()));

        // A stale generation (e.g. an old spawn's exit callback firing after a
        // restart replaced the entry) must not remove the current session.
        assert!(!take_if_current(&mut sessions, "a", 0));
        assert!(sessions.contains_key("a"));

        // The current generation is allowed to remove its own entry.
        assert!(take_if_current(&mut sessions, "a", 1));
        assert!(!sessions.contains_key("a"));

        // A missing id never reports itself as "mine".
        assert!(!take_if_current(&mut sessions, "missing", 1));

        session.kill();
    }
}
