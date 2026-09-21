//! A tile's conversation card: the title and recap its agent writes (conversation cards spec §2),
//! and the fallback title taken from the session's first prompt (§2.1).

use serde_json::{json, Map, Value};

pub const TITLE_MAX: usize = 60;
pub const RECAP_MAX: usize = 280;

/// Who last set the card.
pub const BY_AGENT: &str = "agent";
pub const BY_USER: &str = "user";

fn is_control(c: char) -> bool {
    (c as u32) < 0x20 || c as u32 == 0x7f
}

/// One line, whitespace collapsed, control characters dropped, cut at `TITLE_MAX` characters.
/// None when nothing is left.
pub fn clean_title(s: &str) -> Option<String> {
    let collapsed: String = s.chars().map(|c| if c.is_whitespace() || is_control(c) { ' ' } else { c }).collect();
    let words: Vec<&str> = collapsed.split_whitespace().collect();
    let joined = words.join(" ");
    if joined.is_empty() {
        return None;
    }
    Some(joined.chars().take(TITLE_MAX).collect::<String>().trim_end().to_string())
}

/// Newlines kept, other control characters dropped, trimmed, cut at `RECAP_MAX` characters.
/// None when nothing is left.
pub fn clean_recap(s: &str) -> Option<String> {
    let kept: String = s.replace("\r\n", "\n").chars().filter(|&c| c == '\n' || !is_control(c)).collect();
    let trimmed = kept.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(RECAP_MAX).collect::<String>().trim_end().to_string())
}

/// The title a session gets before its agent sets one: the first line of its first prompt,
/// whitespace collapsed, cut on a word boundary with `…` when longer than `TITLE_MAX`. A slash
/// command, an empty prompt, or one the harness injected rather than the user typed (it starts
/// with a tag such as `<task-notification>`) gives none, so the next prompt is tried.
pub fn fallback_title(prompt: &str) -> Option<String> {
    let first = prompt.lines().find(|l| !l.trim().is_empty())?;
    let words: Vec<&str> = first.split_whitespace().collect();
    let joined = words.join(" ");
    if joined.is_empty() || joined.starts_with('/') || joined.starts_with('<') {
        return None;
    }
    if joined.chars().count() <= TITLE_MAX {
        return Some(joined);
    }
    // Room for the ellipsis: cut to TITLE_MAX - 1 characters, then back to the last whole word.
    let cut: String = joined.chars().take(TITLE_MAX - 1).collect();
    let at_word = match cut.rfind(' ') {
        Some(i) if i > 0 => cut[..i].to_string(),
        _ => cut,
    };
    Some(format!("{}…", at_word.trim_end()))
}

/// The card a def carries, as stored: `{title?, recap?, updatedAt, by}`.
pub fn read(def_extra: &Map<String, Value>) -> Option<Value> {
    def_extra.get("card").filter(|c| c.is_object()).cloned()
}

fn field<'a>(card: Option<&'a Value>, key: &str) -> Option<&'a str> {
    card.and_then(|c| c.get(key)).and_then(|v| v.as_str())
}

/// The card after an agent's `card --title … --recap …` (spec §3.1): given fields replace the
/// old ones, `updatedAt` is `now` and `by` becomes `agent`; a title the user typed stays when
/// no `--title` is given. Both fields absent returns the card unchanged (`None` when there was
/// none).
pub fn merged(existing: Option<&Value>, title: Option<&str>, recap: Option<&str>, now: &str) -> Option<Value> {
    let title = title.and_then(clean_title);
    let recap = recap.and_then(clean_recap);
    if title.is_none() && recap.is_none() {
        return existing.cloned();
    }
    let mut out = Map::new();
    let agent_titled = title.is_some();
    let kept_title = field(existing, "title").map(str::to_string);
    match title {
        Some(t) => {
            out.insert("title".into(), json!(t));
        }
        None => {
            if let Some(t) = kept_title {
                out.insert("title".into(), json!(t));
            }
        }
    }
    match recap.or_else(|| field(existing, "recap").map(str::to_string)) {
        Some(r) => {
            out.insert("recap".into(), json!(r));
        }
        None => {}
    }
    out.insert("updatedAt".into(), json!(now));
    // A user title survives a recap-only update, and the card stays the user's.
    let by = if !agent_titled && field(existing, "by") == Some(BY_USER) { BY_USER } else { BY_AGENT };
    out.insert("by".into(), json!(by));
    Some(Value::Object(out))
}

/// The card after the user typed a title on the desktop or the phone: an empty title removes
/// the user's title (the agent's or the fallback returns) but keeps the recap.
pub fn with_user_title(existing: Option<&Value>, title: &str, now: &str) -> Option<Value> {
    let mut out = Map::new();
    if let Some(t) = clean_title(title) {
        out.insert("title".into(), json!(t));
        out.insert("by".into(), json!(BY_USER));
    } else {
        out.insert("by".into(), json!(BY_AGENT));
    }
    if let Some(r) = field(existing, "recap") {
        out.insert("recap".into(), json!(r));
    }
    if out.len() == 1 {
        return None;
    }
    out.insert("updatedAt".into(), json!(now));
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_one_line_collapsed_and_cut() {
        assert_eq!(clean_title("  Phone:\tanswer   questions\nfrom the screen ").as_deref(), Some("Phone: answer questions from the screen"));
        assert_eq!(clean_title("\x1b[31m red \x07"), Some("[31m red".into()));
        assert_eq!(clean_title("   "), None);
        let long = "x".repeat(100);
        assert_eq!(clean_title(&long).unwrap().chars().count(), TITLE_MAX);
    }

    #[test]
    fn recaps_keep_newlines_and_are_cut() {
        assert_eq!(clean_recap("done\r\n\x00next\n").as_deref(), Some("done\nnext"));
        assert_eq!(clean_recap("\n \n"), None);
        assert_eq!(clean_recap(&"y".repeat(1000)).unwrap().chars().count(), RECAP_MAX);
        assert_eq!(RECAP_MAX, 280);
    }

    #[test]
    fn the_fallback_title_is_the_first_prompt_line_cut_on_a_word() {
        assert_eq!(fallback_title("fix the build\n\nand the tests").as_deref(), Some("fix the build"));
        assert_eq!(fallback_title("\n\n  fix   the build  ").as_deref(), Some("fix the build"));
        assert_eq!(fallback_title("/resume"), None);
        assert_eq!(fallback_title("   "), None);
        assert_eq!(fallback_title("<task-notification>\nsomething finished"), None);
        assert_eq!(fallback_title("<system-reminder>x</system-reminder>"), None);
        let long = "please look at the phone app and tell me why the question card never shows up on the fold";
        let t = fallback_title(long).unwrap();
        assert!(t.ends_with('…'), "{t}");
        assert!(t.chars().count() <= TITLE_MAX, "{t}");
        assert_eq!(t, "please look at the phone app and tell me why the question…");
        // One long word: cut mid-word rather than to nothing.
        let word = "a".repeat(80);
        assert_eq!(fallback_title(&word).unwrap().chars().count(), TITLE_MAX);
    }

    #[test]
    fn an_agent_update_merges_and_keeps_a_user_title() {
        let none = merged(None, Some(" Phone keys "), None, "t1").unwrap();
        assert_eq!(none, json!({"title": "Phone keys", "updatedAt": "t1", "by": "agent"}));
        let both = merged(Some(&none), None, Some("Done.\nNext: spec."), "t2").unwrap();
        assert_eq!(both, json!({"title": "Phone keys", "recap": "Done.\nNext: spec.", "updatedAt": "t2", "by": "agent"}));
        let user = json!({"title": "Mine", "recap": "old", "updatedAt": "t0", "by": "user"});
        let recap_only = merged(Some(&user), None, Some("new"), "t3").unwrap();
        assert_eq!(recap_only, json!({"title": "Mine", "recap": "new", "updatedAt": "t3", "by": "user"}));
        let retitled = merged(Some(&user), Some("Theirs"), None, "t4").unwrap();
        assert_eq!(retitled, json!({"title": "Theirs", "recap": "old", "updatedAt": "t4", "by": "agent"}));
        // Nothing given: nothing changes.
        assert_eq!(merged(Some(&user), None, None, "t5"), Some(user.clone()));
        assert_eq!(merged(None, Some("   "), None, "t6"), None);
    }

    #[test]
    fn a_user_title_is_marked_and_an_empty_one_removed() {
        let agent = json!({"title": "Theirs", "recap": "r", "updatedAt": "t0", "by": "agent"});
        let mine = with_user_title(Some(&agent), "Mine", "t1").unwrap();
        assert_eq!(mine, json!({"title": "Mine", "recap": "r", "updatedAt": "t1", "by": "user"}));
        let cleared = with_user_title(Some(&mine), "", "t2").unwrap();
        assert_eq!(cleared, json!({"recap": "r", "updatedAt": "t2", "by": "agent"}));
        assert_eq!(with_user_title(None, "", "t3"), None);
    }

    #[test]
    fn read_takes_only_an_object() {
        let mut extra = Map::new();
        assert_eq!(read(&extra), None);
        extra.insert("card".into(), json!("junk"));
        assert_eq!(read(&extra), None);
        extra.insert("card".into(), json!({"title": "T"}));
        assert_eq!(read(&extra), Some(json!({"title": "T"})));
    }
}
