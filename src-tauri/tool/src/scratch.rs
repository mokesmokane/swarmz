//! `swarmz scratch` (scratch terminal spec §4): an agent asks the app to open its tile's scratch
//! shell for the user, with an optional note and suggested command. It never sees the shell.

pub const NOTE_MAX: usize = 200;
pub const COMMAND_MAX: usize = 500;

/// Ok(None) for no text, Ok(Some) for acceptable text, Err(code) for `too_long` or `bad_text`.
pub fn check_text(s: Option<&str>, max: usize) -> Result<Option<String>, &'static str> {
    // No control characters at all, trailing ones included: a newline would press Enter in the
    // user's shell.
    if s.is_some_and(|t| t.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)) {
        return Err("bad_text");
    }
    let Some(t) = s.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if t.chars().count() > max {
        return Err("too_long");
    }
    Ok(Some(t.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_one_line_within_its_limit() {
        assert_eq!(check_text(None, 10), Ok(None));
        assert_eq!(check_text(Some("  "), 10), Ok(None));
        assert_eq!(check_text(Some(" gh auth login "), 20), Ok(Some("gh auth login".into())));
        assert_eq!(check_text(Some(&"é".repeat(10)), 10), Ok(Some("é".repeat(10))));
        assert_eq!(check_text(Some(&"x".repeat(11)), 10), Err("too_long"));
        for bad in ["ls\nrm -rf ~", "ls\r", "a\tb", "\x1b[31m", "x\x7f"] {
            assert_eq!(check_text(Some(bad), 50), Err("bad_text"), "{bad:?}");
        }
    }
}
