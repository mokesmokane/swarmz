//! One function per subcommand (spec §4.1). `main.rs` parses arguments and prints.

use crate::client::HolderClient;
use crate::dialog::parse_dialog;
use crate::hold::{hold, CliError, HoldRequest};
use crate::newtile::{add_def, claude_line, empty_workspace, list_folders, session_started, startup_line, unique_name, workspace_file};
use crate::paths::{live_session, session_paths, sessions_dir_in, valid_tile_id};
use crate::proto::{Hello, PROTOCOL_VERSION};
use crate::screen::line_text;
use crate::server::TOOL_VIEWER;
use crate::agent::{fold_log, read_log, Fold};
use crate::tiles::{homed_defs, prune as prune_sessions, session_rows, tile_rows, try_tile_rows_with_folds, watch_events, TileRow};
use crate::util::{new_uuid, now_iso_ms, valid_abs_path};
use crate::workspace::{load_from, save_to, ClaudeConfig, TerminalDef, Workspace};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const WATCH_TICK: Duration = Duration::from_millis(1000);
const CWD_EVERY: Duration = Duration::from_secs(5);
pub const PING_EVERY: Duration = Duration::from_secs(25);
const PRUNE_AGE: Duration = Duration::from_secs(7 * 86_400);

pub struct Env {
    pub home: PathBuf,
    pub exe: PathBuf,
    pub machine: Option<String>,
}

fn failed(e: impl std::fmt::Display) -> CliError {
    CliError::new("failed", e.to_string())
}

impl Env {
    pub fn from_process() -> Result<Env, CliError> {
        let exe = std::env::current_exe().map_err(|e| failed(format!("cannot locate this program: {e}")))?;
        let machine = match std::env::var("SWARMZ_MACHINE") {
            Ok(m) => Some(m).filter(|m| !m.is_empty()),
            Err(_) => crate::util::self_machine(),
        };
        Ok(Env { home: crate::paths::home_dir(), exe, machine })
    }

    fn sessions(&self) -> PathBuf {
        sessions_dir_in(&self.home)
    }

    fn workspace(&self) -> Result<Option<Workspace>, CliError> {
        load_from(&workspace_file(&self.home)).map_err(failed)
    }

    /// Tailscale is only asked when the machine name was not given by the environment.
    fn uses_tailscale(&self) -> bool {
        std::env::var_os("SWARMZ_MACHINE").is_none()
    }
}

pub fn tile_arg(s: &str) -> Result<String, CliError> {
    if valid_tile_id(s) {
        Ok(s.to_string())
    } else {
        Err(CliError::new("invalid", format!("invalid tile id {s:?}")))
    }
}

/// A question-only connection to a running tile.
pub fn connect_tool(env: &Env, tile: &str) -> Result<HolderClient, CliError> {
    let paths = session_paths(&env.sessions(), tile).map_err(|e| CliError::new("invalid", e))?;
    if live_session(&paths).is_none() {
        return Err(CliError::new("not_running", format!("{tile} is not running")));
    }
    let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: TOOL_VIEWER.into() };
    HolderClient::connect(&paths.socket, &hello, |_, _| {}, |_| {}).map_err(failed)
}

pub fn screen_texts(client: &HolderClient, lines: usize) -> Option<Vec<String>> {
    client.screen(lines, Duration::from_secs(3)).map(|s| s.lines.iter().map(line_text).collect())
}

fn dialog_open(env: &Env, tile: &str) -> Option<bool> {
    let client = connect_tool(env, tile).ok()?;
    Some(parse_dialog(&screen_texts(&client, 200)?).is_some())
}

fn live_cwd(env: &Env, tile: &str) -> Option<String> {
    connect_tool(env, tile).ok()?.info(Duration::from_secs(2))?.cwd
}

fn rows(env: &Env) -> Vec<TileRow> {
    tile_rows(&env.home, env.machine.as_deref(), &|id| live_cwd(env, id), &|id| dialog_open(env, id))
}

pub fn row(env: &Env, tile: &str) -> Result<Value, CliError> {
    let row = rows(env).into_iter().find(|r| r.id == tile).ok_or_else(|| CliError::new("unknown", format!("{tile} is not a tile on this Mac")))?;
    Ok(json!({"v": 1, "tile": row}))
}

pub fn ls(env: &Env) -> Result<Value, CliError> {
    Ok(json!({"v": 1, "tiles": rows(env)}))
}

/// A file's `(length, modified time)`, or None when it cannot be read.
type Stamp = Option<(u64, SystemTime)>;

fn stamp(path: &Path) -> Stamp {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// The folded hook log, re-read only when `events.log.1` or `events.log` changes: the log can
/// reach a few MiB and `watch` looks every second.
#[derive(Default)]
struct LogCache {
    stamps: Option<(Stamp, Stamp)>,
    folds: HashMap<String, Fold>,
}

impl LogCache {
    fn folds(&mut self, home: &Path) -> &HashMap<String, Fold> {
        let dir = home.join(".swarmz").join("agents");
        let now = (stamp(&dir.join("events.log.1")), stamp(&dir.join("events.log")));
        if self.stamps != Some(now) {
            self.folds = fold_log(&read_log(home));
            self.stamps = Some(now);
        }
        &self.folds
    }
}

fn emit(out: &mut dyn Write, v: &Value) -> bool {
    writeln!(out, "{v}").and_then(|_| out.flush()).is_ok()
}

pub fn watch(env: &Env, out: &mut dyn Write) -> Result<(), CliError> {
    let cache: RefCell<HashMap<String, (Instant, Option<String>)>> = RefCell::new(HashMap::new());
    let cwd = |id: &str| {
        if let Some((at, v)) = cache.borrow().get(id) {
            if at.elapsed() < CWD_EVERY {
                return v.clone();
            }
        }
        let v = live_cwd(env, id);
        cache.borrow_mut().insert(id.to_string(), (Instant::now(), v.clone()));
        v
    };
    let mut prev: BTreeMap<String, TileRow> = BTreeMap::new();
    let mut first = true;
    let mut last_ping = Instant::now();
    let mut log = LogCache::default();
    loop {
        let folds = log.folds(&env.home);
        // An unreadable workspace keeps the rows we had rather than reporting every tile gone.
        let now = try_tile_rows_with_folds(&env.home, env.machine.as_deref(), folds, &cwd, &|id| dialog_open(env, id))
            .unwrap_or_else(|| prev.values().cloned().collect());
        let events = if first { vec![json!({"v": 1, "type": "snapshot", "tiles": now})] } else { watch_events(&prev, &now) };
        for e in &events {
            if !emit(out, e) {
                return Ok(());
            }
        }
        if last_ping.elapsed() >= PING_EVERY {
            if !emit(out, &json!({"v": 1, "type": "ping"})) {
                return Ok(());
            }
            last_ping = Instant::now();
        }
        prev = now.into_iter().map(|r| (r.id.clone(), r)).collect();
        first = false;
        std::thread::sleep(WATCH_TICK);
    }
}

pub fn machines(env: &Env) -> Result<Value, CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let configured = ws.extra.get("machines").and_then(|m| m.as_object()).cloned().unwrap_or_default();
    let status = if env.uses_tailscale() { crate::tailscale::status().ok() } else { None };
    let mut names: BTreeSet<String> = configured.keys().cloned().collect();
    if let Some(m) = &env.machine {
        names.insert(m.clone());
    }
    let mut list: Vec<Value> = names
        .into_iter()
        .map(|name| {
            let cfg = configured.get(&name);
            let text = |k: &str| cfg.and_then(|c| c.get(k)).and_then(|v| v.as_str()).map(str::to_string);
            let is_self = env.machine.as_deref() == Some(name.as_str());
            let online = if is_self {
                Some(true)
            } else {
                status.as_ref().and_then(|s| s.peers.iter().find(|p| p.name == name)).map(|p| p.online)
            };
            json!({"name": name, "alias": text("alias"), "color": text("color"), "online": online, "self": is_self})
        })
        .collect();
    // This Mac first, then by name.
    list.sort_by_key(|m| (!m["self"].as_bool().unwrap_or(false), m["name"].as_str().unwrap_or("").to_string()));
    Ok(json!({"v": 1, "machines": list}))
}

pub fn sessions(env: &Env) -> Result<Value, CliError> {
    Ok(json!({"v": 1, "sessions": session_rows(&env.home)}))
}

pub fn prune(env: &Env) -> Result<Value, CliError> {
    Ok(json!({"v": 1, "removed": prune_sessions(&env.home, PRUNE_AGE)}))
}

pub fn folders(env: &Env, path: Option<&str>) -> Result<Value, CliError> {
    let l = list_folders(path, &env.home).map_err(|e| CliError::new("invalid", e))?;
    Ok(json!({"v": 1, "path": l.path, "parent": l.parent, "dirs": l.dirs}))
}

fn check_folder(folder: &str) -> Result<(), CliError> {
    if !valid_abs_path(folder) {
        return Err(CliError::new("invalid", format!("{folder:?} is not an absolute folder path")));
    }
    if !Path::new(folder).is_dir() {
        return Err(CliError::new("cwd_missing", format!("{folder} does not exist")));
    }
    Ok(())
}

/// Best effort: ends a session this command started and could not finish setting up.
fn end_session(env: &Env, tile: &str) {
    if let Ok(client) = connect_tool(env, tile) {
        let _ = client.terminate();
    }
}

/// Holds the tile and types `line` into it. Returns false, typing nothing, when the session was
/// already running (another start got there first). A session this call started is ended again
/// if the line cannot be typed.
fn hold_and_type(env: &Env, tile: &str, name: &str, cwd: &str, line: Option<&str>) -> Result<bool, CliError> {
    let req = HoldRequest { tile: tile.to_string(), name: name.to_string(), cwd: cwd.to_string(), cols: 80, rows: 24, env: vec![], require_cwd: true };
    if hold(&env.exe, &env.sessions(), &req)?.existed {
        return Ok(false);
    }
    if let Some(line) = line {
        let typed = connect_tool(env, tile).and_then(|c| c.write(format!("{line}\r").as_bytes()).map_err(failed));
        if let Err(e) = typed {
            end_session(env, tile);
            return Err(e);
        }
    }
    Ok(true)
}

fn names(ws: &Workspace) -> Vec<String> {
    ws.terminals.iter().map(|t| t.name.clone()).collect()
}

pub fn new_tile(env: &Env, folder: &str, skip_permissions: bool, name: Option<&str>) -> Result<Value, CliError> {
    check_folder(folder)?;
    let machine = env.machine.clone().ok_or_else(|| CliError::new("no_machine", "this Mac's name is unknown (is Tailscale running?)"))?;
    let base = name.map(str::to_string).unwrap_or_else(|| Path::new(folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    // A tentative name for the session; the def takes a name checked against the file as it is
    // when the tile is recorded.
    let tentative = unique_name(&base, &names(&env.workspace()?.unwrap_or_else(empty_workspace)));
    let id = new_uuid();
    let claude = ClaudeConfig { enabled: true, session_id: new_uuid(), skip_permissions, started: false };
    // Held and typed before the workspace names the tile: an app that adopts it then finds the
    // session running and never types a second Claude line.
    if !hold_and_type(env, &id, &tentative, folder, Some(&claude_line(&claude)))? {
        return Err(failed(format!("a session for the new tile {id} was already running")));
    }
    // Reloaded just before saving, so changes made while the session started are kept.
    let recorded = env.workspace().and_then(|ws| {
        let mut ws = ws.unwrap_or_else(empty_workspace);
        let name = unique_name(&base, &names(&ws));
        let def = TerminalDef { id: id.clone(), name, cwd: folder.to_string(), ssh: None, claude: Some(claude), command: None, extra: Map::new() };
        add_def(&mut ws, def, &machine, &now_iso_ms());
        save_to(&workspace_file(&env.home), &ws).map_err(failed)
    });
    if let Err(e) = recorded {
        end_session(env, &id);
        return Err(e);
    }
    row(env, &id)
}

pub fn restart(env: &Env, tile: &str) -> Result<Value, CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let mut def = homed_defs(&ws, env.machine.as_deref())
        .into_iter()
        .find(|d| d.id == tile)
        .ok_or_else(|| CliError::new("unknown", format!("{tile} is not a tile on this Mac")))?;
    let paths = session_paths(&env.sessions(), tile).map_err(|e| CliError::new("invalid", e))?;
    if live_session(&paths).is_some() {
        return Err(CliError::new("running", format!("{} is already running", def.name)));
    }
    let started = session_started(&env.home, &def);
    if let Some(c) = def.claude.as_mut() {
        c.started = started;
    }
    if !hold_and_type(env, tile, &def.name, &def.cwd, startup_line(&def).as_deref())? {
        return Err(CliError::new("running", format!("{} is already running", def.name)));
    }
    row(env, tile)
}
