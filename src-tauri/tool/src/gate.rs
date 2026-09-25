//! The forced command for phone keys: only the tool, only the phone's commands (spec §4.7).

/// Subcommands a phone key may run (spec §4.7). `phone` is further limited to `ls` and `revoke`.
pub const ALLOWED: &[&str] = &[
    "version", "info", "close", "machines", "ls", "watch", "transcript", "image", "output", "send", "key", "pending", "answer",
    "folders", "new", "restart", "phone", "card", "upload", "conductor", "fleet", "ask", "reply", "notify", "stats",
];

/// POSIX shell word splitting: blanks separate words; single quotes are literal; double quotes
/// allow `\"`, `\\`, `\$` and `` \` ``; a backslash outside quotes escapes the next character.
/// No expansion of any kind. Fails closed: an unquoted newline, or an unquoted shell
/// metacharacter (`; | & < > ( ) $` or a backtick), is an error rather than being passed
/// through as an ordinary word character. The phone always single-quotes its arguments, so
/// these characters inside a quoted (or backslash-escaped) word are unaffected.
pub fn split_words(s: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            '\n' => return Err("an unquoted newline is not allowed".into()),
            ';' | '|' | '&' | '<' | '>' | '(' | ')' | '$' | '`' => {
                return Err(format!("the unquoted character {c:?} is not allowed"));
            }
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(ch) => cur.push(ch),
                        None => return Err("unterminated single quote".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.peek() {
                            Some(&n) if matches!(n, '"' | '\\' | '$' | '`') => {
                                cur.push(n);
                                chars.next();
                            }
                            _ => cur.push('\\'),
                        },
                        Some(ch) => cur.push(ch),
                        None => return Err("unterminated double quote".into()),
                    }
                }
            }
            '\\' => {
                in_word = true;
                match chars.next() {
                    Some(n) => cur.push(n),
                    None => return Err("trailing backslash".into()),
                }
            }
            other => {
                in_word = true;
                cur.push(other);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    Ok(words)
}

/// The tool's arguments when `words` is an allowed command.
pub fn check(words: &[String], tool_paths: &[String]) -> Result<Vec<String>, String> {
    let program = words.first().ok_or("no command given")?;
    if program != "swarmz" && !tool_paths.iter().any(|p| p == program) {
        return Err(format!("{program:?} is not allowed"));
    }
    let sub = words.get(1).ok_or("no subcommand given")?;
    if !ALLOWED.contains(&sub.as_str()) {
        return Err(format!("{sub:?} is not allowed"));
    }
    if sub == "phone" && !matches!(words.get(2).map(String::as_str), Some("ls") | Some("revoke")) {
        return Err("only phone ls and phone revoke are allowed".into());
    }
    Ok(words[1..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> {
        split_words(s).unwrap()
    }

    #[test]
    fn splits_like_a_posix_shell() {
        assert_eq!(w("swarmz ls"), vec!["swarmz", "ls"]);
        assert_eq!(w("  swarmz   send  t1 'hello world'  "), vec!["swarmz", "send", "t1", "hello world"]);
        assert_eq!(w(r#"swarmz send t1 'it'\''s'"#), vec!["swarmz", "send", "t1", "it's"]);
        assert_eq!(w(r#"swarmz send t1 "a \"b\" \$c \\ d""#), vec!["swarmz", "send", "t1", r#"a "b" $c \ d"#]);
        assert_eq!(w(r"swarmz send t1 a\ b"), vec!["swarmz", "send", "t1", "a b"]);
        assert_eq!(w("swarmz send t1 ''"), vec!["swarmz", "send", "t1", ""]);
        assert_eq!(w("swarmz send t1 'a;b|c$(d)`e`'"), vec!["swarmz", "send", "t1", "a;b|c$(d)`e`"]);
        assert_eq!(w("swarmz send t1 'a;b|c'"), vec!["swarmz", "send", "t1", "a;b|c"]);
        assert!(split_words("swarmz send 'open").is_err());
        assert!(split_words("swarmz send \"open").is_err());
        assert!(split_words("").unwrap().is_empty());
        // Fail closed: unquoted shell metacharacters and an unquoted newline are rejected.
        assert!(split_words("swarmz ls; rm -rf ~").is_err());
        assert!(split_words("swarmz send t1 a|b").is_err());
        assert!(split_words("swarmz send t1 a&b").is_err());
        assert!(split_words("swarmz send t1 a<b").is_err());
        assert!(split_words("swarmz send t1 a>b").is_err());
        assert!(split_words("swarmz send t1 a(b)").is_err());
        assert!(split_words("swarmz send t1 a$b").is_err());
        assert!(split_words("swarmz send t1 a`b").is_err());
        assert!(split_words("swarmz send\nt1").is_err());
    }

    #[test]
    fn only_the_tool_and_the_phones_commands_pass() {
        let tools = vec!["/Users/me/.swarmz/bin/swarmz".to_string()];
        assert_eq!(check(&w("swarmz ls"), &tools).unwrap(), vec!["ls"]);
        assert_eq!(check(&w("/Users/me/.swarmz/bin/swarmz watch"), &tools).unwrap(), vec!["watch"]);
        assert_eq!(check(&w("swarmz phone ls"), &tools).unwrap(), vec!["phone", "ls"]);
        assert_eq!(check(&w("swarmz phone revoke fold"), &tools).unwrap(), vec!["phone", "revoke", "fold"]);
        // The tool's own argument parsing handles trailing flags like `--local`.
        assert_eq!(check(&w("swarmz phone revoke fold --local"), &tools).unwrap(), vec!["phone", "revoke", "fold", "--local"]);
        for bad in [
            "swarmz attach t1",
            "swarmz hold t1 --cwd /",
            "swarmz phone add --name x --key y",
            "swarmz phone",
            "swarmz sessions",
            "swarmz prune",
            "swarmz __holder t1",
            "swarmz __keep-def t1",
            "swarmz ssh-gate",
            "swarmz",
            "sh -c id",
            "/tmp/swarmz ls",
            "swarmzz ls",
        ] {
            assert!(check(&w(bad), &tools).is_err(), "{bad}");
        }
        assert!(check(&[], &tools).is_err());
    }
}
