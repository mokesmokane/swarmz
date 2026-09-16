//! Phone keys in `~/.ssh/authorized_keys`, each locked to the ssh gate (spec §7.2).

use crate::workspace::Workspace;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const KEY_TAG: &str = "swarmz-phone:";

/// Everything in a `key_line` before the public key itself.
const OPTIONS_PREFIX: &str =
    "command=\"$HOME/.swarmz/bin/swarmz ssh-gate\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ";

pub fn authorized_keys(home: &Path) -> PathBuf {
    home.join(".ssh").join("authorized_keys")
}

/// Letters, digits, single spaces (never leading, trailing or doubled), `.`, `_` and `-`;
/// 1–40 characters.
pub fn valid_device(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 40
        && !name.starts_with(' ')
        && !name.ends_with(' ')
        && !name.contains("  ")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

/// `ssh-ed25519 <base64>` and nothing else.
pub fn valid_pubkey(key: &str) -> bool {
    let mut parts = key.split(' ');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some("ssh-ed25519"), Some(blob), None) if !blob.is_empty() && blob.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
    )
}

pub fn key_line(device: &str, pubkey: &str) -> String {
    format!("{OPTIONS_PREFIX}{pubkey} {KEY_TAG}{device}")
}

/// A fully gated `authorized_keys` line, parsed apart.
struct GatedLine {
    key_type: String,
    blob: String,
    device: String,
}

/// Parses a line as: exactly the options prefix `key_line` writes, then `<key_type> <blob> `,
/// then `swarmz-phone:<device>` as the rest of the line (which may itself contain spaces).
/// Anything else — a missing/altered options prefix, a different comment, a device-less
/// tag — is not a gated line and is ignored by every caller here.
fn parse_gated_line(line: &str) -> Option<GatedLine> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let rest = line.strip_prefix(OPTIONS_PREFIX)?;
    let mut parts = rest.splitn(3, ' ');
    let key_type = parts.next()?;
    if key_type != "ssh-ed25519" {
        return None;
    }
    let blob = parts.next()?;
    if blob.is_empty() {
        return None;
    }
    let tail = parts.next()?;
    let device = tail.strip_prefix(KEY_TAG)?;
    if device.is_empty() {
        return None;
    }
    Some(GatedLine { key_type: key_type.to_string(), blob: blob.to_string(), device: device.to_string() })
}

/// The last `n` characters of `s`, by character, not by byte.
fn last_chars(s: &str, n: usize) -> String {
    let skip = s.chars().count().saturating_sub(n);
    s.chars().skip(skip).collect()
}

/// Resolves `path` to the file it should actually be written to: itself, unless it is a
/// symlink, in which case its (fully resolved) target, so replacing the file's contents
/// never replaces the symlink itself.
fn write_target(path: &Path) -> PathBuf {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

/// Writes `text` to `path` (following a symlink to its target) via a private (`0600`) temp
/// file, `fsync`ed and atomically renamed into place. The containing folder is created
/// private (`0700`) if it does not already exist. The temp file is removed on any failure.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("authorized_keys has no folder")?;
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let target = write_target(path);
    let target_dir = target.parent().unwrap_or(dir);
    let file_name = target.file_name().and_then(|n| n.to_str()).unwrap_or("authorized_keys");
    let tmp = target_dir.join(format!(".{file_name}.swarmz-tmp-{}", std::process::id()));

    let write_result = (|| -> Result<(), String> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("could not create {}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("could not sync {}: {e}", tmp.display()))
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not replace {}: {e}", target.display()));
    }
    Ok(())
}

/// Reads `path`, treating a missing file as empty text but propagating every other error
/// (permission denied, not valid UTF-8, and so on) rather than silently losing the file's
/// contents.
fn read_or_empty(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Appends the phone's line unless the key is already there on a live gated line (`Ok(false)`).
/// An error if the same key material already appears on some other, non-gated line: adding it
/// again would be misleading, since that copy of the key is not restricted to the gate.
pub fn add_key(path: &Path, device: &str, pubkey: &str) -> Result<bool, String> {
    if !valid_device(device) {
        return Err(format!("invalid device name {device:?}"));
    }
    if !valid_pubkey(pubkey) {
        return Err("the key must be an ssh-ed25519 public key".into());
    }
    let blob = pubkey.split(' ').nth(1).unwrap_or("");
    let mut text = read_or_empty(path)?;

    let mut present_unrestricted = false;
    for line in text.lines() {
        match parse_gated_line(line) {
            Some(gated) if gated.blob == blob => return Ok(false),
            Some(_) => {}
            None => {
                if line.split(' ').any(|w| w == blob) {
                    present_unrestricted = true;
                }
            }
        }
    }
    if present_unrestricted {
        return Err("this key is already present without the swarmz restriction".into());
    }

    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&key_line(device, pubkey));
    text.push('\n');
    write_private(path, &text)?;
    Ok(true)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneKey {
    pub device: String,
    pub key_type: String,
    /// The last 8 characters of the key, to tell keys apart.
    pub key_end: String,
}

/// Only fully gated lines (the exact options prefix, `ssh-ed25519`, and a `swarmz-phone:`
/// device tag) are listed. Errors reading the file are treated as no keys.
pub fn list_keys(path: &Path) -> Vec<PhoneKey> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter_map(|line| {
            let gated = parse_gated_line(line)?;
            Some(PhoneKey { device: gated.device, key_type: gated.key_type, key_end: last_chars(&gated.blob, 8) })
        })
        .collect()
}

/// Removes the device's fully gated lines, leaving every other line byte for byte untouched
/// (including its own `\n` or `\r\n` ending). Returns how many were removed.
pub fn revoke(path: &Path, device: &str) -> Result<usize, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut removed = 0usize;
    let mut kept = String::with_capacity(text.len());
    for raw_line in text.split_inclusive('\n') {
        let content = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        if parse_gated_line(content).is_some_and(|g| g.device == device) {
            removed += 1;
            continue;
        }
        kept.push_str(raw_line);
    }
    if removed > 0 {
        write_private(path, &kept)?;
    }
    Ok(removed)
}

/// An ssh username: `^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$`. In particular this can never start
/// with `-`, so it can never be mistaken for an ssh option.
fn valid_ssh_user(user: &str) -> bool {
    let bytes = user.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    let head_ok = matches!(bytes[0], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_');
    head_ok && bytes[1..].iter().all(|&b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

/// The other Macs swarmz knows, as ssh destinations: the workspace's `machines` plus `peers`
/// (other Macs online on the tailnet, which use `default_user` unless configured). A machine is
/// skipped when its name is not a valid tile id or starts with `-`, or when neither its
/// configured user nor `default_user` is a valid ssh username (an invalid configured user is
/// never silently replaced by the default).
pub fn machine_hosts(ws: &Workspace, self_machine: Option<&str>, default_user: &str, peers: &[String]) -> Vec<(String, String)> {
    let empty = serde_json::Map::new();
    let machines = ws.extra.get("machines").and_then(|m| m.as_object()).unwrap_or(&empty);
    let names: std::collections::BTreeSet<&str> = machines.keys().map(String::as_str).chain(peers.iter().map(String::as_str)).collect();
    names
        .into_iter()
        .filter(|name| Some(*name) != self_machine)
        .filter(|name| crate::paths::valid_tile_id(name) && !name.starts_with('-'))
        .filter_map(|name| {
            let configured = machines.get(name).and_then(|cfg| cfg.get("user")).and_then(|u| u.as_str()).map(str::trim).filter(|u| !u.is_empty());
            let user = match configured {
                Some(u) if valid_ssh_user(u) => u,
                Some(_) => return None,
                None if valid_ssh_user(default_user) => default_user,
                None => return None,
            };
            Some((name.to_string(), format!("{user}@{name}")))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4Jm5mJ0x1bm9SZXBsYWNlVGhpc0tleUZvclRlc3Q";

    fn tmp(tag: &str) -> PathBuf {
        let d = PathBuf::from(format!("/tmp/szc-{}-phone-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn validation() {
        assert!(!valid_device("Martin's Fold"));
        assert!(valid_device("fold-7"));
        assert!(valid_device("Galaxy Z Fold 6"));
        assert!(!valid_device(""));
        assert!(!valid_device(&"a".repeat(41)));
        // Tightened: no leading, trailing or doubled spaces.
        assert!(!valid_device(" fold"));
        assert!(!valid_device("fold "));
        assert!(!valid_device("fold  7"));
        assert!(valid_pubkey(KEY));
        assert!(!valid_pubkey("ssh-rsa AAAA"));
        assert!(!valid_pubkey("ssh-ed25519 AAAA\" evil"));
        assert!(!valid_pubkey("ssh-ed25519 AAAA,command=x"));
        assert!(!valid_pubkey("ssh-ed25519 AAAA extra words"));
        assert!(!valid_pubkey("ssh-ed25519 "));
    }

    #[test]
    fn the_line_forces_the_gate() {
        assert_eq!(
            key_line("fold", KEY),
            format!("command=\"$HOME/.swarmz/bin/swarmz ssh-gate\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty {KEY} swarmz-phone:fold")
        );
    }

    #[test]
    fn add_list_and_revoke() {
        let h = tmp("keys");
        let path = authorized_keys(&h);
        assert!(add_key(&path, "fold", KEY).unwrap());
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        // The same key again is not added twice.
        assert!(!add_key(&path, "fold", KEY).unwrap());
        // Existing lines are kept, even without a trailing newline.
        std::fs::write(&path, "ssh-ed25519 AAAAmine me@mac").unwrap();
        assert!(add_key(&path, "fold", KEY).unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("ssh-ed25519 AAAAmine me@mac\n"));
        assert!(text.ends_with("swarmz-phone:fold\n"));
        let keys = list_keys(&path);
        assert_eq!(keys.len(), 1);
        assert_eq!((keys[0].device.as_str(), keys[0].key_type.as_str()), ("fold", "ssh-ed25519"));
        assert_eq!(keys[0].key_end, KEY[KEY.len() - 8..]);
        assert_eq!(revoke(&path, "other").unwrap(), 0);
        assert_eq!(revoke(&path, "fold").unwrap(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ssh-ed25519 AAAAmine me@mac\n");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn spaced_device_names_are_matched_in_full() {
        let h = tmp("spaced");
        let path = authorized_keys(&h);
        assert!(add_key(&path, "Galaxy Z Fold 6", KEY).unwrap());
        let keys = list_keys(&path);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].device, "Galaxy Z Fold 6");
        assert_eq!(revoke(&path, "Galaxy Z Fold 6").unwrap(), 1);
        assert!(list_keys(&path).is_empty());
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_read_error_other_than_missing_is_not_swallowed() {
        let h = tmp("readerr");
        // A directory where a file is expected: read_to_string fails with something other
        // than NotFound, and that must not be treated as "no keys, start fresh".
        let path = h.join("dir-not-a-file");
        std::fs::create_dir_all(&path).unwrap();
        assert!(add_key(&path, "fold", KEY).is_err());
        assert!(revoke(&path, "fold").is_err());
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn only_fully_gated_lines_are_matched() {
        let h = tmp("lookalike");
        let path = authorized_keys(&h);
        // No options prefix: an ordinary, unrestricted key whose comment happens to look
        // like a phone tag.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let lookalike = format!("{KEY} swarmz-phone:fold\n");
        std::fs::write(&path, &lookalike).unwrap();
        assert!(list_keys(&path).is_empty());
        assert_eq!(revoke(&path, "fold").unwrap(), 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), lookalike);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn adding_a_key_present_without_the_restriction_is_an_error() {
        let h = tmp("unrestricted");
        let path = authorized_keys(&h);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let unrestricted = format!("{KEY} me@laptop\n");
        std::fs::write(&path, &unrestricted).unwrap();
        let err = add_key(&path, "fold", KEY).unwrap_err();
        assert!(err.contains("already present"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), unrestricted);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn writes_survive_a_symlinked_authorized_keys() {
        let h = tmp("symlink");
        let real_dir = h.join("elsewhere");
        std::fs::create_dir_all(&real_dir).unwrap();
        let real_path = real_dir.join("authorized_keys");
        std::fs::write(&real_path, "").unwrap();
        let ssh_dir = h.join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        let link_path = ssh_dir.join("authorized_keys");
        std::os::unix::fs::symlink(&real_path, &link_path).unwrap();

        assert!(add_key(&link_path, "fold", KEY).unwrap());
        assert!(std::fs::symlink_metadata(&link_path).unwrap().file_type().is_symlink());
        let text = std::fs::read_to_string(&real_path).unwrap();
        assert!(text.ends_with("swarmz-phone:fold\n"));

        assert_eq!(revoke(&link_path, "fold").unwrap(), 1);
        assert!(std::fs::symlink_metadata(&link_path).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&real_path).unwrap(), "");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn crlf_lines_are_tolerated_and_other_lines_untouched() {
        let h = tmp("crlf");
        let path = authorized_keys(&h);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let gated = key_line("fold", KEY);
        let text = format!("ssh-ed25519 AAAAmine me@mac\r\n{gated}\r\n");
        std::fs::write(&path, &text).unwrap();

        let keys = list_keys(&path);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].device, "fold");

        assert_eq!(revoke(&path, "fold").unwrap(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ssh-ed25519 AAAAmine me@mac\r\n");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn machine_hosts_skip_this_mac_and_use_the_configured_user() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"mini": {"lastUsed": "t"}, "studio": {"user": "admin", "lastUsed": "t"}, "air": {"lastUsed": "t"}}
        }))
        .unwrap();
        let hosts = machine_hosts(&ws, Some("mini"), "me", &[]);
        assert_eq!(hosts, vec![("air".to_string(), "me@air".to_string()), ("studio".to_string(), "admin@studio".to_string())]);
    }

    #[test]
    fn machine_hosts_add_tailnet_peers_with_the_default_user() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"mini": {"lastUsed": "t"}, "studio": {"user": "admin", "lastUsed": "t"}}
        }))
        .unwrap();
        let peers = ["studio", "laptop", "mini", "-evil", "a.b"].map(String::from);
        let hosts = machine_hosts(&ws, Some("mini"), "me", &peers);
        assert_eq!(hosts, vec![("laptop".to_string(), "me@laptop".to_string()), ("studio".to_string(), "admin@studio".to_string())]);
        // No workspace machines at all: the peers alone.
        let bare: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({"version": 1, "terminals": [], "layout": null})).unwrap();
        assert_eq!(machine_hosts(&bare, None, "me", &["air".to_string()]), vec![("air".to_string(), "me@air".to_string())]);
        assert_eq!(machine_hosts(&bare, None, "", &["air".to_string()]), vec![]);
    }

    #[test]
    fn machine_hosts_rejects_a_hostile_configured_user() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"studio": {"user": "-oProxyCommand=x", "lastUsed": "t"}}
        }))
        .unwrap();
        // Invalid configured user: skipped, never falls back to default_user.
        assert_eq!(machine_hosts(&ws, None, "me", &[]), vec![]);
    }

    #[test]
    fn machine_hosts_rejects_a_user_containing_at() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"studio": {"user": "a@b", "lastUsed": "t"}}
        }))
        .unwrap();
        assert_eq!(machine_hosts(&ws, None, "me", &[]), vec![]);
    }

    #[test]
    fn machine_hosts_skips_when_the_default_user_is_blank() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"studio": {"lastUsed": "t"}}
        }))
        .unwrap();
        assert_eq!(machine_hosts(&ws, None, "", &[]), vec![]);
    }

    #[test]
    fn machine_hosts_rejects_a_machine_name_starting_with_a_dash() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"-badmachine": {"lastUsed": "t"}}
        }))
        .unwrap();
        // valid_tile_id alone would accept this (letters, digits, `-`); the leading dash
        // must be rejected explicitly so it can never be mistaken for an ssh option.
        assert_eq!(machine_hosts(&ws, None, "me", &[]), vec![]);
    }
}
