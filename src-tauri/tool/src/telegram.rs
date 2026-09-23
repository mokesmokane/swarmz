//! Telegram (conductor spec §5): the per-Mac `~/.swarmz/telegram.json`, `swarmz notify` (a
//! message to the user) and `swarmz telegram-follow` (the user's messages, typed into the
//! conductor). Requests go through `curl`, which every Mac has; the token travels in a curl
//! config on stdin, never in an argument list.

use crate::hold::CliError;
use serde_json::{json, Value};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Telegram cuts messages at 4096 characters; this leaves room for the title line.
pub const TEXT_MAX: usize = 4000;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub token: String,
    pub chat_id: String,
}

pub fn path(home: &Path) -> PathBuf {
    home.join(".swarmz").join("telegram.json")
}

/// The Mac's Telegram setup, or None when there is none (or the file is unreadable or incomplete).
pub fn read(home: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(path(home)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let token = v["token"].as_str()?.trim().to_string();
    let chat_id = v["chatId"].as_str()?.trim().to_string();
    if token.is_empty() || chat_id.is_empty() {
        return None;
    }
    Some(Config { token, chat_id })
}

/// Writes the setup, mode 0600, atomically. The token is the bot's; the chat id the user's.
pub fn write(home: &Path, cfg: &Config) -> Result<(), String> {
    let target = path(home);
    let dir = target.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".telegram.json.swarmz-tmp-{}", std::process::id()));
    let text = format!("{}\n", json!({"token": cfg.token, "chatId": cfg.chat_id}));
    let written = (|| -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("could not create {}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("could not sync {}: {e}", tmp.display()))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not move {} into place: {e}", tmp.display())
    })
}

/// Removes the setup; fine when there is none.
pub fn remove(home: &Path) -> Result<(), String> {
    match std::fs::remove_file(path(home)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", path(home).display())),
    }
}

/// The API's base URL: Telegram's, or `SWARMZ_TELEGRAM_API` (a fake server in tests).
pub fn api_base() -> String {
    std::env::var("SWARMZ_TELEGRAM_API").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "https://api.telegram.org".to_string())
}

pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Cuts `s` to at most `max` characters, marking the cut.
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The HTML message `notify` sends: the tile's title in bold on its own line when given, then
/// the text, at most [`TEXT_MAX`] characters of it.
pub fn message_text(tile_title: Option<&str>, text: &str) -> String {
    let body = escape_html(&cut(text.trim(), TEXT_MAX));
    match tile_title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => format!("<b>{}</b>\n{body}", escape_html(t)),
        None => body,
    }
}

/// A value for a curl config line: double-quoted, with curl's escapes.
pub fn config_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Calls `method` with a JSON body through curl (config on stdin, so the token is in no
/// argument list) and returns Telegram's `result`; `ok: false` and transport failures are
/// `failed` with the description.
fn call(cfg: &Config, method: &str, body: &Value, timeout: Duration) -> Result<Value, CliError> {
    let url = format!("{}/bot{}/{method}", api_base(), cfg.token);
    let config = format!(
        "url = {}\nheader = \"Content-Type: application/json\"\ndata = {}\n",
        config_value(&url),
        config_value(&body.to_string())
    );
    let mut c = Command::new("curl");
    c.args(["-sS", "--max-time", &timeout.as_secs().to_string(), "-K", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| CliError::new("failed", format!("could not run curl: {e}")))?;
    {
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all(config.as_bytes());
    }
    let done = child.wait_with_output().map_err(|e| CliError::new("failed", format!("curl: {e}")))?;
    let stdout = String::from_utf8_lossy(&done.stdout);
    if !done.status.success() {
        let err = crate::util::last_non_blank(&String::from_utf8_lossy(&done.stderr)).unwrap_or_else(|| format!("curl exited with {:?}", done.status.code()));
        return Err(CliError::new("failed", format!("Telegram is not reachable: {err}")));
    }
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|_| CliError::new("failed", format!("Telegram answered something unreadable: {}", cut(stdout.trim(), 200))))?;
    if v["ok"].as_bool() != Some(true) {
        let why = v["description"].as_str().unwrap_or("no description");
        return Err(CliError::new("failed", format!("Telegram refused: {why}")));
    }
    Ok(v["result"].clone())
}

/// Sends `html` to the configured chat.
pub fn send_message(cfg: &Config, html: &str) -> Result<(), CliError> {
    call(cfg, "sendMessage", &json!({"chat_id": cfg.chat_id, "text": html, "parse_mode": "HTML"}), Duration::from_secs(15)).map(|_| ())
}

/// Long-polls for updates after `offset`, waiting up to `wait` seconds server side.
pub fn get_updates(cfg: &Config, offset: i64, wait: u64) -> Result<Vec<Value>, CliError> {
    let r = call(cfg, "getUpdates", &json!({"offset": offset, "timeout": wait, "allowed_updates": ["message"]}), Duration::from_secs(wait + 15))?;
    Ok(r.as_array().cloned().unwrap_or_default())
}

/// The text of an update's message when it came from the configured chat; anything else
/// (another sender, a sticker, an edit) is None.
pub fn text_from_chat(update: &Value, chat_id: &str) -> Option<String> {
    let m = &update["message"];
    let from = &m["chat"]["id"];
    let same = match from {
        Value::Number(n) => n.to_string() == chat_id,
        Value::String(s) => s == chat_id,
        _ => false,
    };
    if !same {
        return None;
    }
    m["text"].as_str().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// The message `conductor --claim` sends when Telegram is set up (spec §3, §5).
pub fn claim_message(title: &str) -> String {
    format!("🎛 <b>{}</b> asks to be the conductor. Reply <b>approve</b> or <b>deny</b>.", escape_html(title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_with_mode_0600_and_rejects_incomplete_files() {
        let dir = std::env::temp_dir().join(format!("szc-{}-telegram", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read(&dir), None);
        let cfg = Config { token: "123:abc".into(), chat_id: "42".into() };
        write(&dir, &cfg).unwrap();
        assert_eq!(read(&dir), Some(cfg));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(path(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::write(path(&dir), r#"{"token":"x"}"#).unwrap();
        assert_eq!(read(&dir), None);
        std::fs::write(path(&dir), r#"{"token":" ","chatId":"1"}"#).unwrap();
        assert_eq!(read(&dir), None);
        remove(&dir).unwrap();
        remove(&dir).unwrap();
        assert!(!path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn messages_are_html_with_a_bold_title_and_cut() {
        assert_eq!(message_text(None, " a <b> & c "), "a &lt;b&gt; &amp; c");
        assert_eq!(message_text(Some("api <1>"), "hi"), "<b>api &lt;1&gt;</b>\nhi");
        assert_eq!(message_text(Some("  "), "hi"), "hi");
        let long = "x".repeat(TEXT_MAX + 50);
        let out = message_text(None, &long);
        assert_eq!(out.chars().count(), TEXT_MAX);
        assert!(out.ends_with('…'));
        assert!(claim_message("a<b").contains("<b>a&lt;b</b>"));
    }

    #[test]
    fn curl_config_values_are_quoted_with_curls_escapes() {
        assert_eq!(config_value(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(config_value("x\ny"), "\"x\\ny\"");
        assert_eq!(config_value("ünï"), "\"ünï\"");
    }

    #[test]
    fn only_the_configured_chats_text_counts() {
        let u = json!({"update_id": 1, "message": {"chat": {"id": 42}, "text": " hello "}});
        assert_eq!(text_from_chat(&u, "42"), Some("hello".into()));
        assert_eq!(text_from_chat(&u, "43"), None);
        let s = json!({"update_id": 2, "message": {"chat": {"id": "42"}, "sticker": {}}});
        assert_eq!(text_from_chat(&s, "42"), None);
        let neg = json!({"update_id": 3, "message": {"chat": {"id": -100123}, "text": "x"}});
        assert_eq!(text_from_chat(&neg, "-100123"), Some("x".into()));
        assert_eq!(text_from_chat(&json!({"update_id": 4}), "42"), None);
    }
}
