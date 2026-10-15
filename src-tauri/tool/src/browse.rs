//! `swarmz browse` (tile browser spec §4): an agent asks the app to open its tile's browser on an
//! address, with an optional note. It never sees the page.

pub const URL_MAX: usize = 2000;
pub const NOTE_MAX: usize = 200;

/// The trimmed address when it is an `http`/`https` URL with a host, no spaces or control
/// characters, within `URL_MAX`; Err(`invalid` | `too_long`) otherwise.
pub fn check_url(s: &str) -> Result<String, &'static str> {
    let t = s.trim();
    if t.chars().count() > URL_MAX {
        return Err("too_long");
    }
    if t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("invalid");
    }
    let lower = t.to_ascii_lowercase();
    let rest = ["https://", "http://"].iter().find_map(|p| lower.strip_prefix(p)).ok_or("invalid")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err("invalid");
    }
    Ok(t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_pass() {
        assert_eq!(check_url(" https://appstoreconnect.apple.com/apps "), Ok("https://appstoreconnect.apple.com/apps".into()));
        assert_eq!(check_url("http://localhost:1420/"), Ok("http://localhost:1420/".into()));
        assert_eq!(check_url("HTTPS://Example.com"), Ok("HTTPS://Example.com".into()));
        for bad in ["", "example.com", "javascript:alert(1)", "file:///etc/passwd", "https://", "https:///x", "https://a b", "https://a\nb", "ftp://x"] {
            assert_eq!(check_url(bad), Err("invalid"), "{bad:?}");
        }
        let long = format!("https://x.com/{}", "a".repeat(URL_MAX));
        assert_eq!(check_url(&long), Err("too_long"));
    }
}
