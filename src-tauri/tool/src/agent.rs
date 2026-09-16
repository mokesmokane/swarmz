//! The hook log (`~/.swarmz/agents/events.log`) folded into per-tile agent status (spec §4.2).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Notification types that mean Claude is waiting on the user (same set as `agentState.ts`).
pub const BLOCKING_NOTIFICATIONS: [&str; 5] = ["permission_prompt", "idle_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"];

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub ts: String,
    pub terminal: String,
    pub event: String,
    pub session_id: Option<String>,
    pub notification_type: Option<String>,
    pub permission_mode: Option<String>,
    pub transcript_path: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
}

pub fn parse_line(line: &str) -> Option<Event> {
    let mut parts = line.splitn(4, '\t');
    let ts = parts.next()?.trim();
    let terminal = parts.next()?.trim();
    let event = parts.next()?.trim();
    let v: Value = serde_json::from_str(parts.next()?).ok()?;
    if ts.is_empty() || terminal.is_empty() || event.is_empty() {
        return None;
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(Event {
        ts: ts.to_string(),
        terminal: terminal.to_string(),
        event: event.to_string(),
        session_id: s("session_id"),
        notification_type: s("notification_type"),
        permission_mode: s("permission_mode"),
        transcript_path: s("transcript_path"),
        tool_name: s("tool_name"),
        tool_input: v.get("tool_input").cloned(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Offline,
    Working,
    Idle,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Needs {
    Permission,
    Question,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fold {
    pub status: Status,
    pub session_id: Option<String>,
    pub since: Option<String>,
    pub last_event: Option<String>,
    pub needs: Option<Needs>,
    pub mode: Option<String>,
    pub turn_ended_at: Option<String>,
    pub transcript_path: Option<String>,
    /// What the pending permission is for (spec §4.4), while `needs` is `permission`.
    pub summary: Option<String>,
    pub tool: Option<String>,
}

impl Fold {
    /// Folds one event; false when it changes nothing (spec §4.2, `agentState.ts`).
    pub fn apply(&mut self, ev: &Event) -> bool {
        let next_status = match ev.event.as_str() {
            "SessionStart" => Status::Idle,
            "UserPromptSubmit" => Status::Working,
            "Stop" | "StopFailure" => Status::Idle,
            "Notification" => match ev.notification_type.as_deref() {
                Some(t) if BLOCKING_NOTIFICATIONS.contains(&t) => Status::Blocked,
                _ => return false,
            },
            "PermissionRequest" => Status::Blocked,
            "PostToolUse" if self.status == Status::Blocked => Status::Working,
            "SessionEnd" => Status::Offline,
            _ => return false,
        };
        match ev.event.as_str() {
            "SessionStart" => {
                self.session_id = ev.session_id.clone();
                if ev.transcript_path.is_some() {
                    self.transcript_path = ev.transcript_path.clone();
                }
                self.clear_block();
            }
            "Stop" | "StopFailure" => {
                self.turn_ended_at = Some(ev.ts.clone());
                self.clear_block();
            }
            "Notification" => {
                let permission = ev.notification_type.as_deref() == Some("permission_prompt");
                // A permission prompt that follows its PermissionRequest keeps that summary.
                if !(permission && self.needs == Some(Needs::Permission)) {
                    self.summary = None;
                    self.tool = None;
                }
                self.needs = Some(if permission { Needs::Permission } else { Needs::Question });
            }
            "PermissionRequest" => {
                let tool = ev.tool_name.clone().unwrap_or_else(|| "a tool".to_string());
                self.summary = Some(permission_summary(&tool, ev.tool_input.as_ref()));
                self.tool = Some(tool);
                self.needs = Some(Needs::Permission);
            }
            "SessionEnd" => {
                self.session_id = None;
                self.clear_block();
            }
            _ => self.clear_block(),
        }
        if let Some(m) = &ev.permission_mode {
            self.mode = Some(mode_label(m));
        }
        self.status = next_status;
        self.since = Some(ev.ts.clone());
        self.last_event = Some(ev.event.clone());
        true
    }

    fn clear_block(&mut self) {
        self.needs = None;
        self.summary = None;
        self.tool = None;
    }
}

/// Folds a whole log, oldest line first, into a state per tile id.
pub fn fold_log(text: &str) -> HashMap<String, Fold> {
    let mut out: HashMap<String, Fold> = HashMap::new();
    for ev in text.lines().filter_map(parse_line) {
        out.entry(ev.terminal.clone()).or_default().apply(&ev);
    }
    out
}

/// The rotated log (`events.log.1`) followed by the current one.
pub fn read_log(home: &Path) -> String {
    let dir = home.join(".swarmz").join("agents");
    let mut text = std::fs::read_to_string(dir.join("events.log.1")).unwrap_or_default();
    text.push_str(&std::fs::read_to_string(dir.join("events.log")).unwrap_or_default());
    text
}

pub fn permission_summary(tool: &str, input: Option<&Value>) -> String {
    let field = |k: &str| input.and_then(|i| i.get(k)).and_then(|v| v.as_str()).map(str::to_string);
    let raw = match tool {
        "Bash" => field("command").map(|c| c.lines().next().unwrap_or("").to_string()),
        "Edit" | "Write" | "MultiEdit" => field("file_path"),
        "NotebookEdit" => field("notebook_path"),
        "WebFetch" => field("url"),
        _ => None,
    };
    let s = raw.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| tool.to_string());
    s.chars().take(200).collect()
}

pub fn mode_label(mode: &str) -> String {
    match mode {
        "acceptEdits" => "accept edits".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn line(ts: &str, tile: &str, event: &str, input: &Value) -> String {
        format!("{ts}\t{tile}\t{event}\t{input}")
    }

    #[test]
    fn the_shared_fixture_folds_the_same_way() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/agent-status.json")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
        for case in cases {
            let log: Vec<String> = case["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| line(e["ts"].as_str().unwrap(), "t1", e["event"].as_str().unwrap(), &e["input"]))
                .collect();
            let folds = fold_log(&log.join("\n"));
            let f = folds.get("t1").cloned().unwrap_or_default();
            let got = serde_json::to_value(&f).unwrap();
            for key in ["status", "sessionId", "needs", "mode", "turnEndedAt"] {
                assert_eq!(got[key], case["expect"][key], "{}: {key}", case["name"]);
            }
        }
    }

    #[test]
    fn parse_line_reads_every_field_and_rejects_junk() {
        let input = json!({"session_id": "s", "transcript_path": "/t.jsonl", "tool_name": "Bash", "tool_input": {"command": "ls -la"}, "permission_mode": "plan"});
        let ev = parse_line(&line("t", "id", "PermissionRequest", &input)).unwrap();
        assert_eq!(ev.session_id.as_deref(), Some("s"));
        assert_eq!(ev.transcript_path.as_deref(), Some("/t.jsonl"));
        assert_eq!(ev.tool_name.as_deref(), Some("Bash"));
        assert_eq!(ev.tool_input.as_ref().unwrap()["command"], "ls -la");
        assert!(parse_line("garbage").is_none());
        assert!(parse_line("t\tid\tStop\tnot json").is_none());
        assert!(parse_line("\tid\tStop\t{}").is_none());
    }

    #[test]
    fn a_permission_request_records_its_summary_until_the_turn_moves_on() {
        let log = [
            line("1", "a", "SessionStart", &json!({"session_id": "s", "transcript_path": "/p/s.jsonl"})),
            line("2", "a", "PermissionRequest", &json!({"session_id": "s", "tool_name": "Edit", "tool_input": {"file_path": "/p/src/main.rs"}})),
        ]
        .join("\n");
        let f = fold_log(&log).remove("a").unwrap();
        assert_eq!(f.summary.as_deref(), Some("/p/src/main.rs"));
        assert_eq!(f.tool.as_deref(), Some("Edit"));
        assert_eq!(f.transcript_path.as_deref(), Some("/p/s.jsonl"));
        let later = format!("{log}\n{}", line("3", "a", "UserPromptSubmit", &json!({"session_id": "s"})));
        let f = fold_log(&later).remove("a").unwrap();
        assert_eq!((f.summary, f.tool), (None, None));
        assert_eq!(f.transcript_path.as_deref(), Some("/p/s.jsonl"));
    }

    #[test]
    fn summaries_by_tool() {
        assert_eq!(permission_summary("Bash", Some(&json!({"command": "git push\n--force"}))), "git push");
        assert_eq!(permission_summary("Write", Some(&json!({"file_path": "/a/b.txt"}))), "/a/b.txt");
        assert_eq!(permission_summary("NotebookEdit", Some(&json!({"notebook_path": "/n.ipynb"}))), "/n.ipynb");
        assert_eq!(permission_summary("WebFetch", Some(&json!({"url": "https://x.dev"}))), "https://x.dev");
        assert_eq!(permission_summary("Task", Some(&json!({}))), "Task");
        assert_eq!(permission_summary("Bash", None), "Bash");
        assert_eq!(permission_summary("Bash", Some(&json!({"command": "x".repeat(500)}))).chars().count(), 200);
    }

    #[test]
    fn modes_are_labelled() {
        assert_eq!(mode_label("acceptEdits"), "accept edits");
        assert_eq!(mode_label("plan"), "plan");
        assert_eq!(mode_label("default"), "default");
        assert_eq!(mode_label("bypassPermissions"), "bypassPermissions");
    }

    #[test]
    fn read_log_joins_the_rotated_file_first() {
        let home = std::path::PathBuf::from(format!("/tmp/szc-{}-agentlog", std::process::id()));
        let dir = home.join(".swarmz/agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("events.log.1"), "old\n").unwrap();
        std::fs::write(dir.join("events.log"), "new\n").unwrap();
        assert_eq!(read_log(&home), "old\nnew\n");
        std::fs::remove_file(dir.join("events.log.1")).unwrap();
        assert_eq!(read_log(&home), "new\n");
        let _ = std::fs::remove_dir_all(&home);
    }
}
