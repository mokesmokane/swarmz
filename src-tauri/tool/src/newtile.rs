//! Tiles the phone creates or restarts on this Mac (spec §4.5, §4.1 `folders`, `restart`).

use crate::transcript::guess_path;
use crate::util::valid_abs_path;
use crate::workspace::{ClaudeConfig, TerminalDef, Workspace};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<String>,
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

/// The sub-folders of `path` (the home folder when None): visible ones sorted, then hidden ones
/// sorted, the same rules as the desktop folder picker.
pub fn list_folders(path: Option<&str>, home: &Path) -> Result<Listing, String> {
    let dir = match path {
        Some(p) => PathBuf::from(p),
        None => home.to_path_buf(),
    };
    let shown = dir.to_string_lossy().into_owned();
    if !valid_abs_path(&shown) {
        return Err(format!("{shown:?} is not an absolute folder path"));
    }
    if dir.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return Err(format!("{shown:?} must not contain . or .. segments"));
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("could not open {shown}: {e}"))?;
    let (mut visible, mut hidden): (Vec<String>, Vec<String>) = (vec![], vec![]);
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || has_control(&name) {
            continue;
        }
        if name.starts_with('.') { hidden.push(name) } else { visible.push(name) }
    }
    visible.sort();
    hidden.sort();
    visible.extend(hidden);
    let parent = if shown == "/" {
        None
    } else {
        dir.parent().map(|p| p.to_string_lossy().into_owned())
    };
    Ok(Listing { path: shown, parent, dirs: visible })
}

/// Cuts `s` to at most `max` characters, trims the whitespace the cut may leave at the end, and
/// falls back to `"shell"` if that leaves nothing.
fn clip(s: &str, max: usize) -> String {
    let cut: String = s.chars().take(max).collect();
    let cut = cut.trim_end();
    if cut.is_empty() { "shell".to_string() } else { cut.to_string() }
}

/// The registry's name rules (no quotes, backquotes, backslashes, `$` or control characters; at
/// most 64 characters), then `-2`, `-3` … until the name is free. Every candidate returned,
/// including a suffixed one, is itself at most 64 characters.
pub fn unique_name(base: &str, taken: &[String]) -> String {
    let cleaned: String = base.chars().filter(|c| !matches!(c, '"' | '\'' | '`' | '\\' | '$') && !c.is_control()).collect();
    let cleaned = cleaned.trim();
    let cleaned = if cleaned.is_empty() { "shell" } else { cleaned };
    let name = clip(cleaned, 64);
    if !taken.iter().any(|t| *t == name) {
        return name;
    }
    (2..)
        .map(|i| {
            let suffix = format!("-{i}");
            let room = 64usize.saturating_sub(suffix.chars().count());
            format!("{}{suffix}", clip(cleaned, room))
        })
        .find(|c| !taken.iter().any(|t| t == c))
        .expect("an unused name")
}

pub fn claude_line(c: &ClaudeConfig) -> String {
    let mut parts = vec!["claude".to_string()];
    if c.skip_permissions {
        parts.push("--dangerously-skip-permissions".into());
    }
    parts.push(if c.started { "--resume" } else { "--session-id" }.into());
    parts.push(c.session_id.clone());
    parts.join(" ")
}

/// The line a local tile types when it starts (same rules as `startupSteps` in the app for a
/// local tile).
pub fn startup_line(def: &TerminalDef) -> Option<String> {
    if let Some(cmd) = def.command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        return Some(cmd.to_string());
    }
    def.claude.as_ref().filter(|c| c.enabled && crate::util::valid_uuid(&c.session_id)).map(claude_line)
}

/// Whether the tile's Claude session has a transcript, so it must be resumed rather than
/// started with its id again.
pub fn session_started(home: &Path, def: &TerminalDef) -> bool {
    def.claude.as_ref().is_some_and(|c| c.started || guess_path(home, &def.cwd, &c.session_id).exists())
}

pub fn empty_workspace() -> Workspace {
    Workspace { version: 1, terminals: vec![], layout: Value::Null, extra: Map::new() }
}

pub fn workspace_file(home: &Path) -> PathBuf {
    home.join(".swarmz").join("workspace.json")
}

/// Appends the def with `origin` = this Mac and bumps the sync revision as this Mac.
pub fn add_def(ws: &mut Workspace, mut def: TerminalDef, self_machine: &str, now: &str) {
    def.extra.insert("origin".into(), json!(self_machine));
    ws.terminals.push(def);
    let revision = ws.extra.get("sync").and_then(|s| s.get("revision")).and_then(|r| r.as_u64()).unwrap_or(0) + 1;
    ws.extra.insert("sync".into(), json!({"revision": revision, "updatedAt": now, "updatedBy": self_machine}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::ClaudeConfig;
    use serde_json::{json, Map};
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = PathBuf::from(format!("/tmp/szc-{}-newtile-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn def(id: &str, claude: Option<ClaudeConfig>, command: Option<&str>) -> TerminalDef {
        TerminalDef { id: id.into(), name: id.into(), cwd: "/p/app".into(), ssh: None, claude, command: command.map(str::to_string), extra: Map::new() }
    }

    fn cc(started: bool, skip: bool) -> ClaudeConfig {
        ClaudeConfig { enabled: true, session_id: "5e2b8a52-0000-4000-8000-000000000001".into(), skip_permissions: skip, started }
    }

    #[test]
    fn folders_list_directories_visible_first_with_a_parent() {
        let d = tmp("folders");
        for name in ["zeta", "alpha", ".hidden"] {
            std::fs::create_dir(d.join(name)).unwrap();
        }
        std::fs::write(d.join("file.txt"), "x").unwrap();
        let l = list_folders(Some(d.to_str().unwrap()), Path::new("/")).unwrap();
        assert_eq!(l.dirs, vec!["alpha", "zeta", ".hidden"]);
        assert_eq!(l.path, d.to_string_lossy());
        assert_eq!(l.parent.as_deref(), Some("/tmp"));
        assert_eq!(list_folders(Some("/"), Path::new("/")).unwrap().parent, None);
        // No path means the home folder.
        assert_eq!(list_folders(None, &d).unwrap().path, d.to_string_lossy());
        assert!(list_folders(Some("relative"), &d).is_err());
        assert!(list_folders(Some("/definitely/not/here"), &d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn folders_reject_dot_and_dot_dot_segments() {
        assert!(list_folders(Some("/tmp/.."), Path::new("/")).is_err());
        assert!(list_folders(Some("/tmp/./x"), Path::new("/")).is_err());
    }

    #[test]
    fn names_are_unique_and_safe() {
        let taken = vec!["app".to_string(), "app-2".to_string()];
        assert_eq!(unique_name("app", &taken), "app-3");
        assert_eq!(unique_name("web", &taken), "web");
        assert_eq!(unique_name("it's $cool", &[]), "its cool");
        assert_eq!(unique_name("$$$", &[]), "shell");
        assert_eq!(unique_name(&"n".repeat(80), &[]).chars().count(), 64);
        let clashing = unique_name(&"n".repeat(80), &["n".repeat(64)]);
        assert!(clashing.chars().count() <= 64, "{clashing}");
        assert_ne!(clashing, "n".repeat(64));
    }

    #[test]
    fn startup_lines() {
        assert_eq!(startup_line(&def("a", Some(cc(false, false)), None)).unwrap(), "claude --session-id 5e2b8a52-0000-4000-8000-000000000001");
        assert_eq!(startup_line(&def("a", Some(cc(true, true)), None)).unwrap(), "claude --dangerously-skip-permissions --resume 5e2b8a52-0000-4000-8000-000000000001");
        assert_eq!(startup_line(&def("a", Some(cc(true, false)), Some("  npm run dev "))).unwrap(), "npm run dev");
        assert_eq!(startup_line(&def("a", None, None)), None);
        let mut off = cc(true, false);
        off.enabled = false;
        assert_eq!(startup_line(&def("a", Some(off), None)), None);
    }

    #[test]
    fn a_session_counts_as_started_when_its_transcript_exists() {
        let h = tmp("started");
        let d = def("a", Some(cc(false, false)), None);
        assert!(!session_started(&h, &d));
        let path = crate::transcript::guess_path(&h, &d.cwd, &d.claude.as_ref().unwrap().session_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}\n").unwrap();
        assert!(session_started(&h, &d));
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn adding_a_def_stamps_origin_and_bumps_the_revision() {
        let mut ws = empty_workspace();
        add_def(&mut ws, def("a", Some(cc(false, false)), None), "mini", "2026-09-16T10:00:00.000Z");
        assert_eq!(ws.terminals[0].extra["origin"], "mini");
        assert_eq!(ws.extra["sync"], json!({"revision": 1, "updatedAt": "2026-09-16T10:00:00.000Z", "updatedBy": "mini"}));
        add_def(&mut ws, def("b", None, None), "mini", "2026-09-16T10:00:01.000Z");
        assert_eq!(ws.extra["sync"]["revision"], 2);
        assert_eq!(ws.terminals.len(), 2);
        // The written file reads back.
        let h = tmp("write");
        let path = workspace_file(&h);
        crate::workspace::save_to(&path, &ws).unwrap();
        let back = crate::workspace::load_from(&path).unwrap().unwrap();
        assert_eq!(back.terminals[1].id, "b");
        let _ = std::fs::remove_dir_all(&h);
    }
}
