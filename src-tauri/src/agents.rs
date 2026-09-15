use serde_json::{json, Map, Value};

pub const HOOK_VERSION: u32 = 1;

pub const HOOK_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SessionEnd"];

pub const SCRIPT_MARKER: &str = ".swarmz/hooks/claude.sh";

pub const HOOK_SCRIPT: &str = r#"#!/bin/sh
# installed by swarmz; reinstalling overwrites this file.
# SWARMZ_HOOK_VERSION=1
set -u
id="${SWARMZ_TERMINAL_ID:-}"
[ -n "$id" ] || exit 0
event="${1:-}"
[ -n "$event" ] || exit 0
input=$(cat 2>/dev/null | tr -d '\n\r')
case "$input" in *'"agent_id"'*) exit 0 ;; esac
dir="$HOME/.swarmz/agents"
mkdir -p "$dir" 2>/dev/null || exit 0
log="$dir/events.log"
if [ -f "$log" ] && [ "$(wc -c < "$log" | tr -d ' ')" -gt 524288 ]; then
  mv -f "$log" "$log.1" 2>/dev/null
fi
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\t%s\t%s\t%s\n' "$ts" "$id" "$event" "$input" >> "$log"
exit 0
"#;

/// The `SWARMZ_HOOK_VERSION=<n>` header of an installed script, or None when absent.
pub fn script_version(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("# SWARMZ_HOOK_VERSION=").or_else(|| l.trim().strip_prefix("#SWARMZ_HOOK_VERSION=")))
        .and_then(|v| v.trim().parse().ok())
}

pub fn hook_entry(event: &str) -> Value {
    let mut entry = Map::new();
    entry.insert("type".into(), json!("command"));
    entry.insert("command".into(), json!(format!("sh \"$HOME/{SCRIPT_MARKER}\" {event}")));
    if event != "SessionEnd" {
        entry.insert("async".into(), json!(true));
    }
    entry.insert("timeout".into(), json!(5));
    json!({ "hooks": [Value::Object(entry)] })
}

fn is_swarmz_group(group: &Value) -> bool {
    group["hooks"]
        .as_array()
        .map(|hs| hs.iter().any(|h| h["command"].as_str().map(|c| c.contains(SCRIPT_MARKER)).unwrap_or(false)))
        .unwrap_or(false)
}

/// Merges swarmz's hook entries into a settings.json text. Returns the new text and whether it
/// differs from the input. Foreign hooks, unknown keys and key order are preserved. Malformed
/// input is an error, never overwritten.
pub fn install_hooks(settings: Option<&str>) -> Result<(String, bool), String> {
    let mut root: Value = match settings {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|e| format!("settings.json is not valid JSON: {e}"))?
        }
        _ => json!({}),
    };
    if !root.is_object() {
        return Err("settings.json is not a JSON object".into());
    }
    let before = serde_json::to_string(&root).map_err(|e| e.to_string())?;
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err("settings.json \"hooks\" is not an object".into());
    }
    let hooks = hooks.as_object_mut().unwrap();
    for ev in HOOK_EVENTS {
        let groups = hooks.entry(ev).or_insert_with(|| json!([]));
        if !groups.is_array() {
            return Err(format!("settings.json hooks.{ev} is not an array"));
        }
        let arr = groups.as_array_mut().unwrap();
        arr.retain(|g| !is_swarmz_group(g));
        arr.push(hook_entry(ev));
    }
    let after = serde_json::to_string(&root).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    Ok((pretty, before != after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn script_has_version_header_and_is_parsed() {
        assert!(HOOK_SCRIPT.starts_with("#!/bin/sh\n"));
        assert_eq!(script_version(HOOK_SCRIPT), Some(HOOK_VERSION));
        assert_eq!(script_version("#!/bin/sh\necho hi\n"), None);
        assert_eq!(script_version("# SWARMZ_HOOK_VERSION=7\n"), Some(7));
    }

    #[test]
    fn script_exits_zero_and_writes_nothing_without_terminal_id() {
        let dir = std::env::temp_dir().join(format!("swarmz-hook-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude.sh");
        std::fs::write(&script, HOOK_SCRIPT).unwrap();
        let out = std::process::Command::new("sh")
            .arg(&script)
            .arg("Stop")
            .env("HOME", &dir)
            .env_remove("SWARMZ_TERMINAL_ID")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(!dir.join(".swarmz/agents/events.log").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn script_appends_one_tab_separated_line() {
        let dir = std::env::temp_dir().join(format!("swarmz-hook-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude.sh");
        std::fs::write(&script, HOOK_SCRIPT).unwrap();
        let mut child = std::process::Command::new("sh")
            .arg(&script)
            .arg("Notification")
            .env("HOME", &dir)
            .env("SWARMZ_TERMINAL_ID", "t-1")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        {
            use std::io::Write;
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(b"{\"session_id\":\"s1\",\n\"hook_event_name\":\"Notification\",\"notification_type\":\"permission_prompt\"}\n").unwrap();
        }
        assert!(child.wait().unwrap().success());
        let log = std::fs::read_to_string(dir.join(".swarmz/agents/events.log")).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 1);
        let fields: Vec<&str> = lines[0].split('\t').collect();
        assert_eq!(fields.len(), 4);
        assert_eq!(fields[1], "t-1");
        assert_eq!(fields[2], "Notification");
        assert!(fields[3].contains("\"notification_type\":\"permission_prompt\""));
        assert!(!fields[3].contains('\n'));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn script_drops_subagent_events() {
        let dir = std::env::temp_dir().join(format!("swarmz-hook-test3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude.sh");
        std::fs::write(&script, HOOK_SCRIPT).unwrap();
        let mut child = std::process::Command::new("sh")
            .arg(&script)
            .arg("Stop")
            .env("HOME", &dir)
            .env("SWARMZ_TERMINAL_ID", "t-1")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"{\"session_id\":\"s1\",\"agent_id\":\"a1\",\"hook_event_name\":\"Stop\"}").unwrap();
        }
        assert!(child.wait().unwrap().success());
        assert!(!dir.join(".swarmz/agents/events.log").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn hooks_of(text: &str) -> Value {
        serde_json::from_str::<Value>(text).unwrap()["hooks"].clone()
    }

    #[test]
    fn install_into_empty_settings_adds_six_events() {
        let (out, changed) = install_hooks(None).unwrap();
        assert!(changed);
        let hooks = hooks_of(&out);
        for ev in HOOK_EVENTS {
            let arr = hooks[ev].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{ev}");
            let entry = &arr[0]["hooks"][0];
            assert_eq!(entry["type"], "command");
            assert_eq!(entry["command"], format!("sh \"$HOME/.swarmz/hooks/claude.sh\" {ev}"));
            assert_eq!(entry["timeout"], 5);
            if ev == "SessionEnd" {
                assert!(entry.get("async").is_none());
            } else {
                assert_eq!(entry["async"], true);
            }
        }
    }

    #[test]
    fn install_is_idempotent() {
        let (once, _) = install_hooks(None).unwrap();
        let (twice, changed) = install_hooks(Some(&once)).unwrap();
        assert!(!changed);
        assert_eq!(once, twice);
    }

    #[test]
    fn install_replaces_only_swarmz_entries_and_keeps_foreign_ones() {
        let existing = json!({
            "theme": "dark",
            "hooks": {
                "Stop": [
                    { "matcher": "", "hooks": [ { "type": "command", "command": "bash /x/herdr.sh stop", "timeout": 10 } ] },
                    { "hooks": [ { "type": "command", "command": "sh \"$HOME/.swarmz/hooks/claude.sh\" Stop", "timeout": 99 } ] }
                ],
                "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo hi" } ] } ]
            },
            "permissions": { "allow": ["Bash(ls)"] }
        })
        .to_string();
        let (out, changed) = install_hooks(Some(&existing)).unwrap();
        assert!(changed);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls)");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "bash /x/herdr.sh stop");
        assert_eq!(stop[1]["hooks"][0]["timeout"], 5);
        assert_eq!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "echo hi");
        // key order preserved: theme first, hooks second, permissions last
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["theme", "hooks", "permissions"]);
    }

    #[test]
    fn install_refuses_malformed_settings() {
        let err = install_hooks(Some("{ not json")).unwrap_err();
        assert!(err.contains("settings.json"), "{err}");
    }
}
