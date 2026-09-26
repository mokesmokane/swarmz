//! Claude Code's and Codex's permission dialogs read from the screen (spec §4.4, Codex tiles spec §6).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Opt {
    pub n: u32,
    pub label: String,
    /// A question option's one-line description, shown under its label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A multi-select question option's box: `Some(true)` when ticked. `None` on a single-select
    /// option and on every permission option.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}

impl Opt {
    pub fn new(n: u32, label: impl Into<String>) -> Opt {
        Opt { n, label: label.into(), description: None, checked: None }
    }
}

/// Which of Claude Code's dialogs is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A permission prompt ("Do you want to proceed?", footer "Esc to cancel").
    Permission,
    /// A question Claude asks with its AskUserQuestion tool (footer "Enter to select").
    Question,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dialog {
    pub kind: Kind,
    /// A permission's heading ("Bash command"); a question's header tab ("Button colour"), or
    /// "Questions" for a multi-question form, whose tab bar names every question.
    pub heading: String,
    /// A permission's command or file; a question's text.
    pub target: Option<String>,
    pub description: Option<String>,
    /// The choices a digit answers. A question's "Type something" and "Chat about this" entries
    /// are left out: they need typing after the digit, which `answer` does not do.
    pub options: Vec<Opt>,
    /// A multi-select question: a digit toggles its option instead of answering.
    pub multi: bool,
    /// Where the question's `❯` cursor is: an option's number, or `submit_at` on the Submit entry.
    pub cursor: Option<u32>,
    /// A multi-select question's Submit entry, as the position after its last numbered entry
    /// (`Type something` included), reached with `↓` from an option and confirmed with Enter.
    pub submit_at: Option<u32>,
    /// Codex drew it: an option is chosen by its hotkey (`(y)`), else by moving the `›` cursor
    /// to it and pressing Enter, never by its digit.
    pub codex: bool,
}

impl Dialog {
    /// What the question is about: the command or file when shown, else the heading.
    pub fn summary(&self) -> String {
        self.target.clone().unwrap_or_else(|| self.heading.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// Type the option's digit: answers a permission or a single-select question, toggles a
    /// multi-select option.
    Option(Opt),
    Esc,
    /// Move `downs` times to a multi-select question's Submit entry, then Enter.
    Submit { downs: u32 },
}

fn clean(line: &str) -> &str {
    line.trim().trim_matches('│').trim()
}

/// How many columns a header line is indented, ignoring a leading box border.
fn indent(line: &str) -> usize {
    let s = line.strip_prefix('│').unwrap_or(line);
    s.len() - s.trim_start_matches(' ').len()
}

/// `^\s*[❯>]?\s*(\d+)\.\s+(.+)$`
fn option_line(line: &str) -> Option<Opt> {
    let t = clean(line);
    let t = t.strip_prefix('❯').or_else(|| t.strip_prefix('>')).or_else(|| t.strip_prefix('›')).unwrap_or(t).trim_start();
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
    // A multi-select question's option carries its box: `[ ] Circle` or `[✔] Circle`.
    let (label, checked) = match label.strip_prefix('[') {
        Some(rest) => {
            let mut it = rest.chars();
            match (it.next(), it.next()) {
                (Some(mark), Some(']')) => (it.as_str().trim_start(), Some(mark != ' ')),
                _ => (label, None),
            }
        }
        None => (label, None),
    };
    if label.is_empty() {
        return None;
    }
    Some(Opt { n: digits.parse().ok()?, label: label.to_string(), description: None, checked })
}

/// The footer line of the dialog nearest the bottom, and which kind of dialog it ends.
fn find_footer(lines: &[String]) -> Option<(usize, Kind, bool)> {
    lines.iter().rposition(|l| footer_kind(l).is_some()).map(|i| {
        let (kind, codex) = footer_kind(&lines[i]).unwrap();
        (i, kind, codex)
    })
}

/// Which dialog a footer ends, and whether Codex drew it: its approval ends `Press enter to
/// confirm or esc to cancel`, its other pickers `enter select · esc back` and the like.
fn footer_kind(line: &str) -> Option<(Kind, bool)> {
    let t = clean(line);
    if t.starts_with("Esc to cancel") {
        Some((Kind::Permission, false))
    } else if t.starts_with("Enter to select") {
        Some((Kind::Question, false))
    } else if t.starts_with("Press enter to confirm or esc to cancel") {
        Some((Kind::Permission, true))
    } else if t.starts_with("enter ") && t.contains(" · ") && t.contains("esc ") {
        Some((Kind::Question, true))
    } else {
        None
    }
}

/// A Codex option's hotkey, from the label's trailing `(y)`: a single character, or `esc`.
pub fn codex_key(label: &str) -> Option<&str> {
    let inner = label.trim_end().strip_suffix(')')?.rsplit_once(" (")?.1;
    (inner == "esc" || inner.chars().count() == 1).then_some(inner)
}

/// Codex's approval and pickers, captured from Codex CLI 0.157.1 (2026-09-26): the heading
/// (`Would you like to run the following command?`), `Environment:`/`Reason:` lines and the
/// command after `$ `, then the options, the chosen one marked `›`, each ending in its hotkey,
/// and the footer. A picker has a title and a question line above its options instead.
fn parse_codex(lines: &[String], footer: usize, kind: Kind) -> Option<Dialog> {
    let start = footer.saturating_sub(40);
    let last_opt = (start..footer).rev().find(|&i| option_line(&lines[i]).is_some())?;
    // Up through the options; a wrapped label's second line sits deeper, under an option.
    let mut first_opt = last_opt;
    while first_opt > start {
        let above = &lines[first_opt - 1];
        let wrapped = !clean(above).is_empty() && indent(above) >= 5 && first_opt >= 2 && option_line(&lines[first_opt - 2]).is_some();
        if option_line(above).is_some() || wrapped {
            first_opt -= 1;
        } else {
            break;
        }
    }
    let mut options: Vec<Opt> = Vec::new();
    let mut cursor = None;
    for line in &lines[first_opt..=last_opt] {
        if let Some(o) = option_line(line) {
            if clean(line).starts_with('›') {
                cursor = Some(o.n);
            }
            options.push(o);
        } else if let Some(last) = options.last_mut() {
            last.label = join_wrapped(&last.label, clean(line));
        }
    }
    let above: Vec<String> = (first_opt.saturating_sub(12)..first_opt).map(|i| clean(&lines[i]).to_string()).collect();
    // A picker's title and question: the block of text right above the options.
    let header: Vec<String> = above.rsplit(|l| l.is_empty()).find(|b| !b.is_empty()).map(|b| b.to_vec()).unwrap_or_default();
    let (heading, target, description) = match kind {
        Kind::Permission => {
            // The approval spaces its heading, reason and command apart with blank lines.
            let at = above.iter().rposition(|l| l.starts_with("Would you like to"));
            let block: Vec<String> = at.map(|i| above[i..].to_vec()).unwrap_or_else(|| header.clone());
            let heading = at.map(|i| above[i].clone()).unwrap_or_else(|| "Codex wants to go ahead".to_string());
            let target = block.iter().find_map(|l| l.strip_prefix("$ ")).map(str::to_string);
            let description = block.iter().find_map(|l| l.strip_prefix("Reason:")).map(|r| r.trim().to_string());
            (heading, target, description)
        }
        Kind::Question => {
            let heading = header.first().cloned().unwrap_or_else(|| "Question".to_string());
            (heading, header.last().cloned().filter(|_| header.len() > 1), None)
        }
    };
    Some(Dialog { kind, heading, target, description, options, multi: false, cursor, submit_at: None, codex: true })
}

/// An entry of a question's option list that is not an answer: choosing it means typing next.
fn is_meta_option(label: &str) -> bool {
    let l = label.trim_end_matches('.').to_lowercase();
    l == "type something" || l == "chat about this"
}

/// Claude Code's AskUserQuestion dialog, captured from 2.1.278 (2026-09-19): a rule, a header tab
/// (`☐ Button colour`; a form shows every question's tab, `←  ☐ Size  ☐ Shape  ✔ Submit  →`),
/// the question, numbered options each with a description line under it (a multi-select
/// option's label starts with its `[ ]` box), a `Type something` entry, a second rule, a
/// `Chat about this` entry, and the footer `Enter to select · … · Esc to cancel`.
fn parse_question(lines: &[String], footer: usize) -> Option<Dialog> {
    // The options sit between a rule and the footer -- or, in the usual layout, between two rules
    // with only the `Chat about this` entry after the second: the first region up from the
    // footer that holds a real option is the list.
    let mut bound = footer;
    let mut region = None;
    for _ in 0..2 {
        let rule = (0..bound).rev().take(80).find(|&i| is_rule(&lines[i]));
        let start = rule.map(|r| r + 1).unwrap_or(bound.saturating_sub(30));
        if (start..bound).any(|i| option_line(&lines[i]).is_some_and(|o| !is_meta_option(&o.label))) {
            region = Some((start, bound));
            break;
        }
        bound = rule?;
    }
    let (start, end) = region?;
    let first_opt = (start..end).find(|&i| option_line(&lines[i]).is_some())?;
    let mut options: Vec<Opt> = Vec::new();
    let mut cursor = None;
    let mut submit_at = None;
    for line in &lines[first_opt..end] {
        let at_cursor = clean(line).starts_with('❯') || clean(line).starts_with('>');
        if let Some(o) = option_line(line) {
            if at_cursor {
                cursor = Some(o.n);
            }
            options.push(o);
        } else if !clean(line).is_empty() {
            let last = options.last_mut()?;
            let text = clean(line).trim_start_matches(['❯', '>']).trim();
            if text == "Submit" && last.checked.is_some() {
                submit_at = Some(last.n + 1);
                if at_cursor {
                    cursor = submit_at;
                }
                continue;
            }
            last.description = Some(match last.description.take() {
                Some(d) => join_wrapped(&d, text),
                None => text.to_string(),
            });
        }
    }
    let multi = options.iter().any(|o| o.checked.is_some());
    options.retain(|o| !is_meta_option(&o.label));
    // Above the options: the header tab, then the question (the nearest non-empty line).
    let question = (start..first_opt).rev().find(|&i| !clean(&lines[i]).is_empty())?;
    let header = (start..question).find(|&i| !clean(&lines[i]).is_empty()).map(|i| clean(&lines[i]));
    let heading = match header {
        Some(h) if h.starts_with('←') => "Questions".to_string(),
        Some(h) => h.trim_start_matches(['☐', '☑', '☒', '✔', '✓']).trim().to_string(),
        None => "Question".to_string(),
    };
    Some(Dialog { kind: Kind::Question, heading, target: Some(clean(&lines[question]).to_string()), description: None, options, multi, cursor, submit_at, codex: false })
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
    match find_footer(lines)? {
        (footer, kind, true) => parse_codex(lines, footer, kind),
        (footer, Kind::Question, false) => parse_question(lines, footer),
        (footer, Kind::Permission, false) => parse_permission(lines, footer),
    }
}

fn parse_permission(lines: &[String], footer: usize) -> Option<Dialog> {
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
    // Non-empty header lines with their indentation (a "Tip: …" line sits at the same indent as
    // the heading and must not be mistaken for the target; see `heading_indent` below).
    let header: Vec<(usize, String)> = lines[start..question].iter().filter(|l| !clean(l).is_empty()).map(|l| (indent(l), clean(l).to_string())).collect();
    let (heading_indent, heading) = header.first().cloned()?;
    // The target and description are the header lines indented deeper than the heading -- this
    // skips a "Tip: …" line, which sits at the heading's own indent.
    let deeper: Vec<&String> = header[1..].iter().filter(|(i, _)| *i > heading_indent).map(|(_, t)| t).collect();
    let (target, description) = if !deeper.is_empty() {
        (Some(deeper[0].clone()), deeper.get(1).map(|s| (*s).clone()))
    } else {
        // No line is indented deeper than the heading: fall back to treating the header as a
        // flat list, as when there is no rule and only the last few lines above the question
        // count.
        let mut flat: Vec<String> = header.iter().map(|(_, t)| t.clone()).collect();
        if rule.is_none() && flat.len() > 3 {
            flat.drain(..flat.len() - 3);
        }
        let target = flat.get(1).cloned();
        let description = if flat.len() == 3 { flat.last().cloned() } else { None };
        (target, description)
    };
    Some(Dialog { kind: Kind::Permission, heading, target, description, options, multi: false, cursor: None, submit_at: None, codex: false })
}

/// The dialog Claude is showing now: its footer is on the visible screen (at or below
/// `visible_start`, the index of the first visible row in `lines`) with nothing but blank lines
/// below it. A dialog in scrollback, or quoted in output that has more below it, is not one.
pub fn live_dialog(lines: &[String], visible_start: usize) -> Option<Dialog> {
    let (footer, _, _) = find_footer(lines)?;
    if footer < visible_start || lines[footer + 1..].iter().any(|l| !clean(l).is_empty()) {
        return None;
    }
    parse_dialog(lines)
}

/// What the visible screen says about Claude's state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScreenView {
    /// The permission or question dialog showing now (`live_dialog`).
    pub dialog: Option<Dialog>,
    /// Claude's "esc to interrupt" hint is on the visible screen: a turn (such as a long
    /// approved tool run) is in progress.
    pub interruptible: bool,
    /// The tile's own shell is in front (its agent has exited); asked only when the screen shows
    /// neither a dialog nor a turn in progress, None when not asked or the holder cannot say.
    pub shell_in_front: Option<bool>,
}

pub fn read_screen(lines: &[String], visible_start: usize) -> ScreenView {
    let visible = &lines[visible_start.min(lines.len())..];
    ScreenView {
        dialog: live_dialog(lines, visible_start),
        interruptible: visible.iter().any(|l| l.to_lowercase().contains("esc to interrupt")),
        shell_in_front: None,
    }
}

pub fn resolve(choice: &str, d: &Dialog) -> Result<Answer, String> {
    let lower = |o: &Opt| o.label.to_lowercase();
    let always = |l: &str| l.contains("always") || l.contains("don't ask") || l.contains("don\u{2019}t ask") || l.contains("allow all");
    let found = match choice {
        "deny" => return Ok(Answer::Esc),
        "submit" => {
            let (Some(at), Some(cur)) = (d.submit_at, d.cursor) else {
                return Err("the question has no Submit entry".into());
            };
            return Ok(Answer::Submit { downs: at.saturating_sub(cur) });
        }
        "yes" => d.options.iter().find(|o| lower(o).starts_with("yes") && !always(&lower(o))),
        "always" => d.options.iter().find(|o| lower(o).starts_with("yes") && always(&lower(o))),
        "no" => d.options.iter().find(|o| lower(o).starts_with("no")),
        n if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => d.options.iter().find(|o| o.n.to_string() == n),
        other => return Err(format!("unknown answer {other:?}: use yes, always, no, deny, submit or an option number")),
    };
    found.cloned().map(Answer::Option).ok_or_else(|| format!("the question has no {choice:?} option"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Codex CLI 0.157.1's approval for an escalated command (captured 2026-09-26).
    fn codex_approval() -> Vec<String> {
        lines(&[
            "› Run exactly this shell command with escalated permissions and nothing else: touch /tmp/cx-probe-",
            "  swarmz",
            "• I’ll request escalated permissions for the exact command.",
            "• Running touch /tmp/cx-probe-swarmz",
            "",
            "  Would you like to run the following command?",
            "",
            "  Environment: local",
            "",
            "  Reason: Allow running the exact command with escalated permissions?",
            "",
            "  $ touch /tmp/cx-probe-swarmz",
            "",
            "› 1. Yes, proceed (y)",
            "  2. Yes, and don't ask again for commands that start with `touch /tmp/cx-probe-swarmz` (p)",
            "  3. No, and tell Codex what to do differently (esc)",
            "",
            "  Press enter to confirm or esc to cancel",
            "",
        ])
    }

    #[test]
    fn codexs_approval_is_a_permission() {
        let d = live_dialog(&codex_approval(), 0).unwrap();
        assert_eq!(d.kind, Kind::Permission);
        assert!(d.codex);
        assert_eq!(d.heading, "Would you like to run the following command?");
        assert_eq!(d.target.as_deref(), Some("touch /tmp/cx-probe-swarmz"));
        assert_eq!(d.description.as_deref(), Some("Allow running the exact command with escalated permissions?"));
        assert_eq!(d.options.len(), 3);
        assert_eq!(d.cursor, Some(1));
        assert_eq!(d.summary(), "touch /tmp/cx-probe-swarmz");
        let pick = |c: &str| match resolve(c, &d).unwrap() {
            Answer::Option(o) => o,
            other => panic!("{other:?}"),
        };
        assert_eq!(codex_key(&pick("yes").label), Some("y"));
        assert_eq!(codex_key(&pick("always").label), Some("p"));
        assert_eq!(codex_key(&pick("no").label), Some("esc"));
        // A command's output quoting it, with more below, is not a live dialog.
        let mut quoted = codex_approval();
        quoted.push("• Ran it".into());
        assert!(live_dialog(&quoted, 0).is_none());
    }

    #[test]
    fn codexs_pickers_are_questions() {
        let screen = lines(&[
            "• The command completed with no output.",
            "",
            "  Approaching rate limits",
            "  Switch to gpt-6-luna for lower credit usage?",
            "",
            "› 1. Switch to gpt-6-luna                   Fast and affordable model for easier tasks.",
            "  2. Keep current model",
            "  3. Keep current model (never show again)  Hide future rate limit reminders about switching models",
            "",
            "  enter select · esc back",
        ]);
        let d = live_dialog(&screen, 0).unwrap();
        assert_eq!(d.kind, Kind::Question);
        assert!(d.codex);
        assert_eq!(d.heading, "Approaching rate limits");
        assert_eq!(d.target.as_deref(), Some("Switch to gpt-6-luna for lower credit usage?"));
        assert_eq!(d.options.iter().map(|o| o.n).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(d.cursor, Some(1));
        assert_eq!(codex_key(&d.options[1].label), None);
        // Codex's idle footer is no dialog.
        assert!(live_dialog(&lines(&["› Ask Codex to do anything", "  ? for shortcuts"]), 0).is_none());
    }

    #[test]
    fn hotkeys_come_from_the_labels_end() {
        assert_eq!(codex_key("Yes, proceed (y)"), Some("y"));
        assert_eq!(codex_key("No (esc)"), Some("esc"));
        assert_eq!(codex_key("Keep current model (never show again)"), None);
        assert_eq!(codex_key("Keep current model"), None);
    }

    /// An empty permission dialog to build test dialogs from.
    fn permission(heading: &str) -> Dialog {
        Dialog { kind: Kind::Permission, heading: heading.into(), target: None, description: None, options: vec![], multi: false, cursor: None, submit_at: None, codex: false }
    }

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Claude Code 2.1.278's AskUserQuestion dialog for one single-select question (captured
    /// 2026-09-19).
    fn question() -> Vec<String> {
        lines(&[
            "❯ Use the AskUserQuestion tool to ask me exactly one question about which colour the button should be,",
            "  offering exactly three primary-colour options. Do nothing else.",
            "",
            "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            " ☐ Button colour",
            "Which colour should the button be?",
            "❯ 1. Red",
            "     A bold red button",
            "  2. Blue",
            "     A classic blue button",
            "  3. Yellow",
            "     A bright yellow button",
            "  4. Type something.",
            "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            "  5. Chat about this",
            "Enter to select · ↑/↓ to navigate · Esc to cancel",
            "",
        ])
    }

    /// The second question of a two-question form, multi-select, with one box ticked and the
    /// cursor on the Submit entry (captured 2026-09-19).
    fn multi_select() -> Vec<String> {
        lines(&[
            "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            "←  ☒ Size  ☒ Shape  ✔ Submit  →",
            "Which shapes do you want to include?",
            "  1. [ ] Circle",
            "  Round shape with no corners.",
            "  2. [✔] Square",
            "  Four equal sides and right angles.",
            "  3. [ ] Triangle",
            "  Three sides and three corners.",
            "  4. [ ] Type something",
            "❯    Submit",
            "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            "  5. Chat about this",
            "Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel",
        ])
    }

    /// The form's review step, which has no second rule (captured 2026-09-19).
    fn review() -> Vec<String> {
        lines(&[
            "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
            "←  ☒ Size  ☒ Shape  ✔ Submit  →",
            "Review your answers",
            " ● Which garment size do you want?",
            "   → Small",
            " ● Which shapes do you want to include?",
            "   → Square",
            "Ready to submit your answers?",
            "❯ 1. Submit answers",
            "  2. Cancel",
            "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
        ])
    }

    #[test]
    fn reads_a_single_select_question() {
        let d = parse_dialog(&question()).expect("a dialog");
        assert_eq!((d.kind, d.heading.as_str(), d.multi), (Kind::Question, "Button colour", false));
        assert_eq!(d.summary(), "Which colour should the button be?");
        let opts: Vec<(u32, &str, Option<&str>)> = d.options.iter().map(|o| (o.n, o.label.as_str(), o.description.as_deref())).collect();
        assert_eq!(opts, vec![(1, "Red", Some("A bold red button")), (2, "Blue", Some("A classic blue button")), (3, "Yellow", Some("A bright yellow button"))]);
        assert_eq!((d.cursor, d.submit_at), (Some(1), None));
        // Its digit answers it; the permission words do not fit.
        assert!(matches!(resolve("2", &d), Ok(Answer::Option(Opt { n: 2, .. }))));
        assert!(resolve("yes", &d).is_err());
        assert!(resolve("submit", &d).is_err());
    }

    #[test]
    fn reads_a_multi_select_question_with_its_boxes_and_submit_entry() {
        let d = parse_dialog(&multi_select()).expect("a dialog");
        assert_eq!((d.kind, d.heading.as_str(), d.multi), (Kind::Question, "Questions", true));
        assert_eq!(d.summary(), "Which shapes do you want to include?");
        let opts: Vec<(u32, &str, Option<bool>)> = d.options.iter().map(|o| (o.n, o.label.as_str(), o.checked)).collect();
        assert_eq!(opts, vec![(1, "Circle", Some(false)), (2, "Square", Some(true)), (3, "Triangle", Some(false))]);
        assert_eq!(d.options[0].description.as_deref(), Some("Round shape with no corners."));
        assert_eq!((d.cursor, d.submit_at), (Some(5), Some(5)));
        assert_eq!(resolve("submit", &d), Ok(Answer::Submit { downs: 0 }));
        // From an option, Submit is a few ↓ away.
        let mut from_first = multi_select();
        from_first[3] = "❯ 1. [ ] Circle".into();
        from_first[10] = "     Submit".into();
        let d = parse_dialog(&from_first).unwrap();
        assert_eq!(d.cursor, Some(1));
        assert_eq!(resolve("submit", &d), Ok(Answer::Submit { downs: 4 }));
    }

    #[test]
    fn reads_the_review_step_without_a_second_rule() {
        let d = parse_dialog(&review()).expect("a dialog");
        assert_eq!((d.kind, d.heading.as_str()), (Kind::Question, "Questions"));
        assert_eq!(d.summary(), "Ready to submit your answers?");
        let opts: Vec<(u32, &str)> = d.options.iter().map(|o| (o.n, o.label.as_str())).collect();
        assert_eq!(opts, vec![(1, "Submit answers"), (2, "Cancel")]);
    }

    #[test]
    fn the_newest_footer_decides_the_kind() {
        // A permission dialog in scrollback above a live question: the question is read.
        let mut both = real();
        both.extend(question());
        let d = parse_dialog(&both).unwrap();
        assert_eq!(d.kind, Kind::Question);
        assert_eq!(live_dialog(&both, both.len() - 6).map(|d| d.kind), Some(Kind::Question));
        // A permission dialog read as before.
        assert_eq!(parse_dialog(&real()).unwrap().kind, Kind::Permission);
    }

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

    /// Claude Code 2.1.274's dialog with a "Tip: …" line at the heading's own indent, wrapped
    /// onto a second line, above the target and description (indented deeper).
    fn real_with_tip() -> Vec<String> {
        [
            "─────────────────────────────",
            " Bash command",
            " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\"",
            " below",
            "",
            "   mkdir -p /tmp/swarmz-phone-test",
            "   Create the phone test directory",
            "",
            " Do you want to proceed?",
            " ❯ 1. Yes",
            "   2. Yes, and always allow access to /tmp from this project",
            "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
            "   4. No",
            "",
            " Esc to cancel · Tab to amend",
            "",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn a_tip_line_does_not_become_the_target() {
        let d = parse_dialog(&real_with_tip()).expect("a dialog");
        assert_eq!(d.heading, "Bash command");
        assert_eq!(d.target.as_deref(), Some("mkdir -p /tmp/swarmz-phone-test"));
        assert_eq!(d.description.as_deref(), Some("Create the phone test directory"));
        assert_eq!(d.options.len(), 4);
        let pick = |s: &str| match resolve(s, &d) {
            Ok(Answer::Option(o)) => Some(o.n),
            Ok(Answer::Esc) => Some(0),
            Ok(Answer::Submit { .. }) | Err(_) => None,
        };
        assert_eq!(pick("yes"), Some(1));
        assert_eq!(pick("always"), Some(2));
        assert_eq!(pick("no"), Some(4));
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
    fn the_interrupt_hint_counts_only_on_the_visible_screen() {
        let lines: Vec<String> = ["✻ Running… (12s · ESC to interrupt)", "", "> "].iter().map(|s| s.to_string()).collect();
        assert!(read_screen(&lines, 0).interruptible);
        assert!(read_screen(&lines, 0).dialog.is_none());
        assert!(!read_screen(&lines, 1).interruptible);
        assert!(!read_screen(&lines, 9).interruptible);
        let v = read_screen(&real(), 0);
        assert!(v.dialog.is_some() && !v.interruptible);
    }

    #[test]
    fn a_curly_apostrophe_counts_as_dont_ask() {
        let d = Dialog { options: vec![Opt::new(1, "Yes"), Opt::new(2, "Yes, and don\u{2019}t ask again for npm commands"), Opt::new(3, "No")], ..permission("h") };
        assert!(matches!(resolve("always", &d), Ok(Answer::Option(Opt { n: 2, .. }))));
        assert!(matches!(resolve("yes", &d), Ok(Answer::Option(Opt { n: 1, .. }))));
    }

    #[test]
    fn answers_resolve_against_the_options_on_screen() {
        let d = parse_dialog(&real()).unwrap();
        let pick = |s: &str| match resolve(s, &d) {
            Ok(Answer::Option(o)) => Some(o.n),
            Ok(Answer::Esc) => Some(0),
            Ok(Answer::Submit { .. }) | Err(_) => None,
        };
        assert_eq!(pick("yes"), Some(1));
        assert_eq!(pick("always"), Some(2));
        assert_eq!(pick("no"), Some(3));
        assert_eq!(pick("deny"), Some(0));
        assert_eq!(pick("2"), Some(2));
        assert_eq!(pick("7"), None);
        assert_eq!(pick("maybe"), None);
        let two = Dialog { options: vec![Opt::new(1, "Yes"), Opt::new(2, "No, and tell Claude what to do differently")], ..permission("h") };
        assert!(resolve("always", &two).is_err());
        assert!(matches!(resolve("no", &two), Ok(Answer::Option(Opt { n: 2, .. }))));
    }
}
