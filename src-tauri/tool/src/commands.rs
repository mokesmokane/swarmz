//! One function per subcommand (spec §4.1). `main.rs` parses arguments and prints.

use crate::client::HolderClient;
use crate::hold::{detach, hold, CliError, HoldRequest};
use crate::newtile::{add_def, claude_line, empty_workspace, keep_def, kept_def_file, list_folders, session_started, startup_line, unique_name, workspace_file, KeptDef};
use crate::paths::{live_session, pid_alive, read_meta, session_paths, sessions_dir_in, valid_tile_id};
use crate::proto::{Hello, PROTOCOL_VERSION};
use crate::screen::line_text;
use crate::server::TOOL_VIEWER;
use crate::agent::{fold_log, read_log, Fold};
use crate::dialog::{live_dialog, resolve, Answer, Dialog};
use crate::gate::{check, split_words};
use crate::input::{key_bytes, send_bytes};
use crate::phone::{add_key, authorized_keys, list_keys, machine_hosts, revoke, valid_device};
use crate::proc::run_with_timeout;
use crate::screen::{diff_lines, LinesUpdate};
use crate::transcript::{after, guess_path, image as transcript_image, page, Change, Normaliser};
use crate::tiles::{apply_screen, homed_defs, prune as prune_sessions, session_rows, tile_rows, try_tile_rows_with_folds, watch_events, TileRow};
use crate::util::{new_uuid, now_iso_ms, sh_quote, valid_abs_path};
use crate::workspace::{load_from, read_from, save_to, ClaudeConfig, TerminalDef, Workspace};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

const WATCH_TICK: Duration = Duration::from_millis(1000);
const CWD_EVERY: Duration = Duration::from_secs(5);
pub const PING_EVERY: Duration = Duration::from_secs(25);
const PRUNE_AGE: Duration = Duration::from_secs(7 * 86_400);
const OUTPUT_TICK: Duration = Duration::from_millis(300);
const TRANSCRIPT_TICK: Duration = Duration::from_millis(500);
const RESOLVE_EVERY: Duration = Duration::from_secs(2);
/// Unanswered screen requests in a row after which `output --follow` gives up on a live session.
const OUTPUT_MISSES: u32 = 5;

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

    /// The workspace for reading: an invalid file is reported and left where it is.
    fn workspace(&self) -> Result<Option<Workspace>, CliError> {
        read_from(&workspace_file(&self.home)).map_err(failed)
    }

    /// The workspace for a command about to write it (an invalid file is moved aside first).
    fn workspace_to_write(&self) -> Result<Option<Workspace>, CliError> {
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
    connect_tool_with_exit(env, tile, false, |_| {})
}

/// `connect_tool` for a command that reads the screen: a holder that predates `Screen` (its
/// metadata has no `build`) is refused with `old_session` before anything is sent to it.
fn connect_screen(env: &Env, tile: &str) -> Result<HolderClient, CliError> {
    connect_tool_with_exit(env, tile, true, |_| {})
}

pub const OLD_SESSION: &str = "restart this tile to use it from the phone";

/// `connect_tool`, with `on_exit` called when the session ends or the connection drops.
fn connect_tool_with_exit(env: &Env, tile: &str, need_screen: bool, on_exit: impl FnOnce(Option<i32>) + Send + 'static) -> Result<HolderClient, CliError> {
    let paths = session_paths(&env.sessions(), tile).map_err(|e| CliError::new("invalid", e))?;
    let Some(meta) = live_session(&paths) else {
        return Err(CliError::new("not_running", format!("{tile} is not running")));
    };
    if need_screen && meta.build.is_none() {
        return Err(CliError::new("old_session", OLD_SESSION));
    }
    let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: TOOL_VIEWER.into() };
    HolderClient::connect(&paths.socket, &hello, |_, _| {}, on_exit).map_err(failed)
}

pub fn screen_texts(client: &HolderClient, lines: usize) -> Option<Vec<String>> {
    client.screen(lines, Duration::from_secs(3)).map(|s| s.lines.iter().map(line_text).collect())
}

/// The permission dialog on the session's visible screen now, if any; None when it did not
/// answer. Only the visible rows are asked for (the size the holder reported on connecting).
fn screen_dialog(client: &HolderClient) -> Option<Option<Dialog>> {
    let rows = client.welcome().rows as usize;
    let snap = client.screen(if rows == 0 { 200 } else { rows }, Duration::from_secs(3))?;
    let texts: Vec<String> = snap.lines.iter().map(line_text).collect();
    // A holder that predates `visibleStart`: the last `rows` lines are the screen.
    let start = snap.visible_start.unwrap_or_else(|| texts.len().saturating_sub(snap.rows as usize));
    Some(live_dialog(&texts, start))
}

/// The dialog a tile shows, for its row; None when it could not be asked.
fn dialog_for(env: &Env, tile: &str) -> Option<Option<Dialog>> {
    screen_dialog(&connect_tool(env, tile).ok()?)
}

fn live_cwd(env: &Env, tile: &str) -> Option<String> {
    connect_tool(env, tile).ok()?.info(Duration::from_secs(2))?.cwd
}

fn rows(env: &Env) -> Vec<TileRow> {
    tile_rows(&env.home, env.machine.as_deref(), &|id| live_cwd(env, id), &|id| dialog_for(env, id))
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
        let now = try_tile_rows_with_folds(&env.home, env.machine.as_deref(), folds, &cwd, &|id| dialog_for(env, id))
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

const KILL_GRACE: Duration = Duration::from_secs(2);

/// Best effort: ends a session this command started (its holder is `pid`) and could not finish
/// setting up. Asks the holder over its socket, or failing that signals the holder itself.
fn end_session(env: &Env, tile: &str, pid: u32) {
    if let Ok(client) = connect_tool(env, tile) {
        if client.terminate().is_ok() {
            return;
        }
    }
    if let Ok(paths) = session_paths(&env.sessions(), tile) {
        kill_holder(&paths.meta, pid);
    }
}

/// SIGTERM, then SIGKILL after `KILL_GRACE`, to `pid` -- each only while the session's metadata
/// still names that pid and it is alive, so a reused pid is never signalled.
fn kill_holder(meta: &Path, pid: u32) {
    let ours = || pid_alive(pid) && read_meta(meta).is_some_and(|m| m.pid == pid);
    if pid == 0 || pid > i32::MAX as u32 || !ours() {
        return;
    }
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if !ours() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if ours() {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
}

/// Holds the tile and types `line` into it. Returns the holder's pid when this call started the
/// session, or None, typing nothing, when it was already running (another start got there
/// first). A session this call started is ended again if the line cannot be typed.
fn hold_and_type(env: &Env, tile: &str, name: &str, cwd: &str, line: Option<&str>) -> Result<Option<u32>, CliError> {
    let req = HoldRequest { tile: tile.to_string(), name: name.to_string(), cwd: cwd.to_string(), cols: 80, rows: 24, env: vec![], require_cwd: true };
    let held = hold(&env.exe, &env.sessions(), &req)?;
    if held.existed {
        return Ok(None);
    }
    if let Some(line) = line {
        let typed = connect_tool(env, tile).and_then(|c| c.write(format!("{line}\r").as_bytes()).map_err(failed));
        if let Err(e) = typed {
            end_session(env, tile, held.pid);
            return Err(e);
        }
    }
    Ok(Some(held.pid))
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
    let Some(pid) = hold_and_type(env, &id, &tentative, folder, Some(&claude_line(&claude)))? else {
        return Err(failed(format!("a session for the new tile {id} was already running")));
    };
    // Reloaded just before saving, so changes made while the session started are kept.
    let recorded = env.workspace_to_write().and_then(|ws| {
        let mut ws = ws.unwrap_or_else(empty_workspace);
        let name = unique_name(&base, &names(&ws));
        let def = TerminalDef { id: id.clone(), name, cwd: folder.to_string(), ssh: None, claude: Some(claude), command: None, extra: Map::new() };
        add_def(&mut ws, def.clone(), &machine, &now_iso_ms());
        save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
        Ok(def)
    });
    let def = match recorded {
        Ok(def) => def,
        Err(e) => {
            end_session(env, &id, pid);
            return Err(e);
        }
    };
    // Best effort: the tile is recorded either way.
    let _ = start_keep_def(env, &KeptDef { machine, def });
    row(env, &id)
}

/// How long, and how often, a new tile's def is watched after `new` (spec §4.5).
const KEEP_DEF_FOR: Duration = Duration::from_secs(30);
const KEEP_DEF_EVERY: Duration = Duration::from_secs(1);

/// Hands the def to a detached `__keep-def` helper: an app that saves an older copy of the
/// workspace in the next moments would otherwise drop the tile `new` just recorded.
fn start_keep_def(env: &Env, kept: &KeptDef) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = kept_def_file(&env.sessions(), &kept.def.id);
    let text = serde_json::to_vec(kept).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&file);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)
        .and_then(|mut f| f.write_all(&text))
        .map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&env.exe);
    cmd.arg("__keep-def")
        .arg(&kept.def.id)
        .current_dir("/")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    detach(&mut cmd);
    match cmd.spawn() {
        Ok(mut child) => {
            // Reaped if it ends while we are still here; otherwise launchd adopts it.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&file);
            Err(e.to_string())
        }
    }
}

/// The `__keep-def <tile>` helper: reads (and, when done, removes) the def `new` left for it
/// and keeps it in the workspace while the session runs.
pub fn keep_def_main(home: &Path, tile: &str) -> Result<(), CliError> {
    struct Remove(PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let sessions = sessions_dir_in(home);
    let file = kept_def_file(&sessions, tile);
    let _remove = Remove(file.clone());
    let kept: KeptDef = std::fs::read(&file)
        .map_err(failed)
        .and_then(|b| serde_json::from_slice(&b).map_err(failed))?;
    if kept.def.id != tile {
        return Err(CliError::new("invalid", "the kept def is for another tile"));
    }
    let paths = session_paths(&sessions, tile).map_err(|e| CliError::new("invalid", e))?;
    keep_def(&workspace_file(home), &kept, KEEP_DEF_FOR, KEEP_DEF_EVERY, &|| live_session(&paths).is_some());
    Ok(())
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
    if hold_and_type(env, tile, &def.name, &def.cwd, startup_line(&def).as_deref())?.is_none() {
        return Err(CliError::new("running", format!("{} is already running", def.name)));
    }
    row(env, tile)
}

pub fn send(env: &Env, tile: &str, text: &str) -> Result<Value, CliError> {
    send_bytes(text, None).map_err(|e| CliError::new("invalid", e))?;
    let c = connect_tool(env, tile)?;
    // A paste only for a program that takes one: a shell without bracketed paste would type the
    // markers as text. A holder that cannot say gets the paste, as before.
    let mode = c.info(Duration::from_secs(3)).and_then(|i| i.bracketed_paste);
    let bytes = send_bytes(text, mode).map_err(|e| CliError::new("invalid", e))?;
    c.write(&bytes).map_err(failed)?;
    // Enter separately, so the paste has been taken in before the line is submitted.
    std::thread::sleep(Duration::from_millis(50));
    c.write(b"\r").map_err(failed)?;
    Ok(json!({"v": 1, "sent": true}))
}

pub fn key(env: &Env, tile: &str, name: &str) -> Result<Value, CliError> {
    let bytes = key_bytes(name).ok_or_else(|| CliError::new("usage", format!("unknown key {name:?}: use esc, ctrl-c, tab, shift-tab, up, down or enter")))?;
    connect_tool(env, tile)?.write(bytes).map_err(failed)?;
    Ok(json!({"v": 1, "sent": true}))
}

/// The tile's folded hook state; None when the log has no events for it.
fn fold_for(env: &Env, tile: &str) -> Option<Fold> {
    fold_log(&read_log(&env.home)).remove(tile)
}

struct Question {
    dialog: Dialog,
    tool: String,
    summary: String,
}

/// The dialog on the visible screen, with its summary (always the screen's) and tool (the hook
/// event's when it describes this same question, else the dialog's heading).
fn current_question(env: &Env, c: &HolderClient, tile: &str) -> Result<Option<Question>, CliError> {
    let d = screen_dialog(c).ok_or_else(|| failed("the session did not answer"))?;
    let Some(d) = d else { return Ok(None) };
    let mut fold = fold_for(env, tile).unwrap_or_default();
    apply_screen(&mut fold, Some(&d));
    let tool = fold.tool.unwrap_or_else(|| d.heading.clone());
    let summary = fold.summary.unwrap_or_else(|| d.summary());
    Ok(Some(Question { dialog: d, tool, summary }))
}

pub fn pending(env: &Env, tile: &str) -> Result<Value, CliError> {
    let c = connect_screen(env, tile)?;
    Ok(match current_question(env, &c, tile)? {
        None => json!({"v": 1, "pending": null}),
        Some(q) => json!({"v": 1, "pending": {"tool": q.tool, "summary": q.summary, "options": q.dialog.options}}),
    })
}

pub fn answer(env: &Env, tile: &str, choice: &str, expect_summary: Option<&str>) -> Result<Value, CliError> {
    let known = matches!(choice, "yes" | "always" | "no" | "deny") || (!choice.is_empty() && choice.chars().all(|c| c.is_ascii_digit()));
    if !known {
        return Err(CliError::new("usage", format!("unknown answer {choice:?}: use yes, always, no, deny or an option number")));
    }
    let c = connect_screen(env, tile)?;
    let Some(q) = current_question(env, &c, tile)? else {
        return Ok(json!({"v": 1, "ignored": true, "reason": "no question is showing"}));
    };
    if expect_summary.is_some_and(|s| s != q.summary) {
        return Ok(json!({"v": 1, "ignored": true, "reason": "a different question is showing"}));
    }
    let answer = resolve(choice, &q.dialog).map_err(|e| CliError::new("no_option", e))?;
    let (bytes, option) = match answer {
        Answer::Esc => (b"\x1b".to_vec(), Value::Null),
        Answer::Option(o) => (o.n.to_string().into_bytes(), json!(o)),
    };
    c.write(&bytes).map_err(failed)?;
    Ok(json!({"v": 1, "answered": true, "option": option}))
}

pub fn output(env: &Env, tile: &str, lines: usize, follow: bool, out: &mut dyn Write) -> Result<(), CliError> {
    let ended = Arc::new(AtomicBool::new(false));
    let on_exit = {
        let ended = ended.clone();
        move |_| ended.store(true, Ordering::SeqCst)
    };
    let c = connect_tool_with_exit(env, tile, true, on_exit)?;
    let snap = c.screen(lines, Duration::from_secs(3)).ok_or_else(|| failed("the session did not answer"))?;
    let first = json!({"v": 1, "cols": snap.cols, "rows": snap.rows, "cursor": snap.cursor, "lines": snap.lines});
    if !emit(out, &first) || !follow {
        return Ok(());
    }
    let mut prev = snap.lines;
    let mut prev_cursor = snap.cursor;
    let mut last_ping = Instant::now();
    let mut misses = 0;
    loop {
        std::thread::sleep(OUTPUT_TICK);
        if ended.load(Ordering::SeqCst) {
            emit(out, &json!({"v": 1, "type": "exit"}));
            return Ok(());
        }
        let Some(s) = c.screen(lines, Duration::from_secs(3)) else {
            // A slow answer from a live session skips this tick; `ended` says when it is over.
            misses += 1;
            if misses >= OUTPUT_MISSES && !ended.load(Ordering::SeqCst) {
                return Err(failed("the session stopped answering"));
            }
            continue;
        };
        misses = 0;
        // Only the cursor moved: an update that keeps every line and adds none.
        let update = diff_lines(&prev, &s.lines).or_else(|| (s.cursor != prev_cursor).then(|| LinesUpdate { drop: 0, from: prev.len(), lines: vec![] }));
        if let Some(u) = update {
            let ev = json!({"v": 1, "type": "update", "drop": u.drop, "from": u.from, "lines": u.lines, "cursor": s.cursor});
            if !emit(out, &ev) {
                return Ok(());
            }
            prev = s.lines;
            prev_cursor = s.cursor;
        }
        if last_ping.elapsed() >= PING_EVERY {
            if !emit(out, &json!({"v": 1, "type": "ping"})) {
                return Ok(());
            }
            last_ping = Instant::now();
        }
    }
}

/// The tile's current transcript: the hook's path, else where Claude would keep the session.
/// Only this Mac's own tiles are guessed: an ssh tile's or another Mac's transcript is not here.
fn transcript_path(env: &Env, tile: &str) -> Result<(PathBuf, Option<String>), CliError> {
    let fold = fold_for(env, tile).unwrap_or_default();
    if let Some(p) = fold.transcript_path.clone() {
        return Ok((PathBuf::from(p), fold.session_id));
    }
    let unknown = || CliError::new("unknown", format!("no Claude session is known for {tile}"));
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let def = homed_defs(&ws, env.machine.as_deref()).into_iter().find(|d| d.id == tile).ok_or_else(unknown)?;
    let c = def.claude.as_ref().ok_or_else(unknown)?;
    let sid = fold.session_id.clone().unwrap_or_else(|| c.session_id.clone());
    let path = guess_path(&env.home, &def.cwd, &sid).ok_or_else(unknown)?;
    Ok((path, Some(sid)))
}

/// Reads complete lines from `offset` on and feeds them to the normaliser. Returns the changes,
/// each message once, and the new offset (a partial last line is left for the next read).
fn read_new(path: &Path, offset: u64, n: &mut Normaliser) -> (Vec<Change>, u64) {
    let Ok(mut f) = std::fs::File::open(path) else { return (vec![], offset) };
    if f.seek(SeekFrom::Start(offset)).is_err() {
        return (vec![], offset);
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (vec![], offset);
    }
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return (vec![], offset) };
    let mut changes = Vec::new();
    for line in String::from_utf8_lossy(&buf[..end]).lines() {
        for ch in n.push_line(line) {
            // The view printed is always the latest, so a message new in this read is not also
            // printed as updated.
            let seen_new = matches!(ch, Change::Updated(i) if changes.contains(&Change::New(i)));
            if !seen_new && !changes.contains(&ch) {
                changes.push(ch);
            }
        }
    }
    (changes, offset + end as u64 + 1)
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn transcript(
    env: &Env,
    tile: &str,
    before: Option<&str>,
    after_id: Option<&str>,
    limit: usize,
    follow: bool,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    let (mut path, mut session) = transcript_path(env, tile)?;
    let mut n = Normaliser::new();
    let (_, mut offset) = read_new(&path, 0, &mut n);
    let views = n.views();
    let first = match after_id {
        Some(id) => json!({"v": 1, "messages": after(&views, id), "hasMore": false}),
        None => {
            let (p, more) = page(&views, before, limit);
            json!({"v": 1, "messages": p, "hasMore": more})
        }
    };
    if !emit(out, &first) || !follow {
        return Ok(());
    }
    let mut last_resolve = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        std::thread::sleep(TRANSCRIPT_TICK);
        if last_resolve.elapsed() >= RESOLVE_EVERY {
            last_resolve = Instant::now();
            if let Ok((p, s)) = transcript_path(env, tile) {
                if p != path {
                    path = p;
                    session = s;
                    n = Normaliser::new();
                    offset = 0;
                    if !emit(out, &json!({"v": 1, "type": "session", "sessionId": session})) {
                        return Ok(());
                    }
                }
            }
        }
        if file_len(&path) < offset {
            // Rewritten in place: start over, telling the reader to drop what it has.
            n = Normaliser::new();
            offset = 0;
            if !emit(out, &json!({"v": 1, "type": "session", "sessionId": session})) {
                return Ok(());
            }
        }
        let (changes, next) = read_new(&path, offset, &mut n);
        offset = next;
        for ch in changes {
            let (kind, i) = match ch {
                Change::New(i) => ("message", i),
                Change::Updated(i) => ("update", i),
            };
            if !emit(out, &json!({"v": 1, "type": kind, "message": n.view(i)})) {
                return Ok(());
            }
        }
        if last_ping.elapsed() >= PING_EVERY {
            if !emit(out, &json!({"v": 1, "type": "ping"})) {
                return Ok(());
            }
            last_ping = Instant::now();
        }
    }
}

pub fn image(env: &Env, tile: &str, image_id: &str) -> Result<Value, CliError> {
    let valid = !image_id.is_empty() && image_id.len() <= 100 && image_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        return Err(CliError::new("invalid", format!("invalid image id {image_id:?}")));
    }
    let (path, _) = transcript_path(env, tile)?;
    let (mime, data) = transcript_image(&path, image_id).ok_or_else(|| CliError::new("unknown", format!("no image {image_id}")))?;
    Ok(json!({"v": 1, "mime": mime, "base64": data}))
}

fn default_user() -> String {
    std::env::var("USER").unwrap_or_default()
}

/// The last non-blank line of `s`, trimmed; `s` itself, trimmed, when every line is blank.
fn last_line(s: &str) -> String {
    s.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or_else(|| s.trim()).to_string()
}

/// `s` cut to at most `n` characters (by character, not byte), so a hostile or runaway remote
/// message can never bloat a fan-out result.
fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

/// Runs `swarmz <args>` on every other Mac swarmz knows, over ssh without prompting, one thread
/// per machine so the total wait is about the single ssh call's 15 s limit rather than their sum.
/// Results are joined back in `machine_hosts`' order (sorted by machine name).
///
/// `Err` only when the set of other Macs itself could not be determined -- an unreadable or
/// corrupt workspace file. That must never be read as "there are no other Macs": a caller whose
/// local change already applied (e.g. a revoked key) has to say the other Macs could not be
/// reached, not report a clean, empty result. An individual machine being unreachable is not an
/// error here; it is reported per machine in the returned list instead.
fn fan_out(env: &Env, args: &[&str]) -> Result<Vec<Value>, String> {
    let ws = env.workspace().map_err(|e| e.message)?.unwrap_or_else(empty_workspace);
    let remote = std::iter::once("~/.swarmz/bin/swarmz".to_string()).chain(args.iter().map(|a| sh_quote(a))).collect::<Vec<_>>().join(" ");
    let hosts = machine_hosts(&ws, env.machine.as_deref(), &default_user());
    let handles: Vec<_> = hosts
        .into_iter()
        .map(|(machine, host)| {
            let remote = remote.clone();
            std::thread::spawn(move || {
                let mut c = std::process::Command::new("ssh");
                c.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ControlPath=~/.swarmz/ssh/%C", "-o", "ControlMaster=no", "--", &host, &remote]);
                match run_with_timeout(c, Duration::from_secs(15), "ssh") {
                    Ok(done) if done.status.success() => json!({"machine": machine, "ok": true}),
                    Ok(done) => {
                        let reply: Value = serde_json::from_str(done.stdout.trim()).unwrap_or(Value::Null);
                        let error = reply["error"].as_str().map(str::to_string).unwrap_or_else(|| last_line(&done.stderr));
                        json!({"machine": machine, "ok": false, "error": truncate_chars(&error, 200)})
                    }
                    Err(e) => json!({"machine": machine, "ok": false, "error": truncate_chars(&e, 200)}),
                }
            })
        })
        .collect();
    Ok(handles.into_iter().map(|h| h.join().unwrap_or_else(|_| json!({"ok": false, "error": "the ssh thread panicked"}))).collect())
}

pub fn phone_add(env: &Env, device: &str, key: &str, local: bool) -> Result<Value, CliError> {
    let added = add_key(&authorized_keys(&env.home), device, key).map_err(|e| CliError::new("invalid", e))?;
    let machines = if local {
        vec![]
    } else {
        fan_out(env, &["phone", "add", "--name", device, "--key", key, "--local"])
            .map_err(|e| CliError::new("failed", format!("added here; could not reach the other Macs: {e}")))?
    };
    Ok(json!({"v": 1, "added": added, "machines": machines}))
}

pub fn phone_ls(env: &Env) -> Result<Value, CliError> {
    Ok(json!({"v": 1, "phones": list_keys(&authorized_keys(&env.home))}))
}

pub fn phone_revoke(env: &Env, device: &str, local: bool) -> Result<Value, CliError> {
    if !valid_device(device) {
        return Err(CliError::new("invalid", format!("invalid device name {device:?}")));
    }
    let removed = revoke(&authorized_keys(&env.home), device).map_err(failed)?;
    let machines = if local {
        vec![]
    } else {
        fan_out(env, &["phone", "revoke", device, "--local"])
            .map_err(|e| CliError::new("failed", format!("revoked here; could not reach the other Macs: {e}")))?
    };
    Ok(json!({"v": 1, "removed": removed, "machines": machines}))
}

/// Replaces this process with the allowed tool command in `SSH_ORIGINAL_COMMAND`. Returns only
/// when the command is refused or cannot be run.
pub fn ssh_gate(env: &Env) -> CliError {
    let denied = |m: String| CliError::new("denied", m);
    let Ok(original) = std::env::var("SSH_ORIGINAL_COMMAND") else {
        return denied("this key only runs swarmz commands".into());
    };
    let words = match split_words(&original) {
        Ok(w) => w,
        Err(e) => return denied(e),
    };
    let mut tools = vec![env.home.join(".swarmz/bin/swarmz").to_string_lossy().into_owned(), env.exe.to_string_lossy().into_owned()];
    if let Ok(real) = std::fs::canonicalize(&env.exe) {
        tools.push(real.to_string_lossy().into_owned());
    }
    let args = match check(&words, &tools) {
        Ok(a) => a,
        Err(e) => return denied(e),
    };
    let err = std::process::Command::new(&env.exe).args(&args).exec();
    failed(format!("could not run swarmz: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{write_meta, Meta};
    use std::os::unix::process::ExitStatusExt;
    use std::process::Command;

    fn meta_for(dir: &Path, pid: u32) -> PathBuf {
        let path = dir.join("t.json");
        let meta = Meta { v: 1, pid, shell_pid: None, cwd: "/".into(), name: "t".into(), started_at: "s".into(), exited_at: None, exit_code: None, cwd_fallback: false, build: None };
        write_meta(&path, &meta).unwrap();
        path
    }

    #[test]
    fn screen_commands_refuse_a_holder_that_predates_screen() {
        let home = PathBuf::from(format!("/tmp/szc-{}-commands-old", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = sessions_dir_in(&home);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = session_paths(&dir, "old1").unwrap();
        // A live session (our own pid, a listening socket) whose metadata has no build. The
        // listener never answers, so a command that sent it anything would wait and fail.
        let _listener = std::os::unix::net::UnixListener::bind(&paths.socket).unwrap();
        let meta = Meta { v: 1, pid: std::process::id(), shell_pid: None, cwd: "/".into(), name: "old1".into(), started_at: "s".into(), exited_at: None, exit_code: None, cwd_fallback: false, build: None };
        write_meta(&paths.meta, &meta).unwrap();
        let env = Env { home: home.clone(), exe: PathBuf::from("/nonexistent"), machine: Some("mini".into()) };
        let started = Instant::now();
        let code = |r: Result<Value, CliError>| r.map_err(|e| (e.code, e.message)).unwrap_err();
        assert_eq!(code(pending(&env, "old1")), ("old_session", OLD_SESSION.to_string()));
        assert_eq!(code(answer(&env, "old1", "yes", None)).0, "old_session");
        let mut out = Vec::new();
        assert_eq!(output(&env, "old1", 20, false, &mut out).unwrap_err().code, "old_session");
        assert!(out.is_empty());
        assert!(started.elapsed() < Duration::from_secs(2), "a screen request was sent");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn kill_holder_signals_only_the_pid_the_metadata_names() {
        let dir = PathBuf::from(format!("/tmp/szc-{}-commands-kill", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id();

        // The metadata names another pid: nothing is signalled.
        let meta = meta_for(&dir, pid + 1);
        kill_holder(&meta, pid);
        std::thread::sleep(Duration::from_millis(200));
        assert!(child.try_wait().unwrap().is_none(), "a pid the metadata does not name was signalled");
        // No metadata at all: nothing is signalled either.
        std::fs::remove_file(&meta).unwrap();
        kill_holder(&meta, pid);
        assert!(child.try_wait().unwrap().is_none());

        let meta = meta_for(&dir, pid);
        kill_holder(&meta, pid);
        let status = child.wait().unwrap();
        assert_eq!(status.signal(), Some(libc::SIGTERM));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
