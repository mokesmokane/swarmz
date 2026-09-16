//! One function per subcommand (spec §4.1). `main.rs` parses arguments and prints.

use crate::client::HolderClient;
use crate::dialog::parse_dialog;
use crate::hold::{hold, CliError, HoldRequest};
use crate::newtile::{add_def, claude_line, empty_workspace, list_folders, session_started, startup_line, unique_name, workspace_file};
use crate::paths::{live_session, pid_alive, read_meta, session_paths, sessions_dir_in, valid_tile_id};
use crate::proto::{Hello, PROTOCOL_VERSION};
use crate::screen::line_text;
use crate::server::TOOL_VIEWER;
use crate::agent::{fold_log, read_log, Fold, Needs};
use crate::dialog::{resolve, Answer, Dialog};
use crate::input::{key_bytes, paste_bytes};
use crate::screen::diff_lines;
use crate::transcript::{after, guess_path, image as transcript_image, page, Change, Normaliser};
use crate::tiles::{homed_defs, prune as prune_sessions, session_rows, tile_rows, try_tile_rows_with_folds, watch_events, TileRow};
use crate::util::{new_uuid, now_iso_ms, valid_abs_path};
use crate::workspace::{load_from, save_to, ClaudeConfig, TerminalDef, Workspace};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const WATCH_TICK: Duration = Duration::from_millis(1000);
const CWD_EVERY: Duration = Duration::from_secs(5);
pub const PING_EVERY: Duration = Duration::from_secs(25);
const PRUNE_AGE: Duration = Duration::from_secs(7 * 86_400);
const OUTPUT_TICK: Duration = Duration::from_millis(300);
const TRANSCRIPT_TICK: Duration = Duration::from_millis(500);
const RESOLVE_EVERY: Duration = Duration::from_secs(2);

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
    let recorded = env.workspace().and_then(|ws| {
        let mut ws = ws.unwrap_or_else(empty_workspace);
        let name = unique_name(&base, &names(&ws));
        let def = TerminalDef { id: id.clone(), name, cwd: folder.to_string(), ssh: None, claude: Some(claude), command: None, extra: Map::new() };
        add_def(&mut ws, def, &machine, &now_iso_ms());
        save_to(&workspace_file(&env.home), &ws).map_err(failed)
    });
    if let Err(e) = recorded {
        end_session(env, &id, pid);
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
    if hold_and_type(env, tile, &def.name, &def.cwd, startup_line(&def).as_deref())?.is_none() {
        return Err(CliError::new("running", format!("{} is already running", def.name)));
    }
    row(env, tile)
}

pub fn send(env: &Env, tile: &str, text: &str) -> Result<Value, CliError> {
    let bytes = paste_bytes(text).map_err(|e| CliError::new("invalid", e))?;
    let c = connect_tool(env, tile)?;
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

fn fold_for(env: &Env, tile: &str) -> Fold {
    fold_log(&read_log(&env.home)).remove(tile).unwrap_or_default()
}

/// The dialog on screen with its tool and summary (the hook event's when it describes this
/// block, else what the screen shows).
fn current_question(env: &Env, c: &HolderClient, tile: &str) -> Result<Option<(Dialog, String, String)>, CliError> {
    let texts = screen_texts(c, 200).ok_or_else(|| failed("the session did not answer"))?;
    let Some(d) = parse_dialog(&texts) else { return Ok(None) };
    let fold = fold_for(env, tile);
    let from_hook = fold.needs == Some(Needs::Permission);
    let tool = fold.tool.filter(|_| from_hook).unwrap_or_else(|| d.heading.clone());
    let summary = fold.summary.filter(|_| from_hook).unwrap_or_else(|| d.summary());
    Ok(Some((d, tool, summary)))
}

pub fn pending(env: &Env, tile: &str) -> Result<Value, CliError> {
    let c = connect_tool(env, tile)?;
    Ok(match current_question(env, &c, tile)? {
        None => json!({"v": 1, "pending": null}),
        Some((d, tool, summary)) => json!({"v": 1, "pending": {"tool": tool, "summary": summary, "options": d.options}}),
    })
}

pub fn answer(env: &Env, tile: &str, choice: &str, expect_summary: Option<&str>) -> Result<Value, CliError> {
    let known = matches!(choice, "yes" | "always" | "no" | "deny") || (!choice.is_empty() && choice.chars().all(|c| c.is_ascii_digit()));
    if !known {
        return Err(CliError::new("usage", format!("unknown answer {choice:?}: use yes, always, no, deny or an option number")));
    }
    let c = connect_tool(env, tile)?;
    let Some((d, _, summary)) = current_question(env, &c, tile)? else {
        return Ok(json!({"v": 1, "ignored": true, "reason": "no question is showing"}));
    };
    if expect_summary.is_some_and(|s| s != summary) {
        return Ok(json!({"v": 1, "ignored": true, "reason": "a different question is showing"}));
    }
    let answer = resolve(choice, &d).map_err(|e| CliError::new("no_option", e))?;
    let (bytes, option) = match answer {
        Answer::Esc => (b"\x1b".to_vec(), Value::Null),
        Answer::Option(o) => (o.n.to_string().into_bytes(), json!(o)),
    };
    c.write(&bytes).map_err(failed)?;
    Ok(json!({"v": 1, "answered": true, "option": option}))
}

pub fn output(env: &Env, tile: &str, lines: usize, follow: bool, out: &mut dyn Write) -> Result<(), CliError> {
    let c = connect_tool(env, tile)?;
    let snap = c.screen(lines, Duration::from_secs(3)).ok_or_else(|| failed("the session did not answer"))?;
    let first = json!({"v": 1, "cols": snap.cols, "rows": snap.rows, "cursor": snap.cursor, "lines": snap.lines});
    if !emit(out, &first) || !follow {
        return Ok(());
    }
    let mut prev = snap.lines;
    let mut last_ping = Instant::now();
    loop {
        std::thread::sleep(OUTPUT_TICK);
        let Some(s) = c.screen(lines, Duration::from_secs(3)) else {
            emit(out, &json!({"v": 1, "type": "exit"}));
            return Ok(());
        };
        if let Some(u) = diff_lines(&prev, &s.lines) {
            let ev = json!({"v": 1, "type": "update", "drop": u.drop, "from": u.from, "lines": u.lines, "cursor": s.cursor});
            if !emit(out, &ev) {
                return Ok(());
            }
            prev = s.lines;
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
fn transcript_path(env: &Env, tile: &str) -> Result<(PathBuf, Option<String>), CliError> {
    let fold = fold_for(env, tile);
    if let Some(p) = fold.transcript_path.clone() {
        return Ok((PathBuf::from(p), fold.session_id));
    }
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let def = ws.terminals.iter().find(|d| d.id == tile);
    match def.and_then(|d| d.claude.as_ref().map(|c| (d, c))) {
        Some((d, c)) => {
            let sid = fold.session_id.clone().unwrap_or_else(|| c.session_id.clone());
            Ok((guess_path(&env.home, &d.cwd, &sid), Some(sid)))
        }
        None => Err(CliError::new("unknown", format!("no Claude session is known for {tile}"))),
    }
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
    let (mut path, _) = transcript_path(env, tile)?;
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
                    n = Normaliser::new();
                    offset = 0;
                    if !emit(out, &json!({"v": 1, "type": "session", "sessionId": s})) {
                        return Ok(());
                    }
                }
            }
        }
        if file_len(&path) < offset {
            // Rewritten in place: start over.
            n = Normaliser::new();
            offset = 0;
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
