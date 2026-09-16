//! Small shared helpers: ids, validation, time and this Mac's name.

use std::io::Read;

/// A random version-4 UUID, lowercase.
pub fn new_uuid() -> String {
    let mut b = [0u8; 16];
    let filled = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
    if !filled {
        // /dev/urandom always exists on macOS; this only keeps the function total.
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let mixed = t ^ ((std::process::id() as u128) << 64);
        b.copy_from_slice(&mixed.to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `8-4-4-4-12` hex digits.
pub fn valid_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
}

/// An absolute path with no ASCII control characters.
pub fn valid_abs_path(s: &str) -> bool {
    s.starts_with('/') && !s.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

/// Now as `YYYY-MM-DDTHH:MM:SS.mmmZ` (the form the app writes into `sync.updatedAt`).
pub fn now_iso_ms() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format_iso_ms(d.as_secs() as i64, d.subsec_millis())
}

pub fn format_iso_ms(secs: i64, millis: u32) -> String {
    let base = crate::paths::format_iso(secs);
    format!("{}.{millis:03}Z", &base[..19])
}

/// This Mac's short MagicDNS name (the machine key swarmz uses), or None without Tailscale.
pub fn self_machine() -> Option<String> {
    crate::tailscale::status().ok()?.self_machine.map(|m| m.name).filter(|n| !n.is_empty())
}

/// One word for a POSIX shell.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_v4_shaped_and_unique() {
        let a = new_uuid();
        let b = new_uuid();
        assert_ne!(a, b);
        assert!(valid_uuid(&a), "{a}");
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn uuid_validation() {
        assert!(valid_uuid("46aaf955-63a2-4517-9df4-962e4f66dc6c"));
        assert!(valid_uuid("46AAF955-63A2-4517-9DF4-962E4F66DC6C"));
        assert!(!valid_uuid("46aaf955-63a2-4517-9df4-962e4f66dc6"));
        assert!(!valid_uuid("46aaf955x63a2-4517-9df4-962e4f66dc6c"));
        assert!(!valid_uuid("../../etc/passwd"));
        assert!(!valid_uuid(""));
    }

    #[test]
    fn absolute_paths_without_control_characters() {
        assert!(valid_abs_path("/Users/me/projects/app"));
        assert!(valid_abs_path("/"));
        assert!(valid_abs_path("/a dir/with 'quotes'"));
        assert!(!valid_abs_path("relative/path"));
        assert!(!valid_abs_path(""));
        assert!(!valid_abs_path("/a\nb"));
        assert!(!valid_abs_path("/a\u{7f}"));
    }

    #[test]
    fn iso_time_has_milliseconds() {
        let t = now_iso_ms();
        assert_eq!(t.len(), 24, "{t}");
        assert!(t.ends_with('Z'));
        assert_eq!(&t[19..20], ".");
        assert_eq!(format_iso_ms(0, 7), "1970-01-01T00:00:00.007Z");
    }

    #[test]
    fn shell_quoting() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
        let words = crate::gate::split_words(&format!("x {}", sh_quote("a 'b' $c; d"))).unwrap();
        assert_eq!(words, vec!["x", "a 'b' $c; d"]);
    }
}
