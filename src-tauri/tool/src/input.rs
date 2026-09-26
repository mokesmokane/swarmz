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

/// The text with control characters other than newline and tab removed, so it can never end a
/// paste early or send escape sequences of its own.
pub fn typed_bytes(text: &str) -> Result<Vec<u8>, String> {
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
    Ok(body.into_bytes())
}

/// `typed_bytes` as one bracketed paste.
pub fn paste_bytes(text: &str) -> Result<Vec<u8>, String> {
    let mut out = b"\x1b[200~".to_vec();
    out.extend(typed_bytes(text)?);
    out.extend_from_slice(b"\x1b[201~");
    Ok(out)
}

/// Whether `text`, just sent, is still sitting in Claude Code's input box on the visible
/// `lines`: the last line that starts with the box's `>` prompt still begins with the text's
/// first line. Claude groups bytes that arrive close together as one paste, and an Enter that
/// lands inside that window is a newline in the box, not a submit; `send` checks this and
/// presses Enter again. A submitted prompt is echoed as `> text` too, but above an emptied
/// box, so the last `>` line decides. A shell has no such line and reads as false.
pub fn still_in_box(lines: &[String], text: &str) -> bool {
    let head: String = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(24).collect();
    if head.is_empty() {
        return false;
    }
    let box_line = lines.iter().rev().map(|l| l.trim()).find(|l| l.starts_with("> ") || l.starts_with("❯ ") || *l == ">" || *l == "❯");
    match box_line {
        Some(l) => l[l.chars().next().unwrap().len_utf8()..].trim_start().starts_with(&head),
        None => false,
    }
}

/// What Claude's input box holds (the last line starting with its `>` prompt), trimmed; None when
/// the screen shows no box (a shell, or Claude not running).
pub fn box_text(lines: &[String]) -> Option<String> {
    let l = lines.iter().rev().map(|l| l.trim()).find(|l| l.starts_with("> ") || l.starts_with("❯ ") || *l == ">" || *l == "❯")?;
    Some(l[l.chars().next().unwrap().len_utf8()..].trim().to_string())
}

/// What `send` types: a bracketed paste unless the program has said it does not take one
/// (`Some(false)`); a holder that cannot say (`None`) gets the paste.
pub fn send_bytes(text: &str, bracketed_paste: Option<bool>) -> Result<Vec<u8>, String> {
    if bracketed_paste == Some(false) { typed_bytes(text) } else { paste_bytes(text) }
}

#[cfg(test)]
mod tests {

    #[test]
    fn reads_what_the_input_box_holds() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(box_text(&l(&["> old prompt", "reply", "────", "❯ do both", "────"])), Some("do both".into()));
        assert_eq!(box_text(&l(&["────", "❯ ", "────"])), Some(String::new()));
        assert_eq!(box_text(&l(&["$ ls", "file"])), None);
    }

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
    fn a_sent_text_still_in_the_box_is_told_from_a_submitted_one() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let text = "[conductor swarmz] The user wants a short summary of where this stands.";
        // Before the submit: the box holds the text (wrapped), under the transcript.
        let before = s(&["● Still in progress.", "", "> [conductor swarmz] The user wants a short summary of where", "  this stands.", "  ↑/↓ to select · Enter to view", "  ● main"]);
        assert!(still_in_box(&before, text));
        // After: the prompt is echoed above, and the box below it is empty.
        let after = s(&["> [conductor swarmz] The user wants a short summary of where this stands.", "", "● Working on it…", "", "> ", "  ? for shortcuts"]);
        assert!(!still_in_box(&after, text));
        let placeholder = s(&["> [conductor swarmz] The user wants a short summary", "", "> Try \"fix the build\""]);
        assert!(!still_in_box(&placeholder, text));
        // A shell, or nothing that looks like a box.
        assert!(!still_in_box(&s(&["$ echo mine", "mine", "$ "]), "echo mine"));
        assert!(!still_in_box(&s(&[]), text));
        assert!(!still_in_box(&before, "   "));
        // Another text in the box is not this one.
        assert!(!still_in_box(&before, "something else entirely"));
    }

    #[test]
    fn pastes_are_bracketed_and_cannot_smuggle_escapes() {
        assert_eq!(paste_bytes("hi there").unwrap(), b"\x1b[200~hi there\x1b[201~".to_vec());
        assert_eq!(paste_bytes("a\r\nb\tc").unwrap(), b"\x1b[200~a\nb\tc\x1b[201~".to_vec());
        assert_eq!(paste_bytes("x\x1b[201~rm -rf\x07y").unwrap(), b"\x1b[200~x[201~rm -rfy\x1b[201~".to_vec());
        assert!(paste_bytes("").is_err());
        assert!(paste_bytes(&"a".repeat(MAX_SEND + 1)).is_err());
    }

    #[test]
    fn text_is_pasted_only_when_the_program_takes_pastes() {
        assert_eq!(send_bytes("a\x1bb\r\nc", Some(false)).unwrap(), b"ab\nc".to_vec());
        assert_eq!(send_bytes("hi", Some(true)).unwrap(), b"\x1b[200~hi\x1b[201~".to_vec());
        assert_eq!(send_bytes("hi", None).unwrap(), b"\x1b[200~hi\x1b[201~".to_vec());
        assert!(send_bytes("", Some(false)).is_err());
    }
}
