//! Phone keys in `~/.ssh/authorized_keys`, each locked to the ssh gate (spec §7.2).

use crate::workspace::Workspace;
use serde::Serialize;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const KEY_TAG: &str = "swarmz-phone:";

pub fn authorized_keys(home: &Path) -> PathBuf {
    home.join(".ssh").join("authorized_keys")
}

/// Letters, digits, spaces, `.`, `_` and `-`; 1–40 characters.
pub fn valid_device(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 40 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
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
    format!("command=\"$HOME/.swarmz/bin/swarmz ssh-gate\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty {pubkey} {KEY_TAG}{device}")
}

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("authorized_keys has no folder")?;
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("swarmz-tmp-{}", std::process::id()));
    let mut f = std::fs::File::create(&tmp).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}

fn comment_device(line: &str) -> Option<&str> {
    line.rsplit(' ').next()?.strip_prefix(KEY_TAG)
}

/// Appends the phone's line unless the key is already there. True when it was added.
pub fn add_key(path: &Path, device: &str, pubkey: &str) -> Result<bool, String> {
    if !valid_device(device) {
        return Err(format!("invalid device name {device:?}"));
    }
    if !valid_pubkey(pubkey) {
        return Err("the key must be an ssh-ed25519 public key".into());
    }
    let mut text = std::fs::read_to_string(path).unwrap_or_default();
    if text.lines().any(|l| l.split(' ').any(|w| w == pubkey.split(' ').nth(1).unwrap_or(""))) {
        return Ok(false);
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

pub fn list_keys(path: &Path) -> Vec<PhoneKey> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter_map(|l| {
            let device = comment_device(l)?.to_string();
            let words: Vec<&str> = l.split(' ').collect();
            let at = words.iter().position(|w| *w == "ssh-ed25519")?;
            let blob = words.get(at + 1)?;
            Some(PhoneKey { device, key_type: "ssh-ed25519".into(), key_end: blob[blob.len().saturating_sub(8)..].to_string() })
        })
        .collect()
}

/// Removes the device's lines. Returns how many were removed.
pub fn revoke(path: &Path, device: &str) -> Result<usize, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(0) };
    let kept: Vec<&str> = text.lines().filter(|l| comment_device(l) != Some(device)).collect();
    let removed = text.lines().count() - kept.len();
    if removed > 0 {
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        write_private(path, &out)?;
    }
    Ok(removed)
}

/// The other Macs swarmz knows, as ssh destinations.
pub fn machine_hosts(ws: &Workspace, self_machine: Option<&str>, default_user: &str) -> Vec<(String, String)> {
    let Some(machines) = ws.extra.get("machines").and_then(|m| m.as_object()) else { return vec![] };
    let mut out: Vec<(String, String)> = machines
        .iter()
        .filter(|(name, _)| Some(name.as_str()) != self_machine)
        .filter(|(name, _)| crate::paths::valid_tile_id(name))
        .map(|(name, cfg)| {
            let user = cfg.get("user").and_then(|u| u.as_str()).map(str::trim).filter(|u| !u.is_empty()).unwrap_or(default_user);
            (name.clone(), format!("{user}@{name}"))
        })
        .collect();
    out.sort();
    out
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
        std::fs::write(&path, format!("ssh-ed25519 AAAAmine me@mac{}", "")).unwrap();
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
    fn machine_hosts_skip_this_mac_and_use_the_configured_user() {
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "version": 1, "terminals": [], "layout": null,
            "machines": {"mini": {"lastUsed": "t"}, "studio": {"user": "admin", "lastUsed": "t"}, "air": {"lastUsed": "t"}}
        }))
        .unwrap();
        let hosts = machine_hosts(&ws, Some("mini"), "me");
        assert_eq!(hosts, vec![("air".to_string(), "me@air".to_string()), ("studio".to_string(), "admin@studio".to_string())]);
    }
}
