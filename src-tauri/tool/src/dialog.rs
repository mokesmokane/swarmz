//! Claude Code's permission dialog read from the screen (spec §4.4).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Opt {
    pub n: u32,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dialog {
    pub heading: String,
    pub target: Option<String>,
    pub description: Option<String>,
    pub options: Vec<Opt>,
}

impl Dialog {
    /// What the question is about: the command or file when shown, else the heading.
    pub fn summary(&self) -> String {
        self.target.clone().unwrap_or_else(|| self.heading.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Option(Opt),
    Esc,
}

fn clean(line: &str) -> &str {
    line.trim().trim_matches('│').trim()
}

/// `^\s*[❯>]?\s*(\d+)\.\s+(.+)$`
fn option_line(line: &str) -> Option<Opt> {
    let t = clean(line);
    let t = t.strip_prefix('❯').or_else(|| t.strip_prefix('>')).unwrap_or(t).trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = t[digits.len()..].strip_prefix('.')?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let label = rest.trim();
    if label.is_empty() {
        return None;
    }
    Some(Opt { n: digits.parse().ok()?, label: label.to_string() })
}

fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.chars().count() >= 3 && t.chars().all(|c| c == '─')
}

fn join_wrapped(a: &str, b: &str) -> String {
    if a.ends_with('-') || a.ends_with('/') {
        format!("{a}{b}")
    } else {
        format!("{a} {b}")
    }
}

pub fn parse_dialog(lines: &[String]) -> Option<Dialog> {
    let footer = lines.iter().rposition(|l| clean(l).starts_with("Esc to cancel"))?;
    // The dialog sits between the nearest rule above the footer and the footer; without a rule,
    // only the last 15 lines are considered, so numbered lists in older output never count.
    let rule = (0..footer).rev().take(80).find(|&i| is_rule(&lines[i]));
    let start = rule.map(|r| r + 1).unwrap_or(footer.saturating_sub(15));
    let first_opt = (start..footer).find(|&i| option_line(&lines[i]).is_some())?;
    let mut options: Vec<Opt> = Vec::new();
    for line in &lines[first_opt..footer] {
        if let Some(o) = option_line(line) {
            options.push(o);
        } else if !clean(line).is_empty() {
            let last = options.last_mut()?;
            last.label = join_wrapped(&last.label, clean(line));
        }
    }
    // The question is the nearest non-empty line above the options.
    let question = (start..first_opt).rev().find(|&i| !clean(&lines[i]).is_empty())?;
    let mut header: Vec<String> = lines[start..question].iter().map(|l| clean(l).to_string()).filter(|l| !l.is_empty()).collect();
    if rule.is_none() && header.len() > 3 {
        header.drain(..header.len() - 3);
    }
    let heading = header.first()?.clone();
    let target = header.get(1).cloned();
    let description = if header.len() == 3 { header.last().cloned() } else { None };
    Some(Dialog { heading, target, description, options })
}

/// The dialog Claude is showing now: its footer is on the visible screen (at or below
/// `visible_start`, the index of the first visible row in `lines`) with nothing but blank lines
/// below it. A dialog in scrollback, or quoted in output that has more below it, is not one.
pub fn live_dialog(lines: &[String], visible_start: usize) -> Option<Dialog> {
    let footer = lines.iter().rposition(|l| clean(l).starts_with("Esc to cancel"))?;
    if footer < visible_start || lines[footer + 1..].iter().any(|l| !clean(l).is_empty()) {
        return None;
    }
    parse_dialog(lines)
}

pub fn resolve(choice: &str, d: &Dialog) -> Result<Answer, String> {
    let lower = |o: &Opt| o.label.to_lowercase();
    let always = |l: &str| l.contains("always") || l.contains("don't ask") || l.contains("don\u{2019}t ask") || l.contains("allow all");
    let found = match choice {
        "deny" => return Ok(Answer::Esc),
        "yes" => d.options.iter().find(|o| lower(o).starts_with("yes") && !always(&lower(o))),
        "always" => d.options.iter().find(|o| lower(o).starts_with("yes") && always(&lower(o))),
        "no" => d.options.iter().find(|o| lower(o).starts_with("no")),
        n if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => d.options.iter().find(|o| o.n.to_string() == n),
        other => return Err(format!("unknown answer {other:?}: use yes, always, no, deny or an option number")),
    };
    found.cloned().map(Answer::Option).ok_or_else(|| format!("the question has no {choice:?} option"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real() -> Vec<String> {
        [
            "❯ Use the Bash tool to run exactly: mkdir -p probe-dir-xyz",
            "",
            "  Creating probe-dir-xyz directory",
            "  ⎿  $ mkdir -p probe-dir-xyz",
            "",
            "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            " Bash command",
            "",
            "   mkdir -p probe-dir-xyz",
            "   Create probe-dir-xyz directory",
            "",
            " Do you want to proceed?",
            " ❯ 1. Yes",
            "   2. Yes, and always allow access to /private/tmp/claude-501/-Users-mokes-projects-swarmz/20a24a27-ac03-47da-",
            "      82eb-e75fbb0dce9f/scratchpad/spike2dir from this project",
            "   3. No",
            "",
            " Esc to cancel · Tab to amend",
            "",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn reads_the_real_dialog() {
        let d = parse_dialog(&real()).expect("a dialog");
        assert_eq!(d.heading, "Bash command");
        assert_eq!(d.target.as_deref(), Some("mkdir -p probe-dir-xyz"));
        assert_eq!(d.description.as_deref(), Some("Create probe-dir-xyz directory"));
        assert_eq!(d.summary(), "mkdir -p probe-dir-xyz");
        let opts: Vec<(u32, &str)> = d.options.iter().map(|o| (o.n, o.label.as_str())).collect();
        assert_eq!(opts[0], (1, "Yes"));
        assert_eq!(
            opts[1],
            (2, "Yes, and always allow access to /private/tmp/claude-501/-Users-mokes-projects-swarmz/20a24a27-ac03-47da-82eb-e75fbb0dce9f/scratchpad/spike2dir from this project")
        );
        assert_eq!(opts[2], (3, "No"));
    }

    #[test]
    fn numbered_lists_in_older_output_are_not_options() {
        let mut lines: Vec<String> = ["  Still waiting on your call:", "", "  1. Ship the fix.", "  2. Choose a rate.", ""].iter().map(|s| s.to_string()).collect();
        lines.extend(real());
        let d = parse_dialog(&lines).unwrap();
        assert_eq!(d.options.len(), 3);
        assert_eq!(d.options[0].label, "Yes");
    }

    #[test]
    fn no_footer_means_no_dialog() {
        let mut lines = real();
        lines.retain(|l| !l.contains("Esc to cancel"));
        assert!(parse_dialog(&lines).is_none());
        assert!(parse_dialog(&[]).is_none());
        let only_footer = vec![" Esc to cancel".to_string()];
        assert!(parse_dialog(&only_footer).is_none());
    }

    #[test]
    fn a_dialog_without_a_rule_uses_the_lines_above_the_question() {
        let lines: Vec<String> = ["some output", " Edit file", "   src/main.rs", " Do you want to make this edit?", " > 1. Yes", "   2. No", " Esc to cancel"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let d = parse_dialog(&lines).unwrap();
        assert_eq!(d.heading, "some output");
        assert_eq!(d.summary(), "Edit file");
        assert_eq!(d.options.len(), 2);
    }

    #[test]
    fn only_a_dialog_on_the_visible_screen_is_live() {
        assert!(live_dialog(&real(), 0).is_some());
        let mut blank_below = real();
        blank_below.extend(["".to_string(), "   ".to_string()]);
        assert!(live_dialog(&blank_below, 0).is_some());
        // Some scrollback above the visible rows still lets the dialog's top be read.
        assert_eq!(live_dialog(&real(), 3).map(|d| d.summary()).as_deref(), Some("mkdir -p probe-dir-xyz"));
        // Output below the footer: the dialog was quoted or has been answered.
        let mut more = real();
        more.push("$ ls".to_string());
        assert!(parse_dialog(&more).is_some());
        assert!(live_dialog(&more, 0).is_none());
        // Scrolled off the screen, even with only blank lines below.
        let mut scrolled = real();
        let n = scrolled.len();
        scrolled.extend(std::iter::repeat_n(String::new(), 24));
        assert!(live_dialog(&scrolled, n).is_none());
        // A blank visible screen (its rows trimmed away) never lets a footer in scrollback count.
        assert!(live_dialog(&real(), real().len()).is_none());
        assert!(live_dialog(&[], 0).is_none());
    }

    #[test]
    fn a_curly_apostrophe_counts_as_dont_ask() {
        let d = Dialog {
            heading: "h".into(),
            target: None,
            description: None,
            options: vec![Opt { n: 1, label: "Yes".into() }, Opt { n: 2, label: "Yes, and don\u{2019}t ask again for npm commands".into() }, Opt { n: 3, label: "No".into() }],
        };
        assert!(matches!(resolve("always", &d), Ok(Answer::Option(Opt { n: 2, .. }))));
        assert!(matches!(resolve("yes", &d), Ok(Answer::Option(Opt { n: 1, .. }))));
    }

    #[test]
    fn answers_resolve_against_the_options_on_screen() {
        let d = parse_dialog(&real()).unwrap();
        let pick = |s: &str| match resolve(s, &d) {
            Ok(Answer::Option(o)) => Some(o.n),
            Ok(Answer::Esc) => Some(0),
            Err(_) => None,
        };
        assert_eq!(pick("yes"), Some(1));
        assert_eq!(pick("always"), Some(2));
        assert_eq!(pick("no"), Some(3));
        assert_eq!(pick("deny"), Some(0));
        assert_eq!(pick("2"), Some(2));
        assert_eq!(pick("7"), None);
        assert_eq!(pick("maybe"), None);
        let two = Dialog { heading: "h".into(), target: None, description: None, options: vec![Opt { n: 1, label: "Yes".into() }, Opt { n: 2, label: "No, and tell Claude what to do differently".into() }] };
        assert!(resolve("always", &two).is_err());
        assert!(matches!(resolve("no", &two), Ok(Answer::Option(Opt { n: 2, .. }))));
    }
}
