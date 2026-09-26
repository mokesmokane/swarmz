//! A tile's board (tile board spec): the agent's own picture of its work (where it is, its plan,
//! its changes, its questions, who it talks to), shown in the header over the tile's pane.
//! `swarmz board` reads it as JSON, keeps only the known fields within their limits, writes it to
//! `~/.swarmz/boards/<tile>.json` and appends a `Board` event carrying it to `events.log`, so the
//! desktop's agent watchers deliver it live.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The most characters any string on a board keeps.
pub const TEXT_MAX: usize = 400;
/// The colour schemes a board may pick (tile board spec §1).
pub const SCHEMES: [&str; 6] = ["Lagoon", "Heather", "Ember", "Moss", "Harbor", "Rosewood"];

pub fn dir(home: &Path) -> PathBuf {
    home.join(".swarmz").join("boards")
}

pub fn path(home: &Path, tile: &str) -> PathBuf {
    dir(home).join(format!("{tile}.json"))
}

fn text(v: &Value) -> Option<Value> {
    let s = v.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(Value::String(s.chars().take(TEXT_MAX).collect()))
}

fn obj(fields: Vec<(&str, Option<Value>)>) -> Option<Value> {
    let m: Map<String, Value> = fields.into_iter().filter_map(|(k, v)| v.map(|v| (k.to_string(), v))).collect();
    (!m.is_empty()).then_some(Value::Object(m))
}

fn list(v: &Value, max: usize, each: impl Fn(&Value) -> Option<Value>) -> Option<Value> {
    let items: Vec<Value> = v.as_array()?.iter().filter_map(&each).take(max).collect();
    (!items.is_empty()).then_some(Value::Array(items))
}

fn count(v: &Value) -> Option<Value> {
    v.as_u64().map(|n| json!(n.min(1_000_000)))
}

/// The board with only the known fields, each within its limits; None when nothing is left.
pub fn clean(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let get = |k: &str| o.get(k).unwrap_or(&Value::Null);
    let scheme = get("scheme").as_str().and_then(|s| SCHEMES.iter().find(|x| x.eq_ignore_ascii_case(s.trim()))).map(|s| json!(s));
    let ov = get("overview");
    let overview = obj(vec![
        ("goal", text(&ov["goal"])),
        ("now", text(&ov["now"])),
        ("next", text(&ov["next"])),
        ("needsYou", ov["needsYou"].as_bool().map(Value::Bool)),
    ]);
    let pl = get("plan");
    let plan = obj(vec![
        ("title", text(&pl["title"])),
        (
            "steps",
            list(&pl["steps"], 8, |s| {
                let t = text(&s["t"])?;
                let state = match s["s"].as_str().unwrap_or("todo") {
                    "done" => "done",
                    "current" | "doing" => "current",
                    _ => "todo",
                };
                obj(vec![("t", Some(t)), ("d", text(&s["d"])), ("s", Some(json!(state)))])
            }),
        ),
    ]);
    let ch = get("changes");
    let changes = obj(vec![
        ("branch", text(&ch["branch"])),
        ("base", text(&ch["base"])),
        ("flags", list(&ch["flags"], 4, text)),
        ("rows", list(&ch["rows"], 8, |r| obj(vec![("p", Some(text(&r["p"])?)), ("a", count(&r["a"])), ("r", count(&r["r"]))]))),
        ("note", text(&ch["note"])),
    ]);
    let questions = list(get("questions"), 4, |q| obj(vec![("q", Some(text(&q["q"])?)), ("o", list(&q["o"], 4, text))]));
    let sw = get("swarm");
    let swarm = obj(vec![
        ("tiles", list(&sw["tiles"], 6, |t| obj(vec![("n", Some(text(&t["n"])?)), ("d", text(&t["d"])), ("bad", t["bad"].as_bool().filter(|b| *b).map(Value::Bool))]))),
        ("agents", list(&sw["agents"], 8, |a| obj(vec![("n", Some(text(&a["n"])?)), ("t", text(&a["t"])), ("k", text(&a["k"]))]))),
    ]);
    obj(vec![("scheme", scheme), ("overview", overview), ("plan", plan), ("changes", changes), ("questions", questions), ("swarm", swarm)])
}

/// Writes the tile's board (atomically) and announces it on the hook log. Returns what was kept.
pub fn write(home: &Path, tile: &str, board: &Value, at: &str) -> Result<Value, String> {
    let kept = clean(board).ok_or_else(|| "the board is empty: nothing it knows (overview, plan, changes, questions, swarm, scheme) was given".to_string())?;
    let d = dir(home);
    std::fs::create_dir_all(&d).map_err(|e| format!("could not create {}: {e}", d.display()))?;
    let final_path = path(home, tile);
    let tmp = d.join(format!(".{tile}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&json!({"at": at, "board": kept})).unwrap()).map_err(|e| format!("could not write the board: {e}"))?;
    std::fs::rename(&tmp, &final_path).map_err(|e| format!("could not write the board: {e}"))?;
    announce(home, tile, at, &json!({"board": kept}))?;
    Ok(kept)
}

/// Removes the tile's board; the header goes (an empty `Board` event says so).
pub fn clear(home: &Path, tile: &str, at: &str) -> Result<bool, String> {
    let existed = std::fs::remove_file(path(home, tile)).is_ok();
    announce(home, tile, at, &json!({"board": null}))?;
    Ok(existed)
}

/// The tile's board and when it was written, or None.
pub fn read(home: &Path, tile: &str) -> Option<Value> {
    let v: Value = serde_json::from_slice(&std::fs::read(path(home, tile)).ok()?).ok()?;
    v.get("board").filter(|b| b.is_object())?;
    Some(v)
}

/// One `Board` line on the hook log, in the hook script's format (`ts \t tile \t event \t json`),
/// written in a single append so it never interleaves with a hook's line.
fn announce(home: &Path, tile: &str, at: &str, payload: &Value) -> Result<(), String> {
    let dir = home.join(".swarmz").join("agents");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let line = format!("{at}\t{tile}\tBoard\t{}\n", serde_json::to_string(payload).unwrap());
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.log")).map_err(|e| format!("could not open the hook log: {e}"))?;
    f.write_all(line.as_bytes()).map_err(|e| format!("could not write the hook log: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_what_it_knows_within_limits() {
        let long = "x".repeat(900);
        let v = json!({
            "scheme": "ember",
            "overview": {"goal": " Ship it ", "now": long, "needsYou": true, "extra": 1},
            "plan": {"title": "Plan", "steps": [{"t": "a", "s": "done"}, {"t": "b", "s": "doing", "d": "went well"}, {"t": "", "s": "todo"}, {"t": "c", "s": "weird"}]},
            "changes": {"branch": "main", "flags": ["a", "b", "c", "d", "e"], "rows": [{"p": "src", "a": 5, "r": -1}]},
            "questions": [{"q": "Go?", "o": ["Yes", "No"]}, {"o": ["orphan"]}],
            "swarm": {"tiles": [{"n": "↑ ops", "bad": false}, {"n": "✕ relay", "bad": true}], "agents": []},
            "unknown": {"a": 1}
        });
        let c = clean(&v).unwrap();
        assert_eq!(c["scheme"], "Ember");
        assert_eq!(c["overview"]["goal"], "Ship it");
        assert_eq!(c["overview"]["now"].as_str().unwrap().chars().count(), TEXT_MAX);
        assert_eq!(c["overview"]["needsYou"], true);
        assert!(c["overview"].get("extra").is_none());
        assert_eq!(c["plan"]["steps"], json!([{"t": "a", "s": "done"}, {"t": "b", "d": "went well", "s": "current"}, {"t": "c", "s": "todo"}]));
        assert_eq!(c["changes"]["flags"].as_array().unwrap().len(), 4);
        assert_eq!(c["changes"]["rows"], json!([{"p": "src", "a": 5}]));
        assert_eq!(c["questions"], json!([{"q": "Go?", "o": ["Yes", "No"]}]));
        assert_eq!(c["swarm"]["tiles"], json!([{"n": "↑ ops"}, {"n": "✕ relay", "bad": true}]));
        assert!(c["swarm"].get("agents").is_none());
        assert!(c.get("unknown").is_none());
        assert!(clean(&json!({"nothing": 1})).is_none());
        assert!(clean(&json!("text")).is_none());
    }

    #[test]
    fn writes_the_file_and_announces_it_on_the_log_then_clears() {
        let home = std::env::temp_dir().join(format!("szb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let kept = write(&home, "t1", &json!({"overview": {"goal": "G"}}), "2026-09-26T10:00:00Z").unwrap();
        assert_eq!(kept, json!({"overview": {"goal": "G"}}));
        assert_eq!(read(&home, "t1").unwrap()["board"], kept);
        let log = std::fs::read_to_string(home.join(".swarmz/agents/events.log")).unwrap();
        assert_eq!(log, "2026-09-26T10:00:00Z\tt1\tBoard\t{\"board\":{\"overview\":{\"goal\":\"G\"}}}\n");
        assert!(write(&home, "t1", &json!({}), "t").is_err());
        assert!(clear(&home, "t1", "2026-09-26T10:01:00Z").unwrap());
        assert!(read(&home, "t1").is_none());
        assert!(std::fs::read_to_string(home.join(".swarmz/agents/events.log")).unwrap().ends_with("\tt1\tBoard\t{\"board\":null}\n"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
