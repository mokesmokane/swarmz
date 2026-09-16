//! Bytes the tool types into a session (spec §4.1 `send`, `key`).

/// The longest text `send` accepts.
pub const MAX_SEND: usize = 64 * 1024;

pub fn key_bytes(name: &str) -> Option<&'static [u8]> {
    Some(match name {
        "esc" => b"\x1b",
        "ctrl-c" => b"\x03",
        "tab" => b"\t",
        "shift-tab" => b"\x1b[Z",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "enter" => b"\r",
        _ => return None,
    })
}

/// The text as one bracketed paste. Control characters other than newline and tab are removed,
/// so the text can never end the paste early or send escape sequences of its own.
pub fn paste_bytes(text: &str) -> Result<Vec<u8>, String> {
    if text.is_empty() {
        return Err("nothing to send".into());
    }
    if text.len() > MAX_SEND {
        return Err(format!("text is longer than {MAX_SEND} bytes"));
    }
    let body: String = text
        .replace("\r\n", "\n")
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || (c as u32 >= 0x20 && c as u32 != 0x7f))
        .collect();
    let mut out = b"\x1b[200~".to_vec();
    out.extend_from_slice(body.as_bytes());
    out.extend_from_slice(b"\x1b[201~");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(key_bytes("esc"), Some(&b"\x1b"[..]));
        assert_eq!(key_bytes("ctrl-c"), Some(&b"\x03"[..]));
        assert_eq!(key_bytes("tab"), Some(&b"\t"[..]));
        assert_eq!(key_bytes("shift-tab"), Some(&b"\x1b[Z"[..]));
        assert_eq!(key_bytes("up"), Some(&b"\x1b[A"[..]));
        assert_eq!(key_bytes("down"), Some(&b"\x1b[B"[..]));
        assert_eq!(key_bytes("enter"), Some(&b"\r"[..]));
        assert_eq!(key_bytes("f1"), None);
    }

    #[test]
    fn pastes_are_bracketed_and_cannot_smuggle_escapes() {
        assert_eq!(paste_bytes("hi there").unwrap(), b"\x1b[200~hi there\x1b[201~".to_vec());
        assert_eq!(paste_bytes("a\r\nb\tc").unwrap(), b"\x1b[200~a\nb\tc\x1b[201~".to_vec());
        assert_eq!(paste_bytes("x\x1b[201~rm -rf\x07y").unwrap(), b"\x1b[200~x[201~rm -rfy\x1b[201~".to_vec());
        assert!(paste_bytes("").is_err());
        assert!(paste_bytes(&"a".repeat(MAX_SEND + 1)).is_err());
    }
}
