//! The tiles this Mac holds, as the phone lists them (spec §4.1 `ls`, `watch`), and the session
//! files behind them (`sessions`, `prune`).

use crate::agent::{fold_log, read_log, Fold, Needs, Status};
use crate::dialog::{Kind, ScreenView};
use crate::paths::{live_session, read_meta, session_paths, sessions_dir_in, socket_live};
use crate::transcript::{continued_in, guess_path, last_assistant_text, resolve_continued, resolve_continued_by};
use crate::workspace::{read_from, TerminalDef, Workspace};
use serde::Serialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TileRow {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub kind: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub status: Status,
    pub needs: Option<Needs>,
    pub since: Option<String>,
    pub last_event: Option<String>,
    pub mode: Option<String>,
    pub last_message: Option<String>,
    pub turn_ended_at: Option<String>,
    pub session_id: Option<String>,
    pub summary: Option<String>,
    pub machine: Option<String>,
    /// The card's title, else the fold's fallback (conversation cards spec §3.2).
    pub title: Option<String>,
    pub recap: Option<String>,
    pub card_at: Option<String>,
    pub card_by: Option<String>,
}

fn origin(def: &TerminalDef) -> Option<&str> {
    def.extra.get("origin").and_then(|v| v.as_str())
}

pub fn homed_defs(ws: &Workspace, self_machine: Option<&str>) -> Vec<TerminalDef> {
    ws.terminals
        .iter()
        .filter(|d| d.ssh.is_none())
        .filter(|d| match origin(d) {
            None => true,
            Some(o) => Some(o) == self_machine,
        })
        .cloned()
        .collect()
}

fn workspace_path(home: &Path) -> PathBuf {
    home.join(".swarmz").join("workspace.json")
}

pub fn tile_rows(
    home: &Path,
    self_machine: Option<&str>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog: &dyn Fn(&str) -> Option<ScreenView>,
) -> Vec<TileRow> {
    tile_rows_with_folds(home, self_machine, &fold_log(&read_log(home)), live_cwd, dialog)
}

/// `tile_rows` with the hook log already folded, so a caller that polls (`watch`) folds the log
/// only when it changes.
pub fn tile_rows_with_folds(
    home: &Path,
    self_machine: Option<&str>,
    folds: &HashMap<String, Fold>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog: &dyn Fn(&str) -> Option<ScreenView>,
) -> Vec<TileRow> {
    try_tile_rows_with_folds(home, self_machine, folds, live_cwd, dialog, &read_last_text, &resolve_continued).unwrap_or_default()
}

fn read_last_text(path: &Path) -> Option<String> {
    last_assistant_text(path, LAST_MESSAGE_CHARS)
}

const LAST_MESSAGE_CHARS: usize = 240;

/// A file's `(length, modified time)`, or None when it cannot be read.
pub type Stamp = Option<(u64, SystemTime)>;

pub fn stamp(path: &Path) -> Stamp {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// Each transcript's last assistant text, and the session it says it continued in, read again
/// only when the file's length or modified time changes (`watch` asks every second, and
/// transcripts grow large).
#[derive(Default)]
pub struct LastTextCache {
    seen: RefCell<HashMap<PathBuf, (Stamp, Option<String>)>>,
    continued: RefCell<HashMap<PathBuf, (Stamp, Option<String>)>>,
}

/// `read` for `path`, from `cache` while the file's stamp is unchanged.
fn cached(cache: &RefCell<HashMap<PathBuf, (Stamp, Option<String>)>>, path: &Path, read: impl Fn(&Path) -> Option<String>) -> Option<String> {
    let now = stamp(path);
    if let Some((at, value)) = cache.borrow().get(path) {
        if *at == now && now.is_some() {
            return value.clone();
        }
    }
    let value = read(path);
    cache.borrow_mut().insert(path.to_path_buf(), (now, value.clone()));
    value
}

impl LastTextCache {
    pub fn get(&self, path: &Path) -> Option<String> {
        self.get_with(path, read_last_text)
    }

    pub fn get_with(&self, path: &Path, read: impl Fn(&Path) -> Option<String>) -> Option<String> {
        cached(&self.seen, path, read)
    }

    /// `resolve_continued`, reading each file's tail again only when it changes.
    pub fn resolve(&self, path: &Path) -> (PathBuf, Option<String>) {
        self.resolve_with(path, continued_in)
    }

    pub fn resolve_with(&self, path: &Path, read: impl Fn(&Path) -> Option<String>) -> (PathBuf, Option<String>) {
        resolve_continued_by(path, &|p| cached(&self.continued, p, &read))
    }
}

/// `tile_rows_with_folds`, but None when the workspace file exists and cannot be read (a poller
/// keeps what it had instead of reporting every tile gone). No file at all is `Some(vec![])`.
pub fn try_tile_rows_with_folds(
    home: &Path,
    self_machine: Option<&str>,
    folds: &HashMap<String, Fold>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog: &dyn Fn(&str) -> Option<ScreenView>,
    last_text: &dyn Fn(&Path) -> Option<String>,
    resolve: &dyn Fn(&Path) -> (PathBuf, Option<String>),
) -> Option<Vec<TileRow>> {
    let dir = sessions_dir_in(home);
    let running = |id: &str| session_paths(&dir, id).ok().and_then(|p| live_session(&p)).is_some();
    rows_from(home, self_machine, folds, live_cwd, dialog, &running, last_text, resolve)
}

/// `tile_rows` with the liveness check supplied (tests use it without real holders).
pub fn tile_rows_with(
    home: &Path,
    self_machine: Option<&str>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog: &dyn Fn(&str) -> Option<ScreenView>,
    running: &dyn Fn(&str) -> bool,
) -> Vec<TileRow> {
    rows_from(home, self_machine, &fold_log(&read_log(home)), live_cwd, dialog, running, &read_last_text, &resolve_continued).unwrap_or_default()
}

fn rows_from(
    home: &Path,
    self_machine: Option<&str>,
    folds: &HashMap<String, Fold>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog: &dyn Fn(&str) -> Option<ScreenView>,
    running: &dyn Fn(&str) -> bool,
    last_text: &dyn Fn(&Path) -> Option<String>,
    resolve: &dyn Fn(&Path) -> (PathBuf, Option<String>),
) -> Option<Vec<TileRow>> {
    let ws = match read_from(&workspace_path(home)) {
        Ok(Some(ws)) => ws,
        Ok(None) => return Some(vec![]),
        Err(_) => return None,
    };
    let dir = sessions_dir_in(home);
    let rows = homed_defs(&ws, self_machine)
        .into_iter()
        .map(|def| {
            let is_running = running(&def.id);
            let meta = session_paths(&dir, &def.id).ok().and_then(|p| read_meta(&p.meta));
            let claude = def.claude.as_ref().filter(|c| c.enabled);
            let mut fold: Fold = folds.get(&def.id).cloned().unwrap_or_default();
            if !is_running {
                fold.status = Status::Offline;
                fold.needs = None;
                fold.summary = None;
                fold.tool = None;
            } else if meta.as_ref().is_some_and(|m| m.screen) {
                // A holder that does not answer Screen keeps the fold as it is.
                if let Some(view) = dialog(&def.id) {
                    apply_screen(&mut fold, &view);
                }
            }
            let transcript = fold.transcript_path.clone().map(PathBuf::from).or_else(|| {
                claude.and_then(|c| guess_path(home, &def.cwd, fold.session_id.as_deref().unwrap_or(&c.session_id)))
            });
            // Claude may have moved the conversation on (`continued-in`): the newest file speaks,
            // under its own session id.
            let (transcript, moved) = match transcript.filter(|_| claude.is_some()) {
                Some(p) => {
                    let (p, moved) = resolve(&p);
                    (Some(p), moved)
                }
                None => (None, None),
            };
            let last_message = transcript.as_deref().and_then(last_text);
            let card = crate::card::read(&def.extra);
            let card_str = |k: &str| card.as_ref().and_then(|c| c.get(k)).and_then(|v| v.as_str()).map(str::to_string);
            TileRow {
                title: card_str("title").or_else(|| fold.title.clone()),
                recap: card_str("recap"),
                card_at: card_str("updatedAt"),
                card_by: card_str("by"),
                cwd: if is_running { live_cwd(&def.id).unwrap_or_else(|| def.cwd.clone()) } else { def.cwd.clone() },
                kind: if claude.is_some() { "claude" } else { "shell" }.to_string(),
                running: is_running,
                exit_code: if is_running { None } else { meta.and_then(|m| m.exit_code) },
                status: fold.status,
                needs: fold.needs,
                since: fold.since,
                last_event: fold.last_event,
                mode: fold.mode,
                last_message,
                turn_ended_at: fold.turn_ended_at,
                session_id: moved.or(fold.session_id).or_else(|| claude.map(|c| c.session_id.clone())),
                summary: fold.summary,
                machine: self_machine.map(str::to_string),
                id: def.id,
                name: def.name,
            }
        })
        .collect();
    Some(rows)
}

/// The screen decides permission state (spec §4.2): a live dialog means Claude is blocked on a
/// permission, whatever the hook log says (hooks run asynchronously and can land out of order, and
/// subagents' requests are never logged); no dialog ends a permission block the log still shows.
/// The summary is always the dialog's; the hook's tool name is kept only when the hook describes
/// the same question. A permission block with no dialog is `working` while Claude's interrupt
/// hint shows (a long approved tool run), else `idle`. Question-type blocks are left as the log
/// says.
pub fn apply_screen(fold: &mut Fold, view: &ScreenView) {
    match view.dialog.as_ref() {
        // A question Claude asks (AskUserQuestion) is only ever seen on the screen: no hook
        // reports it, so the fold's own state gives way while it shows and returns when it closes.
        Some(d) if d.kind == Kind::Question => {
            fold.tool = Some("AskUserQuestion".to_string());
            fold.summary = Some(d.summary());
            fold.status = Status::Blocked;
            fold.needs = Some(Needs::Question);
        }
        Some(d) => {
            let summary = d.summary();
            let same = fold.needs == Some(Needs::Permission) && fold.summary.as_deref() == Some(summary.as_str());
            fold.tool = Some(fold.tool.take().filter(|_| same).unwrap_or_else(|| d.heading.clone()));
            fold.summary = Some(summary);
            fold.status = Status::Blocked;
            fold.needs = Some(Needs::Permission);
        }
        None if fold.status == Status::Blocked && fold.needs == Some(Needs::Permission) => {
            fold.status = if view.interruptible { Status::Working } else { Status::Idle };
            fold.needs = None;
            fold.summary = None;
            fold.tool = None;
        }
        None => {}
    }
}

/// What `watch` prints for a change from `prev` to `next`: a `tile` event per new or changed
/// row, then a `gone` event per removed id.
pub fn watch_events(prev: &BTreeMap<String, TileRow>, next: &[TileRow]) -> Vec<Value> {
    let mut out = Vec::new();
    for row in next {
        if prev.get(&row.id) != Some(row) {
            out.push(json!({"v": 1, "type": "tile", "tile": row}));
        }
    }
    let now: BTreeSet<&str> = next.iter().map(|r| r.id.as_str()).collect();
    for id in prev.keys() {
        if !now.contains(id.as_str()) {
            out.push(json!({"v": 1, "type": "gone", "id": id}));
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub name: Option<String>,
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub exited_at: Option<String>,
    pub exit_code: Option<i32>,
    pub known: bool,
}

const SESSION_EXTS: [&str; 4] = ["json", "sock", "log", "lock"];
/// A session's files other than its lock, which is never removed (a start may hold it).
const SESSION_FILES: [&str; 3] = ["json", "sock", "log"];

fn session_ids(dir: &Path) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some((id, ext)) = name.rsplit_once('.') {
            if SESSION_EXTS.contains(&ext) && crate::paths::valid_tile_id(id) {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

/// Every session with files beyond its lock. An error when `workspace.json` exists and cannot be
/// read: without it no session can be told apart from one outside the workspace.
pub fn session_rows(home: &Path) -> Result<Vec<SessionRow>, String> {
    let dir = sessions_dir_in(home);
    let known: BTreeSet<String> = read_from(&workspace_path(home))?
        .map(|ws| ws.terminals.into_iter().map(|t| t.id).collect())
        .unwrap_or_default();
    Ok(session_ids(&dir)
        .into_iter()
        .filter(|id| SESSION_FILES.iter().any(|e| dir.join(format!("{id}.{e}")).exists()))
        .filter_map(|id| {
            let paths = session_paths(&dir, &id).ok()?;
            let meta = read_meta(&paths.meta);
            let running = live_session(&paths).is_some();
            Some(SessionRow {
                name: meta.as_ref().map(|m| m.name.clone()),
                pid: meta.as_ref().map(|m| m.pid),
                started_at: meta.as_ref().map(|m| m.started_at.clone()),
                exited_at: meta.as_ref().and_then(|m| m.exited_at.clone()),
                exit_code: meta.as_ref().and_then(|m| m.exit_code),
                running,
                known: known.contains(&id),
                id,
            })
        })
        .collect())
}

/// Removes the files of sessions that are not running and whose files are all older than
/// `older_than`. Returns how many sessions were removed. Lock files are never removed: a start
/// may hold one at any moment, and removing it would let a second start take a fresh lock.
pub fn prune(home: &Path, older_than: Duration) -> usize {
    let dir = sessions_dir_in(home);
    let now = SystemTime::now();
    let mut removed = 0;
    for id in session_ids(&dir) {
        let Ok(paths) = session_paths(&dir, &id) else { continue };
        if live_session(&paths).is_some() || socket_live(&paths.socket) {
            continue;
        }
        let files: Vec<PathBuf> = SESSION_FILES.iter().map(|e| dir.join(format!("{id}.{e}"))).filter(|p| p.exists()).collect();
        if files.is_empty() {
            continue;
        }
        let old = files.iter().all(|p| {
            std::fs::symlink_metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age >= older_than)
        });
        if old {
            for p in files {
                let _ = std::fs::remove_file(p);
            }
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dialog::Dialog;
    use serde_json::json;
    use std::path::PathBuf;

    fn home(tag: &str) -> PathBuf {
        let h = PathBuf::from(format!("/tmp/szc-{}-tiles-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(h.join(".swarmz/agents")).unwrap();
        std::fs::create_dir_all(h.join(".swarmz/sessions")).unwrap();
        h
    }

    fn write_workspace(h: &Path) {
        let ws = json!({
            "version": 1,
            "layout": null,
            "sync": {"revision": 3, "updatedAt": "2026-09-16T10:00:00.000Z", "updatedBy": "mini"},
            "terminals": [
                {"id": "c1", "name": "api", "cwd": "/p/api", "origin": "mini",
                 "claude": {"enabled": true, "sessionId": "5e2b8a52-0000-4000-8000-000000000001", "skipPermissions": false, "started": true}},
                {"id": "s1", "name": "shell", "cwd": "/p"},
                {"id": "o1", "name": "theirs", "cwd": "/q", "origin": "studio"},
                {"id": "r1", "name": "remote", "cwd": "/p", "ssh": {"host": "studio", "cwd": "/x"}}
            ]
        });
        std::fs::write(h.join(".swarmz/workspace.json"), ws.to_string()).unwrap();
    }

    #[test]
    fn rows_cover_tiles_homed_here_with_status_and_last_message() {
        let h = home("rows");
        write_workspace(&h);
        let transcript = h.join("t.jsonl");
        std::fs::write(
            &transcript,
            json!({"type": "assistant", "uuid": "u", "message": {"id": "m", "content": [{"type": "text", "text": "All tests pass."}]}}).to_string() + "\n",
        )
        .unwrap();
        let log = [
            format!("2026-09-16T10:00:00Z\tc1\tSessionStart\t{}", json!({"session_id": "5e2b", "transcript_path": transcript, "permission_mode": "plan"})),
            format!("2026-09-16T10:00:05Z\tc1\tUserPromptSubmit\t{}", json!({"session_id": "5e2b"})),
            format!("2026-09-16T10:00:09Z\tc1\tPermissionRequest\t{}", json!({"session_id": "5e2b", "tool_name": "Bash", "tool_input": {"command": "npm test"}})),
        ];
        std::fs::write(h.join(".swarmz/agents/events.log"), log.join("\n") + "\n").unwrap();
        // The shell tile's holder exited with code 2.
        std::fs::write(
            h.join(".swarmz/sessions/s1.json"),
            json!({"v": 1, "pid": 999999, "shellPid": null, "cwd": "/p", "name": "shell", "startedAt": "t", "exitedAt": "t2", "exitCode": 2}).to_string(),
        )
        .unwrap();

        let rows = tile_rows(&h, Some("mini"), &|_| None, &|_| None);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "s1"]);
        let c1 = &rows[0];
        assert_eq!((c1.kind.as_str(), c1.running, c1.name.as_str()), ("claude", false, "api"));
        // Not running: whatever the log said, nothing is working there now.
        assert_eq!(serde_json::to_value(c1).unwrap()["status"], "offline");
        assert_eq!(c1.last_message.as_deref(), Some("All tests pass."));
        assert_eq!(c1.mode.as_deref(), Some("plan"));
        let s1 = &rows[1];
        assert_eq!((s1.kind.as_str(), s1.exit_code), ("shell", Some(2)));
        assert_eq!(s1.last_message, None);
        let _ = std::fs::remove_dir_all(&h);
    }

    fn dialog(summary: &str) -> Dialog {
        Dialog { kind: Kind::Permission, heading: "Bash command".into(), target: Some(summary.into()), description: None, options: vec![], multi: false, cursor: None, submit_at: None }
    }

    fn question(text: &str) -> Option<ScreenView> {
        let d = Dialog { kind: Kind::Question, heading: "Colour".into(), target: Some(text.into()), ..dialog("") };
        Some(ScreenView { dialog: Some(d), interruptible: false })
    }

    #[test]
    fn a_question_on_screen_blocks_the_tile_and_its_close_returns_to_the_log() {
        let mut f = Fold { status: Status::Working, ..Fold::default() };
        apply_screen(&mut f, &question("Which colour?").unwrap());
        assert_eq!((f.status, f.needs, f.tool.as_deref(), f.summary.as_deref()), (Status::Blocked, Some(Needs::Question), Some("AskUserQuestion"), Some("Which colour?")));
        // No hook reports the question, so with it gone the log's own state stands.
        let mut f = Fold { status: Status::Working, ..Fold::default() };
        apply_screen(&mut f, &nothing_shown(false).unwrap());
        assert_eq!((f.status, f.needs), (Status::Working, None));
        // A row: the screen's question overrides a log that says working.
        let h = home("asked");
        write_workspace(&h);
        write_meta_for(&h, "c1", true);
        write_log(&h, &[format!("1\tc1\tUserPromptSubmit\t{}", json!({"session_id": "s"}))]);
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| question("Which colour?"), &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1"), (json!("blocked"), json!("question"), json!("Which colour?")));
        let _ = std::fs::remove_dir_all(&h);
    }

    fn shown(summary: &str) -> Option<ScreenView> {
        Some(ScreenView { dialog: Some(dialog(summary)), interruptible: false })
    }

    fn nothing_shown(interruptible: bool) -> Option<ScreenView> {
        Some(ScreenView { dialog: None, interruptible })
    }

    /// Session metadata for `id`, from a holder that answers Screen or not (every holder that
    /// writes `build` but not `screen` predates it).
    fn write_meta_for(h: &Path, id: &str, screen: bool) {
        let mut m = json!({"v": 1, "pid": 999999, "shellPid": null, "cwd": "/p", "name": id, "startedAt": "t", "build": 5});
        if screen {
            m["screen"] = json!(true);
        }
        std::fs::write(h.join(format!(".swarmz/sessions/{id}.json")), m.to_string()).unwrap();
    }

    fn write_log(h: &Path, lines: &[String]) {
        std::fs::write(h.join(".swarmz/agents/events.log"), lines.join("\n") + "\n").unwrap();
    }

    fn status_of(rows: &[TileRow], id: &str) -> (Value, Value, Value) {
        let v = serde_json::to_value(rows.iter().find(|r| r.id == id).unwrap()).unwrap();
        (v["status"].clone(), v["needs"].clone(), v["summary"].clone())
    }

    fn permission(ts: &str, command: &str) -> String {
        format!("{ts}\tc1\tPermissionRequest\t{}", json!({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": command}}))
    }

    #[test]
    fn a_running_tile_uses_live_cwd_and_the_screen_decides_the_block() {
        let h = home("live");
        write_workspace(&h);
        write_meta_for(&h, "c1", true);
        write_log(&h, &[format!("1\tc1\tSessionStart\t{}", json!({"session_id": "s"})), permission("2", "npm test")]);
        let rows = tile_rows_with(&h, Some("mini"), &|id| Some(format!("/live/{id}")), &|_| shown("npm test"), &|id| id == "c1");
        let c1 = rows.iter().find(|r| r.id == "c1").unwrap();
        assert!(c1.running);
        assert_eq!(c1.cwd, "/live/c1");
        assert_eq!(status_of(&rows, "c1"), (json!("blocked"), json!("permission"), json!("npm test")));
        // (b) The dialog has gone while the log still says blocked: idle, nothing needed.
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| nothing_shown(false), &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1"), (json!("idle"), Value::Null, Value::Null));
        // Gone, and Claude's interrupt hint shows: the approved tool is still running.
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| nothing_shown(true), &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1"), (json!("working"), Value::Null, Value::Null));
        // The screen did not answer: the log stands.
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| None, &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1").0, json!("blocked"));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_tool_result_logged_after_the_request_never_hides_a_live_dialog() {
        let h = home("late-post");
        write_workspace(&h);
        write_meta_for(&h, "c1", true);
        // (a) The hooks are asynchronous: the previous tool's PostToolUse lands after the
        // PermissionRequest for the next one, so the log alone reads "working".
        let post = format!("3\tc1\tPostToolUse\t{}", json!({"session_id": "s"}));
        write_log(&h, &[format!("1\tc1\tUserPromptSubmit\t{}", json!({"session_id": "s"})), permission("2", "npm test"), post]);
        let showing = |_: &str| shown("npm test");
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &showing, &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1"), (json!("blocked"), json!("permission"), json!("npm test")));
        // A subagent's dialog, never logged at all, blocks the same way.
        write_log(&h, &[format!("1\tc1\tUserPromptSubmit\t{}", json!({"session_id": "s"}))]);
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &showing, &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1").0, json!("blocked"));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_summary_is_the_screens_when_the_hook_describes_another_question() {
        let h = home("other-summary");
        write_workspace(&h);
        write_meta_for(&h, "c1", true);
        write_log(&h, &[permission("1", "rm -rf build")]);
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| shown("npm test"), &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1"), (json!("blocked"), json!("permission"), json!("npm test")));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_hook_tool_is_kept_only_for_the_question_it_describes() {
        let hooked = || Fold { status: Status::Blocked, needs: Some(Needs::Permission), summary: Some("npm test".into()), tool: Some("Bash".into()), ..Fold::default() };
        let mut f = hooked();
        apply_screen(&mut f, &shown("npm test").unwrap());
        assert_eq!((f.tool.as_deref(), f.summary.as_deref()), (Some("Bash"), Some("npm test")));
        let mut f = hooked();
        apply_screen(&mut f, &shown("rm -rf build").unwrap());
        assert_eq!((f.tool.as_deref(), f.summary.as_deref()), (Some("Bash command"), Some("rm -rf build")));
        let mut f = Fold { status: Status::Working, ..Fold::default() };
        apply_screen(&mut f, &shown("npm test").unwrap());
        assert_eq!((f.status, f.needs, f.tool.as_deref()), (Status::Blocked, Some(Needs::Permission), Some("Bash command")));
        let mut f = hooked();
        apply_screen(&mut f, &ScreenView::default());
        assert_eq!((f.status, f.needs, f.summary, f.tool), (Status::Idle, None, None, None));
        let mut f = hooked();
        apply_screen(&mut f, &ScreenView { dialog: None, interruptible: true });
        assert_eq!((f.status, f.needs, f.summary, f.tool), (Status::Working, None, None, None));
        let mut working = Fold { status: Status::Working, ..Fold::default() };
        apply_screen(&mut working, &ScreenView::default());
        assert_eq!(working.status, Status::Working);
    }

    #[test]
    fn question_blocks_stay_as_the_log_says() {
        let h = home("question");
        write_workspace(&h);
        write_meta_for(&h, "c1", true);
        write_log(&h, &[format!("1\tc1\tNotification\t{}", json!({"session_id": "s", "notification_type": "idle_prompt"}))]);
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| nothing_shown(false), &|id| id == "c1");
        assert_eq!(status_of(&rows, "c1").0, json!("blocked"));
        assert_eq!(status_of(&rows, "c1").1, json!("question"));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_holder_without_the_screen_capability_is_never_asked_for_its_screen() {
        let h = home("old-holder");
        write_workspace(&h);
        write_meta_for(&h, "c1", false);
        write_log(&h, &[permission("1", "npm test")]);
        let asked = std::cell::Cell::new(false);
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| {
            asked.set(true);
            nothing_shown(false)
        }, &|id| id == "c1");
        assert!(!asked.get());
        assert_eq!(status_of(&rows, "c1").0, json!("blocked"));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn rows_use_the_fold_they_are_given_not_the_log_file() {
        let h = home("folds");
        write_workspace(&h);
        let log = format!("1\tc1\tSessionStart\t{}", json!({"session_id": "s", "permission_mode": "plan"}));
        std::fs::write(h.join(".swarmz/agents/events.log"), log).unwrap();
        let mut folds = HashMap::new();
        folds.insert("c1".to_string(), Fold { mode: Some("acceptEdits".into()), ..Fold::default() });
        let rows = tile_rows_with_folds(&h, Some("mini"), &folds, &|_| None, &|_| None);
        let c1 = rows.iter().find(|r| r.id == "c1").unwrap();
        assert_eq!(c1.mode.as_deref(), Some("acceptEdits"));
        let rows = tile_rows_with_folds(&h, Some("mini"), &HashMap::new(), &|_| None, &|_| None);
        assert_eq!(rows.iter().find(|r| r.id == "c1").unwrap().mode, None);
        // The file-reading wrapper still folds the log.
        let rows = tile_rows(&h, Some("mini"), &|_| None, &|_| None);
        assert_eq!(rows.iter().find(|r| r.id == "c1").unwrap().mode.as_deref(), Some("plan"));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn an_unreadable_workspace_is_none_and_a_missing_one_is_empty() {
        use std::os::unix::fs::PermissionsExt;
        let h = home("unreadable");
        let none = HashMap::new();
        assert_eq!(try_tile_rows_with_folds(&h, Some("mini"), &none, &|_| None, &|_| None, &read_last_text, &resolve_continued), Some(vec![]));
        write_workspace(&h);
        let file = h.join(".swarmz/workspace.json");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = try_tile_rows_with_folds(&h, Some("mini"), &none, &|_| None, &|_| None, &read_last_text, &resolve_continued);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(unreadable, None);
        assert_eq!(tile_rows_with_folds(&h, Some("mini"), &none, &|_| None, &|_| None).len(), 2);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn without_a_machine_name_only_defs_without_an_origin_are_homed() {
        let h = home("noself");
        write_workspace(&h);
        let rows = tile_rows(&h, None, &|_| None, &|_| None);
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["s1"]);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn last_texts_are_read_again_only_when_the_transcript_changes() {
        let h = home("lasttext");
        let path = h.join("t.jsonl");
        std::fs::write(&path, "one\n").unwrap();
        let reads = std::cell::Cell::new(0);
        let read = |p: &Path| {
            reads.set(reads.get() + 1);
            std::fs::read_to_string(p).ok()
        };
        let cache = LastTextCache::default();
        assert_eq!(cache.get_with(&path, read).as_deref(), Some("one\n"));
        assert_eq!(cache.get_with(&path, read).as_deref(), Some("one\n"));
        assert_eq!(reads.get(), 1);
        std::fs::write(&path, "one\ntwo\n").unwrap();
        assert_eq!(cache.get_with(&path, read).as_deref(), Some("one\ntwo\n"));
        assert_eq!(reads.get(), 2);
        // A missing file is asked again every time.
        let gone = h.join("gone.jsonl");
        assert_eq!(cache.get_with(&gone, read), None);
        assert_eq!(cache.get_with(&gone, read), None);
        assert_eq!(reads.get(), 4);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn continuations_are_read_again_only_when_a_transcript_changes() {
        let h = home("continued");
        let ids = ["11111111-0000-4000-8000-000000000001", "22222222-0000-4000-8000-000000000002", "33333333-0000-4000-8000-000000000003"];
        let file = |i: usize| h.join(format!("{}.jsonl", ids[i]));
        let record = |to: &str| format!("{}\n", json!({"type": "continued-in", "continuedInSessionId": to}));
        std::fs::write(file(0), record(ids[1])).unwrap();
        std::fs::write(file(1), "{}\n").unwrap();
        std::fs::write(file(2), "{}\n").unwrap();
        let reads = std::cell::Cell::new(0);
        let read = |p: &Path| {
            reads.set(reads.get() + 1);
            continued_in(p)
        };
        let cache = LastTextCache::default();
        assert_eq!(cache.resolve_with(&file(0), read), (file(1), Some(ids[1].to_string())));
        assert_eq!(cache.resolve_with(&file(0), read), (file(1), Some(ids[1].to_string())));
        assert_eq!(reads.get(), 2);
        // The new file continues again: only it is read again.
        std::fs::write(file(1), format!("{{}}\n{}", record(ids[2]))).unwrap();
        assert_eq!(cache.resolve_with(&file(0), read), (file(2), Some(ids[2].to_string())));
        assert_eq!(reads.get(), 4);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn watch_events_report_changes_and_removals_only() {
        let row = |id: &str, name: &str| TileRow { id: id.into(), name: name.into(), ..TileRow::default() };
        let mut prev = BTreeMap::new();
        prev.insert("a".to_string(), row("a", "one"));
        prev.insert("b".to_string(), row("b", "two"));
        let next = vec![row("a", "one"), row("b", "renamed"), row("c", "new")];
        let evs = watch_events(&prev, &next);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0]["type"], "tile");
        assert_eq!(evs[0]["tile"]["name"], "renamed");
        assert_eq!(evs[1]["tile"]["id"], "c");
        let gone = watch_events(&prev, &[row("a", "one")]);
        assert_eq!(gone, vec![json!({"v": 1, "type": "gone", "id": "b"})]);
    }

    #[test]
    fn sessions_are_listed_and_only_old_dead_ones_pruned() {
        let h = home("prune");
        write_workspace(&h);
        let dir = h.join(".swarmz/sessions");
        let meta = |name: &str| json!({"v": 1, "pid": 999999, "shellPid": null, "cwd": "/", "name": name, "startedAt": "s", "exitedAt": "e", "exitCode": 0}).to_string();
        std::fs::write(dir.join("c1.json"), meta("api")).unwrap();
        std::fs::write(dir.join("c1.log"), "").unwrap();
        std::fs::write(dir.join("zz.json"), meta("gone")).unwrap();
        std::fs::write(dir.join("zz.lock"), "").unwrap();
        std::fs::write(dir.join("new.lock"), "").unwrap();
        let rows = session_rows(&h).unwrap();
        // A lock alone is not a session.
        let ids: Vec<(&str, bool)> = rows.iter().map(|r| (r.id.as_str(), r.known)).collect();
        assert_eq!(ids, vec![("c1", true), ("zz", false)]);
        assert!(rows.iter().all(|r| !r.running));
        // Nothing is old enough yet.
        assert_eq!(prune(&h, Duration::from_secs(7 * 86_400)), 0);
        // With a zero age everything dead goes, except the locks.
        assert_eq!(prune(&h, Duration::ZERO), 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["new.lock", "zz.lock"]);
        assert_eq!(prune(&h, Duration::ZERO), 0);
        assert!(session_rows(&h).unwrap().is_empty());
        // An unreadable workspace is an error, not "no session is known".
        std::fs::write(h.join(".swarmz/workspace.json"), "{ broken").unwrap();
        std::fs::write(dir.join("c1.json"), meta("api")).unwrap();
        assert!(session_rows(&h).is_err());
        let _ = std::fs::remove_dir_all(&h);
    }
}
