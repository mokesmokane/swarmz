//! Claude Code transcripts as conversation messages for the phone (spec §4.3).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageRef {
    pub id: String,
    pub mime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolView {
    pub name: String,
    pub summary: String,
    pub ok: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: String,
    pub ts: String,
    pub role: String,
    pub text: String,
    pub images: Vec<ImageRef>,
    pub tools: Vec<ToolView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    New(usize),
    Updated(usize),
}

#[derive(Debug, Clone)]
struct Tool {
    name: String,
    target: String,
    ok: Option<bool>,
}

#[derive(Debug, Clone)]
struct Msg {
    id: String,
    ts: String,
    role: String,
    api_id: Option<String>,
    text: String,
    images: Vec<ImageRef>,
    tools: Vec<Tool>,
}

#[derive(Default)]
pub struct Normaliser {
    msgs: Vec<Msg>,
    tool_at: HashMap<String, (usize, usize)>,
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or(path).to_string()
}

fn kind(name: &str) -> &'static str {
    match name {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Read" => "read",
        "Grep" | "Glob" => "search",
        _ => "",
    }
}

fn single_summary(t: &Tool) -> String {
    match (kind(&t.name), t.name.as_str()) {
        ("edit", _) => format!("Edited {}", t.target),
        ("read", _) => format!("Read {}", t.target),
        ("search", _) => "Searched".to_string(),
        (_, "Bash") => format!("Ran {}", t.target),
        _ => t.name.clone(),
    }
}

fn combined_ok(tools: &[Tool]) -> Option<bool> {
    if tools.iter().any(|t| t.ok == Some(false)) {
        Some(false)
    } else if tools.iter().any(|t| t.ok.is_none()) {
        None
    } else {
        Some(true)
    }
}

fn collapse(tools: &[Tool]) -> Vec<ToolView> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < tools.len() {
        let k = kind(&tools[i].name);
        let mut j = i + 1;
        if !k.is_empty() {
            while j < tools.len() && kind(&tools[j].name) == k {
                j += 1;
            }
        }
        let run = &tools[i..j];
        let summary = if run.len() == 1 {
            single_summary(&run[0])
        } else {
            match k {
                "edit" => format!("Edited {} files", run.len()),
                "read" => format!("Read {} files", run.len()),
                _ => "Searched".to_string(),
            }
        };
        out.push(ToolView { name: run[0].name.clone(), summary, ok: combined_ok(run) });
        i = j;
    }
    out
}

fn tag_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

/// What a user text shows as, or None when it is not something the user typed.
fn user_text(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.starts_with("[Request interrupted") {
        return None;
    }
    if t.starts_with('<') {
        let name = tag_value(t, "command-name")?;
        let args = tag_value(t, "command-args").unwrap_or_default();
        return Some(if args.is_empty() { name } else { format!("{name} {args}") });
    }
    Some(t.to_string())
}

impl Normaliser {
    pub fn new() -> Normaliser {
        Normaliser::default()
    }

    pub fn push_line(&mut self, line: &str) -> Vec<Change> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
        let flag = |k: &str| v.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
        if flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") {
            return vec![];
        }
        let uuid = v["uuid"].as_str().unwrap_or("").to_string();
        let ts = v["timestamp"].as_str().unwrap_or("").to_string();
        match v["type"].as_str() {
            Some("user") => self.user(&uuid, &ts, &v["message"]["content"]),
            Some("assistant") => self.assistant(&uuid, &ts, &v["message"]),
            _ => vec![],
        }
    }

    fn user(&mut self, uuid: &str, ts: &str, content: &Value) -> Vec<Change> {
        let mut changes = Vec::new();
        let mut texts = Vec::new();
        let mut images = Vec::new();
        if let Some(s) = content.as_str() {
            texts.push(s.to_string());
        } else if let Some(parts) = content.as_array() {
            for (i, p) in parts.iter().enumerate() {
                match p["type"].as_str() {
                    Some("text") => texts.push(p["text"].as_str().unwrap_or("").to_string()),
                    Some("image") => images.push(ImageRef {
                        id: format!("{uuid}-{i}"),
                        mime: p["source"]["media_type"].as_str().unwrap_or("image/png").to_string(),
                    }),
                    Some("tool_result") => {
                        let id = p["tool_use_id"].as_str().unwrap_or("");
                        if let Some(&(m, t)) = self.tool_at.get(id) {
                            self.msgs[m].tools[t].ok = Some(!p["is_error"].as_bool().unwrap_or(false));
                            if !changes.contains(&Change::Updated(m)) {
                                changes.push(Change::Updated(m));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        let text = user_text(&texts.join("\n")).unwrap_or_default();
        if !text.is_empty() || !images.is_empty() {
            self.msgs.push(Msg { id: uuid.to_string(), ts: ts.to_string(), role: "user".into(), api_id: None, text, images, tools: vec![] });
            changes.push(Change::New(self.msgs.len() - 1));
        }
        changes
    }

    fn assistant(&mut self, uuid: &str, ts: &str, message: &Value) -> Vec<Change> {
        let api_id = message["id"].as_str().map(str::to_string);
        let mut changes = Vec::new();
        for p in message["content"].as_array().cloned().unwrap_or_default() {
            match p["type"].as_str() {
                Some("text") => {
                    let text = p["text"].as_str().unwrap_or("").trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    let last = self.msgs.len().checked_sub(1);
                    let merge = last.filter(|&i| {
                        let m = &self.msgs[i];
                        m.role == "assistant" && m.tools.is_empty() && m.api_id.is_some() && m.api_id == api_id
                    });
                    if let Some(i) = merge {
                        let m = &mut self.msgs[i];
                        m.text = if m.text.is_empty() { text } else { format!("{}\n\n{text}", m.text) };
                        changes.push(Change::Updated(i));
                    } else {
                        self.msgs.push(Msg { id: uuid.to_string(), ts: ts.to_string(), role: "assistant".into(), api_id: api_id.clone(), text, images: vec![], tools: vec![] });
                        changes.push(Change::New(self.msgs.len() - 1));
                    }
                }
                Some("tool_use") => {
                    let name = p["name"].as_str().unwrap_or("tool").to_string();
                    let input = &p["input"];
                    let target = match kind(&name) {
                        "edit" | "read" => file_name(input["file_path"].as_str().or(input["notebook_path"].as_str()).unwrap_or("")),
                        _ if name == "Bash" => input["command"].as_str().unwrap_or("").split_whitespace().next().unwrap_or("").to_string(),
                        _ => String::new(),
                    };
                    let idx = match self.msgs.last() {
                        Some(m) if m.role == "assistant" => self.msgs.len() - 1,
                        _ => {
                            self.msgs.push(Msg { id: uuid.to_string(), ts: ts.to_string(), role: "assistant".into(), api_id: api_id.clone(), text: String::new(), images: vec![], tools: vec![] });
                            changes.push(Change::New(self.msgs.len() - 1));
                            self.msgs.len() - 1
                        }
                    };
                    self.msgs[idx].tools.push(Tool { name, target, ok: None });
                    if let Some(id) = p["id"].as_str() {
                        self.tool_at.insert(id.to_string(), (idx, self.msgs[idx].tools.len() - 1));
                    }
                    if !changes.contains(&Change::New(idx)) && !changes.contains(&Change::Updated(idx)) {
                        changes.push(Change::Updated(idx));
                    }
                }
                _ => {}
            }
        }
        changes
    }

    pub fn view(&self, i: usize) -> MessageView {
        let m = &self.msgs[i];
        MessageView { id: m.id.clone(), ts: m.ts.clone(), role: m.role.clone(), text: m.text.clone(), images: m.images.clone(), tools: collapse(&m.tools) }
    }

    pub fn views(&self) -> Vec<MessageView> {
        (0..self.msgs.len()).map(|i| self.view(i)).collect()
    }
}

/// Up to `limit` messages just older than `before` (the newest when None), oldest first, and
/// whether older ones remain. An unknown `before` gives an empty page.
pub fn page(all: &[MessageView], before: Option<&str>, limit: usize) -> (Vec<MessageView>, bool) {
    let end = match before {
        None => all.len(),
        Some(id) => match all.iter().position(|m| m.id == id) {
            Some(i) => i,
            None => return (vec![], false),
        },
    };
    let start = end.saturating_sub(limit);
    (all[start..end].to_vec(), start > 0)
}

/// The message with id `id` (whose tools may have changed) and every newer one, or None when no
/// message has that id.
pub fn after(all: &[MessageView], id: &str) -> Option<Vec<MessageView>> {
    all.iter().position(|m| m.id == id).map(|i| all[i..].to_vec())
}

/// `(mime, base64)` of image `<uuid>-<index>` in the transcript.
pub fn image(path: &Path, image_id: &str) -> Option<(String, String)> {
    let (uuid, index) = image_id.rsplit_once('-')?;
    let index: usize = index.parse().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines() {
        if !line.contains(uuid) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["uuid"].as_str() != Some(uuid) {
            continue;
        }
        let part = v["message"]["content"].as_array()?.get(index)?;
        if part["type"].as_str() != Some("image") {
            return None;
        }
        let mime = part["source"]["media_type"].as_str()?.to_string();
        let data = part["source"]["data"].as_str()?.to_string();
        return Some((mime, data));
    }
    None
}

/// The newest main-thread assistant text, cut to `max` characters, reading only the file's tail.
pub fn last_assistant_text(path: &Path, max: usize) -> Option<String> {
    const TAIL: u64 = 512 * 1024;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"].as_str() != Some("assistant") || v["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        let found = v["message"]["content"].as_array().and_then(|parts| {
            parts.iter().rev().find_map(|p| (p["type"].as_str() == Some("text")).then(|| p["text"].as_str().unwrap_or("").trim().to_string()))
        });
        if let Some(t) = found.filter(|t| !t.is_empty()) {
            return Some(t.chars().take(max).collect());
        }
    }
    None
}

/// How much of a transcript's end is read to find a `continued-in` record.
const CONTINUED_TAIL: u64 = 64 * 1024;
/// The most `continued-in` records followed from one transcript.
const CONTINUED_HOPS: usize = 10;

/// The last `CONTINUED_TAIL` bytes of a file.
fn tail(path: &Path) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(CONTINUED_TAIL))).ok()?;
    let mut buf = Vec::new();
    f.take(CONTINUED_TAIL).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// The session a transcript says it continued in: its last complete record is `continued-in` with
/// a UUID `continuedInSessionId`. Reads only the tail. A final line with no newline after it is
/// half written and skipped; any other line that is not JSON ends the chain, so a record appended
/// to a resumed old session can never make this flap between two files.
pub fn continued_in(path: &Path) -> Option<String> {
    let buf = tail(path)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if !buf.ends_with(b"\n") {
        lines.pop();
    }
    let last = serde_json::from_str::<Value>(lines.iter().rev().find(|l| !l.trim().is_empty())?).ok()?;
    if last["type"].as_str() != Some("continued-in") {
        return None;
    }
    let id = last["continuedInSessionId"].as_str()?;
    crate::util::valid_uuid(id).then(|| id.to_string())
}

/// `resolve_continued` with the step supplied (a poller caches `continued_in` per file).
pub fn resolve_continued_by(path: &Path, next: &dyn Fn(&Path) -> Option<String>) -> (PathBuf, Option<String>) {
    let mut at = path.to_path_buf();
    let mut session = None;
    let mut seen = vec![at.clone()];
    for _ in 0..CONTINUED_HOPS {
        let Some(id) = next(&at).filter(|id| crate::util::valid_uuid(id)) else { break };
        let Some(dir) = at.parent() else { break };
        let target = dir.join(format!("{id}.jsonl"));
        if seen.contains(&target) || !target.is_file() {
            break;
        }
        seen.push(target.clone());
        at = target;
        session = Some(id);
    }
    (at, session)
}

/// Where a transcript's conversation lives now: Claude can move a conversation into a new session
/// file in the same folder, ending the old file with a `continued-in` record. Follows those
/// records (at most ten, stopping on a cycle or a missing file) and returns the final file and,
/// when it moved, that file's session id (None means the caller's id still holds). The new file is
/// always a UUID name joined to the same folder, so a record can never lead elsewhere.
pub fn resolve_continued(path: &Path) -> (PathBuf, Option<String>) {
    resolve_continued_by(path, &continued_in)
}

/// Where Claude keeps a session's transcript when no hook event has said: every character of the
/// folder that is not a letter, digit or `-` becomes `-`. None when the session id is not a UUID,
/// so an id can never lead the path elsewhere.
pub fn guess_path(home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if !crate::util::valid_uuid(session_id) {
        return None;
    }
    let dir: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    Some(home.join(".claude").join("projects").join(dir).join(format!("{session_id}.jsonl")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(uuid: &str, content: serde_json::Value) -> String {
        json!({"type": "user", "uuid": uuid, "timestamp": format!("2026-09-16T10:00:{uuid}Z"), "isSidechain": false, "message": {"role": "user", "content": content}}).to_string()
    }

    fn assistant(uuid: &str, msg_id: &str, part: serde_json::Value) -> String {
        json!({"type": "assistant", "uuid": uuid, "timestamp": format!("2026-09-16T10:01:{uuid}Z"), "isSidechain": false, "message": {"id": msg_id, "role": "assistant", "content": [part]}}).to_string()
    }

    fn tool_use(id: &str, name: &str, input: serde_json::Value) -> serde_json::Value {
        json!({"type": "tool_use", "id": id, "name": name, "input": input})
    }

    fn tool_result(uuid: &str, id: &str, is_error: bool) -> String {
        user(uuid, json!([{"type": "tool_result", "tool_use_id": id, "content": "x", "is_error": is_error}]))
    }

    fn run(lines: &[String]) -> Vec<MessageView> {
        let mut n = Normaliser::new();
        for l in lines {
            n.push_line(l);
        }
        n.views()
    }

    #[test]
    fn a_conversation_with_tools_is_grouped() {
        let lines = vec![
            user("01", json!("fix the bug")),
            assistant("02", "m1", json!({"type": "thinking", "thinking": "hmm"})),
            assistant("03", "m1", json!({"type": "text", "text": "Looking."})),
            assistant("04", "m1", tool_use("t1", "Read", json!({"file_path": "/p/a.rs"}))),
            tool_result("05", "t1", false),
            assistant("06", "m1", tool_use("t2", "Read", json!({"file_path": "/p/b.rs"}))),
            tool_result("07", "t2", false),
            assistant("08", "m2", tool_use("t3", "Edit", json!({"file_path": "/p/a.rs"}))),
            tool_result("09", "t3", false),
            assistant("10", "m2", tool_use("t4", "Bash", json!({"command": "cargo test --all"}))),
            tool_result("11", "t4", true),
            assistant("12", "m3", json!({"type": "text", "text": "Fixed."})),
        ];
        let m = run(&lines);
        assert_eq!(m.len(), 3, "{m:?}");
        assert_eq!((m[0].role.as_str(), m[0].text.as_str(), m[0].id.as_str()), ("user", "fix the bug", "01"));
        assert_eq!(m[1].text, "Looking.");
        let tools: Vec<(String, Option<bool>)> = m[1].tools.iter().map(|t| (t.summary.clone(), t.ok)).collect();
        assert_eq!(
            tools,
            vec![("Read 2 files".to_string(), Some(true)), ("Edited a.rs".to_string(), Some(true)), ("Ran cargo".to_string(), Some(false))]
        );
        assert_eq!(m[1].tools[2].name, "Bash");
        assert_eq!((m[2].text.as_str(), m[2].tools.len()), ("Fixed.", 0));
    }

    #[test]
    fn dropped_entries_and_slash_commands() {
        let lines = vec![
            json!({"type": "user", "uuid": "a1", "isMeta": true, "message": {"role": "user", "content": "caveat"}}).to_string(),
            json!({"type": "assistant", "uuid": "a2", "isSidechain": true, "message": {"id": "x", "role": "assistant", "content": [{"type": "text", "text": "sub"}]}}).to_string(),
            json!({"type": "system", "uuid": "a3"}).to_string(),
            json!({"type": "attachment", "uuid": "a4"}).to_string(),
            user("a5", json!("<local-command-stdout>done</local-command-stdout>")),
            user("a6", json!("<task-notification>x</task-notification>")),
            user("a7", json!("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>")),
            user("a8", json!([{"type": "text", "text": "[Request interrupted by user]"}])),
            "not json at all".to_string(),
        ];
        let m = run(&lines);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(m[0].text, "/review 123");
    }

    #[test]
    fn tools_before_any_text_start_an_empty_message_and_images_are_listed() {
        let lines = vec![
            user("b1", json!([{"type": "text", "text": "look"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBO"}}])),
            assistant("b2", "m1", tool_use("t1", "Grep", json!({"pattern": "x"}))),
            assistant("b3", "m1", tool_use("t2", "Glob", json!({"pattern": "*.rs"}))),
        ];
        let m = run(&lines);
        assert_eq!(m[0].images, vec![ImageRef { id: "b1-1".into(), mime: "image/png".into() }]);
        assert_eq!((m[1].id.as_str(), m[1].text.as_str()), ("b2", ""));
        assert_eq!(m[1].tools.len(), 1);
        assert_eq!((m[1].tools[0].summary.as_str(), m[1].tools[0].ok), ("Searched", None));
    }

    #[test]
    fn changes_report_new_and_updated_messages() {
        let mut n = Normaliser::new();
        assert_eq!(n.push_line(&user("c1", json!("hi"))), vec![Change::New(0)]);
        assert_eq!(n.push_line(&assistant("c2", "m", json!({"type": "text", "text": "a"}))), vec![Change::New(1)]);
        assert_eq!(n.push_line(&assistant("c3", "m", json!({"type": "text", "text": "b"}))), vec![Change::Updated(1)]);
        assert_eq!(n.view(1).text, "a\n\nb");
        assert_eq!(n.push_line(&assistant("c4", "m", tool_use("t", "Write", json!({"file_path": "/z/new.txt"})))), vec![Change::Updated(1)]);
        assert_eq!(n.push_line(&tool_result("c5", "t", false)), vec![Change::Updated(1)]);
        assert_eq!(n.push_line(&json!({"type": "system"}).to_string()), vec![]);
        assert_eq!(n.view(1).tools[0].summary, "Edited new.txt");
    }

    #[test]
    fn paging_is_newest_first_by_page_and_after_resumes() {
        let lines: Vec<String> = (0..10).map(|i| user(&format!("{i:02}"), json!(format!("m{i}")))).collect();
        let all = run(&lines);
        let (p, more) = page(&all, None, 3);
        assert_eq!(p.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["m7", "m8", "m9"]);
        assert!(more);
        let (p, more) = page(&all, Some("07"), 5);
        assert_eq!(p.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["m2", "m3", "m4", "m5", "m6"]);
        assert!(more);
        let (p, more) = page(&all, Some("02"), 5);
        assert_eq!(p.len(), 2);
        assert!(!more);
        let (p, _) = page(&all, Some("unknown"), 5);
        assert!(p.is_empty());
        let a = after(&all, "07").unwrap();
        assert_eq!(a.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["m7", "m8", "m9"]);
        assert_eq!(after(&all, "unknown"), None);
    }

    #[test]
    fn images_and_the_last_assistant_text_come_from_the_file() {
        let dir = std::path::PathBuf::from(format!("/tmp/szc-{}-transcript", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let long = "y".repeat(300);
        let lines = [
            user("d1", json!([{"type": "text", "text": "see"}, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}}])),
            assistant("d2", "m", json!({"type": "text", "text": long})),
            assistant("d3", "m", tool_use("t", "Bash", json!({"command": "ls"}))),
            json!({"type": "assistant", "uuid": "d4", "isSidechain": true, "message": {"id": "q", "content": [{"type": "text", "text": "from a subagent"}]}}).to_string(),
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        assert_eq!(image(&path, "d1-1"), Some(("image/jpeg".to_string(), "AAAA".to_string())));
        assert_eq!(image(&path, "d1-0"), None);
        assert_eq!(image(&path, "zz-1"), None);
        assert_eq!(last_assistant_text(&path, 240).unwrap().chars().count(), 240);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn chain_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(format!("/tmp/szc-{}-chain-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn continued(old: &str, new: &str) -> String {
        json!({"type": "continued-in", "timestamp": "2026-09-17T09:00:00Z", "sessionId": old, "continuedInSessionId": new}).to_string()
    }

    const S1: &str = "11111111-0000-4000-8000-000000000001";
    const S2: &str = "22222222-0000-4000-8000-000000000002";
    const S3: &str = "33333333-0000-4000-8000-000000000003";

    fn write_session(dir: &Path, sid: &str, last: Option<String>) -> PathBuf {
        let path = dir.join(format!("{sid}.jsonl"));
        let mut lines = vec![user("e1", json!(format!("in {sid}")))];
        lines.extend(last);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    #[test]
    fn a_session_without_a_continuation_stays_put() {
        let dir = chain_dir("none");
        let p = write_session(&dir, S1, None);
        assert_eq!(resolve_continued(&p), (p.clone(), None));
        let missing = dir.join(format!("{S3}.jsonl"));
        assert_eq!(resolve_continued(&missing), (missing.clone(), None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn continuations_are_followed_one_and_two_hops() {
        let dir = chain_dir("hops");
        let p1 = write_session(&dir, S1, Some(continued(S1, S2)));
        let p2 = write_session(&dir, S2, None);
        assert_eq!(resolve_continued(&p1), (p2.clone(), Some(S2.to_string())));
        let p2 = write_session(&dir, S2, Some(continued(S2, S3)));
        let p3 = write_session(&dir, S3, None);
        assert_eq!(resolve_continued(&p1), (p3.clone(), Some(S3.to_string())));
        assert_eq!(resolve_continued(&p2), (p3, Some(S3.to_string())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cycle_or_a_long_chain_stops() {
        let dir = chain_dir("cycle");
        let p1 = write_session(&dir, S1, Some(continued(S1, S2)));
        write_session(&dir, S2, Some(continued(S2, S1)));
        // A -> B -> A stops at B, the last file the chain had not seen.
        assert_eq!(resolve_continued(&p1), (dir.join(format!("{S2}.jsonl")), Some(S2.to_string())));
        let self_loop = write_session(&dir, S3, Some(continued(S3, S3)));
        assert_eq!(resolve_continued(&self_loop).0, self_loop);
        // A chain longer than ten hops ends after ten.
        let ids: Vec<String> = (0..15).map(|i| format!("44444444-0000-4000-8000-{i:012}")).collect();
        for w in ids.windows(2) {
            write_session(&dir, &w[0], Some(continued(&w[0], &w[1])));
        }
        write_session(&dir, &ids[14], None);
        let (end, sid) = resolve_continued(&dir.join(format!("{}.jsonl", ids[0])));
        assert_eq!(end, dir.join(format!("{}.jsonl", ids[10])));
        assert_eq!(sid.as_deref(), Some(ids[10].as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_or_missing_targets_are_not_followed() {
        let dir = chain_dir("bad");
        let missing = write_session(&dir, S1, Some(continued(S1, S2)));
        assert_eq!(resolve_continued(&missing), (missing.clone(), None));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/x.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("not-a-uuid.jsonl"), "{}\n").unwrap();
        for target in ["not-a-uuid", "sub/x", "../x", &format!("../{S3}")] {
            let p = write_session(&dir, S3, Some(continued(S3, target)));
            assert_eq!(resolve_continued(&p), (p.clone(), None), "{target}");
        }
        // A complete line that is not JSON ends the chain: only a half-written final record (no
        // newline after it) is skipped, so a resumed old session cannot flap between files.
        write_session(&dir, S2, None);
        let broken = dir.join("broken.jsonl");
        std::fs::write(&broken, continued(S1, S2) + "\nnot json at all\n").unwrap();
        assert_eq!(resolve_continued(&broken), (broken.clone(), None));
        let half = dir.join("half.jsonl");
        std::fs::write(&half, continued(S1, S2) + "\n{\"type\":\"user\",\"uuid\"").unwrap();
        assert_eq!(resolve_continued(&half), (dir.join(format!("{S2}.jsonl")), Some(S2.to_string())));
        // Only the last record counts.
        write_session(&dir, S2, None);
        let p = write_session(&dir, S1, Some(continued(S1, S2) + "\n" + &user("e9", json!("later"))));
        assert_eq!(resolve_continued(&p), (p.clone(), None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_tail_of_a_huge_file_is_read() {
        let dir = chain_dir("huge");
        write_session(&dir, S2, None);
        let p1 = dir.join(format!("{S1}.jsonl"));
        // A head far bigger than the tail read, whose one line is cut by it.
        let head = "x".repeat(8 * 1024 * 1024);
        std::fs::write(&p1, format!("{{\"type\":\"user\",\"pad\":\"{head}\"}}\n{}\n", continued(S1, S2))).unwrap();
        assert!(tail(&p1).unwrap().len() as u64 <= CONTINUED_TAIL);
        assert_eq!(resolve_continued(&p1), (dir.join(format!("{S2}.jsonl")), Some(S2.to_string())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn guessed_paths_follow_claudes_project_naming() {
        let sid = "5e2b8a52-0000-4000-8000-000000000001";
        let p = guess_path(std::path::Path::new("/h"), "/Users/me/my.app/x_y", sid);
        assert_eq!(p, Some(std::path::PathBuf::from(format!("/h/.claude/projects/-Users-me-my-app-x-y/{sid}.jsonl"))));
        assert_eq!(guess_path(std::path::Path::new("/h"), "/p", "abc"), None);
        assert_eq!(guess_path(std::path::Path::new("/h"), "/p", "../../x"), None);
    }
}
