//! Telegram from the desktop (conductor spec §5): the Notifications panel's read, write and
//! fan-out of `~/.swarmz/telegram.json`, a test message, and the follower (`swarmz
//! telegram-follow`) the app keeps running while the conductor runs on this Mac.

use crate::agents::ssh_command;
use crate::remote::{run_with_timeout, run_with_timeout_input, validate_host};
use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use swarmz_tool::telegram::{self, Config};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramInfo {
    pub configured: bool,
    pub chat_id: String,
    /// The token's last four characters, so the panel can say one is set without showing it.
    pub token_end: String,
}

pub fn info_in(home: &std::path::Path) -> TelegramInfo {
    match telegram::read(home) {
        Some(c) => TelegramInfo { configured: true, chat_id: c.chat_id.clone(), token_end: c.token.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect() },
        None => TelegramInfo { configured: false, chat_id: String::new(), token_end: String::new() },
    }
}

/// A bot token looks like `123456:ABC-DEF…`; a chat id is an integer, negative for groups.
pub fn validate(token: &str, chat_id: &str) -> Result<Config, String> {
    let token = token.trim();
    let chat_id = chat_id.trim();
    if token.is_empty() || chat_id.is_empty() {
        return Err("both the bot token and the chat id are needed".into());
    }
    if token.len() > 200 || !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-')) {
        return Err("the token has characters a bot token never has".into());
    }
    if !token.contains(':') {
        return Err("a bot token looks like 123456789:AAxx…".into());
    }
    let digits = chat_id.strip_prefix('-').unwrap_or(chat_id);
    if digits.is_empty() || digits.len() > 20 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err("the chat id is a number (the one @userinfobot or @getidsbot shows)".into());
    }
    Ok(Config { token: token.to_string(), chat_id: chat_id.to_string() })
}

/// Writes `len` bytes of stdin to `~/.swarmz/telegram.json` on the remote, mode 0600, atomically
/// and only at full length (see `remote_write_script_command` for why the size is checked).
pub fn remote_write_command(len: usize) -> String {
    format!(
        "umask 077 && mkdir -p ~/.swarmz && cat > ~/.swarmz/telegram.json.tmp.$$ && [ \"$(wc -c < ~/.swarmz/telegram.json.tmp.$$ | tr -d ' ')\" -eq {len} ] && chmod 600 ~/.swarmz/telegram.json.tmp.$$ && mv -f ~/.swarmz/telegram.json.tmp.$$ ~/.swarmz/telegram.json || {{ rm -f ~/.swarmz/telegram.json.tmp.$$; exit 1; }}"
    )
}

pub const REMOTE_REMOVE_COMMAND: &str = "rm -f ~/.swarmz/telegram.json";
pub const REMOTE_READ_COMMAND: &str = "cat ~/.swarmz/telegram.json 2>/dev/null; true";

/// What a push does to a remote Mac's setup.
#[derive(Debug, PartialEq)]
pub enum PushPlan {
    Write,
    Remove,
    Nothing,
}

/// A push's decision: this Mac's setup is written where it differs; a Mac with none here
/// removes the remote's only when the user removed it (`remove`), never on a routine sync,
/// or a Mac that was never set up would wipe the setup of every Mac it connects to.
pub fn push_plan(local: Option<&Config>, remote: Option<&Config>, remote_has_file: bool, remove: bool) -> PushPlan {
    match local {
        Some(cfg) if remote != Some(cfg) => PushPlan::Write,
        Some(_) => PushPlan::Nothing,
        None if remove && (remote.is_some() || remote_has_file) => PushPlan::Remove,
        None => PushPlan::Nothing,
    }
}

/// Copies this Mac's setup to `host` where it differs; with `remove` (the user removed it here),
/// a Mac with no setup removes `host`'s too. True when something changed there.
pub fn push(host: &str, remove: bool) -> Result<bool, String> {
    let host = validate_host(host)?;
    let local = telegram::read(&swarmz_tool::paths::home_dir());
    let mut cmd = ssh_command(&host)?;
    cmd.arg(REMOTE_READ_COMMAND);
    let done = run_with_timeout(cmd, Duration::from_secs(10), "ssh")?;
    if !done.status.success() {
        return Err(ssh_failure(&done));
    }
    let remote: Option<Config> = serde_json::from_str::<serde_json::Value>(done.stdout.trim()).ok().and_then(|v| {
        Some(Config { token: v["token"].as_str()?.trim().to_string(), chat_id: v["chatId"].as_str()?.trim().to_string() })
    });
    match (push_plan(local.as_ref(), remote.as_ref(), !done.stdout.trim().is_empty(), remove), local) {
        (PushPlan::Write, Some(cfg)) => {
            let payload = format!("{}\n", serde_json::json!({"token": cfg.token, "chatId": cfg.chat_id}));
            let mut cmd = ssh_command(&host)?;
            cmd.arg(remote_write_command(payload.len()));
            let done = run_with_timeout_input(cmd, Duration::from_secs(10), "ssh", Some(payload.as_bytes()))?;
            if !done.status.success() {
                return Err(ssh_failure(&done));
            }
            Ok(true)
        }
        (PushPlan::Remove, _) => {
            let mut cmd = ssh_command(&host)?;
            cmd.arg(REMOTE_REMOVE_COMMAND);
            let done = run_with_timeout(cmd, Duration::from_secs(10), "ssh")?;
            if !done.status.success() {
                return Err(ssh_failure(&done));
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn ssh_failure(done: &crate::remote::Finished) -> String {
    if done.status.code() == Some(255) {
        format!("not reachable: {}", done.stderr.trim())
    } else if done.stderr.trim().is_empty() {
        format!("failed (exit {:?})", done.status.code())
    } else {
        done.stderr.trim().to_string()
    }
}

/// `swarmz telegram-follow`, kept running: restarted after it ends (a network blip, a Mac
/// waking) with a pause between, until stopped. One per app.
pub struct Follower {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    gen: u64,
}

static FOLLOWER_GEN: AtomicU64 = AtomicU64::new(0);
const RESTART_PAUSE: Duration = Duration::from_secs(15);

impl Follower {
    pub fn start(tool: std::path::PathBuf) -> Follower {
        let stop = Arc::new(AtomicBool::new(false));
        let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        let gen = FOLLOWER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let (stop_t, child_t) = (stop.clone(), child.clone());
        std::thread::spawn(move || {
            while !stop_t.load(Ordering::SeqCst) {
                let mut cmd = Command::new(&tool);
                cmd.arg("telegram-follow").env_remove("SWARMZ_TERMINAL_ID").env_remove("SWARMZ_TERMINAL_NAME").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                match cmd.spawn() {
                    Ok(mut c) => {
                        // Stop may have been asked for while spawning: kill what was just started.
                        if stop_t.load(Ordering::SeqCst) {
                            let _ = c.kill();
                            let _ = c.wait();
                            return;
                        }
                        *child_t.lock().unwrap() = Some(c);
                        // Poll rather than block in `wait`: the lock must stay free for a stop.
                        loop {
                            if stop_t.load(Ordering::SeqCst) {
                                return;
                            }
                            let ended = match child_t.lock().unwrap().as_mut() {
                                Some(c) => c.try_wait().map(|st| st.is_some()).unwrap_or(true),
                                None => true,
                            };
                            if ended {
                                if let Some(mut c) = child_t.lock().unwrap().take() {
                                    let _ = c.wait();
                                }
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(250));
                        }
                    }
                    Err(e) => eprintln!("swarmz: could not start telegram-follow: {e}"),
                }
                if stop_t.load(Ordering::SeqCst) {
                    return;
                }
                // Wait in small steps so a stop is felt promptly.
                let mut waited = Duration::ZERO;
                while waited < RESTART_PAUSE && !stop_t.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(250));
                    waited += Duration::from_millis(250);
                }
            }
        });
        Follower { stop, child, gen }
    }

    pub fn gen(&self) -> u64 {
        self.gen
    }
}

impl Drop for Follower {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_mac_without_telegram_never_wipes_another_macs_unless_the_user_removed_it() {
        let cfg = Config { token: "1:a".into(), chat_id: "42".into() };
        let other = Config { token: "1:a".into(), chat_id: "7".into() };
        assert_eq!(push_plan(None, Some(&cfg), true, false), PushPlan::Nothing);
        assert_eq!(push_plan(None, Some(&cfg), true, true), PushPlan::Remove);
        assert_eq!(push_plan(None, None, true, true), PushPlan::Remove, "an unreadable file goes too");
        assert_eq!(push_plan(None, None, false, true), PushPlan::Nothing);
        assert_eq!(push_plan(Some(&cfg), Some(&other), true, false), PushPlan::Write);
        assert_eq!(push_plan(Some(&cfg), None, false, false), PushPlan::Write);
        assert_eq!(push_plan(Some(&cfg), Some(&cfg), true, true), PushPlan::Nothing);
    }

    use super::*;

    #[test]
    fn validation_accepts_bot_tokens_and_chat_ids_only() {
        let ok = validate(" 123456:AAxx-yy_zz ", " -100123 ").unwrap();
        assert_eq!(ok, Config { token: "123456:AAxx-yy_zz".into(), chat_id: "-100123".into() });
        assert!(validate("", "1").is_err());
        assert!(validate("123456AAxx", "1").is_err());
        assert!(validate("123:abc", "12a").is_err());
        assert!(validate("123:abc", "-").is_err());
        assert!(validate("123:a b", "1").is_err());
        assert!(validate("123:a;rm", "1").is_err());
    }

    #[test]
    fn info_says_configured_without_the_token() {
        let dir = std::env::temp_dir().join(format!("szb-{}-telegram-info", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(info_in(&dir), TelegramInfo { configured: false, chat_id: String::new(), token_end: String::new() });
        telegram::write(&dir, &Config { token: "123456:AAxxyyzz".into(), chat_id: "42".into() }).unwrap();
        let i = info_in(&dir);
        assert_eq!((i.configured, i.chat_id.as_str(), i.token_end.as_str()), (true, "42", "yyzz"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_remote_write_is_atomic_private_and_size_checked() {
        let c = remote_write_command(57);
        assert!(c.starts_with("umask 077 && mkdir -p ~/.swarmz && cat > ~/.swarmz/telegram.json.tmp.$$"));
        assert!(c.contains("-eq 57"));
        assert!(c.contains("chmod 600"));
        assert!(c.contains("mv -f ~/.swarmz/telegram.json.tmp.$$ ~/.swarmz/telegram.json"));
        assert!(c.ends_with("exit 1; }"));
    }

    #[test]
    fn a_follower_stops_its_child() {
        // A "tool" that sleeps: the follower must end it on drop, and not respawn it.
        let dir = std::env::temp_dir().join(format!("szb-{}-follower", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("tool.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let f = Follower::start(script.clone());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let pid = loop {
            if let Some(c) = f.child.lock().unwrap().as_ref() {
                break c.id();
            }
            assert!(std::time::Instant::now() < deadline, "the follower never started its child");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(unsafe { libc::kill(pid as i32, 0) } == 0);
        drop(f);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(pid as i32, 0) } == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(unsafe { libc::kill(pid as i32, 0) } != 0, "the child outlived the follower");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
