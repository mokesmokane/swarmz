use serde_json::{json, Map, Value};
use crate::remote::{run_with_timeout, run_with_timeout_input, validate_host, CONTROL_PATH};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("{} has no parent", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}

/// Installs the hook script and settings entries under `home`. Returns true when something
/// was written. Never touches a settings file it cannot parse.
pub fn install_local_in(home: &Path) -> Result<bool, String> {
    let mut wrote = false;
    let script_path = home.join(".swarmz").join("hooks").join("claude.sh");
    let current = std::fs::read_to_string(&script_path).ok();
    if current.as_deref().and_then(script_version) != Some(HOOK_VERSION) || current.as_deref() != Some(HOOK_SCRIPT) {
        write_atomic(&script_path, HOOK_SCRIPT)?;
        wrote = true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not chmod {}: {e}", script_path.display()))?;
    }
    let settings_path = home.join(".claude").join("settings.json");
    let existing = std::fs::read_to_string(&settings_path).ok();
    let (merged, changed) = install_hooks(existing.as_deref())?;
    if changed || existing.is_none() {
        write_atomic(&settings_path, &format!("{merged}\n"))?;
        wrote = true;
    }
    Ok(wrote)
}

pub fn install_local() -> Result<bool, String> {
    install_local_in(&home_dir())
}

pub const REMOTE_SEPARATOR: &str = "__SWARMZ_SEP_7f3a__";

pub fn remote_read_command() -> &'static str {
    // Each cat may fail (file absent); the separator always prints so the reply splits.
    "cat ~/.swarmz/hooks/claude.sh 2>/dev/null; printf '\\n%s\\n' __SWARMZ_SEP_7f3a__; cat ~/.claude/settings.json 2>/dev/null; true"
}

pub fn remote_write_script_command() -> &'static str {
    "mkdir -p ~/.swarmz/hooks && cat > ~/.swarmz/hooks/claude.sh.tmp.$$ && chmod 755 ~/.swarmz/hooks/claude.sh.tmp.$$ && mv -f ~/.swarmz/hooks/claude.sh.tmp.$$ ~/.swarmz/hooks/claude.sh"
}

pub fn remote_write_settings_command() -> &'static str {
    "mkdir -p ~/.claude && cat > ~/.claude/settings.json.tmp.$$ && mv -f ~/.claude/settings.json.tmp.$$ ~/.claude/settings.json"
}

/// Splits the reply of `remote_read_command` into (script, settings), each None when empty.
pub fn split_remote_read(stdout: &str) -> (Option<String>, Option<String>) {
    let sep_line = format!("\n{REMOTE_SEPARATOR}\n");
    let (a, b) = match stdout.find(&sep_line) {
        Some(i) => (&stdout[..i], &stdout[i + sep_line.len()..]),
        None => (stdout, ""),
    };
    let clean = |s: &str| {
        let trimmed = s.trim();
        if trimmed.is_empty() || trimmed == REMOTE_SEPARATOR {
            None
        } else {
            Some(s.to_string())
        }
    };
    (clean(a), clean(b))
}

fn ssh_command(host: &str) -> Result<Command, String> {
    crate::remote::ensure_ssh_dir()?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg(format!("ControlPath={CONTROL_PATH}"))
        .arg("-o").arg("ControlMaster=auto")
        .arg("-o").arg("ControlPersist=10m")
        .arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("ConnectTimeout=5")
        .arg(host);
    Ok(cmd)
}

fn ssh_failure(done: &crate::remote::Finished, what: &str) -> String {
    if done.status.code() == Some(255) {
        format!("not reachable: {}", done.stderr.trim())
    } else if done.stderr.trim().is_empty() {
        format!("{what} failed (exit {:?})", done.status.code())
    } else {
        done.stderr.trim().to_string()
    }
}

/// Installs the hook on `host` over the shared ssh socket. Returns true when something was
/// written there.
pub fn install_remote(host: &str) -> Result<bool, String> {
    let host = validate_host(host)?;
    let mut cmd = ssh_command(&host)?;
    cmd.arg(remote_read_command());
    let done = run_with_timeout(cmd, Duration::from_secs(10), "ssh")?;
    if !done.status.success() {
        return Err(ssh_failure(&done, "remote read"));
    }
    let (script, settings) = split_remote_read(&done.stdout);
    let mut wrote = false;
    if script.as_deref().and_then(script_version) != Some(HOOK_VERSION) || script.as_deref() != Some(HOOK_SCRIPT) {
        let mut cmd = ssh_command(&host)?;
        cmd.arg(remote_write_script_command());
        let done = run_with_timeout_input(cmd, Duration::from_secs(10), "ssh", Some(HOOK_SCRIPT.as_bytes()))?;
        if !done.status.success() {
            return Err(ssh_failure(&done, "remote script write"));
        }
        wrote = true;
    }
    let (merged, changed) = install_hooks(settings.as_deref())?;
    if changed || settings.is_none() {
        let mut cmd = ssh_command(&host)?;
        cmd.arg(remote_write_settings_command());
        let done = run_with_timeout_input(cmd, Duration::from_secs(10), "ssh", Some(format!("{merged}\n").as_bytes()))?;
        if !done.status.success() {
            return Err(ssh_failure(&done, "remote settings write"));
        }
        wrote = true;
    }
    Ok(wrote)
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

    #[test]
    fn install_local_writes_script_and_settings_then_is_a_no_op() {
        let home = std::env::temp_dir().join(format!("swarmz-install-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        assert!(install_local_in(&home).unwrap());
        let script = std::fs::read_to_string(home.join(".swarmz/hooks/claude.sh")).unwrap();
        assert_eq!(script, HOOK_SCRIPT);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(home.join(".swarmz/hooks/claude.sh")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let settings = std::fs::read_to_string(home.join(".claude/settings.json")).unwrap();
        assert!(settings.contains(SCRIPT_MARKER));
        assert!(!install_local_in(&home).unwrap());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn install_local_replaces_an_older_script() {
        let home = std::env::temp_dir().join(format!("swarmz-install2-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".swarmz/hooks")).unwrap();
        std::fs::write(home.join(".swarmz/hooks/claude.sh"), "#!/bin/sh\n# SWARMZ_HOOK_VERSION=0\nexit 0\n").unwrap();
        assert!(install_local_in(&home).unwrap());
        assert_eq!(std::fs::read_to_string(home.join(".swarmz/hooks/claude.sh")).unwrap(), HOOK_SCRIPT);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn install_local_leaves_malformed_settings_alone() {
        let home = std::env::temp_dir().join(format!("swarmz-install3-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), "{ nope").unwrap();
        let err = install_local_in(&home).unwrap_err();
        assert!(err.contains("settings.json"));
        assert_eq!(std::fs::read_to_string(home.join(".claude/settings.json")).unwrap(), "{ nope");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn remote_commands_read_both_files_and_write_atomically() {
        let read = remote_read_command();
        assert!(read.contains("cat ~/.swarmz/hooks/claude.sh"));
        assert!(read.contains("cat ~/.claude/settings.json"));
        assert!(read.contains(REMOTE_SEPARATOR));
        let ws = remote_write_script_command();
        assert!(ws.contains("mkdir -p ~/.swarmz/hooks"));
        assert!(ws.contains("chmod 755"));
        let wc = remote_write_settings_command();
        assert!(wc.contains("mkdir -p ~/.claude"));
        assert!(wc.contains("mv -f"));
    }

    #[test]
    fn split_remote_read_handles_missing_files() {
        let (script, settings) = split_remote_read(&format!("{REMOTE_SEPARATOR}\n"));
        assert_eq!(script, None);
        assert_eq!(settings, None);
        let (script, settings) = split_remote_read(&format!("#!/bin/sh\n# SWARMZ_HOOK_VERSION=1\n{REMOTE_SEPARATOR}\n{{\"a\":1}}\n"));
        assert_eq!(script_version(script.as_deref().unwrap()), Some(1));
        assert_eq!(settings.as_deref(), Some("{\"a\":1}\n"));
    }

    #[test]
    fn remote_read_command_succeeds_with_missing_files() {
        let home = std::env::temp_dir().join(format!("swarmz-remote-read-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();

        // First run: no files exist, should succeed and return None/None
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(remote_read_command());
        cmd.env("HOME", &home);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let output = cmd.output().unwrap();
        assert!(output.status.success(), "remote_read_command failed with missing files: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout);
        let (script, settings) = split_remote_read(&stdout);
        assert_eq!(script, None);
        assert_eq!(settings, None);

        // Second run: create both files and verify they are read
        std::fs::create_dir_all(home.join(".swarmz/hooks")).unwrap();
        std::fs::write(home.join(".swarmz/hooks/claude.sh"), HOOK_SCRIPT).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"a":1}"#).unwrap();

        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(remote_read_command());
        cmd.env("HOME", &home);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let output = cmd.output().unwrap();
        assert!(output.status.success(), "remote_read_command failed with files present: {}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout);
        let (script, settings) = split_remote_read(&stdout);
        assert!(script.is_some(), "script should be read");
        assert!(settings.is_some(), "settings should be read");
        assert_eq!(script.as_deref(), Some(HOOK_SCRIPT));
        assert_eq!(settings.as_deref(), Some(r#"{"a":1}"#));

        std::fs::remove_dir_all(&home).unwrap();
    }
}
