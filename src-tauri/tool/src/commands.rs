//! One function per subcommand (spec §4.1). `main.rs` parses arguments and prints.

use crate::client::HolderClient;
use crate::hold::{detach, hold, CliError, HoldRequest};
use crate::newtile::{bump_revision, add_def, claude_line, empty_workspace, keep_def, kept_def_file, list_folders, session_started, startup_line, unique_name, workspace_file, KeptDef};
use crate::paths::{live_session, pid_alive, read_meta, session_paths, sessions_dir_in, valid_tile_id};
use crate::proto::{Hello, PROTOCOL_VERSION};
use crate::screen::line_text;
use crate::server::TOOL_VIEWER;
use crate::agent::{fold_log, read_log, Fold};
use crate::dialog::{read_screen, resolve, Answer, Dialog, ScreenView};
use crate::gate::{check, split_words};
use crate::input::{key_bytes, send_bytes};
use crate::phone::{add_key, authorized_keys, list_keys, machine_hosts, revoke, valid_device};
use crate::proc::run_with_timeout;
use crate::screen::{diff_lines, LinesUpdate};
use crate::transcript::{after, guess_path, image as transcript_image, page, resolve_continued, Change, Normaliser};
use crate::tiles::{apply_screen, homed_defs, prune as prune_sessions, session_rows, stamp, tile_rows, try_tile_rows_with_folds, watch_events, LastTextCache, Stamp, TileRow};
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
use std::time::{Duration, Instant};

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

    /// The environment for `ssh-gate`, which only checks and execs a command: it never asks
    /// Tailscale for this Mac's name (the command it runs does, if it needs it).
    pub fn for_gate() -> Result<Env, CliError> {
        let exe = std::env::current_exe().map_err(|e| failed(format!("cannot locate this program: {e}")))?;
        Ok(Env { home: crate::paths::home_dir(), exe, machine: None })
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

/// `connect_tool` for a command that reads the screen: a holder whose metadata does not say it
/// answers `Screen` (older holders ignore the frame and would leave us waiting) is refused with
/// `old_session` before anything is sent to it.
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
    if need_screen && !meta.screen {
        return Err(CliError::new("old_session", OLD_SESSION));
    }
    let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: TOOL_VIEWER.into() };
    HolderClient::connect(&paths.socket, &hello, |_, _| {}, on_exit).map_err(failed)
}

pub fn screen_texts(client: &HolderClient, lines: usize) -> Option<Vec<String>> {
    client.screen(lines, Duration::from_secs(3)).map(|s| s.lines.iter().map(line_text).collect())
}

/// What the session's visible screen shows now; None when it did not answer. Only the visible
/// rows are asked for (the size the holder reported on connecting).
fn screen_view(client: &HolderClient) -> Option<ScreenView> {
    let rows = client.welcome().rows as usize;
    let snap = client.screen(if rows == 0 { 200 } else { rows }, Duration::from_secs(3))?;
    let texts: Vec<String> = snap.lines.iter().map(line_text).collect();
    // A holder that predates `visibleStart`: the last `rows` lines are the screen.
    let start = snap.visible_start.unwrap_or_else(|| texts.len().saturating_sub(snap.rows as usize));
    Some(read_screen(&texts, start))
}

/// What a tile's screen shows, for its row; None when it could not (or must not) be asked.
fn dialog_for(env: &Env, tile: &str) -> Option<ScreenView> {
    screen_view(&connect_screen(env, tile).ok()?)
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
    let mut v = json!({"v": 1, "tiles": rows(env)});
    merge_conductor(&mut v, &conductor_state(env));
    Ok(v)
}

/// The workspace's conductor and any pending claim, as `ls` and `watch` report them beside the
/// rows (conductor spec §7): `{"conductor": <id>|null, "claim": {...}|null}`.
fn conductor_state(env: &Env) -> Value {
    match env.workspace() {
        Ok(ws) => crate::conductor::state(&ws.unwrap_or_else(empty_workspace)),
        Err(_) => json!({"conductor": null, "claim": null}),
    }
}

fn merge_conductor(into: &mut Value, state: &Value) {
    into["conductor"] = state["conductor"].clone();
    into["conductors"] = state["conductors"].clone();
    into["claim"] = state["claim"].clone();
}

/// The folded hook log, re-read only when `events.log.1` or `events.log` changes: the log can
/// reach a few MiB and `watch` looks every second.
#[derive(Default)]
struct LogCache {
    stamps: Option<(Stamp, Stamp)>,
    folds: HashMap<String, Fold>,
    refolds: usize,
}

impl LogCache {
    fn folds(&mut self, home: &Path) -> &HashMap<String, Fold> {
        let dir = home.join(".swarmz").join("agents");
        let now = (stamp(&dir.join("events.log.1")), stamp(&dir.join("events.log")));
        if self.stamps != Some(now) {
            self.folds = fold_log(&read_log(home));
            self.stamps = Some(now);
            self.refolds += 1;
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
    let mut prev_conductor = Value::Null;
    let mut first = true;
    let mut last_ping = Instant::now();
    let mut log = LogCache::default();
    let texts = LastTextCache::default();
    loop {
        let folds = log.folds(&env.home);
        // An unreadable workspace keeps the rows we had rather than reporting every tile gone.
        let now = try_tile_rows_with_folds(&env.home, env.machine.as_deref(), folds, &cwd, &|id| dialog_for(env, id), &|p| texts.get(p), &|p| texts.resolve(p))
            .unwrap_or_else(|| prev.values().cloned().collect());
        let cstate = conductor_state(env);
        let mut events = if first {
            let mut snap = json!({"v": 1, "type": "snapshot", "tiles": now});
            merge_conductor(&mut snap, &cstate);
            vec![snap]
        } else {
            watch_events(&prev, &now)
        };
        // The conductor or a claim changed: one event, after the rows it may refer to.
        if !first && cstate != prev_conductor {
            let mut ev = json!({"v": 1, "type": "conductor"});
            merge_conductor(&mut ev, &cstate);
            events.push(ev);
        }
        prev_conductor = cstate;
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
    let status = if env.uses_tailscale() { crate::tailscale::status().ok() } else { None };
    Ok(json!({"v": 1, "machines": machine_list(&ws, env.machine.as_deref(), status.as_ref())}))
}

/// The workspace's machines, this Mac, and the other Macs online on the tailnet: this Mac first,
/// then by name.
pub fn machine_list(ws: &Workspace, self_machine: Option<&str>, status: Option<&crate::tailscale::TailscaleStatus>) -> Vec<Value> {
    let configured = ws.extra.get("machines").and_then(|m| m.as_object()).cloned().unwrap_or_default();
    let mut names: BTreeSet<String> = configured.keys().cloned().collect();
    names.extend(status.map(|s| s.online_macs()).unwrap_or_default());
    if let Some(m) = self_machine {
        names.insert(m.to_string());
    }
    let mut list: Vec<Value> = names
        .into_iter()
        .map(|name| {
            let cfg = configured.get(&name);
            let text = |k: &str| cfg.and_then(|c| c.get(k)).and_then(|v| v.as_str()).map(str::to_string);
            let is_self = self_machine == Some(name.as_str());
            let online = if is_self {
                Some(true)
            } else {
                status.and_then(|s| s.peers.iter().find(|p| p.name == name)).map(|p| p.online)
            };
            json!({"name": name, "alias": text("alias"), "color": text("color"), "online": online, "self": is_self})
        })
        .collect();
    list.sort_by_key(|m| (!m["self"].as_bool().unwrap_or(false), m["name"].as_str().unwrap_or("").to_string()));
    list
}

pub fn sessions(env: &Env) -> Result<Value, CliError> {
    Ok(json!({"v": 1, "sessions": session_rows(&env.home).map_err(failed)?}))
}

pub fn prune(env: &Env) -> Result<Value, CliError> {
    Ok(json!({
        "v": 1,
        "removed": prune_sessions(&env.home, PRUNE_AGE),
        "pasteRemoved": crate::upload::sweep_paste(&env.home, crate::upload::PASTE_AGE),
    }))
}

/// `upload` (phone attachments spec §3.1): exactly `size` bytes of stdin into `~/.swarmz/paste`
/// under a stamped, sanitised name; prints the absolute path. Sweeps old paste files afterwards.
pub fn upload(env: &Env, name: &str, size: u64) -> Result<Value, CliError> {
    let mut stdin = std::io::stdin().lock();
    let (path, n) = crate::upload::write_upload(&env.home, name, size, &mut stdin).map_err(|(code, msg)| CliError::new(code, msg))?;
    let _ = crate::upload::sweep_paste(&env.home, crate::upload::PASTE_AGE);
    Ok(json!({"v": 1, "path": path.to_string_lossy(), "size": n}))
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
        let revision = ws.extra.get("sync").and_then(|s| s.get("revision")).and_then(|r| r.as_u64()).unwrap_or(0);
        Ok((def, revision))
    });
    let (def, revision) = match recorded {
        Ok(recorded) => recorded,
        Err(e) => {
            end_session(env, &id, pid);
            return Err(e);
        }
    };
    // Best effort: the tile is recorded either way.
    let _ = start_keep_def(env, &KeptDef { machine, def, revision });
    row(env, &id)
}

/// `card` (conversation cards spec §3.1): read a tile's card, or set its title and/or recap as
/// its agent. Setting re-reads the workspace (a concurrent change is kept), merges the fields
/// (`card::merged`), bumps the sync revision and writes atomically.
pub fn card(env: &Env, tile: Option<&str>, title: Option<&str>, recap: Option<&str>, by_user: bool) -> Result<Value, CliError> {
    let tile = match tile {
        Some(t) => tile_arg(t)?,
        None => match std::env::var("SWARMZ_TERMINAL_ID") {
            Ok(t) if !t.is_empty() => tile_arg(&t)?,
            _ => return Err(CliError::new("usage", "usage: swarmz card [--tile <id>] [--title <text>] [--recap <text>]: no tile given and SWARMZ_TERMINAL_ID is not set")),
        },
    };
    let setting = title.is_some() || recap.is_some();
    let ws = if setting { env.workspace_to_write()? } else { env.workspace()? };
    let mut ws = ws.unwrap_or_else(empty_workspace);
    let Some(def) = ws.terminals.iter_mut().find(|d| d.id == tile) else {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    };
    let existing = crate::card::read(&def.extra);
    if !setting {
        return Ok(json!({"v": 1, "card": existing}));
    }
    let now = now_iso_ms();
    let next = if by_user {
        crate::card::with_user_title(existing.as_ref(), title.unwrap_or(""), &now)
    } else {
        crate::card::merged(existing.as_ref(), title, recap, &now)
    };
    if next == existing {
        return Ok(json!({"v": 1, "card": existing}));
    }
    match &next {
        Some(c) => {
            def.extra.insert("card".into(), c.clone());
        }
        None => {
            def.extra.remove("card");
        }
    }
    // Whose change it is, for the sync tiebreak: this Mac, else the tile's home, else the tool.
    let by = env.machine.clone().or_else(|| def.extra.get("origin").and_then(|o| o.as_str()).map(str::to_string)).unwrap_or_else(|| "swarmz".to_string());
    bump_revision(&mut ws, &by, &now);
    save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
    Ok(json!({"v": 1, "card": next}))
}

/// `swarmz conductor [--claim | --set <tile> | --clear | --deny]` (conductor spec §3). Reading
/// needs no tile; a claim is by the calling tile; set, clear and deny are the user's (the guard
/// in `main` keeps tiles from them) and tell the claimant the outcome as a prompt.
pub fn conductor(env: &Env, action: ConductorAction) -> Result<Value, CliError> {
    let now = now_iso_ms();
    let by = env.machine.clone().unwrap_or_else(|| "swarmz".to_string());
    match action {
        ConductorAction::Read => Ok(crate::conductor::state(&env.workspace()?.unwrap_or_else(empty_workspace))),
        ConductorAction::Claim(tile, sub) => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            let changed = crate::conductor::claim(&mut ws, &tile, sub, &by, &now)?;
            if changed {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
                // The user may be away: the claim goes to Telegram too, when it is set up (spec §3).
                if let Some(cfg) = crate::telegram::read(&env.home) {
                    let c = crate::conductor::claim_of(&ws).unwrap_or_default();
                    let top = crate::conductor::conductor_of(&ws);
                    let what = if c["sub"] == json!(true) {
                        format!("a conductor under {}", crate::conductor::title_of(&ws, c["parent"].as_str().unwrap_or_default()))
                    } else if let Some(t) = top.filter(|t| t != &tile) {
                        format!("the top conductor, replacing {}", crate::conductor::title_of(&ws, &t))
                    } else {
                        "the conductor".to_string()
                    };
                    let _ = crate::telegram::send_message(&cfg, &crate::telegram::claim_message(&crate::conductor::title_of(&ws, &tile), &what));
                }
            }
            let pending = crate::conductor::claim_of(&ws).is_some_and(|c| c["tile"].as_str() == Some(tile.as_str()));
            let already = !pending && crate::conductor::Tree::of(&ws).is_conductor(&tile);
            Ok(json!({"v": 1, "claimed": true, "pending": pending, "conductor": already}))
        }
        ConductorAction::Set(tile) => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            let claimant = crate::conductor::claim_of(&ws).and_then(|c| c["tile"].as_str().map(str::to_string));
            let changed = crate::conductor::set(&mut ws, &tile, &by, &now)?;
            if changed {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
                tell_role(env, &ws, &tile);
                if let Some(c) = claimant.filter(|c| c != &tile) {
                    tell(env, &c, crate::conductor::outcome_line(false));
                }
            }
            Ok(crate::conductor::state(&ws))
        }
        ConductorAction::SetSub { tile, parent } => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            let was_sub = crate::conductor::Tree::of(&ws).subs.contains_key(&tile);
            if crate::conductor::set_sub(&mut ws, &tile, &parent, &by, &now)? {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
                if !was_sub {
                    tell_role(env, &ws, &tile);
                }
            }
            Ok(crate::conductor::state(&ws))
        }
        ConductorAction::Assign { tile, to } => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            if crate::conductor::assign(&mut ws, &tile, &to, &by, &now)? {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
            }
            Ok(crate::conductor::state(&ws))
        }
        ConductorAction::Remove(tile) => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            if crate::conductor::remove_sub(&mut ws, &tile, &by, &now) {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
                tell(env, &tile, "[swarmz] you are no longer a conductor; your tiles answer to the conductor above you again");
            }
            Ok(crate::conductor::state(&ws))
        }
        ConductorAction::Deny => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            if let Some(c) = crate::conductor::deny(&mut ws, &by, &now) {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
                tell(env, &c, crate::conductor::outcome_line(false));
            }
            Ok(crate::conductor::state(&ws))
        }
        ConductorAction::Clear => {
            let mut ws = env.workspace_to_write()?.unwrap_or_else(empty_workspace);
            if crate::conductor::clear(&mut ws, &by, &now) {
                save_to(&workspace_file(&env.home), &ws).map_err(failed)?;
            }
            Ok(crate::conductor::state(&ws))
        }
    }
}

/// Tells `tile` what it has just become: the top conductor, or a sub-conductor for its folders.
fn tell_role(env: &Env, ws: &Workspace, tile: &str) {
    let tree = crate::conductor::Tree::of(ws);
    match tree.subs.get(tile) {
        Some(s) => tell(env, tile, &crate::conductor::sub_outcome_line(&crate::conductor::title_of(ws, &s.parent))),
        None => tell(env, tile, crate::conductor::outcome_line(true)),
    }
}

/// The workspace as the guard reads it (an unreadable one reads as empty: nobody is a conductor).
pub fn guard_workspace(env: &Env) -> Result<Workspace, CliError> {
    Ok(env.workspace()?.unwrap_or_else(empty_workspace))
}

/// A tile's title for prompts.
pub fn title_of(env: &Env, tile: &str) -> Result<String, CliError> {
    Ok(crate::conductor::title_of(&env.workspace()?.unwrap_or_else(empty_workspace), tile))
}

pub enum ConductorAction {
    Read,
    /// A tile asks for the top role, or (true) to be a sub-conductor under its conductor.
    Claim(String, bool),
    Set(String),
    SetSub { tile: String, parent: String },
    Assign { tile: String, to: String },
    Remove(String),
    Deny,
    Clear,
}

/// Types `line` into `tile` where it is: locally when it runs here, else over ssh to its home
/// Mac. Best effort: a tile that is not running, or a Mac that does not answer, is skipped.
fn tell(env: &Env, tile: &str, line: &str) {
    let _ = deliver(env, tile, line);
}

/// `send` to a tile wherever its home is. Errors when neither the local holder nor the home
/// Mac takes it.
fn deliver(env: &Env, tile: &str, line: &str) -> Result<(), CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let def = crate::conductor::def_of(&ws, tile).ok_or_else(|| CliError::new("unknown_tile", format!("no tile {tile} in the workspace")))?;
    let origin = def.extra.get("origin").and_then(|o| o.as_str()).map(str::to_string);
    let here = origin.is_none() || origin.as_deref() == env.machine.as_deref();
    if here {
        return send(env, tile, line).map(|_| ());
    }
    let machine = origin.unwrap();
    let host = crate::conductor::host_for(&ws, env.machine.as_deref(), &default_user(), &machine)
        .ok_or_else(|| CliError::new("failed", format!("no ssh host for {machine}")))?;
    let c = crate::conductor::remote_command(&host, &["send".into(), tile.into(), "--".into(), line.into()]);
    let done = run_with_timeout(c, Duration::from_secs(15), "ssh").map_err(failed)?;
    if done.status.success() {
        Ok(())
    } else {
        Err(failed(crate::util::last_non_blank(&done.stderr).unwrap_or_else(|| format!("ssh exited with {:?}", done.status.code()))))
    }
}

/// `ask <tile> -- <question>` (spec §2): the conductor's question, marked, typed into the tile.
pub fn ask(env: &Env, caller: &str, tile: &str, question: &str) -> Result<Value, CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let line = crate::conductor::ask_line(&crate::conductor::title_of(&ws, caller), question);
    deliver(env, tile, &line)?;
    Ok(json!({"v": 1, "asked": true}))
}

/// `reply -- <text>` (spec §2.1): the calling tile's answer, marked with its title, typed into
/// the conductor wherever it runs.
pub fn reply(env: &Env, caller: &str, text: &str) -> Result<Value, CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    // To the conductor this tile answers to (conductor tree spec §3): a sub-conductor's tiles
    // reply to it, and a sub-conductor replies to its parent.
    let tree = crate::conductor::Tree::of(&ws);
    let conductor = tree.owner(&ws, caller).ok_or_else(|| {
        CliError::new("denied", if tree.top.as_deref() == Some(caller) { "you are the top conductor: there is nobody above you to reply to; tell the user with `swarmz notify`" } else { "no conductor is set to reply to" })
    })?;
    let line = crate::conductor::reply_line(&crate::conductor::title_of(&ws, caller), text);
    deliver(env, &conductor, &line)?;
    Ok(json!({"v": 1, "replied": true}))
}

/// `notify [--tile <id>] -- <text>` (spec §5): a Telegram message to the user, the tile's title
/// in bold first when given. Only the conductor (or the user) may; `not_configured` without a
/// `~/.swarmz/telegram.json`.
pub fn notify(env: &Env, tile: Option<&str>, text: &str) -> Result<Value, CliError> {
    let cfg = crate::telegram::read(&env.home).ok_or_else(|| CliError::new("not_configured", "Telegram is not set up on this Mac (swarmz → Notifications)"))?;
    let title = match tile {
        Some(t) => Some(crate::conductor::title_of(&env.workspace()?.unwrap_or_else(empty_workspace), t)),
        None => None,
    };
    crate::telegram::send_message(&cfg, &crate::telegram::message_text(title.as_deref(), text))?;
    Ok(json!({"v": 1, "notified": true}))
}

/// `telegram-follow [--once]` (spec §5): the user's Telegram messages, typed into the conductor
/// as `[telegram] <text>`; `approve`/`deny` answer a pending claim instead. One JSON line per
/// message handled; `--once` polls a single time (tests). A poll that fails is retried after a
/// pause, since the desktop keeps this running while the conductor runs here.
pub fn telegram_follow(env: &Env, once: bool, out: &mut dyn Write) -> Result<(), CliError> {
    let cfg = crate::telegram::read(&env.home).ok_or_else(|| CliError::new("not_configured", "Telegram is not set up on this Mac"))?;
    let mut offset: i64 = 0;
    loop {
        let updates = match crate::telegram::get_updates(&cfg, offset, if once { 0 } else { 25 }) {
            Ok(u) => u,
            Err(e) if once => return Err(e),
            Err(e) => {
                let _ = emit(out, &json!({"v": 1, "type": "error", "error": e.message}));
                std::thread::sleep(Duration::from_secs(10));
                continue;
            }
        };
        for u in updates {
            if let Some(id) = u["update_id"].as_i64() {
                offset = offset.max(id + 1);
            }
            let Some(text) = crate::telegram::text_from_chat(&u, &cfg.chat_id) else { continue };
            let outcome = telegram_inbound(env, &cfg, &text);
            if !emit(out, &json!({"v": 1, "type": "message", "text": text, "outcome": outcome})) {
                return Ok(());
            }
        }
        if once {
            return Ok(());
        }
    }
}

/// One message from the user's chat: an answer to a pending claim, else a line for the
/// conductor. What was done, for the follow output. Telegram is told when nothing could be.
fn telegram_inbound(env: &Env, cfg: &crate::telegram::Config, text: &str) -> &'static str {
    let ws = env.workspace().ok().flatten().unwrap_or_else(empty_workspace);
    let claim = crate::conductor::claim_of(&ws);
    let word = text.trim().to_ascii_lowercase();
    if let Some(c) = claim.filter(|_| word == "approve" || word == "deny") {
        let tile = c["tile"].as_str().unwrap_or_default().to_string();
        let title = crate::conductor::title_of(&ws, &tile);
        let action = if word == "approve" { ConductorAction::Set(tile) } else { ConductorAction::Deny };
        return match conductor(env, action) {
            Ok(_) if word == "approve" => {
                let _ = crate::telegram::send_message(cfg, &format!("🎛 <b>{}</b> is the conductor now.", crate::telegram::escape_html(&title)));
                "approved"
            }
            Ok(_) => {
                let _ = crate::telegram::send_message(cfg, &format!("The claim by <b>{}</b> was denied.", crate::telegram::escape_html(&title)));
                "denied"
            }
            Err(e) => {
                let _ = crate::telegram::send_message(cfg, &format!("Could not answer the claim: {}", crate::telegram::escape_html(&e.message)));
                "failed"
            }
        };
    }
    let Some(conductor) = crate::conductor::conductor_of(&ws) else {
        let _ = crate::telegram::send_message(cfg, "No conductor is set, so there is nobody to tell. Make a tile the conductor in swarmz first.");
        return "no_conductor";
    };
    match deliver(env, &conductor, &format!("[telegram] {}", text.trim())) {
        Ok(()) => "delivered",
        Err(e) => {
            let _ = crate::telegram::send_message(cfg, &format!("Could not reach the conductor: {}", crate::telegram::escape_html(&e.message)));
            "failed"
        }
    }
}

/// `fleet [--follow]` (spec §2): every tile on every reachable Mac. `--follow` polls and prints
/// a row whenever it changes, and a `ping` every 25 s.
/// Keeps the rows a sub-conductor may see (tree spec §3): itself and every tile below it. The
/// top, the desktop and the phone see everything.
fn fleet_filter(env: &Env, caller: Option<&str>, mut snap: Value) -> Value {
    let Some(caller) = caller else { return snap };
    let ws = env.workspace().ok().flatten().unwrap_or_else(empty_workspace);
    let tree = crate::conductor::Tree::of(&ws);
    if !tree.subs.contains_key(caller) {
        return snap;
    }
    if let Some(rows) = snap["tiles"].as_array_mut() {
        rows.retain(|r| r["id"].as_str().is_some_and(|id| id == caller || tree.ancestors(&ws, id).iter().any(|a| a == caller)));
    }
    snap
}

pub fn fleet(env: &Env, follow: bool, out: &mut dyn Write) -> Result<(), CliError> {
    let caller = crate::conductor::caller_tile();
    let hosts = || -> Vec<(String, String)> {
        let ws = env.workspace().ok().flatten().unwrap_or_else(empty_workspace);
        let peers = if env.uses_tailscale() { crate::tailscale::status().map(|s| s.online_macs()).unwrap_or_default() } else { vec![] };
        machine_hosts(&ws, env.machine.as_deref(), &default_user(), &peers)
    };
    let snapshot = |hosts: &[(String, String)]| -> Value {
        let local = ls(env).ok().and_then(|v| v["tiles"].as_array().cloned()).unwrap_or_default();
        fleet_filter(env, caller.as_deref(), crate::conductor::fleet(local, hosts, Duration::from_secs(8)))
    };
    if !follow {
        writeln!(out, "{}", snapshot(&hosts())).map_err(failed)?;
        return Ok(());
    }
    let mut prev: BTreeMap<String, Value> = BTreeMap::new();
    let mut last_ping = Instant::now();
    let mut first = true;
    loop {
        let snap = snapshot(&hosts());
        let rows: BTreeMap<String, Value> = snap["tiles"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| {
                let id = r["id"].as_str()?.to_string();
                Some((id, r))
            })
            .collect();
        if first {
            writeln!(out, "{}", json!({"v": 1, "type": "snapshot", "tiles": snap["tiles"], "machines": snap["machines"]})).map_err(failed)?;
            first = false;
        } else {
            for (id, row) in &rows {
                if prev.get(id) != Some(row) {
                    writeln!(out, "{}", json!({"v": 1, "type": "tile", "tile": row})).map_err(failed)?;
                }
            }
            for id in prev.keys() {
                if !rows.contains_key(id) {
                    writeln!(out, "{}", json!({"v": 1, "type": "gone", "id": id})).map_err(failed)?;
                }
            }
        }
        prev = rows;
        if last_ping.elapsed() >= Duration::from_secs(25) {
            writeln!(out, "{}", json!({"v": 1, "type": "ping"})).map_err(failed)?;
            last_ping = Instant::now();
        }
        out.flush().map_err(failed)?;
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// `briefing` (spec §4): what the `SessionStart` hook returns for the calling tile.
pub fn briefing(env: &Env, tile: Option<&str>, name: &str) -> Result<String, CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    let tree = crate::conductor::Tree::of(&ws);
    let title = |id: &str| crate::conductor::title_of(&ws, id);
    let role = match tile {
        Some(t) if tree.top.as_deref() == Some(t) => crate::briefing::Role::Top {
            subs: tree.subs.iter().filter(|(_, s)| s.parent == t).map(|(id, _)| (title(id), id.clone())).collect(),
        },
        Some(t) => match tree.subs.get(t) {
            Some(s) => crate::briefing::Role::Sub {
                parent: title(&s.parent),
                subs: tree.subs.iter().filter(|(_, c)| c.parent == t).map(|(id, _)| (title(id), id.clone())).collect(),
            },
            None => crate::briefing::Role::Tile,
        },
        None => crate::briefing::Role::Tile,
    };
    Ok(crate::briefing::briefing_for(&env.home, name, &role))
}

/// The other Macs as ssh destinations, for `--on` (spec §2).
pub fn host_for(env: &Env, machine: &str) -> Result<String, CliError> {
    let ws = env.workspace()?.unwrap_or_else(empty_workspace);
    crate::conductor::host_for(&ws, env.machine.as_deref(), &default_user(), machine)
        .ok_or_else(|| CliError::new("invalid", format!("no ssh host for {machine}: not a known machine, or no valid username")))
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
    // A session being ended (the app closing its tile) counts as over.
    let live = || live_session(&paths).is_some_and(|m| m.terminating_at.is_none());
    keep_def(&workspace_file(home), &kept, KEEP_DEF_FOR, KEEP_DEF_EVERY, &live);
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
    // Claude Code can still take that Enter as part of the paste (a newline in the box); when
    // the screen shows the text still in the box, press Enter again, a few times with growing
    // pauses. A holder without a screen, or a program without a box, ends this at once.
    let mut resent = 0;
    let mut in_box = None;
    for pause in [200u64, 500, 1000, 1500] {
        std::thread::sleep(Duration::from_millis(pause));
        in_box = text_still_in_box(&c, text);
        if in_box != Some(true) || resent == 3 {
            break;
        }
        c.write(b"\r").map_err(failed)?;
        resent += 1;
    }
    // `submitted` is the screen's word: false means the text is still in the box after every
    // Enter, for the sender to act on; absent when the holder has no screen to ask.
    let mut reply = json!({"v": 1, "sent": true, "resent": resent});
    if let Some(still) = in_box {
        reply["submitted"] = json!(!still);
    }
    Ok(reply)
}

/// Whether the tile's visible screen still shows `text` in Claude's input box (`still_in_box`);
/// None when the holder answers no screen.
fn text_still_in_box(c: &HolderClient, text: &str) -> Option<bool> {
    let rows = c.welcome().rows as usize;
    let snap = c.screen(if rows == 0 { 200 } else { rows }, Duration::from_secs(2))?;
    let texts: Vec<String> = snap.lines.iter().map(line_text).collect();
    let start = snap.visible_start.unwrap_or_else(|| texts.len().saturating_sub(snap.rows as usize));
    Some(crate::input::still_in_box(&texts[start.min(texts.len())..], text))
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
    let view = screen_view(c).ok_or_else(|| failed("the session did not answer"))?;
    let Some(d) = view.dialog.clone() else { return Ok(None) };
    let mut fold = fold_for(env, tile).unwrap_or_default();
    apply_screen(&mut fold, &view);
    let tool = fold.tool.unwrap_or_else(|| d.heading.clone());
    let summary = fold.summary.unwrap_or_else(|| d.summary());
    Ok(Some(Question { dialog: d, tool, summary }))
}

pub fn pending(env: &Env, tile: &str) -> Result<Value, CliError> {
    let c = connect_screen(env, tile)?;
    Ok(match current_question(env, &c, tile)? {
        None => json!({"v": 1, "pending": null}),
        Some(q) => json!({
            "v": 1,
            "pending": {
                "kind": q.dialog.kind,
                "tool": q.tool,
                "summary": q.summary,
                "options": q.dialog.options,
                "multi": q.dialog.multi,
                "submit": q.dialog.submit_at.is_some(),
            },
        }),
    })
}

pub fn answer(env: &Env, tile: &str, choice: &str, expect_summary: Option<&str>) -> Result<Value, CliError> {
    let known = matches!(choice, "yes" | "always" | "no" | "deny" | "submit") || (!choice.is_empty() && choice.chars().all(|c| c.is_ascii_digit()));
    if !known {
        return Err(CliError::new("usage", format!("unknown answer {choice:?}: use yes, always, no, deny, submit or an option number")));
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
        Answer::Submit { downs } => {
            // Each ↓ is its own write so the dialog moves one entry at a time before Enter lands.
            for _ in 0..downs {
                c.write(b"\x1b[B").map_err(failed)?;
                std::thread::sleep(Duration::from_millis(30));
            }
            (b"\r".to_vec(), Value::Null)
        }
    };
    c.write(&bytes).map_err(failed)?;
    // A digit on a multi-select question ticks its box rather than answering; the dialog stays.
    let toggled = q.dialog.multi && matches!(option, Value::Object(_));
    Ok(json!({"v": 1, "answered": true, "option": option, "toggled": toggled}))
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
    transcript_path_from(env, tile, fold_for(env, tile).unwrap_or_default())
}

/// `transcript_path` with the tile's fold supplied (a follower keeps the log folded). Either path
/// is followed through Claude's `continued-in` records, and the session id is then the new file's.
fn transcript_path_from(env: &Env, tile: &str, fold: Fold) -> Result<(PathBuf, Option<String>), CliError> {
    let (path, session) = known_transcript_path(env, tile, fold)?;
    let (path, moved) = resolve_continued(&path);
    Ok((path, moved.or(session)))
}

fn known_transcript_path(env: &Env, tile: &str, fold: Fold) -> Result<(PathBuf, Option<String>), CliError> {
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
        Some(id) => match after(&views, id) {
            Some(msgs) => json!({"v": 1, "messages": msgs, "hasMore": false}),
            // Not in this transcript (another session, or rewritten): the newest page, replacing
            // whatever the reader has.
            None => {
                let (p, more) = page(&views, None, limit);
                json!({"v": 1, "messages": p, "hasMore": more, "reset": true})
            }
        },
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
    let mut log = LogCache::default();
    loop {
        std::thread::sleep(TRANSCRIPT_TICK);
        if last_resolve.elapsed() >= RESOLVE_EVERY {
            last_resolve = Instant::now();
            let fold = log.folds(&env.home).get(tile).cloned().unwrap_or_default();
            if let Ok((p, s)) = transcript_path_from(env, tile, fold) {
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
/// The other Macs are the workspace's machines plus the Macs online on the tailnet.
/// Results are joined back in `machine_hosts`' order (sorted by machine name).
///
/// `Err` only when the set of other Macs itself could not be determined -- an unreadable or
/// corrupt workspace file. That must never be read as "there are no other Macs": a caller whose
/// local change already applied (e.g. a revoked key) has to say the other Macs could not be
/// reached, not report a clean, empty result. An individual machine being unreachable is not an
/// error here; it is reported per machine in the returned list instead.
fn fan_out(env: &Env, args: &[&str]) -> Result<Vec<Value>, String> {
    let ws = env.workspace().map_err(|e| e.message)?.unwrap_or_else(empty_workspace);
    let remote = std::iter::once(TOOL_WORD.to_string()).chain(args.iter().map(|a| sh_quote(a))).collect::<Vec<_>>().join(" ");
    let peers = if env.uses_tailscale() { crate::tailscale::status().map(|s| s.online_macs()).unwrap_or_default() } else { vec![] };
    let hosts = machine_hosts(&ws, env.machine.as_deref(), &default_user(), &peers);
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

/// This Mac's name, login user and ssh host key fingerprints: everything the pairing QR code
/// carries (spec §7.2). It holds no secret -- host keys are public and world-readable -- so a
/// photograph of the code gives nobody access; the password is still needed.
///
/// Deliberately out of the ssh gate's allow list: the phone reads the code with its camera and
/// never runs this.
pub fn host_keys(env: &Env) -> Result<Value, CliError> {
    let host = env
        .machine
        .clone()
        .ok_or_else(|| CliError::new("failed", "this Mac's Tailscale name is not known; is Tailscale running?"))?;
    let user = std::env::var("USER")
        .ok()
        .filter(|u| crate::phone::valid_ssh_user(u))
        .ok_or_else(|| CliError::new("failed", "cannot tell which user is logged in ($USER)"))?;
    // No host keys (Remote Login never switched on, say) is not an error: the code still saves
    // the typing, and the phone falls back to trusting the first key it is offered.
    let fingerprints = crate::hostkeys::fingerprints_in(&crate::hostkeys::host_key_dir());
    Ok(json!({"v": 1, "host": host, "user": user, "fingerprints": fingerprints}))
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

/// How other Macs' tools are named on an ssh command line.
const TOOL_WORD: &str = "~/.swarmz/bin/swarmz";

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
    // `~/.swarmz/bin/swarmz` as a literal word too: it is what `fan_out` sends, and a forced
    // command's words are never expanded.
    let mut tools = vec![
        TOOL_WORD.to_string(),
        env.home.join(".swarmz/bin/swarmz").to_string_lossy().into_owned(),
        env.exe.to_string_lossy().into_owned(),
    ];
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
        let meta = Meta { v: 1, pid, shell_pid: None, cwd: "/".into(), name: "t".into(), started_at: "s".into(), exited_at: None, exit_code: None, cwd_fallback: false, build: None, screen: false, terminating_at: None };
        write_meta(&path, &meta).unwrap();
        path
    }

    #[test]
    fn the_log_is_folded_again_only_when_it_changes() {
        let home = PathBuf::from(format!("/tmp/szc-{}-commands-logcache", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = home.join(".swarmz/agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("events.log"), "1\tt1\tSessionStart\t{\"session_id\":\"a\"}\n").unwrap();
        let mut log = LogCache::default();
        assert_eq!(log.folds(&home)["t1"].session_id.as_deref(), Some("a"));
        log.folds(&home);
        log.folds(&home);
        assert_eq!(log.refolds, 1);
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("events.log")).unwrap();
        writeln!(f, "2\tt1\tSessionStart\t{{\"session_id\":\"b\"}}").unwrap();
        assert_eq!(log.folds(&home)["t1"].session_id.as_deref(), Some("b"));
        assert_eq!(log.refolds, 2);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn machines_include_online_macs_on_the_tailnet() {
        let ws: Workspace = serde_json::from_value(json!({"version": 1, "terminals": [], "layout": null, "machines": {"studio": {"alias": "Studio"}}})).unwrap();
        let status = crate::tailscale::parse_status(
            r#"{"BackendState": "Running", "Self": {"DNSName": "mini.ts.net.", "OS": "macOS", "Online": true},
               "Peer": {"a": {"DNSName": "air.ts.net.", "OS": "macOS", "Online": true},
                        "b": {"DNSName": "old.ts.net.", "OS": "macOS", "Online": false},
                        "c": {"DNSName": "pi.ts.net.", "OS": "linux", "Online": true},
                        "d": {"DNSName": "studio.ts.net.", "OS": "macOS", "Online": false}}}"#,
            "me",
        )
        .unwrap();
        let list = machine_list(&ws, Some("mini"), Some(&status));
        let rows: Vec<(String, Value, bool)> = list.iter().map(|m| (m["name"].as_str().unwrap().to_string(), m["online"].clone(), m["self"].as_bool().unwrap())).collect();
        assert_eq!(rows, vec![("mini".into(), json!(true), true), ("air".into(), json!(true), false), ("studio".into(), json!(false), false)]);
        // Without Tailscale: the workspace and this Mac only.
        let names: Vec<String> = machine_list(&ws, Some("mini"), None).iter().map(|m| m["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["mini", "studio"]);
    }

    #[test]
    fn screen_commands_refuse_a_holder_that_predates_screen() {
        let home = PathBuf::from(format!("/tmp/szc-{}-commands-old", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = sessions_dir_in(&home);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = session_paths(&dir, "old1").unwrap();
        // A live session (our own pid, a listening socket) whose metadata has a build but no
        // screen capability, as holders from before it write. The listener never answers, so a
        // command that sent it anything would wait and fail.
        let _listener = std::os::unix::net::UnixListener::bind(&paths.socket).unwrap();
        let meta = Meta { v: 1, pid: std::process::id(), shell_pid: None, cwd: "/".into(), name: "old1".into(), started_at: "s".into(), exited_at: None, exit_code: None, cwd_fallback: false, build: Some(1_789_000_000), screen: false, terminating_at: None };
        write_meta(&paths.meta, &meta).unwrap();
        let env = Env { home: home.clone(), exe: PathBuf::from("/nonexistent"), machine: Some("mini".into()) };
        let started = Instant::now();
        let code = |r: Result<Value, CliError>| r.map_err(|e| (e.code, e.message)).unwrap_err();
        assert_eq!(code(pending(&env, "old1")), ("old_session", OLD_SESSION.to_string()));
        assert_eq!(code(answer(&env, "old1", "yes", None)).0, "old_session");
        let mut out = Vec::new();
        assert_eq!(output(&env, "old1", 20, false, &mut out).unwrap_err().code, "old_session");
        assert!(out.is_empty());
        // The rows never ask it either.
        assert!(dialog_for(&env, "old1").is_none());
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
