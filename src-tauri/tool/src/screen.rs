//! The holder's view of the screen: styled lines for the phone (spec §3.4).

use serde::{Deserialize, Serialize};

/// Lines of scrollback the holder keeps.
pub const SCROLLBACK: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Color {
    /// A palette index (0–255).
    Index(u8),
    /// `#rrggbb`.
    Rgb(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<Color>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<Color>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
}

pub type Line = Vec<Span>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub cols: u16,
    pub rows: u16,
    /// (index into `lines`, column)
    pub cursor: (usize, u16),
    pub lines: Vec<Line>,
}

fn color(c: vt100::Color) -> Option<Color> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(Color::Index(i)),
        vt100::Color::Rgb(r, g, b) => Some(Color::Rgb(format!("#{r:02x}{g:02x}{b:02x}"))),
    }
}

fn row_line(screen: &vt100::Screen, row: u16, cols: u16) -> Line {
    let mut out: Line = Vec::new();
    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else { continue };
        if cell.is_wide_continuation() {
            continue;
        }
        let text = if cell.has_contents() { cell.contents() } else { " " };
        let (mut fg, mut bg) = (color(cell.fgcolor()), color(cell.bgcolor()));
        if cell.inverse() {
            std::mem::swap(&mut fg, &mut bg);
        }
        let bold = cell.bold();
        match out.last_mut() {
            Some(s) if s.fg == fg && s.bg == bg && s.bold == bold => s.text.push_str(text),
            _ => out.push(Span { text: text.to_string(), fg, bg, bold }),
        }
    }
    // Trailing blanks on the default background carry nothing.
    while let Some(last) = out.last_mut() {
        if last.bg.is_some() {
            break;
        }
        let keep = last.text.trim_end_matches(' ').len();
        last.text.truncate(keep);
        if last.text.is_empty() {
            out.pop();
        } else {
            break;
        }
    }
    out
}

/// The last `max_lines` lines of scrollback plus screen. Leaves the live screen in view.
pub fn snapshot(parser: &mut vt100::Parser, max_lines: usize) -> Snapshot {
    let screen = parser.screen_mut();
    let (rows, cols) = screen.size();
    let (cur_row, cur_col) = screen.cursor_position();
    screen.set_scrollback(usize::MAX);
    let total = screen.scrollback();
    let mut lines: Vec<Line> = Vec::new();
    let mut off = total.min(max_lines);
    while off > 0 {
        screen.set_scrollback(off);
        let take = off.min(rows as usize);
        for r in 0..take as u16 {
            lines.push(row_line(screen, r, cols));
        }
        off -= take;
    }
    screen.set_scrollback(0);
    let mut visible: Vec<Line> = (0..rows).map(|r| row_line(screen, r, cols)).collect();
    while visible.len() > cur_row as usize + 1 && visible.last().is_some_and(|l| l.is_empty()) {
        visible.pop();
    }
    let visible_start = lines.len();
    lines.extend(visible);
    let start = lines.len().saturating_sub(max_lines);
    let lines = lines.split_off(start);
    let cursor_line = (visible_start + cur_row as usize).saturating_sub(start);
    Snapshot { cols, rows, cursor: (cursor_line, cur_col), lines }
}

pub fn line_text(line: &Line) -> String {
    line.iter().map(|s| s.text.as_str()).collect()
}

/// How to turn the previous lines into the next: drop `drop` from the top, keep `from` of what
/// remains, then append `lines`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinesUpdate {
    pub drop: usize,
    pub from: usize,
    pub lines: Vec<Line>,
}

fn common_prefix(a: &[Line], b: &[Line]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

pub fn diff_lines(prev: &[Line], next: &[Line]) -> Option<LinesUpdate> {
    if prev == next {
        return None;
    }
    let mut best = (0, common_prefix(prev, next));
    for d in 1..=prev.len() {
        let c = common_prefix(&prev[d..], next);
        if c > best.1 {
            best = (d, c);
        }
    }
    let (drop, from) = best;
    Some(LinesUpdate { drop, from, lines: next[from..].to_vec() })
}

pub fn apply_update(prev: &[Line], u: &LinesUpdate) -> Vec<Line> {
    let mut out: Vec<Line> = prev.iter().skip(u.drop).take(u.from).cloned().collect();
    out.extend(u.lines.iter().cloned());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_lines(s: &Snapshot) -> Vec<String> {
        s.lines.iter().map(line_text).collect()
    }

    #[test]
    fn plain_output_becomes_lines_and_trailing_blank_rows_are_dropped() {
        let mut p = vt100::Parser::new(5, 20, SCROLLBACK);
        p.process(b"one\r\ntwo\r\n$ ");
        let s = snapshot(&mut p, 100);
        assert_eq!(text_lines(&s), vec!["one", "two", "$"]);
        assert_eq!((s.cols, s.rows), (20, 5));
        assert_eq!(s.cursor, (2, 2));
    }

    #[test]
    fn scrollback_comes_before_the_screen_and_is_limited() {
        let mut p = vt100::Parser::new(3, 10, SCROLLBACK);
        for i in 0..10 {
            p.process(format!("l{i}\r\n").as_bytes());
        }
        let all = snapshot(&mut p, 1000);
        let texts = text_lines(&all);
        assert_eq!(&texts[..10], &["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"]);
        let last4 = snapshot(&mut p, 4);
        assert_eq!(last4.lines.len(), 4);
        assert_eq!(line_text(&last4.lines[0]), "l7");
        // Reading the scrollback leaves the live screen in view.
        assert_eq!(p.screen().scrollback(), 0);
    }

    #[test]
    fn colours_and_bold_make_spans() {
        let mut p = vt100::Parser::new(3, 30, SCROLLBACK);
        p.process(b"\x1b[1;31mred\x1b[0m plain \x1b[38;2;37;191;53mgreen\x1b[0m");
        let s = snapshot(&mut p, 10);
        let line = &s.lines[0];
        assert_eq!(line[0], Span { text: "red".into(), fg: Some(Color::Index(1)), bg: None, bold: true });
        assert_eq!(line[1], Span { text: " plain ".into(), fg: None, bg: None, bold: false });
        assert_eq!(line[2].fg, Some(Color::Rgb("#25bf35".into())));
        let json = serde_json::to_value(line).unwrap();
        assert_eq!(json[0], serde_json::json!({"text": "red", "fg": 1, "bold": true}));
        assert_eq!(json[1], serde_json::json!({"text": " plain "}));
    }

    #[test]
    fn inverse_swaps_colours() {
        let mut p = vt100::Parser::new(2, 10, SCROLLBACK);
        p.process(b"\x1b[7mX\x1b[0m");
        let s = snapshot(&mut p, 10);
        assert_eq!(s.lines[0][0].text, "X");
        assert_eq!(s.lines[0][0].fg, None);
    }

    fn l(s: &str) -> Line {
        vec![Span { text: s.into(), fg: None, bg: None, bold: false }]
    }

    #[test]
    fn diffs_cover_no_change_append_scroll_and_replace() {
        let a = vec![l("a"), l("b")];
        assert_eq!(diff_lines(&a, &a), None);
        let appended = vec![l("a"), l("b"), l("c")];
        let u = diff_lines(&a, &appended).unwrap();
        assert_eq!((u.drop, u.from, u.lines.clone()), (0, 2, vec![l("c")]));
        let scrolled = vec![l("b"), l("c"), l("d")];
        let u = diff_lines(&appended, &scrolled).unwrap();
        assert_eq!((u.drop, u.from, u.lines.clone()), (1, 2, vec![l("d")]));
        let replaced = vec![l("a"), l("x")];
        let u = diff_lines(&a, &replaced).unwrap();
        assert_eq!((u.drop, u.from, u.lines.clone()), (0, 1, vec![l("x")]));
    }

    #[test]
    fn applying_a_diff_always_gives_the_new_lines() {
        let cases: Vec<(Vec<Line>, Vec<Line>)> = vec![
            (vec![], vec![l("a")]),
            (vec![l("a")], vec![]),
            (vec![l("a"), l("b"), l("c")], vec![l("c"), l("d")]),
            (vec![l("x"), l("y")], vec![l("p"), l("q"), l("r")]),
            (vec![l("a"), l("a"), l("b")], vec![l("a"), l("b"), l("b")]),
        ];
        for (prev, next) in cases {
            match diff_lines(&prev, &next) {
                None => assert_eq!(prev, next),
                Some(u) => assert_eq!(apply_update(&prev, &u), next),
            }
        }
    }
}
