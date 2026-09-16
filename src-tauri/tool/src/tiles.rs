//! The tiles this Mac holds, as the phone lists them (spec §4.1 `ls`, `watch`), and the session
//! files behind them (`sessions`, `prune`).

use crate::agent::{fold_log, read_log, Fold, Needs, Status};
use crate::paths::{live_session, read_meta, session_paths, sessions_dir_in, socket_live};
use crate::transcript::{guess_path, last_assistant_text};
use crate::workspace::{load_from, TerminalDef, Workspace};
use serde::Serialize;
use serde_json::{json, Value};
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
    dialog_open: &dyn Fn(&str) -> Option<bool>,
) -> Vec<TileRow> {
    tile_rows_with_folds(home, self_machine, &fold_log(&read_log(home)), live_cwd, dialog_open)
}

/// `tile_rows` with the hook log already folded, so a caller that polls (`watch`) folds the log
/// only when it changes.
pub fn tile_rows_with_folds(
    home: &Path,
    self_machine: Option<&str>,
    folds: &HashMap<String, Fold>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog_open: &dyn Fn(&str) -> Option<bool>,
) -> Vec<TileRow> {
    try_tile_rows_with_folds(home, self_machine, folds, live_cwd, dialog_open).unwrap_or_default()
}

/// `tile_rows_with_folds`, but None when the workspace file exists and cannot be read (a poller
/// keeps what it had instead of reporting every tile gone). No file at all is `Some(vec![])`.
pub fn try_tile_rows_with_folds(
    home: &Path,
    self_machine: Option<&str>,
    folds: &HashMap<String, Fold>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog_open: &dyn Fn(&str) -> Option<bool>,
) -> Option<Vec<TileRow>> {
    let dir = sessions_dir_in(home);
    let running = |id: &str| session_paths(&dir, id).ok().and_then(|p| live_session(&p)).is_some();
    rows_from(home, self_machine, folds, live_cwd, dialog_open, &running)
}

/// `tile_rows` with the liveness check supplied (tests use it without real holders).
pub fn tile_rows_with(
    home: &Path,
    self_machine: Option<&str>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog_open: &dyn Fn(&str) -> Option<bool>,
    running: &dyn Fn(&str) -> bool,
) -> Vec<TileRow> {
    rows_from(home, self_machine, &fold_log(&read_log(home)), live_cwd, dialog_open, running).unwrap_or_default()
}

fn rows_from(
    home: &Path,
    self_machine: Option<&str>,
    folds: &HashMap<String, Fold>,
    live_cwd: &dyn Fn(&str) -> Option<String>,
    dialog_open: &dyn Fn(&str) -> Option<bool>,
    running: &dyn Fn(&str) -> bool,
) -> Option<Vec<TileRow>> {
    let ws = match load_from(&workspace_path(home)) {
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
            } else if fold.needs == Some(Needs::Permission) && dialog_open(&def.id) == Some(false) {
                // Answered on the Mac (or elsewhere) and no tool has reported back yet.
                fold.status = Status::Working;
                fold.needs = None;
                fold.summary = None;
                fold.tool = None;
            }
            let transcript = fold.transcript_path.clone().map(PathBuf::from).or_else(|| {
                claude.and_then(|c| guess_path(home, &def.cwd, fold.session_id.as_deref().unwrap_or(&c.session_id)))
            });
            let last_message = if claude.is_some() { transcript.as_deref().and_then(|p| last_assistant_text(p, 240)) } else { None };
            TileRow {
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
                session_id: fold.session_id.or_else(|| claude.map(|c| c.session_id.clone())),
                summary: fold.summary,
                machine: self_machine.map(str::to_string),
                id: def.id,
                name: def.name,
            }
        })
        .collect();
    Some(rows)
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

pub fn session_rows(home: &Path) -> Vec<SessionRow> {
    let dir = sessions_dir_in(home);
    let known: BTreeSet<String> = load_from(&workspace_path(home))
        .ok()
        .flatten()
        .map(|ws| ws.terminals.into_iter().map(|t| t.id).collect())
        .unwrap_or_default();
    session_ids(&dir)
        .into_iter()
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
        .collect()
}

/// Removes every file of sessions that are not running and whose files are all older than
/// `older_than`. Returns how many sessions were removed. A lock file is only ever removed with
/// the rest of its session, never while a start could be using it.
pub fn prune(home: &Path, older_than: Duration) -> usize {
    let dir = sessions_dir_in(home);
    let now = SystemTime::now();
    let mut removed = 0;
    for id in session_ids(&dir) {
        let Ok(paths) = session_paths(&dir, &id) else { continue };
        if live_session(&paths).is_some() || socket_live(&paths.socket) {
            continue;
        }
        let files: Vec<PathBuf> = SESSION_EXTS.iter().map(|e| dir.join(format!("{id}.{e}"))).filter(|p| p.exists()).collect();
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

    #[test]
    fn a_running_tile_uses_live_cwd_and_a_closed_dialog_ends_the_block() {
        let h = home("live");
        write_workspace(&h);
        let log = [
            format!("1\tc1\tSessionStart\t{}", json!({"session_id": "s"})),
            format!("2\tc1\tPermissionRequest\t{}", json!({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": "npm test"}})),
        ];
        std::fs::write(h.join(".swarmz/agents/events.log"), log.join("\n")).unwrap();
        let rows = tile_rows_with(&h, Some("mini"), &|id| Some(format!("/live/{id}")), &|_| Some(true), &|id| id == "c1");
        let c1 = rows.iter().find(|r| r.id == "c1").unwrap();
        assert!(c1.running);
        assert_eq!(c1.cwd, "/live/c1");
        let v = serde_json::to_value(c1).unwrap();
        assert_eq!((v["status"].as_str(), v["needs"].as_str(), v["summary"].as_str()), (Some("blocked"), Some("permission"), Some("npm test")));
        let rows = tile_rows_with(&h, Some("mini"), &|_| None, &|_| Some(false), &|id| id == "c1");
        let v = serde_json::to_value(rows.iter().find(|r| r.id == "c1").unwrap()).unwrap();
        assert_eq!((v["status"].as_str(), v["needs"].as_str(), v["summary"].as_str()), (Some("working"), None, None));
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
        assert_eq!(try_tile_rows_with_folds(&h, Some("mini"), &none, &|_| None, &|_| None), Some(vec![]));
        write_workspace(&h);
        let file = h.join(".swarmz/workspace.json");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = try_tile_rows_with_folds(&h, Some("mini"), &none, &|_| None, &|_| None);
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
        let rows = session_rows(&h);
        let ids: Vec<(&str, bool)> = rows.iter().map(|r| (r.id.as_str(), r.known)).collect();
        assert_eq!(ids, vec![("c1", true), ("new", false), ("zz", false)]);
        assert!(rows.iter().all(|r| !r.running));
        // Nothing is old enough yet.
        assert_eq!(prune(&h, Duration::from_secs(7 * 86_400)), 0);
        // With a zero age everything dead goes, including a lock with no metadata.
        assert_eq!(prune(&h, Duration::ZERO), 3);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&h);
    }
}
