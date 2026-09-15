# Agent State via Claude Code Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tile running Claude Code shows working / idle / blocked / offline on its sidebar and tab dot, reported by Claude's lifecycle hooks and visible from every Mac that has the terminal open.

**Architecture:** A once-installed hook script appends one line per lifecycle event to `~/.swarmz/agents/events.log` on the machine Claude runs on. The Rust core tails that file locally, and over the shared ssh socket for each tailnet machine with a connected tile, emitting each parsed line as a Tauri event. A pure reducer in the frontend folds events into per-terminal state; the store owns watcher lifecycle, hook install, and the `claude.started` flip.

**Tech Stack:** Rust (Tauri 2, serde_json with `preserve_order`, std::process), TypeScript, React 19, zustand, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-15-agent-state-hooks-design.md`

## Global Constraints

- Hook script path is `~/.swarmz/hooks/claude.sh`, version header line `# SWARMZ_HOOK_VERSION=1`, log at `~/.swarmz/agents/events.log`, rotate at 524288 bytes to `events.log.1`.
- Settings hook entries are `{ "type": "command", "command": "sh \"$HOME/.swarmz/hooks/claude.sh\" <Event>", "async": true, "timeout": 5 }` for SessionStart, UserPromptSubmit, Stop, StopFailure, Notification; SessionEnd has no `async` key.
- A swarmz hook entry is identified by `command` containing `.swarmz/hooks/claude.sh`. Foreign hooks and unknown settings keys are preserved. Malformed settings are never overwritten.
- Watchers run `tail -n 200 -F` on the log; remote via `ssh` with `ControlPath=~/.swarmz/ssh/%C`, `ControlMaster=auto`, `BatchMode=yes`, `ConnectTimeout=5`, `ServerAliveInterval=15`.
- Tauri events: `agent:event` payload `{ host: string | null, event: AgentEvent }`; `agent:watch-ended` payload `{ host: string | null }`.
- Status colours: offline `bg-neutral-500`, working `bg-amber-400`, idle `bg-green-500`, blocked `bg-red-500`. `unseen` adds `ring-2` plus the ring colour class. Exited styling wins.
- Blocking notification types: `permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`, `elicitation_url_dialog`.
- Replayed events (ts before app launch) apply only to terminals whose settings have `ssh`.
- Commit messages follow `type(scope): summary` and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test`, `npm run typecheck` and `cd src-tauri && cargo test` before every commit that touches the respective side.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src-tauri/src/agents.rs` (new) | Hook script text, settings merge (`install_hooks`), local and remote install, log line parsing, watcher process management. |
| `src-tauri/src/commands.rs` | Tauri commands `agents_install_local`, `agents_install_remote`, `agents_watch`, `agents_unwatch`; watcher map on `AppState`. |
| `src-tauri/src/lib.rs` | Register the module and commands. |
| `src-tauri/Cargo.toml` | `serde_json` gains `preserve_order`. |
| `src/lib/agentState.ts` (new) | `AgentState`, `AgentEvent`, pure `applyAgentEvent`, `statusClasses`. |
| `src/lib/agentState.test.ts` (new) | Reducer tests. |
| `src/lib/ipc.ts` | Command wrappers and event listeners. |
| `src/lib/workspace.ts` | `startupSteps(s, terminalId?)` prefixes the remote line. |
| `src/store.ts` | `agentState` slice, event application, replay rule, watcher lifecycle, hook install, `started` flip. |
| `src/App.tsx` | Subscribes to the two Tauri events and window focus. |
| `src/components/Sidebar.tsx`, `src/components/TabGroup.tsx` | Status dots. |

---

### Task 1: Hook script and settings merge (Rust, pure)

**Files:**
- Modify: `src-tauri/Cargo.toml:19`
- Create: `src-tauri/src/agents.rs`
- Modify: `src-tauri/src/lib.rs:1-8`

**Interfaces:**
- Produces: `pub const HOOK_VERSION: u32`, `pub const HOOK_SCRIPT: &str`, `pub const HOOK_EVENTS: [&str; 6]`, `pub fn script_version(text: &str) -> Option<u32>`, `pub fn hook_entry(event: &str) -> serde_json::Value`, `pub fn install_hooks(settings: Option<&str>) -> Result<(String, bool), String>`.

- [ ] **Step 1: Enable key-order preservation**

In `src-tauri/Cargo.toml` change line 19 to:

```toml
serde_json = { version = "1", features = ["preserve_order"] }
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/agents.rs` with only the test module for now:

```rust
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
```

- [ ] **Step 3: Run the tests to verify they fail to compile**

Run: `cd src-tauri && cargo test agents:: 2>&1 | tail -5`
Expected: compile errors about `HOOK_SCRIPT`, `install_hooks` etc. not found. (Add `pub mod agents;` to `lib.rs` first, as the first `pub mod` line, so the module is compiled.)

- [ ] **Step 4: Implement the script, version parsing, and merge**

Put this above the test module in `src-tauri/src/agents.rs`:

```rust
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
```

Add `pub mod agents;` as the first line of `src-tauri/src/lib.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test agents:: 2>&1 | tail -5`
Expected: `test result: ok. 7 passed`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/agents.rs src-tauri/src/lib.rs
git commit -m "feat(core): hook script and settings merge for agent state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Local and remote install (Rust)

**Files:**
- Modify: `src-tauri/src/agents.rs`
- Modify: `src-tauri/src/remote.rs:119-125` (make `Finished` and `run_with_timeout_input` usable; they are already `pub(crate)`, nothing to change unless visibility fails)

**Interfaces:**
- Produces: `pub fn install_local_in(home: &Path) -> Result<bool, String>` (true when anything was written), `pub fn install_local() -> Result<bool, String>`, `pub fn install_remote(host: &str) -> Result<bool, String>`, `pub fn remote_read_command() -> &'static str`, `pub fn remote_write_script_command() -> &'static str`, `pub fn remote_write_settings_command() -> &'static str`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `agents.rs`:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test agents:: 2>&1 | grep -E "error\[|cannot find" | head -5`
Expected: `cannot find function install_local_in`, `remote_read_command`, `split_remote_read`, `REMOTE_SEPARATOR`.

- [ ] **Step 3: Implement local and remote install**

Add to `agents.rs` above the tests:

```rust
use crate::remote::{run_with_timeout, run_with_timeout_input, validate_host, CONTROL_PATH};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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
    "cat ~/.swarmz/hooks/claude.sh 2>/dev/null; printf '\\n%s\\n' __SWARMZ_SEP_7f3a__; cat ~/.claude/settings.json 2>/dev/null"
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
    let clean = |s: &str| if s.trim().is_empty() { None } else { Some(s.to_string()) };
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
```

If `crate::remote::Finished` is not visible, change its declaration in `remote.rs:119` to `pub(crate) struct Finished` with `pub(crate)` fields (it already is; only adjust if the compiler complains).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test agents:: 2>&1 | tail -3`
Expected: `test result: ok. 12 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agents.rs src-tauri/src/remote.rs
git commit -m "feat(core): install Claude hooks locally and on tailnet machines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Log parsing and watchers (Rust) with Tauri commands

**Files:**
- Modify: `src-tauri/src/agents.rs`
- Modify: `src-tauri/src/commands.rs:12-17` (AppState) and append commands
- Modify: `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Produces: `pub struct AgentEvent { ts, terminal, event, session_id: Option<String>, notification_type: Option<String>, source: Option<String> }` (Serialize with camelCase), `pub fn parse_line(line: &str) -> Option<AgentEvent>`, `pub fn watch_command(host: Option<&str>) -> Result<Command, String>`, `pub struct Watcher` (kills its child on drop), `pub fn spawn_watcher(app: AppHandle, host: Option<String>, gen: u64) -> Result<Watcher, String>`.
- Tauri commands: `agents_install_local() -> Result<bool, String>`, `agents_install_remote(host: String) -> Result<bool, String>`, `agents_watch(host: Option<String>) -> Result<(), String>`, `agents_unwatch(host: Option<String>) -> Result<(), String>`.
- Tauri events: `agent:event` `{ host: Option<String>, event: AgentEvent }`, `agent:watch-ended` `{ host: Option<String> }`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `agents.rs`:

```rust
    #[test]
    fn parse_line_reads_session_start() {
        let line = "2026-09-15T10:00:00Z\tt-1\tSessionStart\t{\"session_id\":\"abc\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"cwd\":\"/p\"}";
        let ev = parse_line(line).unwrap();
        assert_eq!(ev.ts, "2026-09-15T10:00:00Z");
        assert_eq!(ev.terminal, "t-1");
        assert_eq!(ev.event, "SessionStart");
        assert_eq!(ev.session_id.as_deref(), Some("abc"));
        assert_eq!(ev.source.as_deref(), Some("startup"));
        assert_eq!(ev.notification_type, None);
    }

    #[test]
    fn parse_line_reads_notification_type() {
        let line = "2026-09-15T10:00:01Z\tt-1\tNotification\t{\"session_id\":\"abc\",\"notification_type\":\"permission_prompt\"}";
        let ev = parse_line(line).unwrap();
        assert_eq!(ev.notification_type.as_deref(), Some("permission_prompt"));
    }

    #[test]
    fn parse_line_rejects_short_or_bad_lines() {
        assert!(parse_line("").is_none());
        assert!(parse_line("a\tb\tc").is_none());
        assert!(parse_line("a\tb\tc\tnot json").is_none());
        assert!(parse_line("a\t\tStop\t{}").is_none());
    }

    #[test]
    fn parse_line_serialises_camel_case() {
        let ev = parse_line("t\tid\tStop\t{\"session_id\":\"s\"}").unwrap();
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["sessionId"], "s");
        assert!(v.get("notificationType").is_some());
    }

    #[test]
    fn watch_commands_tail_the_log() {
        let local = watch_command(None).unwrap();
        let args: Vec<String> = local.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(local.get_program(), "tail");
        assert_eq!(args[..3], ["-n".to_string(), "200".to_string(), "-F".to_string()]);
        assert!(args[3].ends_with(".swarmz/agents/events.log"));

        let remote = watch_command(Some("me@box")).unwrap();
        assert_eq!(remote.get_program(), "ssh");
        let args: Vec<String> = remote.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"ServerAliveInterval=15".to_string()));
        let host_at = args.iter().position(|a| a == "me@box").unwrap();
        assert_eq!(host_at, args.len() - 2, "host must be last before the remote command");
        let script = args.last().unwrap();
        assert!(script.contains("mkdir -p ~/.swarmz/agents"));
        assert!(script.contains("tail -n 200 -F ~/.swarmz/agents/events.log"));
    }

    #[test]
    fn watch_command_rejects_bad_host() {
        assert!(watch_command(Some("bad host")).is_err());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test agents:: 2>&1 | grep -E "cannot find" | head -3`
Expected: `cannot find function parse_line`, `watch_command`.

- [ ] **Step 3: Implement parsing and the watcher**

Add to `agents.rs`:

```rust
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub ts: String,
    pub terminal: String,
    pub event: String,
    pub session_id: Option<String>,
    pub notification_type: Option<String>,
    pub source: Option<String>,
}

/// One log line: `ts \t terminal \t event \t json`. None when malformed.
pub fn parse_line(line: &str) -> Option<AgentEvent> {
    let mut parts = line.splitn(4, '\t');
    let ts = parts.next()?.trim();
    let terminal = parts.next()?.trim();
    let event = parts.next()?.trim();
    let json = parts.next()?;
    if ts.is_empty() || terminal.is_empty() || event.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(json).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    Some(AgentEvent {
        ts: ts.to_string(),
        terminal: terminal.to_string(),
        event: event.to_string(),
        session_id: s("session_id"),
        notification_type: s("notification_type"),
        source: s("source"),
    })
}

pub fn local_log_path() -> PathBuf {
    home_dir().join(".swarmz").join("agents").join("events.log")
}

const REMOTE_TAIL: &str = "mkdir -p ~/.swarmz/agents && touch ~/.swarmz/agents/events.log && exec tail -n 200 -F ~/.swarmz/agents/events.log";

/// The process that streams the log: local `tail`, or `ssh host tail` over the shared socket.
pub fn watch_command(host: Option<&str>) -> Result<Command, String> {
    match host {
        None => {
            let path = local_log_path();
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
            }
            if !path.exists() {
                std::fs::write(&path, "").map_err(|e| format!("could not create {}: {e}", path.display()))?;
            }
            let mut cmd = Command::new("tail");
            cmd.arg("-n").arg("200").arg("-F").arg(&path);
            Ok(cmd)
        }
        Some(h) => {
            let host = validate_host(h)?;
            crate::remote::ensure_ssh_dir()?;
            // Options must precede the host: anything after it is the remote command.
            let mut cmd = Command::new("ssh");
            cmd.arg("-o").arg(format!("ControlPath={CONTROL_PATH}"))
                .arg("-o").arg("ControlMaster=auto")
                .arg("-o").arg("ControlPersist=10m")
                .arg("-o").arg("BatchMode=yes")
                .arg("-o").arg("ConnectTimeout=5")
                .arg("-o").arg("ServerAliveInterval=15")
                .arg(&host)
                .arg(REMOTE_TAIL);
            Ok(cmd)
        }
    }
}

#[derive(Serialize, Clone)]
struct EventPayload {
    host: Option<String>,
    event: AgentEvent,
}

#[derive(Serialize, Clone)]
struct EndedPayload {
    host: Option<String>,
    gen: u64,
}

pub struct Watcher {
    child: Child,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts the tail process and a thread that emits `agent:event` per parsed line and
/// `agent:watch-ended` when the process exits. `gen` lets the store ignore an ended event from
/// a watcher it has already replaced.
pub fn spawn_watcher(app: AppHandle, host: Option<String>, gen: u64) -> Result<Watcher, String> {
    let mut cmd = watch_command(host.as_deref())?;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start log watcher: {e}"))?;
    let stdout = child.stdout.take().ok_or("watcher has no stdout")?;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(event) = parse_line(&line) {
                let _ = app.emit("agent:event", EventPayload { host: host.clone(), event });
            }
        }
        let _ = app.emit("agent:watch-ended", EndedPayload { host, gen });
    });
    Ok(Watcher { child })
}
```

In `commands.rs`, extend `AppState`:

```rust
#[derive(Default)]
pub struct AppState {
    pub registry: Mutex<TerminalRegistry>,
    pub sessions: Mutex<HashMap<String, (u64, Arc<PtySession>)>>,
    pub next_gen: AtomicU64,
    pub watchers: Mutex<HashMap<Option<String>, (u64, crate::agents::Watcher)>>,
}
```

and append the commands:

```rust
#[tauri::command]
pub async fn agents_install_local() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(crate::agents::install_local).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agents_install_remote(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::agents::install_remote(&host)).await.map_err(|e| e.to_string())?
}

/// Starts tailing the agent log for `host` (None = this machine). Already watching is a no-op.
#[tauri::command]
pub fn agents_watch(app: AppHandle, state: State<AppState>, host: Option<String>) -> Result<(), String> {
    let mut watchers = state.watchers.lock().unwrap();
    if watchers.contains_key(&host) {
        return Ok(());
    }
    let gen = state.next_gen.fetch_add(1, Ordering::SeqCst);
    let watcher = crate::agents::spawn_watcher(app, host.clone(), gen)?;
    watchers.insert(host, (gen, watcher));
    Ok(())
}

#[tauri::command]
pub fn agents_unwatch(state: State<AppState>, host: Option<String>) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&host);
    Ok(())
}
```

`agents_watch` must not hold the lock while a stale watcher for the same host is still in the map after its process died: the store calls `agents_unwatch` before re-watching (Task 5), so the map entry is gone by then.

Register in `lib.rs` after `commands::workspace_stat,`:

```rust
            commands::agents_install_local,
            commands::agents_install_remote,
            commands::agents_watch,
            commands::agents_unwatch,
```

- [ ] **Step 4: Run all Rust tests**

Run: `cd src-tauri && cargo test 2>&1 | grep -E "test result|error" | head`
Expected: every `test result: ok`, agents module 18 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/agents.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(core): tail agent event logs locally and over ssh

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Frontend reducer

**Files:**
- Create: `src/lib/agentState.ts`
- Create: `src/lib/agentState.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgentStatus = "offline" | "working" | "idle" | "blocked";
  export interface AgentState { status: AgentStatus; sessionId: string | null; since: string; lastEvent: string; unseen: boolean }
  export interface AgentEvent { ts: string; terminal: string; event: string; sessionId: string | null; notificationType: string | null; source: string | null }
  export const OFFLINE: AgentState;
  export const BLOCKING_NOTIFICATIONS: ReadonlySet<string>;
  export function applyAgentEvent(prev: AgentState | undefined, ev: AgentEvent, focused: boolean): AgentState | null; // null = no change
  export function statusClasses(state: AgentState | undefined): string; // tailwind classes for the dot
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { applyAgentEvent, BLOCKING_NOTIFICATIONS, OFFLINE, statusClasses, type AgentEvent, type AgentState } from "./agentState";

const ev = (event: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  ts: "2026-09-15T10:00:00Z", terminal: "t", event, sessionId: "s1", notificationType: null, source: null, ...extra,
});

describe("applyAgentEvent", () => {
  it("SessionStart makes an idle state with the session id, never unseen", () => {
    const s = applyAgentEvent(undefined, ev("SessionStart", { source: "startup" }), false)!;
    expect(s).toEqual<AgentState>({ status: "idle", sessionId: "s1", since: "2026-09-15T10:00:00Z", lastEvent: "SessionStart", unseen: false });
  });
  it("UserPromptSubmit sets working and clears unseen", () => {
    const idle: AgentState = { ...OFFLINE, status: "idle", unseen: true, sessionId: "s1" };
    const s = applyAgentEvent(idle, ev("UserPromptSubmit"), false)!;
    expect(s.status).toBe("working");
    expect(s.unseen).toBe(false);
  });
  it("Stop after working is idle and unseen when not focused", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    expect(applyAgentEvent(working, ev("Stop"), false)!.unseen).toBe(true);
    expect(applyAgentEvent(working, ev("Stop"), true)!.unseen).toBe(false);
    expect(applyAgentEvent(working, ev("StopFailure"), false)!.status).toBe("idle");
  });
  it("Stop after idle is not a new unseen", () => {
    const idle: AgentState = { ...OFFLINE, status: "idle", sessionId: "s1" };
    expect(applyAgentEvent(idle, ev("Stop"), false)!.unseen).toBe(false);
  });
  it("blocking notifications set blocked and unseen when not focused", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    for (const type of BLOCKING_NOTIFICATIONS) {
      const s = applyAgentEvent(working, ev("Notification", { notificationType: type }), false)!;
      expect(s.status).toBe("blocked");
      expect(s.unseen).toBe(true);
    }
    expect(applyAgentEvent(working, ev("Notification", { notificationType: "permission_prompt" }), true)!.unseen).toBe(false);
  });
  it("other notifications are ignored", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    expect(applyAgentEvent(working, ev("Notification", { notificationType: "auth_success" }), false)).toBeNull();
    expect(applyAgentEvent(working, ev("Notification", { notificationType: null }), false)).toBeNull();
  });
  it("SessionEnd is offline with no session", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    const s = applyAgentEvent(working, ev("SessionEnd"), false)!;
    expect(s.status).toBe("offline");
    expect(s.sessionId).toBeNull();
    expect(s.unseen).toBe(false);
  });
  it("unknown events are ignored", () => {
    expect(applyAgentEvent(undefined, ev("PreToolUse"), false)).toBeNull();
  });
  it("records since and lastEvent from the event", () => {
    const s = applyAgentEvent(undefined, ev("UserPromptSubmit", { ts: "2026-09-15T11:00:00Z" }), true)!;
    expect(s.since).toBe("2026-09-15T11:00:00Z");
    expect(s.lastEvent).toBe("UserPromptSubmit");
  });
});

describe("statusClasses", () => {
  it("maps each status to a colour and adds a ring when unseen", () => {
    expect(statusClasses(undefined)).toBe("bg-neutral-500");
    expect(statusClasses({ ...OFFLINE, status: "working" })).toBe("bg-amber-400");
    expect(statusClasses({ ...OFFLINE, status: "idle" })).toBe("bg-green-500");
    expect(statusClasses({ ...OFFLINE, status: "blocked" })).toBe("bg-red-500");
    expect(statusClasses({ ...OFFLINE, status: "blocked", unseen: true })).toBe("bg-red-500 ring-2 ring-red-500/50");
    expect(statusClasses({ ...OFFLINE, status: "idle", unseen: true })).toBe("bg-green-500 ring-2 ring-green-500/50");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/agentState.test.ts 2>&1 | tail -5`
Expected: FAIL, cannot resolve `./agentState`.

- [ ] **Step 3: Implement the reducer**

```ts
export type AgentStatus = "offline" | "working" | "idle" | "blocked";

export interface AgentState {
  status: AgentStatus;
  sessionId: string | null;
  since: string;
  lastEvent: string;
  unseen: boolean;
}

/** One line of ~/.swarmz/agents/events.log as parsed by the core. */
export interface AgentEvent {
  ts: string;
  terminal: string;
  event: string;
  sessionId: string | null;
  notificationType: string | null;
  source: string | null;
}

export const OFFLINE: AgentState = { status: "offline", sessionId: null, since: "", lastEvent: "", unseen: false };

export const BLOCKING_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
  "elicitation_dialog",
  "elicitation_url_dialog",
]);

/**
 * Folds one hook event into a terminal's state. Returns null when the event changes nothing.
 * `focused` is whether the terminal is the focused one in a focused window: a transition to idle
 * (from working) or to blocked while not focused is marked `unseen` until the tile is looked at.
 */
export function applyAgentEvent(prev: AgentState | undefined, ev: AgentEvent, focused: boolean): AgentState | null {
  const cur = prev ?? OFFLINE;
  const next = (status: AgentStatus, unseen: boolean, sessionId: string | null = cur.sessionId): AgentState => ({
    status,
    sessionId,
    since: ev.ts,
    lastEvent: ev.event,
    unseen,
  });
  switch (ev.event) {
    case "SessionStart":
      return next("idle", false, ev.sessionId);
    case "UserPromptSubmit":
      return next("working", false);
    case "Stop":
    case "StopFailure":
      return next("idle", cur.status === "working" && !focused);
    case "Notification":
      if (!ev.notificationType || !BLOCKING_NOTIFICATIONS.has(ev.notificationType)) return null;
      return next("blocked", !focused);
    case "SessionEnd":
      return next("offline", false, null);
    default:
      return null;
  }
}

const COLOR: Record<AgentStatus, string> = {
  offline: "neutral-500",
  working: "amber-400",
  idle: "green-500",
  blocked: "red-500",
};

/** Tailwind classes for a status dot. */
export function statusClasses(state: AgentState | undefined): string {
  const s = state ?? OFFLINE;
  const c = COLOR[s.status];
  return s.unseen ? `bg-${c} ring-2 ring-${c}/50` : `bg-${c}`;
}
```

Tailwind 4 needs the full class names present in source to generate them, so also add this comment at the bottom of `agentState.ts` so the scanner sees every class:

```ts
// Tailwind class inventory (scanned, never executed):
// bg-neutral-500 bg-amber-400 bg-green-500 bg-red-500
// ring-2 ring-neutral-500/50 ring-amber-400/50 ring-green-500/50 ring-red-500/50
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/agentState.test.ts 2>&1 | tail -4`
Expected: `Tests  10 passed`

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentState.ts src/lib/agentState.test.ts
git commit -m "feat(ui): agent state reducer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: IPC wrappers and store integration (local only)

**Files:**
- Modify: `src/lib/ipc.ts:47-68`
- Modify: `src/store.ts` (state interface `90-160`, initial state `~579-590`, `markExited` `726`, `restartTerminal` `698`, `closeTerminal` `670`, `focusTerminal` `739`, `focusGroup`, `loadWorkspace` `777`, and the subscription block at the end)
- Modify: `src/App.tsx`
- Modify: `src/store.test.ts` (mock block `4-40` and new describe)
- Modify: `src/components/Sidebar.test.tsx:5-31`, `src/components/NewRemoteTerminal.test.tsx:5-31`, `src/components/TerminalPane.test.tsx:5-25` (mocks gain the new ipc functions)

**Interfaces:**
- Consumes: `AgentEvent`, `AgentState`, `applyAgentEvent`, `OFFLINE` from Task 4.
- Produces on `ipc`:
  ```ts
  agentsInstallLocal: () => Promise<boolean>;
  agentsInstallRemote: (host: string) => Promise<boolean>;
  agentsWatch: (host: string | null) => Promise<void>;
  agentsUnwatch: (host: string | null) => Promise<void>;
  onAgentEvent: (cb: (p: { host: string | null; event: AgentEvent }) => void) => Promise<UnlistenFn>;
  onAgentWatchEnded: (cb: (p: { host: string | null; gen: number }) => void) => Promise<UnlistenFn>;
  ```
- Produces on the store:
  ```ts
  agentState: Record<string, AgentState>;
  agentHooksError: string | null;
  windowFocused: boolean;
  applyAgentEvent(payload: { host: string | null; event: AgentEvent }): void;
  setWindowFocused(focused: boolean): void;
  installAgentHooks(): Promise<void>;
  ```
  and `export const APP_LAUNCHED_AT: string` (ISO) plus `export function __setLaunchedAt(iso: string)` for tests.

- [ ] **Step 1: Add the IPC wrappers**

In `src/lib/ipc.ts` add after the `TailscaleStatus` interface:

```ts
import type { AgentEvent } from "./agentState";

export interface AgentEventPayload {
  host: string | null;
  event: AgentEvent;
}
```

(put the `import type` with the other imports at the top) and add to the `ipc` object after `workspaceStat`:

```ts
  agentsInstallLocal: () => invoke<boolean>("agents_install_local"),
  agentsInstallRemote: (host: string) => invoke<boolean>("agents_install_remote", { host }),
  agentsWatch: (host: string | null) => invoke<void>("agents_watch", { host }),
  agentsUnwatch: (host: string | null) => invoke<void>("agents_unwatch", { host }),
  onAgentEvent: (cb: (p: AgentEventPayload) => void): Promise<UnlistenFn> =>
    listen<AgentEventPayload>("agent:event", (e) => cb(e.payload)),
  onAgentWatchEnded: (cb: (p: { host: string | null; gen: number }) => void): Promise<UnlistenFn> =>
    listen<{ host: string | null; gen: number }>("agent:watch-ended", (e) => cb(e.payload)),
```

- [ ] **Step 2: Extend every test's ipc mock**

In `src/store.test.ts` add inside the mocked `ipc` object after `workspaceStat`:

```ts
      agentsInstallLocal: vi.fn(async () => false),
      agentsInstallRemote: vi.fn(async () => false),
      agentsWatch: vi.fn(async () => {}),
      agentsUnwatch: vi.fn(async () => {}),
      onAgentEvent: vi.fn(async () => () => {}),
      onAgentWatchEnded: vi.fn(async () => () => {}),
```

Add the same six lines to the `ipc` mock in `src/components/Sidebar.test.tsx`, `src/components/NewRemoteTerminal.test.tsx` and `src/components/TerminalPane.test.tsx`.

In the `beforeEach` of `src/store.test.ts` add to the `useStore.setState({...})` call:

```ts
    agentState: {},
    agentHooksError: null,
    windowFocused: true,
```

and after the existing `vi.mocked(...)` resets:

```ts
  vi.mocked(ipc.agentsInstallLocal).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.agentsInstallRemote).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.agentsWatch).mockClear();
  vi.mocked(ipc.agentsUnwatch).mockClear();
  __setLaunchedAt("2026-09-15T09:00:00Z");
```

and import `__setLaunchedAt` from `./store`.

- [ ] **Step 3: Write the failing store tests**

Append to `src/store.test.ts`:

```ts
describe("agent state", () => {
  const ev = (terminal: string, event: string, extra: Partial<import("./lib/agentState").AgentEvent> = {}) => ({
    host: null,
    event: { ts: "2026-09-15T10:00:00Z", terminal, event, sessionId: "s1", notificationType: null, source: null, ...extra },
  });

  it("applies live events to known terminals and ignores unknown ones", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart"));
    expect(useStore.getState().agentState[id].status).toBe("idle");
    useStore.getState().applyAgentEvent(ev("nope", "SessionStart"));
    expect(useStore.getState().agentState.nope).toBeUndefined();
  });

  it("marks unseen only when the terminal is not focused in a focused window", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    useStore.getState().focusTerminal(b);
    useStore.getState().applyAgentEvent(ev(a, "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(ev(a, "Stop"));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().applyAgentEvent(ev(b, "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(ev(b, "Stop"));
    expect(useStore.getState().agentState[b].unseen).toBe(false);
    useStore.getState().setWindowFocused(false);
    useStore.getState().applyAgentEvent(ev(b, "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(ev(b, "Stop"));
    expect(useStore.getState().agentState[b].unseen).toBe(true);
  });

  it("focusing a terminal in a focused window clears unseen; window focus clears the focused one", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    useStore.getState().applyAgentEvent(ev(a, "Notification", { notificationType: "permission_prompt" }));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().focusTerminal(a);
    expect(useStore.getState().agentState[a].unseen).toBe(false);
    useStore.getState().setWindowFocused(false);
    useStore.getState().applyAgentEvent(ev(a, "Notification", { notificationType: "permission_prompt" }));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().setWindowFocused(true);
    expect(useStore.getState().agentState[a].unseen).toBe(false);
    expect(useStore.getState().focusedTerminalId).toBe(a);
    void b;
  });

  it("replayed events before launch apply only to ssh terminals", async () => {
    const local = await useStore.getState().createTerminal("/tmp/a");
    const remote = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    const old = { ts: "2026-09-15T08:00:00Z" };
    useStore.getState().applyAgentEvent(ev(local, "SessionStart", old));
    useStore.getState().applyAgentEvent(ev(remote, "SessionStart", old));
    expect(useStore.getState().agentState[local]).toBeUndefined();
    expect(useStore.getState().agentState[remote]?.status).toBe("idle");
  });

  it("exit, restart and close reset the state", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit"));
    useStore.getState().markExited(id, 0);
    expect(useStore.getState().agentState[id].status).toBe("offline");
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit"));
    await useStore.getState().restartTerminal(id);
    expect(useStore.getState().agentState[id].status).toBe("offline");
    await useStore.getState().closeTerminal(id);
    expect(useStore.getState().agentState[id]).toBeUndefined();
  });

  it("loadWorkspace installs hooks locally, records a failure, and starts the local watcher", async () => {
    vi.mocked(ipc.agentsInstallLocal).mockRejectedValueOnce("no write access");
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    expect(ipc.agentsInstallLocal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useStore.getState().agentHooksError).toBe("could not install Claude hooks: no write access"));
    expect(ipc.agentsWatch).toHaveBeenCalledWith(null);
    await useStore.getState().installAgentHooks();
    expect(useStore.getState().agentHooksError).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/store.test.ts -t "agent state" 2>&1 | grep -E "✓|×|Error" | head`
Expected: every test fails with `applyAgentEvent is not a function` or similar.

- [ ] **Step 5: Implement the store slice**

In `src/store.ts`:

1. Imports, after the `./lib/workspace` import block:

```ts
import { applyAgentEvent as foldAgentEvent, OFFLINE, type AgentState } from "./lib/agentState";
import type { AgentEventPayload } from "./lib/ipc";
```

2. Module constants, after `SYNC_STAT_MS`:

```ts
/** When this app run started: hook events older than this are replay from before launch. */
export let APP_LAUNCHED_AT = new Date().toISOString();
export function __setLaunchedAt(iso: string) {
  APP_LAUNCHED_AT = iso;
}
```

3. In `WorkbenchState`, after `sync: {...};`:

```ts
  agentState: Record<string, AgentState>;
  agentHooksError: string | null;
  windowFocused: boolean;
```

and after `updateMachine(...)`:

```ts
  applyAgentEvent(payload: AgentEventPayload): void;
  setWindowFocused(focused: boolean): void;
  installAgentHooks(): Promise<void>;
```

4. Initial state, after `sync: { enabled: false, ... },`:

```ts
  agentState: {},
  agentHooksError: null,
  windowFocused: true,
```

5. Actions, add after `updateMachine`:

```ts
  applyAgentEvent({ event }) {
    set((s) => {
      const id = event.terminal;
      if (!s.terminals[id]) return {};
      const settings = s.settings[id] ?? EMPTY_SETTINGS;
      // Replay from before this run: a Claude in one of our own PTYs died with the app, so only a
      // remote's (possibly still alive elsewhere) history counts.
      if (event.ts < APP_LAUNCHED_AT && !settings.ssh) return {};
      const focused = s.windowFocused && s.focusedTerminalId === id;
      const next = foldAgentEvent(s.agentState[id], event, focused);
      if (!next) return {};
      return { agentState: { ...s.agentState, [id]: next } };
    });
  },

  setWindowFocused(focused) {
    set((s) => {
      const id = s.focusedTerminalId;
      const cur = id ? s.agentState[id] : undefined;
      if (!focused || !id || !cur?.unseen) return { windowFocused: focused };
      return { windowFocused: focused, agentState: { ...s.agentState, [id]: { ...cur, unseen: false } } };
    });
  },

  async installAgentHooks() {
    try {
      await ipc.agentsInstallLocal();
      set({ agentHooksError: null });
    } catch (e) {
      set({ agentHooksError: `could not install Claude hooks: ${typeof e === "string" ? e : String(e)}` });
    }
  },
```

6. `focusTerminal`: change its `set` to also clear unseen:

```ts
  focusTerminal(id) {
    set((s) => {
      const g = findGroupOf(s.layout, id);
      if (!g) return {};
      const layout = setActive(s.layout, g.id, id);
      const cur = s.agentState[id];
      const agentState = s.windowFocused && cur?.unseen ? { ...s.agentState, [id]: { ...cur, unseen: false } } : s.agentState;
      return { layout, focusedGroupId: g.id, focusedTerminalId: id, agentState };
    });
  },
```

7. `markExited`: add to the returned object `agentState: s.agentState[id] ? { ...s.agentState, [id]: OFFLINE } : s.agentState,`.

8. `restartTerminal`: add to the `set((s) => ({...}))` object `agentState: s.agentState[id] ? { ...s.agentState, [id]: OFFLINE } : s.agentState,`.

9. `closeTerminal`: in its `set`, add `agentState: omit(s.agentState, id),` to the returned object.

10. `loadWorkspace`: after the existing identity line `if (useStore.getState().selfMachine === null) await useStore.getState().refreshTailscale();` add:

```ts
    void useStore.getState().installAgentHooks();
    ipc.agentsWatch(null).catch(() => {});
```

- [ ] **Step 6: Wire the window and events in App.tsx**

Add a third `useEffect` in `src/App.tsx`:

```tsx
  useEffect(() => {
    const unlisten: Array<() => void> = [];
    void ipc.onAgentEvent((p) => useStore.getState().applyAgentEvent(p)).then((fn) => unlisten.push(fn));
    const onFocus = () => useStore.getState().setWindowFocused(true);
    const onBlur = () => useStore.getState().setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      unlisten.forEach((fn) => fn());
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
```

and `import { ipc } from "./lib/ipc";` at the top.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all files pass, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ipc.ts src/store.ts src/store.test.ts src/App.tsx src/components/Sidebar.test.tsx src/components/NewRemoteTerminal.test.tsx src/components/TerminalPane.test.tsx
git commit -m "feat(ui): fold hook events into per-terminal agent state; install hooks and watch locally

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Status dots in Sidebar and TabGroup, hooks error line

**Files:**
- Modify: `src/components/Sidebar.tsx:89-93` (row dot) and `227-232` (error lines)
- Modify: `src/components/TabGroup.tsx:27-35` (`TabDot`)
- Modify: `src/components/Sidebar.test.tsx`
- Create: `src/components/TabGroup.test.tsx`

**Interfaces:**
- Consumes: `statusClasses`, `agentState`, `agentHooksError`, `installAgentHooks` from Tasks 4 and 5.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/Sidebar.test.tsx`:

```tsx
describe("agent status dot", () => {
  it("uses the agent colour and ring, keeps exited grey, and shows the hooks error with retry", () => {
    useStore.setState({
      settings: { [ID]: { ssh: null, claude: null, command: null, extra: {} } },
      machines: {},
      agentState: { [ID]: { status: "blocked", sessionId: "s", since: "2026-09-15T10:00:00Z", lastEvent: "Notification", unseen: true } },
      agentHooksError: "could not install Claude hooks: nope",
    });
    render(<Sidebar />);
    const dot = screen.getByTestId(`agent-dot-${ID}`);
    expect(dot.className).toContain("bg-red-500");
    expect(dot.className).toContain("ring-2");
    expect(dot.title).toContain("blocked");
    expect(dot.title).toContain("Notification");
    expect(screen.getByText("could not install Claude hooks: nope")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    useStore.setState({ terminals: { [ID]: { ...useStore.getState().terminals[ID], exited: 1 } } });
    expect(screen.getByTestId(`agent-dot-${ID}`).className).toContain("bg-neutral-600");
  });

  it("shows the machine colour when there is no agent state", () => {
    render(<Sidebar />);
    const dot = screen.getByTestId(`agent-dot-${ID}`);
    expect(dot.style.backgroundColor).toBe("rgb(245, 158, 11)");
  });
});
```

Create `src/components/TabGroup.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    createTerminal: vi.fn(async () => ({})),
    writeTerminal: vi.fn(async () => {}),
    resizeTerminal: vi.fn(async () => {}),
    renameTerminal: vi.fn(async () => ({})),
    closeTerminal: vi.fn(async () => {}),
    restartTerminal: vi.fn(async () => ({})),
    listTerminals: vi.fn(async () => []),
    onData: vi.fn(async () => () => {}),
    onExit: vi.fn(async () => () => {}),
    loadWorkspace: vi.fn(async () => null),
    saveWorkspace: vi.fn(async () => {}),
    sshCheck: vi.fn(async () => false),
    sshOpenMaster: vi.fn(async () => false),
    sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),
    terminalForegroundBusy: vi.fn(async () => false),
    tailscaleStatus: vi.fn(async () => ({ running: true, message: null, user: "mokes", self: null, peers: [] })),
    tailscaleOpen: vi.fn(async () => {}),
    agentsInstallLocal: vi.fn(async () => false),
    agentsInstallRemote: vi.fn(async () => false),
    agentsWatch: vi.fn(async () => {}),
    agentsUnwatch: vi.fn(async () => {}),
    onAgentEvent: vi.fn(async () => () => {}),
    onAgentWatchEnded: vi.fn(async () => () => {}),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../lib/xtermRegistry", () => ({ attach: vi.fn(() => ({ term: {}, fit: { fit: vi.fn() } })), fitAndFocus: vi.fn() }));

import { __stopAllPolling, useStore } from "../store";
import { TabGroup } from "./TabGroup";

const ID = "t1";
class FakeResizeObserver { observe() {} disconnect() {} }

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: null, error: null } },
    order: [ID],
    layout: { kind: "group", id: "g1", tabs: [ID], active: ID },
    focusedGroupId: "g1",
    focusedTerminalId: ID,
    settings: { [ID]: { ssh: null, claude: null, command: null, extra: {} } },
    startupPending: {},
    startupNotes: {},
    machines: {},
    agentState: {},
    windowFocused: true,
  });
});

afterEach(() => {
  __stopAllPolling();
  cleanup();
});

describe("tab dot", () => {
  it("shows the agent status colour and ring", () => {
    useStore.setState({ agentState: { [ID]: { status: "working", sessionId: "s", since: "t", lastEvent: "UserPromptSubmit", unseen: false } } });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    const dot = screen.getByTestId(`tab-dot-${ID}`);
    expect(dot.className).toContain("bg-amber-400");
    expect(dot.className).not.toContain("ring-2");
  });

  it("keeps exited grey even with agent state", () => {
    useStore.setState({
      terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: 0, error: null } },
      agentState: { [ID]: { status: "idle", sessionId: "s", since: "t", lastEvent: "Stop", unseen: true } },
    });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    expect(screen.getByTestId(`tab-dot-${ID}`).className).toContain("bg-neutral-600");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/Sidebar.test.tsx src/components/TabGroup.test.tsx 2>&1 | grep -E "×|Unable" | head -5`
Expected: failures on missing `agent-dot-t1` / `tab-dot-t1` test ids.

- [ ] **Step 3: Implement the dots and the error line**

`src/components/TabGroup.tsx`, replace `TabDot`:

```tsx
function TabDot({ id, exited }: { id: string; exited: boolean }) {
  const color = useStore((s) => terminalColor(s, id));
  const agent = useStore((s) => s.agentState[id]);
  const hasAgent = !!agent && agent.status !== "offline";
  const cls = exited ? "bg-neutral-600" : hasAgent ? statusClasses(agent) : color ? "" : "bg-emerald-500";
  return (
    <span
      data-testid={`tab-dot-${id}`}
      className={`h-2 w-2 rounded-full ${cls}`}
      style={{ backgroundColor: !exited && !hasAgent && color ? color : undefined }}
      title={hasAgent ? `${agent.status} · ${agent.lastEvent}` : undefined}
    />
  );
}
```

and add `import { statusClasses } from "../lib/agentState";`.

`src/components/Sidebar.tsx`, in `Row` add `const agent = useStore((s) => s.agentState[id]);` next to the other selectors, then replace the dot span (lines 89-93) with:

```tsx
      {(() => {
        const hasAgent = !!agent && agent.status !== "offline";
        const cls = exited ? "bg-neutral-600" : hasAgent ? statusClasses(agent) : color ? "" : "bg-emerald-500";
        return (
          <span
            data-testid={`agent-dot-${id}`}
            className={`h-2 w-2 shrink-0 rounded-full ${cls}`}
            style={{ backgroundColor: !exited && !hasAgent && color ? color : undefined }}
            title={hasAgent ? `${agent.status} · ${agent.lastEvent} · ${relativeTime(agent.since)}` : undefined}
          />
        );
      })()}
```

Add near the top of `Sidebar.tsx`:

```tsx
import { statusClasses } from "../lib/agentState";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
```

(If `SyncLine` already has an equivalent `ago` helper, reuse it instead and delete this one.)

In the `Sidebar` component add `const agentHooksError = useStore((s) => s.agentHooksError);` and `const installAgentHooks = useStore((s) => s.installAgentHooks);`, then after the `persistError` block:

```tsx
      {agentHooksError && (
        <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
          <span className="flex-1">{agentHooksError}</span>
          <button className="text-neutral-400 hover:text-neutral-100" onClick={() => void installAgentHooks()}>Retry</button>
        </div>
      )}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/Sidebar.test.tsx src/components/TabGroup.tsx src/components/TabGroup.test.tsx
git commit -m "feat(ui): agent status dots in sidebar and tabs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Remote line carries the terminal id

**Files:**
- Modify: `src/lib/workspace.ts:100-118` (`startupSteps`, `startupLine`)
- Modify: `src/lib/workspace.test.ts` (startupLine describe)
- Modify: `src/store.ts:995` and `:1029` (callers)
- Modify: `src/components/TerminalPane.tsx:27`

**Interfaces:**
- Produces: `startupSteps(s: TerminalSettings, terminalId?: string): Step[]`, `startupLine(s: TerminalSettings, terminalId?: string): string | null`.

- [ ] **Step 1: Write the failing test**

In `src/lib/workspace.test.ts`, inside `describe("startupLine")`, add:

```ts
  it("prefixes the remote line with the terminal id when Claude runs there", () => {
    const steps = startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null }, "11111111-2222-3333-4444-555555555555");
    expect(steps[1]).toEqual({
      via: "remote",
      line: `cd ${shellQuote("/proj")} && SWARMZ_TERMINAL_ID=11111111-2222-3333-4444-555555555555 claude --session-id ${claude.sessionId}`,
    });
    // No Claude on the remote: nothing to identify, no prefix.
    expect(startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude: null, command: null }, "t1")[1].line).toBe(`cd ${shellQuote("/proj")}`);
    // Local Claude already inherits the env var from the spawn.
    expect(startupSteps({ ...EMPTY_SETTINGS, claude }, "t1")[0].line).toBe(`claude --session-id ${claude.sessionId}`);
    // Without an id the line is unchanged (display-only callers).
    expect(startupLine({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null })).not.toContain("SWARMZ_TERMINAL_ID");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/workspace.test.ts -t "prefixes the remote line" 2>&1 | grep -E "AssertionError|expected" | head -3`
Expected: assertion failure on the missing prefix.

- [ ] **Step 3: Implement**

In `src/lib/workspace.ts` change `startupSteps` and `startupLine`:

```ts
export function startupSteps(s: TerminalSettings, terminalId?: string): Step[] {
  const command = trimmedCommand(s);
  if (command) return [{ via: "local", line: command }];
  const claudeConfig = safeClaude(s);
  const claude = claudeConfig ? claudeLine(claudeConfig) : null;
  const host = validHost(s);
  if (host) {
    const steps: Step[] = [{ via: "local", line: sshLine(host) }];
    if (s.ssh?.cwd) {
      const cd = `cd ${shellQuote(s.ssh.cwd)}`;
      // The remote shell does not inherit our env, so the id rides on the claude line itself
      // (a UUID, so no quoting) for the hook script to find.
      const remoteClaude = claude && terminalId ? `SWARMZ_TERMINAL_ID=${terminalId} ${claude}` : claude;
      steps.push({ via: "remote", line: remoteClaude ? `${cd} && ${remoteClaude}` : cd });
    }
    return steps;
  }
  return claude ? [{ via: "local", line: claude }] : [];
}

/** Display form of the startup steps, or null when there are none. */
export function startupLine(s: TerminalSettings, terminalId?: string): string | null {
  const steps = startupSteps(s, terminalId);
  return steps.length ? steps.map((st) => st.line).join(" ⏎ ") : null;
}
```

In `src/store.ts` line 995 (`runStartup`) change to `const steps = startupSteps(settings, id);` and line 1029 (`runRemoteStep`) to `startupSteps(s.settings[id] ?? EMPTY_SETTINGS, id)`.

In `src/components/TerminalPane.tsx:27` change to `const line = startupLine(settings, id);` so the card shows the exact line that will be typed.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass. If a TerminalPane test asserts on the exact line text, update it to include the prefix.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace.ts src/lib/workspace.test.ts src/store.ts src/components/TerminalPane.tsx src/components/TerminalPane.test.tsx
git commit -m "feat(ui): remote claude line carries the terminal id for hooks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Remote watchers and remote install lifecycle

**Files:**
- Modify: `src/store.ts` (new module state, `ensureAgentWatchers`, `agentWatchEnded`, subscription)
- Modify: `src/App.tsx` (listen for `agent:watch-ended`)
- Modify: `src/store.test.ts`

**Interfaces:**
- Consumes: `ipc.agentsWatch`, `ipc.agentsUnwatch`, `ipc.agentsInstallRemote`, `ipc.onAgentWatchEnded` from Task 5.
- Produces on the store: `ensureAgentWatchers(): Promise<void>`, `agentWatchEnded(payload: { host: string | null; gen: number }): void`, and `export function __resetAgentWatchers()` for tests.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("agent state")` in `src/store.test.ts`:

```ts
  it("watches a host when its tile connects, installs hooks there once, and unwatches when the tile closes", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    __stopAllPolling();
    vi.mocked(ipc.agentsWatch).mockClear();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsWatch).toHaveBeenCalledWith("me@box");
    expect(ipc.agentsInstallRemote).toHaveBeenCalledWith("me@box");
    expect(ipc.agentsInstallRemote).toHaveBeenCalledTimes(1);
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsInstallRemote).toHaveBeenCalledTimes(1);
    expect(ipc.agentsWatch).toHaveBeenCalledTimes(1);
    await useStore.getState().closeTerminal(id);
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsUnwatch).toHaveBeenCalledWith("me@box");
  });

  it("a remote install failure becomes a startup note on that tile and is retried on the next connect", async () => {
    vi.mocked(ipc.agentsInstallRemote).mockRejectedValueOnce("not reachable: x");
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    __stopAllPolling();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(useStore.getState().startupNotes[id]).toBe("could not install Claude hooks on box: not reachable: x");
    useStore.setState((s) => ({ sshConnected: omitKey(s.sshConnected, id) }));
    await useStore.getState().ensureAgentWatchers();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsInstallRemote).toHaveBeenCalledTimes(2);
  });

  it("re-watches with backoff when a watcher ends while its host is still wanted", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
      __stopAllPolling();
      useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
      await useStore.getState().ensureAgentWatchers();
      vi.mocked(ipc.agentsWatch).mockClear();
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      expect(ipc.agentsUnwatch).toHaveBeenCalledWith("me@box");
      expect(ipc.agentsWatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledWith("me@box");
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 2 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notes on the tile once re-watching has failed for about 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
      __stopAllPolling();
      useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
      await useStore.getState().ensureAgentWatchers();
      vi.mocked(ipc.agentsWatch).mockRejectedValue("boom");
      let gen = 1;
      for (let i = 0; i < AGENT_WATCH_UNAVAILABLE_AFTER; i++) {
        useStore.getState().agentWatchEnded({ host: "me@box", gen: gen++ });
        await vi.advanceTimersByTimeAsync(AGENT_WATCH_BACKOFF_MS[Math.min(i, AGENT_WATCH_BACKOFF_MS.length - 1)]);
      }
      expect(useStore.getState().startupNotes[id]).toBe("agent state unavailable for box");
    } finally {
      vi.mocked(ipc.agentsWatch).mockReset().mockResolvedValue(undefined);
      vi.useRealTimers();
    }
  });

  it("does not re-watch a host nobody wants any more", async () => {
    vi.useFakeTimers();
    try {
      useStore.getState().agentWatchEnded({ host: "me@nowhere", gen: 9 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(ipc.agentsWatch).not.toHaveBeenCalledWith("me@nowhere");
    } finally {
      vi.useRealTimers();
    }
  });
```

Add a tiny helper near the top of the test file:

```ts
const omitKey = <T,>(o: Record<string, T>, k: string): Record<string, T> => {
  const { [k]: _drop, ...rest } = o;
  void _drop;
  return rest;
};
```

and in `beforeEach` call `__resetAgentWatchers();` (import it, `AGENT_WATCH_BACKOFF_MS` and `AGENT_WATCH_UNAVAILABLE_AFTER` from `./store`).

Note on the backoff test: `agentWatchEnded` while a retry is already pending replaces the timer, so the loop above drives exactly one `scheduleAgentRewatch` per iteration; each rejected `agentsWatch` schedules the next.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store.test.ts -t "watches a host|remote install failure|re-watches|nobody wants" 2>&1 | grep -E "×|is not a function" | head -5`
Expected: `ensureAgentWatchers is not a function`.

- [ ] **Step 3: Implement**

In `src/store.ts`:

1. Module state, after `__setLaunchedAt`:

```ts
export const AGENT_WATCH_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Hosts with a live log watcher, hosts whose hooks were installed this run, and retry state. */
const agentWatch = {
  watching: new Set<string>(),
  installed: new Set<string>(),
  attempts: new Map<string, number>(),
  retry: new Map<string, ReturnType<typeof setTimeout>>(),
};

export function __resetAgentWatchers() {
  agentWatch.watching.clear();
  agentWatch.installed.clear();
  agentWatch.attempts.clear();
  for (const t of agentWatch.retry.values()) clearTimeout(t);
  agentWatch.retry.clear();
}

/** ssh hosts that currently have a connected tile, with one terminal id per host for notes. */
function wantedAgentHosts(s: WorkbenchState): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of s.order) {
    const host = s.settings[id]?.ssh?.host?.trim();
    if (host && s.sshConnected[id] && s.terminals[id]?.exited === null && !out.has(host)) out.set(host, id);
  }
  return out;
}
```

2. Interface additions after `installAgentHooks(): Promise<void>;`:

```ts
  ensureAgentWatchers(): Promise<void>;
  agentWatchEnded(payload: { host: string | null; gen: number }): void;
```

3. Actions after `installAgentHooks`:

```ts
  async ensureAgentWatchers() {
    const s = useStore.getState();
    const wanted = wantedAgentHosts(s);
    for (const host of Array.from(agentWatch.watching)) {
      if (!wanted.has(host)) {
        agentWatch.watching.delete(host);
        agentWatch.attempts.delete(host);
        const t = agentWatch.retry.get(host);
        if (t) clearTimeout(t);
        agentWatch.retry.delete(host);
        await ipc.agentsUnwatch(host).catch(() => {});
      }
    }
    for (const [host, id] of wanted) {
      // Mark before awaiting: the subscription and an explicit call can run this concurrently,
      // and the second must see the first's claim, not race it into a duplicate install.
      if (!agentWatch.installed.has(host)) {
        agentWatch.installed.add(host);
        try {
          await ipc.agentsInstallRemote(host);
        } catch (e) {
          agentWatch.installed.delete(host);
          const machine = s.settings[id]?.ssh?.machine ?? hostLabel(host);
          set((st) => ({ startupNotes: { ...st.startupNotes, [id]: `could not install Claude hooks on ${machine}: ${typeof e === "string" ? e : String(e)}` } }));
        }
      }
      if (!agentWatch.watching.has(host) && !agentWatch.retry.has(host)) {
        agentWatch.watching.add(host);
        try {
          await ipc.agentsWatch(host);
          agentWatch.attempts.delete(host);
        } catch {
          agentWatch.watching.delete(host);
          scheduleAgentRewatch(host);
        }
      }
    }
  },

  agentWatchEnded({ host }) {
    if (host === null) {
      ipc.agentsUnwatch(null).catch(() => {});
      setTimeout(() => ipc.agentsWatch(null).catch(() => {}), AGENT_WATCH_BACKOFF_MS[0]);
      return;
    }
    agentWatch.watching.delete(host);
    ipc.agentsUnwatch(host).catch(() => {});
    if (wantedAgentHosts(useStore.getState()).has(host)) scheduleAgentRewatch(host);
  },
```

4. Module helper (after `wantedAgentHosts`):

```ts
/** After this many failed re-watches (1+2+4+8+16 s ≈ 30 s) the tile gets a note. */
export const AGENT_WATCH_UNAVAILABLE_AFTER = 5;

function scheduleAgentRewatch(host: string) {
  const n = agentWatch.attempts.get(host) ?? 0;
  agentWatch.attempts.set(host, n + 1);
  if (n + 1 === AGENT_WATCH_UNAVAILABLE_AFTER) {
    const s = useStore.getState();
    const id = wantedAgentHosts(s).get(host);
    if (id) {
      const machine = s.settings[id]?.ssh?.machine ?? hostLabel(host);
      useStore.setState((st) => ({ startupNotes: { ...st.startupNotes, [id]: `agent state unavailable for ${machine}` } }));
    }
  }
  const delay = AGENT_WATCH_BACKOFF_MS[Math.min(n, AGENT_WATCH_BACKOFF_MS.length - 1)];
  const existing = agentWatch.retry.get(host);
  if (existing) clearTimeout(existing);
  agentWatch.retry.set(
    host,
    setTimeout(() => {
      agentWatch.retry.delete(host);
      void useStore.getState().ensureAgentWatchers();
    }, delay),
  );
}
```

5. Subscription at the bottom of `store.ts`, next to the save subscription:

```ts
useStore.subscribe((s, prev) => {
  if (s.sshConnected !== prev.sshConnected || s.order !== prev.order) void s.ensureAgentWatchers();
});
```

Note the first test drives `ensureAgentWatchers` explicitly and the subscription also fires; the `installed` and `watching` sets make the extra calls no-ops, which is what the `toHaveBeenCalledTimes(1)` assertions check.

6. `App.tsx`: in the effect from Task 5 add
   `void ipc.onAgentWatchEnded((p) => useStore.getState().agentWatchEnded(p)).then((fn) => unlisten.push(fn));`

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass. If the Task 5 "loadWorkspace installs hooks" test now sees extra `agentsWatch(null)` calls from `agentWatchEnded`, that is fine; it asserts `toHaveBeenCalledWith(null)` only.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts src/App.tsx
git commit -m "feat(ui): watch agent logs on tailnet machines with connected tiles; install hooks there once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `claude.started` flips on the first prompt

**Files:**
- Modify: `src/store.ts` (`applyAgentEvent`, `runStartup` `~1010-1020`, `runRemoteStep` `~1040-1046`)
- Modify: `src/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Find the existing tests that assert `claude.started` becomes true after `runStartup` or `runRemoteStep` (search `started).toBe(true)` in `src/store.test.ts`) and change each of those assertions to `toBe(false)`. Then append inside `describe("agent state")`:

```ts
  it("UserPromptSubmit with the tile's session id marks the Claude session started", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: false } });
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit", { sessionId: "other" }));
    expect(useStore.getState().settings[id].claude?.started).toBe(false);
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit", { sessionId: "s1" }));
    expect(useStore.getState().settings[id].claude?.started).toBe(true);
  });

  it("runStartup no longer marks the session started", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: false } });
    await useStore.getState().runStartup(id);
    expect(ipc.writeTerminal).toHaveBeenCalledWith(id, "claude --session-id s1\r");
    expect(useStore.getState().settings[id].claude?.started).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store.test.ts -t "started" 2>&1 | grep -E "×|✓" | head`
Expected: the new tests fail (`started` stays false after the event; runStartup still sets true) and the edited old assertions fail.

- [ ] **Step 3: Implement**

In `applyAgentEvent` in `src/store.ts`, extend the `set` to also flip `started`:

```ts
  applyAgentEvent({ event }) {
    set((s) => {
      const id = event.terminal;
      if (!s.terminals[id]) return {};
      const settings = s.settings[id] ?? EMPTY_SETTINGS;
      if (event.ts < APP_LAUNCHED_AT && !settings.ssh) return {};
      const focused = s.windowFocused && s.focusedTerminalId === id;
      const next = foldAgentEvent(s.agentState[id], event, focused);
      const patch: Partial<WorkbenchState> = {};
      if (next) patch.agentState = { ...s.agentState, [id]: next };
      // The first prompt is what makes a session resumable: only now is `--resume` valid.
      const c = settings.claude;
      if (event.event === "UserPromptSubmit" && c?.enabled && !c.started && event.sessionId === c.sessionId) {
        patch.settings = { ...s.settings, [id]: { ...settings, claude: { ...c, started: true } } };
      }
      return patch;
    });
  },
```

In `runStartup`, replace

```ts
      const claude = !isSsh && startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return {
        settings: { ...st.settings, [id]: { ...cur, claude } },
```

with

```ts
      return {
```

(and drop the now-unused `cur` if the linter or typecheck flags it). In `runRemoteStep`, replace

```ts
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return { settings: { ...st.settings, [id]: { ...cur, claude } }, startupPending: { ...st.startupPending, [id]: false } };
```

with

```ts
      return { startupPending: { ...st.startupPending, [id]: false } };
```

Remove `startupUsesClaude` from the `./lib/workspace` import in `store.ts` if nothing else uses it (check with `grep -n startupUsesClaude src/store.ts`).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "fix(ui): mark a Claude session started on its first prompt, not when the line is typed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Manual verification and docs

**Files:**
- Modify: `CLAUDE.md` (Architecture section)

- [ ] **Step 1: Run everything**

Run: `npm test && npm run typecheck && (cd src-tauri && cargo test)`
Expected: all green.

- [ ] **Step 2: Manual smoke in the app**

Run `npm run tauri dev`. Check, in order:

1. `~/.swarmz/hooks/claude.sh` exists with mode 755 and `~/.claude/settings.json` has six swarmz entries; the herdr SessionStart hook is still there.
2. Open a local tile, type `claude`. The sidebar and tab dot go green on start.
3. Send a prompt: amber. When Claude finishes while another tile is focused: green with a ring; click the tile: ring gone.
4. Trigger a permission prompt (for example ask Claude to run a shell command in default permission mode): red. Answer it: amber, then green.
5. Quit Claude: grey.
6. Open a remote tile to a tailnet Mac, connect, and repeat 2 to 5. Confirm `~/.claude/settings.json` on that Mac gained the entries and `~/.swarmz/agents/events.log` there receives lines.
7. With Claude still running remotely, quit and relaunch swarmz: the remote tile's dot is green or amber before any new event.

Record anything that did not behave in the plan file under this step, then fix under a fresh test.

- [ ] **Step 3: Update CLAUDE.md**

Add to the Architecture section of `CLAUDE.md`, after the "Workspace persistence and tailnet sync" bullet list:

```markdown
### Agent state

Claude Code lifecycle hooks (installed once per machine into `~/.claude/settings.json`, script at `~/.swarmz/hooks/claude.sh`) append one line per event to `~/.swarmz/agents/events.log` on the machine Claude runs on. `agents.rs` tails that file locally and over the shared ssh socket for each tailnet machine with a connected tile, emitting `agent:event`. `src/lib/agentState.ts` is the pure reducer (offline / working / idle / blocked, plus `unseen`); the store owns watcher lifecycle, replay rules and the `claude.started` flip on the first `UserPromptSubmit`. Remote claude lines carry `SWARMZ_TERMINAL_ID=<id>` because the remote shell does not inherit the local env.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-09-15-agent-state-hooks.md
git commit -m "docs: agent state in CLAUDE.md; plan notes from manual smoke

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
