use crate::registry::{TerminalInfo, TerminalRegistry};
use crate::session::TerminalSession;
use crate::workspace::Workspace;
use crate::workspace as ws_file;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use swarmz_tool::client::HolderClient;
use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};
use tauri::{AppHandle, Emitter, Manager, State};

type Sessions = HashMap<String, (u64, Arc<dyn TerminalSession>)>;

#[derive(Default)]
pub struct AppState {
    pub registry: Mutex<TerminalRegistry>,
    pub sessions: Mutex<Sessions>,
    pub next_gen: AtomicU64,
    /// Ids closed before their start had registered them, with when (see `close_terminal`).
    pub closed_early: Mutex<HashMap<String, Instant>>,
    pub watchers: Mutex<HashMap<Option<String>, (u64, crate::agents::Watcher)>>,
    /// Second viewers of tiles shown in other windows (windows and layouts spec §4), by
    /// (window label, tile id). Their replay goes to that window alone; data still arrives on
    /// `pty:data:<id>`, which every window receives from the main viewer.
    pub views: Mutex<HashMap<(String, String), Arc<dyn TerminalSession>>>,
    /// The Telegram follower (conductor spec §5) while the conductor runs on this Mac.
    pub telegram: Mutex<Option<crate::telegram::Follower>>,
}

/// The session a window's writes and resizes go to: its own viewer of the tile when it has one
/// (a tile in another window), else the main viewer.
fn session_for(state: &AppState, label: &str, id: &str) -> Option<Arc<dyn TerminalSession>> {
    if let Some(v) = state.views.lock().unwrap().get(&(label.to_string(), id.to_string())) {
        return Some(v.clone());
    }
    state.sessions.lock().unwrap().get(id).map(|(_, s)| s.clone())
}

/// Drops every viewer a window held (its close, or a tile's return to the workbench).
pub fn drop_views(state: &AppState, label: &str, id: Option<&str>) {
    state.views.lock().unwrap().retain(|(l, i), _| l != label || id.is_some_and(|want| want != i));
}

/// Opens another window's own viewer of a running tile's holder (windows and layouts spec §4): a sizeless Hello,
/// so the pane keeps the size the last typist set until something is typed here, and the replay
/// delivered to this window only. Errors: an unknown tile, or a holder that does not answer.
#[tauri::command]
pub async fn open_view(app: AppHandle, window: tauri::Window, id: String) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.registry.lock().unwrap().get(&id).is_none() {
            return Err(format!("no terminal with id {id}"));
        }
        if !state.sessions.lock().unwrap().contains_key(&id) {
            return Err(format!("terminal {id} is not running"));
        }
        let socket = swarmz_tool::paths::session_paths(&swarmz_tool::paths::sessions_dir(), &id)?.socket;
        let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: format!("window:{label}") };
        let replay_topic = format!("pty:replay:{id}");
        let emit_app = app.clone();
        let target = tauri::EventTarget::labeled(label.clone());
        let replay_size = Arc::new(Mutex::new((0u16, 0u16)));
        let welcome_size = replay_size.clone();
        let client = HolderClient::connect_with(
            &socket,
            &hello,
            move |welcome| *welcome_size.lock().unwrap() = (welcome.cols, welcome.rows),
            move |bytes, replay| {
                if replay {
                    let size = *replay_size.lock().unwrap();
                    let _ = emit_app.emit_to(target.clone(), &replay_topic, replay_payload(&bytes, size));
                }
            },
            |_| {},
        )?;
        let client: Arc<dyn TerminalSession> = Arc::new(client);
        state.views.lock().unwrap().insert((label, id), client);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Closes the calling window's viewer of a tile (the tile returned to the workbench).
#[tauri::command]
pub fn close_view(state: State<'_, AppState>, window: tauri::Window, id: String) {
    drop_views(&state, window.label(), Some(&id));
}

/// Removes the session for `id` only if its recorded generation matches `gen`.
/// Returns true if it removed the entry (i.e. this caller's session was the live one).
fn take_if_current(sessions: &mut Sessions, id: &str, gen: u64) -> bool {
    if let Some((g, _)) = sessions.get(id) {
        if *g == gen {
            sessions.remove(id);
            return true;
        }
    }
    false
}

/// Opens once a start has recorded (or refused) its session. The session's exit callback waits
/// for it, so an exit that races the start never looks for an entry that is not there yet.
#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.cv.notify_all();
    }

    fn wait(&self, timeout: Duration) {
        let guard = self.open.lock().unwrap();
        let _ = self.cv.wait_timeout_while(guard, timeout, |open| !*open);
    }
}

/// Longer than a start can take between connecting and recording its session (a lock and an
/// insert), short enough that a stuck start never pins the exit thread for long.
const EXIT_GATE_WAIT: Duration = Duration::from_secs(10);

/// How long a close for a tile that was not registered yet is remembered; above the longest a
/// start can take before it registers the tile.
const CLOSED_EARLY_TTL: Duration = Duration::from_secs(60);

/// The exit side of a session: once the start has finished, removes the session if it is still
/// the tile's current one and marks the tile exited. Returns whether it did (and so whether the
/// exit should be reported).
fn finish_exit(
    sessions: &Mutex<Sessions>,
    registry: &Mutex<TerminalRegistry>,
    gate: &Gate,
    id: &str,
    gen: u64,
    code: Option<i32>,
) -> bool {
    gate.wait(EXIT_GATE_WAIT);
    let mine = take_if_current(&mut sessions.lock().unwrap(), id, gen);
    if mine {
        registry.lock().unwrap().set_exited(id, code, None);
    }
    mine
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    code: Option<i32>,
}

/// A `pty:replay:<id>` event: the replayed bytes (base64) and the size they were written at
/// (0 when the holder did not say), so the pane parses them at that size before fitting. The size
/// travels inside the replay event rather than in an event of its own because the replay is
/// emitted from inside `connect`, before `create_terminal` returns, and the frontend must never
/// see the two out of order.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ReplayPayload {
    pub data: String,
    pub cols: u16,
    pub rows: u16,
}

pub fn replay_payload(bytes: &[u8], (cols, rows): (u16, u16)) -> ReplayPayload {
    ReplayPayload { data: BASE64.encode(bytes), cols, rows }
}

/// The size a window asks for when it connects. A session that was already running keeps its
/// size until the pane has laid out and sends a real resize (the pane may not be fitted yet, and
/// its placeholder size would squash whatever is on screen); a new one starts at the pane's size.
/// A holder without a build id predates sizeless `Hello`s and would apply 0x0, so it gets the
/// pane's size as before.
fn hello_size(held: &swarmz_tool::hold::HoldResult, cols: u16, rows: u16) -> (u16, u16) {
    if held.existed && held.build.is_some() {
        (0, 0)
    } else {
        (cols, rows)
    }
}

/// Records a freshly connected session for `id`, unless the tile was closed while it was
/// starting (starts run off the main thread, so a close can land in between). The caller holds
/// the sessions lock; `close_terminal` removes the registry entry before it looks at the
/// sessions, so a close either happens before this check (and the session is refused) or finds
/// the session this inserts.
fn insert_if_registered(
    sessions: &mut Sessions,
    registry: &Mutex<TerminalRegistry>,
    id: &str,
    gen: u64,
    session: Arc<dyn TerminalSession>,
) -> bool {
    if registry.lock().unwrap().get(id).is_none() {
        return false;
    }
    sessions.insert(id.to_string(), (gen, session));
    true
}

/// What connecting a tile learned about its session.
struct Joined {
    /// The session was already running.
    existed: bool,
    /// When the session's holder started.
    started_at: String,
}

/// Connects the tile to its session holder, starting one if needed.
fn spawn_for(app: &AppHandle, info: &TerminalInfo, cols: u16, rows: u16) -> Result<Joined, String> {
    let state = app.state::<AppState>();
    let tool = crate::toolbin::ensure_installed()?;
    let held = crate::toolbin::hold(&tool, None, &info.id, &info.name, &info.cwd, cols, rows)?;

    let gen = state.next_gen.fetch_add(1, Ordering::SeqCst);
    let data_app = app.clone();
    let data_topic = format!("pty:data:{}", info.id);
    let replay_topic = format!("pty:replay:{}", info.id);
    let exit_app = app.clone();
    let exit_id = info.id.clone();

    // The exit callback runs on the client's reader thread and can fire before this function
    // has recorded the session (a shell that exits at once). It waits on `gate` until the
    // insert below has landed (or been refused), then finds and removes its own entry via
    // `take_if_current`. The sessions lock is not held across `connect`, which blocks on the
    // holder (and delivers the replay on this thread before it returns): writes and resizes
    // for every other tile take that lock on the main thread.
    let gate = Arc::new(Gate::default());
    let exit_gate = gate.clone();
    let (hello_cols, hello_rows) = hello_size(&held, cols, rows);
    let hello = Hello { v: PROTOCOL_VERSION, cols: hello_cols, rows: hello_rows, viewer: "window".into() };
    let replay_size = Arc::new(Mutex::new((0u16, 0u16)));
    let welcome_size = replay_size.clone();
    let client = HolderClient::connect_with(
        std::path::Path::new(&held.socket),
        &hello,
        move |welcome| *welcome_size.lock().unwrap() = (welcome.cols, welcome.rows),
        move |bytes, replay| {
            if replay {
                let size = *replay_size.lock().unwrap();
                let _ = data_app.emit(&replay_topic, replay_payload(&bytes, size));
            } else {
                let _ = data_app.emit(&data_topic, BASE64.encode(&bytes));
            }
        },
        move |code| {
            if let Some(st) = exit_app.try_state::<AppState>() {
                if !finish_exit(&st.sessions, &st.registry, &exit_gate, &exit_id, gen, code) {
                    return;
                }
            }
            let _ = exit_app.emit(&format!("pty:exit:{exit_id}"), ExitPayload { code });
        },
    )?;
    let started_at = client.welcome().started_at.clone();
    let client: Arc<dyn TerminalSession> = Arc::new(client);
    let inserted = insert_if_registered(&mut state.sessions.lock().unwrap(), &state.registry, &info.id, gen, client.clone());
    gate.open();
    if !inserted {
        // The tile is gone: end its session rather than leave a holder nobody shows.
        client.terminate();
        return Err(format!("terminal {} was closed while it was starting", info.id));
    }
    Ok(Joined { existed: held.existed, started_at })
}

/// Starting a tile runs `swarmz hold` (a process, and up to a few seconds when a new holder has
/// to come up), so it runs off the main thread.
#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    name: Option<String>,
) -> Result<TerminalInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let info = {
            let mut reg = state.registry.lock().unwrap();
            let info = reg.add(id, name, cwd).map_err(|e| e.to_string())?;
            // Checked under the registry lock that `close_terminal` records early closes under.
            // A tombstone only counts while fresh: a stale one (a double close long ago) must not
            // fail a later legitimate create of the same persisted id.
            let tombstoned = state
                .closed_early
                .lock()
                .unwrap()
                .remove(&info.id)
                .is_some_and(|at| at.elapsed() < CLOSED_EARLY_TTL);
            if tombstoned {
                reg.remove(&info.id);
                return Err(format!("terminal {} was closed before it started", info.id));
            }
            info
        };
        match spawn_for(&app, &info, cols, rows) {
            Ok(j) => Ok(TerminalInfo { existed: j.existed, started_at: Some(j.started_at), ..info }),
            Err(e) => {
                let mut reg = state.registry.lock().unwrap();
                // The frontend retries a missing folder in the home folder, keyed on this message.
                if e.contains("is not a directory") {
                    reg.remove(&info.id);
                    return Err(e);
                }
                match reg.get(&info.id) {
                    Some(_) => {
                        reg.set_exited(&info.id, Some(-1), Some(e));
                        Ok(reg.get(&info.id).cloned().unwrap_or(info))
                    }
                    // Closed while starting.
                    None => Err(e),
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_terminals(state: State<'_, AppState>) -> Vec<TerminalInfo> {
    state.registry.lock().unwrap().list()
}

#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, window: tauri::Window, id: String, data: String) -> Result<(), String> {
    let session = session_for(&state, window.label(), &id).ok_or_else(|| format!("terminal {id} is not running"))?;
    session.write(data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, window: tauri::Window, id: String, cols: u16, rows: u16) -> Result<(), String> {
    match session_for(&state, window.label(), &id) {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

/// Whether the tile's pty currently has a foreground process other than the shell itself
/// (e.g. `ssh` still running). Used to tell a genuinely live remote session apart from a
/// host-wide multiplexed master that has outlived the shell that opened it. An unknown id, or
/// a session for which liveness cannot be determined, is reported as not busy so callers don't
/// mistake "unknown" for "safe to type into".
///
/// Asking a holder is a socket round trip, so it runs off the main thread.
#[tauri::command]
pub async fn terminal_foreground_busy(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let session = state.sessions.lock().unwrap().get(&id).map(|(_, s)| s.clone());
    let Some(session) = session else { return Ok(false) };
    tauri::async_runtime::spawn_blocking(move || session.foreground_busy().unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// Whether the tile's program has bracketed paste on (its holder's screen model), so a pane
/// rebuilt from a replay that no longer holds the escape that turned it on can turn it back on.
#[tauri::command]
pub async fn terminal_bracketed_paste(state: State<'_, AppState>, id: String) -> Result<Option<bool>, String> {
    let session = state.sessions.lock().unwrap().get(&id).map(|(_, s)| s.clone());
    let Some(session) = session else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || session.bracketed_paste()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_cwd(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let session = state.sessions.lock().unwrap().get(&id).map(|(_, s)| s.clone());
    let Some(session) = session else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || session.cwd()).await.map_err(|e| e.to_string())
}

/// Records the folder a tile's shell has moved to. Absolute paths only; the directory need not
/// exist here (a foreign tile's folder lives on another machine).
#[tauri::command]
pub fn set_terminal_cwd(state: State<'_, AppState>, id: String, cwd: String) -> Result<TerminalInfo, String> {
    if !cwd.starts_with('/') || cwd.chars().any(|c| c.is_control()) {
        return Err("folder must be an absolute path without control characters".into());
    }
    state.registry.lock().unwrap().set_cwd(&id, &cwd).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_terminal(state: State<'_, AppState>, id: String, name: String) -> Result<TerminalInfo, String> {
    state.registry.lock().unwrap().rename(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Registry first: a start still in flight checks the registry before recording its session
    // (see `insert_if_registered`), so it either sees the tile gone or its session is found here.
    {
        let mut reg = state.registry.lock().unwrap();
        if reg.remove(&id).is_none() {
            // A start may not have registered the tile yet; leave a note it checks after `add`.
            let mut early = state.closed_early.lock().unwrap();
            let now = Instant::now();
            early.retain(|_, at| now.duration_since(*at) < CLOSED_EARLY_TTL);
            early.insert(id.clone(), now);
        }
    }
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some((_, session)) = session {
        // Closing a tile ends its shell; dropping the client afterwards only detaches.
        session.terminate();
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_terminal(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<TerminalInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let info = {
            let mut reg = state.registry.lock().unwrap();
            let current = reg.get(&id).cloned().ok_or_else(|| format!("no terminal with id {id}"))?;
            if current.exited.is_none() {
                return Err("terminal is still running".to_string());
            }
            reg.clear_exited(&id);
            TerminalInfo { exited: None, error: None, ..current }
        };
        match spawn_for(&app, &info, cols, rows) {
            Ok(j) => Ok(TerminalInfo { existed: j.existed, started_at: Some(j.started_at), ..info }),
            Err(e) => {
                let mut reg = state.registry.lock().unwrap();
                reg.set_exited(&id, Some(-1), Some(e.clone()));
                reg.get(&id).cloned().ok_or(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn load_workspace() -> Result<Option<Workspace>, String> {
    ws_file::load_from(&ws_file::default_path())
}

/// The conductor fields of the file on disk (conductor tree spec §7): read before every save, so
/// a role change the tool wrote, or a peer pushed, since this app last adopted is never saved
/// over with older roles. Never moves a broken file aside (a reader, not a writer).
#[tauri::command]
pub fn workspace_roles() -> Result<serde_json::Value, String> {
    let Some(ws) = ws_file::read_from(&ws_file::default_path())? else { return Ok(serde_json::Value::Null) };
    let pick = |k: &str| ws.extra.get(k).cloned().unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({
        "conductor": pick("conductor"),
        "conductors": pick("conductors"),
        "conductorClaim": pick("conductorClaim"),
        "conductorAt": pick("conductorAt"),
    }))
}

#[tauri::command]
pub fn save_workspace(workspace: Workspace) -> Result<(), String> {
    ws_file::save_to(&ws_file::default_path(), &workspace)
}

#[tauri::command]
pub async fn ssh_check(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::remote::check(&host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ssh_list_dir(host: String, path: Option<String>) -> Result<crate::remote::RemoteListing, String> {
    tauri::async_runtime::spawn_blocking(move || crate::remote::list_dir(&host, path.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {

    #[test]
    fn answering_from_the_sidebar_only_passes_safe_arguments() {
        let id = "2d6e3b7b-e3b1-4097-8926-64a02bca5f96";
        assert_eq!(answer_args(id, "yes", None).unwrap(), vec!["answer", id, "yes"]);
        assert_eq!(answer_args(id, "no", Some("martins-mac-mini-2")).unwrap(), vec!["--on", "martins-mac-mini-2", "answer", id, "no"]);
        assert!(answer_args(id, "always", None).is_none());
        assert!(answer_args("../x", "yes", None).is_none());
        assert!(answer_args(id, "yes", Some("-oProxyCommand=x")).is_none());
        assert!(answer_args(id, "yes", Some("a b")).is_none());
    }

    use super::*;
    use crate::pty::{PtySession, SpawnSpec};

    #[test]
    fn a_running_session_is_joined_without_a_size() {
        let held = |existed: bool, build: Option<u64>| swarmz_tool::hold::HoldResult {
            v: PROTOCOL_VERSION,
            socket: "/s".into(),
            existed,
            pid: 1,
            shell_pid: None,
            cwd: "/".into(),
            cwd_fallback: false,
            build,
        };
        assert_eq!(hello_size(&held(true, Some(1)), 80, 24), (0, 0));
        assert_eq!(hello_size(&held(false, Some(1)), 132, 40), (132, 40));
        // A holder from an older tool would apply 0x0 literally.
        assert_eq!(hello_size(&held(true, None), 132, 40), (132, 40));
    }

    #[test]
    fn replay_events_carry_their_size() {
        let p = replay_payload(b"hi", (120, 40));
        assert_eq!(p, ReplayPayload { data: "aGk=".into(), cols: 120, rows: 40 });
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v, serde_json::json!({ "data": "aGk=", "cols": 120, "rows": 40 }));
    }

    fn dummy_session() -> Arc<dyn TerminalSession> {
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
        let mut sessions: Sessions = HashMap::new();
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

        session.terminate();
    }

    #[test]
    fn an_exit_that_races_the_start_waits_for_the_session_to_be_recorded() {
        let tool = crate::toolbin::tests::built_tool();

        let home = std::path::PathBuf::from(format!("/tmp/szb-{}-gate", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        // A shell that exits with 3 shortly after the holder is up.
        let script = home.join("quick-exit.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 0.3\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut cmd = std::process::Command::new(&tool);
        cmd.args(["hold", "g1", "--cwd", home.to_str().unwrap(), "--name", "g", "--require-cwd"])
            .env("HOME", &home)
            .env("SWARMZ_HOLDER_SHELL", &script);
        let out = cmd.output().unwrap();
        let held: swarmz_tool::hold::HoldResult = serde_json::from_slice(&out.stdout).unwrap();

        let state = Arc::new(AppState::default());
        state.registry.lock().unwrap().add("g1".into(), None, home.to_string_lossy().into_owned()).unwrap();
        let gen = 7;
        let gate = Arc::new(Gate::default());
        let (st, g) = (state.clone(), gate.clone());
        let (tx, rx) = std::sync::mpsc::channel();
        let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
        let client = HolderClient::connect(std::path::Path::new(&held.socket), &hello, |_, _| {}, move |code| {
            let _ = tx.send(finish_exit(&st.sessions, &st.registry, &g, "g1", gen, code));
        })
        .unwrap();
        // The shell exits while the start is still "between" connecting and recording.
        std::thread::sleep(Duration::from_millis(1000));
        let client: Arc<dyn TerminalSession> = Arc::new(client);
        assert!(insert_if_registered(&mut state.sessions.lock().unwrap(), &state.registry, "g1", gen, client));
        gate.open();

        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "the exit did not find its session");
        assert!(state.sessions.lock().unwrap().is_empty());
        assert_eq!(state.registry.lock().unwrap().get("g1").unwrap().exited, Some(3));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_session_for_a_tile_closed_while_starting_is_refused() {
        let registry = Mutex::new(TerminalRegistry::new());
        let mut sessions: Sessions = HashMap::new();
        let session = dummy_session();
        assert!(!insert_if_registered(&mut sessions, &registry, "a", 1, session.clone()));
        assert!(sessions.is_empty());

        registry.lock().unwrap().add("a".into(), None, "/".into()).unwrap();
        assert!(insert_if_registered(&mut sessions, &registry, "a", 1, session.clone()));
        assert!(sessions.contains_key("a"));

        session.terminate();
    }
}

#[tauri::command]
pub async fn ssh_open_master(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::remote::open_master(&host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailscale_status() -> Result<crate::tailscale::TailscaleStatus, String> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::status)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailscale_open() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::open_app)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_pull(host: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::sync::pull(&host)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_push(host: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::sync::push(&host, &contents)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_stat() -> Result<Option<u64>, String> {
    tauri::async_runtime::spawn_blocking(crate::sync::stat_local).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agents_install_local() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(crate::agents::install_local).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agents_install_remote(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::agents::install_remote(&host)).await.map_err(|e| e.to_string())?
}

/// Installs or updates the swarmz tool on `host` when the architecture matches. True when the
/// remote tool speaks this protocol afterwards.
#[tauri::command]
pub async fn tool_remote_ready(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::toolbin::remote_ready(&host)).await.map_err(|e| e.to_string())?
}

/// The remote tool's `info` output for a tile on `host`.
#[tauri::command]
pub async fn remote_tile_info(host: String, id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || crate::toolbin::remote_info(&host, &id)).await.map_err(|e| e.to_string())?
}

/// Ends the tile's session holder on `host` (best effort; a tile that was never started there is
/// not an error). True when a session was running and has ended.
#[tauri::command]
pub async fn remote_tile_close(host: String, id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::toolbin::remote_close(&host, &id)).await.map_err(|e| e.to_string())?
}

const SESSION_PRUNE_AGE: Duration = Duration::from_secs(7 * 86_400);

/// Every session on this Mac; dead ones older than a week are removed first. When the workspace
/// cannot be read no session can be told to be outside it, so none is reported (fail closed).
#[tauri::command]
pub async fn local_sessions() -> Result<Vec<swarmz_tool::tiles::SessionRow>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = swarmz_tool::paths::home_dir();
        swarmz_tool::tiles::prune(&home, SESSION_PRUNE_AGE);
        swarmz_tool::tiles::session_rows(&home).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Sets, denies or clears the conductor through the tool (conductor spec §3, §6), which writes
/// the workspace, bumps its revision and tells the tiles concerned; the reply is the tool's
/// `{conductor, claim}`. The store adopts the file afterwards.
#[tauri::command]
pub async fn conductor_action(action: String, id: Option<String>, parent: Option<String>) -> Result<serde_json::Value, String> {
    let valid = |t: &Option<String>| t.as_deref().is_some_and(swarmz_tool::paths::valid_tile_id);
    let args: Vec<String> = match (action.as_str(), id) {
        ("set", Some(id)) if swarmz_tool::paths::valid_tile_id(&id) => vec!["conductor".into(), "--set".into(), id],
        ("set", _) => return Err("a valid tile id is needed".to_string()),
        // A sub-conductor under a parent (conductor tree spec §4).
        ("sub", Some(id)) if swarmz_tool::paths::valid_tile_id(&id) && valid(&parent) => vec!["conductor".into(), "--set".into(), id, "--parent".into(), parent.unwrap()],
        ("sub", _) => return Err("a valid tile and parent are needed".to_string()),
        // A tile under a conductor (`parent` is the conductor).
        ("assign", Some(id)) if swarmz_tool::paths::valid_tile_id(&id) && valid(&parent) => vec!["conductor".into(), "--assign".into(), id, "--to".into(), parent.unwrap()],
        ("assign", _) => return Err("a valid tile and conductor are needed".to_string()),
        ("remove", Some(id)) if swarmz_tool::paths::valid_tile_id(&id) => vec!["conductor".into(), "--remove".into(), id],
        ("remove", _) => return Err("a valid tile id is needed".to_string()),
        ("deny", _) => vec!["conductor".into(), "--deny".into()],
        ("clear", _) => vec!["conductor".into(), "--clear".into()],
        (other, _) => return Err(format!("unknown conductor action {other:?}")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        // Telling a claimant on another Mac goes over ssh, so allow for that.
        crate::toolbin::run_tool_json(&tool, &args, Duration::from_secs(20))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The arguments for answering a tile's permission dialog from the sidebar (sidebar redesign spec):
/// `swarmz [--on <machine>] answer <tile> yes|no`. None when an argument is not safe.
pub fn answer_args(tile: &str, choice: &str, machine: Option<&str>) -> Option<Vec<String>> {
    if !swarmz_tool::paths::valid_tile_id(tile) || !matches!(choice, "yes" | "no") {
        return None;
    }
    let mut args = Vec::new();
    if let Some(m) = machine {
        if m.is_empty() || m.len() > 63 || !m.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') || m.starts_with('-') {
            return None;
        }
        args.extend(["--on".to_string(), m.to_string()]);
    }
    args.extend(["answer".to_string(), tile.to_string(), choice.to_string()]);
    Some(args)
}

/// `--on <machine>` for a tile on another Mac, checked; nothing for this Mac. None when unsafe.
fn on_args(machine: Option<&str>) -> Option<Vec<String>> {
    match machine {
        None => Some(vec![]),
        Some(m) if !m.is_empty() && m.len() <= 63 && !m.starts_with('-') && m.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') => Some(vec!["--on".into(), m.into()]),
        Some(_) => None,
    }
}

/// A tile's board (tile board spec §2), read by the tool on the tile's Mac.
#[tauri::command]
pub async fn board_get(tile: String, machine: Option<String>) -> Result<serde_json::Value, String> {
    let mut args = on_args(machine.as_deref()).ok_or("not a machine swarmz knows")?;
    if !swarmz_tool::paths::valid_tile_id(&tile) {
        return Err("not a tile".into());
    }
    args.extend(["board".into(), "--tile".into(), tile, "--get".into()]);
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::toolbin::run_tool_json(&tool, &args, Duration::from_secs(15))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Types an answer from a board's Questions tab into the tile (`swarmz send`, which presses Enter
/// until Claude's input box takes it), on the tile's Mac.
#[tauri::command]
pub async fn tile_send(tile: String, text: String, machine: Option<String>) -> Result<serde_json::Value, String> {
    let mut args = on_args(machine.as_deref()).ok_or("not a machine swarmz knows")?;
    if !swarmz_tool::paths::valid_tile_id(&tile) {
        return Err("not a tile".into());
    }
    let text: String = text.chars().filter(|c| !c.is_control()).take(1000).collect();
    if text.trim().is_empty() {
        return Err("nothing to send".into());
    }
    args.extend(["send".into(), tile, "--".into(), text]);
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::toolbin::run_tool_json(&tool, &args, Duration::from_secs(20))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Allow or Deny on a tile's permission dialog, from the sidebar's Needs you card. The tool reads
/// the tile's screen and refuses when no permission dialog is showing, so a stale card answers
/// nothing.
#[tauri::command]
pub async fn tile_answer(tile: String, choice: String, machine: Option<String>) -> Result<serde_json::Value, String> {
    let args = answer_args(&tile, &choice, machine.as_deref()).ok_or_else(|| "not a tile, a choice or a machine swarmz knows".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::toolbin::run_tool_json(&tool, &args, Duration::from_secs(20))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The conductor's default folder, `~/.swarmz/conductor`, created with a `CLAUDE.md` that says
/// what it is for (conductor spec §6); returns its path.
#[tauri::command]
pub fn conductor_dir() -> Result<String, String> {
    let dir = swarmz_tool::paths::home_dir().join(".swarmz").join("conductor");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let claude_md = dir.join("CLAUDE.md");
    if !claude_md.exists() {
        std::fs::write(&claude_md, CONDUCTOR_CLAUDE_MD).map_err(|e| format!("could not write {}: {e}", claude_md.display()))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

const CONDUCTOR_CLAUDE_MD: &str = "# The conductor\n\nThis folder is the home of the swarmz conductor: the one Claude session allowed to act on the other tiles in the workspace, on every Mac. There is no code here to work on. The user asks the conductor what the other tiles are doing, hands work to them through it, and is reached by it on Telegram when away.\n\nWhat you may do and how is told to you at the start of every session (`~/.swarmz/bin/swarmz briefing` prints it again). Keep notes you want to survive between sessions in this folder.\n";

/// A Mac's numbers for the Machines view (activity bar and machines spec §4): `swarmz stats`
/// here, or on `host` over ssh with the sync's options. A tool too old to know `stats` is
/// `old_tool`.
#[tauri::command]
pub async fn machine_stats(host: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || match host {
        None => {
            let tool = crate::toolbin::ensure_installed()?;
            crate::toolbin::run_tool_json(&tool, &["stats"], Duration::from_secs(6))
        }
        Some(h) => {
            let done = crate::sync::run_remote(&h, "~/.swarmz/bin/swarmz stats", 6)?;
            if done.status.code() == Some(255) {
                return Err("not reachable".to_string());
            }
            let v: serde_json::Value = serde_json::from_str(done.stdout.trim()).map_err(|_| {
                let e = done.stderr.trim();
                if e.contains("No such file") || e.contains("not found") { "swarmz is not installed there".to_string() } else { format!("unreadable reply: {e}") }
            })?;
            if v["code"] == "usage" {
                return Err("old_tool".to_string());
            }
            if let Some(e) = v["error"].as_str() {
                return Err(e.to_string());
            }
            Ok(v)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One `tailscale ping` to `name` (spec §4): the round trip and whether it went direct; null when
/// it did not answer within two seconds.
#[tauri::command]
pub async fn tailscale_ping(name: String) -> Result<Option<swarmz_tool::tailscale::Ping>, String> {
    tauri::async_runtime::spawn_blocking(move || swarmz_tool::tailscale::ping(&name)).await.map_err(|e| e.to_string())?
}

/// A URL a pane showed, opened in the default browser (file viewing spec §2): `http`, `https`
/// or `file` only, through macOS `open`, so nothing else `open` understands can be reached.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    let ok = ["http://", "https://", "file://"].iter().any(|p| url.starts_with(p));
    if !ok || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("not a web or file URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let done = std::process::Command::new("/usr/bin/open").arg("--").arg(&url).output().map_err(|e| e.to_string())?;
        if done.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&done.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens `path` outside swarmz (file viewing spec §4): the default app, or Finder with
/// `reveal`. A remote file is copied here first (`~/.swarmz/remote/<host>/…`) and the copy is
/// what opens; the reply is the path that was opened.
#[tauri::command]
pub async fn open_path(host: Option<String>, path: String, reveal: bool) -> Result<String, String> {
    let path = path.trim().to_string();
    if !(path.starts_with('/') || path == "~" || path.starts_with("~/")) {
        return Err("the path must be absolute or start with ~".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let home = swarmz_tool::paths::home_dir();
        let local = match host {
            Some(h) => crate::files::fetch_remote(&h, &path, &home)?,
            None => crate::files::expand_home(&path, &home),
        };
        crate::files::open_local(&local, reveal)?;
        Ok(local.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether VS Code's `code` command is on this Mac (spec §4).
#[tauri::command]
pub fn code_available() -> bool {
    crate::files::code_binary().is_some()
}

/// Opens `path` in VS Code: here, or on `host` through VS Code's Remote SSH.
#[tauri::command]
pub async fn open_in_code(host: Option<String>, path: String, line: Option<u32>) -> Result<(), String> {
    let path = path.trim().to_string();
    if !(path.starts_with('/') || path == "~" || path.starts_with("~/")) {
        return Err("the path must be absolute or start with ~".into());
    }
    tauri::async_runtime::spawn_blocking(move || crate::files::open_in_code(host.as_deref(), &path, line, &swarmz_tool::paths::home_dir()))
        .await
        .map_err(|e| e.to_string())?
}

/// A file a tile talks about (file viewing spec §3): on `host` over the ssh master when given,
/// else on this Mac. `path` is absolute or `~`-relative; the frontend resolves relative ones.
#[tauri::command]
pub async fn read_file(host: Option<String>, path: String) -> Result<crate::files::FileView, String> {
    let path = path.trim().to_string();
    if path.is_empty() || path.contains('\0') {
        return Err("no path".into());
    }
    if !(path.starts_with('/') || path == "~" || path.starts_with("~/")) {
        return Err("the path must be absolute or start with ~".into());
    }
    tauri::async_runtime::spawn_blocking(move || match host {
        Some(h) => crate::files::read_remote(&h, &path),
        None => crate::files::read_local(&path, &swarmz_tool::paths::home_dir()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether Telegram is set up on this Mac, and with which chat (conductor spec §5).
#[tauri::command]
pub fn telegram_get() -> crate::telegram::TelegramInfo {
    crate::telegram::info_in(&swarmz_tool::paths::home_dir())
}

/// Writes `~/.swarmz/telegram.json` (mode 0600); both fields empty removes it, and an empty
/// token with a chat id keeps the token already set (the panel never shows it).
#[tauri::command]
pub fn telegram_set(token: String, chat_id: String) -> Result<crate::telegram::TelegramInfo, String> {
    let home = swarmz_tool::paths::home_dir();
    if token.trim().is_empty() && chat_id.trim().is_empty() {
        swarmz_tool::telegram::remove(&home)?;
    } else {
        let token = if token.trim().is_empty() { swarmz_tool::telegram::read(&home).map(|c| c.token).unwrap_or_default() } else { token };
        let cfg = crate::telegram::validate(&token, &chat_id)?;
        swarmz_tool::telegram::write(&home, &cfg)?;
    }
    Ok(crate::telegram::info_in(&home))
}

/// Makes `host`'s Telegram setup match this Mac's, over the shared ssh master; true when it changed.
#[tauri::command]
pub async fn telegram_push(host: String, remove: Option<bool>) -> Result<bool, String> {
    let remove = remove.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || crate::telegram::push(&host, remove)).await.map_err(|e| e.to_string())?
}

/// Sends a test message through the tool (`swarmz notify`), as the conductor would.
#[tauri::command]
pub async fn telegram_test() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        let machine = swarmz_tool::tailscale::status().ok().and_then(|s| s.self_machine.map(|m| m.name)).unwrap_or_else(|| "this Mac".to_string());
        let text = format!("Test message from swarmz on {machine}. The conductor can reach you here.");
        crate::toolbin::run_tool_json(&tool, &["notify", "--", &text], Duration::from_secs(30)).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts or stops the follower that types Telegram messages into the conductor (spec §5):
/// the store asks for it while the conductor is a running local tile and Telegram is set up.
#[tauri::command]
pub fn telegram_follow(state: State<AppState>, enabled: bool) -> Result<bool, String> {
    let mut slot = state.telegram.lock().unwrap();
    match (enabled, slot.is_some()) {
        (true, false) => {
            let tool = crate::toolbin::ensure_installed()?;
            *slot = Some(crate::telegram::Follower::start(tool));
            Ok(true)
        }
        (false, true) => {
            *slot = None;
            Ok(false)
        }
        (on, _) => Ok(on),
    }
}

/// Ends a session that no tile in this window shows.
#[tauri::command]
pub async fn close_session(app: AppHandle, id: String) -> Result<bool, String> {
    if !swarmz_tool::paths::valid_tile_id(&id) {
        return Err(format!("invalid session id {id:?}"));
    }
    if app.state::<AppState>().registry.lock().unwrap().get(&id).is_some() {
        return Err(format!("{id} is open in swarmz; close its tile instead"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        let v = crate::toolbin::run_tool_json(&tool, &["close", &id], Duration::from_secs(10))?;
        Ok(v["closed"].as_bool().unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn phones() -> Result<Vec<swarmz_tool::phone::PhoneKey>, String> {
    tauri::async_runtime::spawn_blocking(|| swarmz_tool::phone::list_keys(&swarmz_tool::phone::authorized_keys(&swarmz_tool::paths::home_dir())))
        .await
        .map_err(|e| e.to_string())
}

/// This Mac's name, login user and ssh host key fingerprints: the pairing QR code's contents
/// (`swarmz host-keys`). Nothing here is secret -- host keys are public -- so the code can be
/// shown on screen and photographed; the Mac's password is still needed to pair.
#[tauri::command]
pub async fn host_keys() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let tool = crate::toolbin::ensure_installed()?;
        crate::toolbin::run_tool_json(&tool, &["host-keys"], Duration::from_secs(10))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Removes a phone's key here and on every other Mac the tool can reach.
#[tauri::command]
pub async fn revoke_phone(device: String) -> Result<serde_json::Value, String> {
    if !swarmz_tool::phone::valid_device(&device) {
        return Err(format!("invalid device name {device:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::toolbin::ensure_installed()?;
        crate::toolbin::run_tool_json(&tool, &["phone", "revoke", &device], Duration::from_secs(120))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts tailing the agent log for `host` (None = this machine) and returns the generation of
/// the watcher now running for it, so the caller can tell a `agent:watch-ended` from that
/// watcher apart from one from a watcher it has already replaced. Already watching is a no-op
/// that returns the running watcher's generation.
#[tauri::command]
pub fn agents_watch(app: AppHandle, state: State<AppState>, host: Option<String>) -> Result<u64, String> {
    let mut watchers = state.watchers.lock().unwrap();
    if let Some((gen, _)) = watchers.get(&host) {
        return Ok(*gen);
    }
    let gen = state.next_gen.fetch_add(1, Ordering::SeqCst);
    let watcher = crate::agents::spawn_watcher(app, host.clone(), gen)?;
    watchers.insert(host, (gen, watcher));
    Ok(gen)
}

#[tauri::command]
pub fn agents_unwatch(state: State<AppState>, host: Option<String>) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&host);
    Ok(())
}

/// Pushes the local clipboard image to `host` as a PNG under `~/.swarmz/paste/` and returns the
/// absolute remote path, or None when the clipboard holds no image. Claude Code's own Ctrl+V
/// reads the clipboard of the machine it runs on, which for an ssh tile is the wrong Mac.
#[tauri::command]
pub async fn paste_image_to_remote(app: AppHandle, host: String) -> Result<Option<String>, String> {
    // The clipboard plugin warns against reading on the main thread, and the ssh round trip
    // must not block it either.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        // An error here is the ordinary "there is no image on the clipboard" answer as well as
        // a real failure; either way the caller falls back to Claude's own Ctrl+V.
        let Ok(image) = app.clipboard().read_image() else {
            return Ok(None);
        };
        let png = crate::paste::png_from_rgba(image.width(), image.height(), image.rgba())?;
        crate::paste::push_png(&host, &png).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
