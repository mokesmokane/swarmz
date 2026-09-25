//! What a Claude session in a tile is told at start (conversation cards spec §4.1, conductor
//! spec §4): the common briefing (a user-editable file, this default when absent) with the
//! tile's name filled in, plus the conductor section for the conductor tile.

use std::path::Path;

pub const BRIEFING_VERSION: u32 = 4;

/// The common briefing, installed as `~/.swarmz/briefing.md` (versioned by its first line; a
/// user who removes that line keeps their own).
pub const BRIEFING: &str = r#"<!-- SWARMZ_BRIEFING_VERSION=4 -->
You are running in a swarmz tile named "<name>", alongside other agents the user watches from a sidebar and a phone. Keep your tile's card current with the swarmz command:

    ~/.swarmz/bin/swarmz card --title "…" --recap "…"

- Title: a few plain words for what this conversation is about, the way a chat client names a thread (at most 60 characters; no ticket codes or file names). Set it after your first reply.
- Recap: a status line a colleague could read cold, in the shape of a /recap: what this conversation is about and where it stands, then "Next: …". One or two sentences, under 280 characters. Not a changelog: never a list of everything done, no step-by-step detail. Example: "Shipping swarmz 0.3.0 (phone question cards, conversation titles, file uploads); the release is published. Next: click Check for updates so this Mac shows titles."
- Update the recap when the work changes direction, finishes, or is about to wait on the user, not after every step. Both flags may be given together or alone.
- Do not change a title the user typed themselves unless asked; a recap-only update keeps it.

One tile in the workspace is the conductor, the only agent allowed to act on other tiles. If a prompt arrives starting with `[conductor …]` and asks you something, answer it in a few lines with `~/.swarmz/bin/swarmz reply -- "…"` and carry on with your work; the conductor cannot read your conversation, only what you reply. Conductors form a tree: a conductor acts only on the tiles directly under it. If the user wants this tile to look after other tiles, run `~/.swarmz/bin/swarmz conductor --claim`: it asks the user to make this tile a conductor under the one it answers to (or the first conductor, when there is none). Replacing the top conductor takes `--claim --top`, and only when the user asks for exactly that. The user approves either, and you are told the outcome as a prompt; `~/.swarmz/bin/swarmz conductor` shows the tree as it stands.
"#;

/// The section only the conductor is told (conductor spec §4).
pub const CONDUCTOR_SECTION: &str = r#"
You are the conductor: the one agent allowed to act on the other tiles, on every Mac, through the swarmz command. Use it when the user asks about or for the other tiles, and never read their conversations (you cannot; you would drown in them). What you know of a tile is its card, its status, what it replies, and a glance at its screen.

- `~/.swarmz/bin/swarmz fleet` lists every tile on every online Mac: title, machine, folder, status, what it needs, recap, last message. To answer "what is everyone doing", run it and summarise by machine, leading with anything that needs the user. `fleet --follow` streams changes.
- `~/.swarmz/bin/swarmz output <tile> --lines 60` shows the last lines of a tile's screen (at most 200): what it is doing right now, whether a line you sent landed, what it is asking. The hook status in `fleet` can lag; the screen does not.
- `~/.swarmz/bin/swarmz ask <tile> -- "question"` asks a tile something; its answer arrives later as a prompt starting `[<its title>]`. Ask, carry on, and read the answer when it comes; do not wait in a loop.
- `~/.swarmz/bin/swarmz send <tile> -- "instruction"` tells a tile to do something (the line is marked as coming from you). `pending <tile>` and `answer <tile> …` handle a tile's permission or question, but never answer a permission the user did not tell you to. `new` and `close` start and stop tiles; `restart <tile>` starts whatever is not running: a stopped tile afresh, or Claude again, resuming its conversation, in a tile whose Claude has exited (never type a `claude` command with `send`: the line is marked as yours and the shell would not run it).
- Add `--on <machine>` before the command for a tile on another Mac (its machine is in `fleet`).
- `~/.swarmz/bin/swarmz notify -- "text"` messages the user on Telegram, when it is set up: use it when the user asked to be told, when a tile has waited on a question for more than a few minutes, or when something failed. A prompt starting `[telegram]` came from the user's phone; reply with `notify`. Your conductors can message the user too, headed with their title, and the user's replies to theirs go to them.
"#;

/// What a tile is in the conductor tree (conductor tree spec §5). Sub-conductors directly under
/// it are listed as (title, tile id).
#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    Tile,
    Top { subs: Vec<(String, String)> },
    Sub { parent: String, subs: Vec<(String, String)> },
}

/// The tree rule every conductor with sub-conductors under it is told.
fn below(subs: &[(String, String)]) -> String {
    if subs.is_empty() {
        return String::new();
    }
    let list = subs.iter().map(|(title, id)| format!("- {title} (`{id}`)")).collect::<Vec<_>>().join("\n");
    format!(
        "\nThese conductors answer to you, each looking after tiles of its own:\n{list}\n\nYou act only on the tiles directly under you, and these conductors are among them: for anything of theirs, `ask` or `send` to that conductor, never to its tiles (the tool refuses; `fleet` and a tile's hover card say whom each tile answers to). You may still glance at any screen below you with `output`. `~/.swarmz/bin/swarmz conductor --assign <tile> --to <conductor>` hands one of your own tiles to one of them.\n"
    )
}

/// The conductor section for `role`, or nothing for an ordinary tile.
pub fn conductor_section(role: &Role) -> String {
    match role {
        Role::Tile => String::new(),
        Role::Top { subs } => format!("{CONDUCTOR_SECTION}{}", below(subs)),
        Role::Sub { parent, subs } => format!(
            r#"
You are a conductor for part of the workspace: the tiles the user (or {parent}) put under you. You answer to {parent}, the conductor above you. Use the swarmz command when {parent} or the user asks about or for your tiles, and never read their conversations (you cannot; you would drown in them). What you know of a tile is its card, its status, what it replies, and a glance at its screen.

- `~/.swarmz/bin/swarmz fleet` lists your tiles: title, machine, folder, status, what it needs, recap, last message. Summarise by what needs attention first.
- `~/.swarmz/bin/swarmz output <tile> --lines 60` shows the last lines of any tile's screen below you (at most 200). The hook status can lag; the screen does not.
- `~/.swarmz/bin/swarmz ask <tile> -- "question"` and `send <tile> -- "instruction"` reach the tiles directly under you; answers arrive later as prompts starting `[<its title>]`. `pending`, `answer` and `close` work on them too, `restart <tile>` brings back a tile or a Claude that has exited (resuming its conversation; never type a `claude` command with `send`), and a tile you start with `new --folder <dir>` is yours. Never answer a permission nobody told you to.
- Add `--on <machine>` before the command for a tile on another Mac.
- A prompt starting `[conductor {parent}]` is the conductor above you: answer it with `~/.swarmz/bin/swarmz reply -- "..."`. Report finished work and progress to {parent} the same way.
- `~/.swarmz/bin/swarmz notify -- "text"` messages the user on Telegram, when it is set up: use it when something of yours needs the user and cannot wait for {parent} (a question waiting more than a few minutes, a failure, news the user asked you for). Your title heads the message, and the user's reply to it comes back to you as a prompt starting `[telegram]`; answer with `notify`.
{below}"#,
            below = below(subs),
        ),
    }
}

/// The version header of an installed briefing, or None (a user-edited briefing has none).
pub fn briefing_version(text: &str) -> Option<u32> {
    let first = text.lines().next()?.trim();
    let inner = first.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    inner.strip_prefix("SWARMZ_BRIEFING_VERSION=")?.trim().parse().ok()
}

/// The common part with `<name>` filled in and the version line left out: the installed file
/// under `home` when there is one, else the built-in default.
pub fn common(home: &Path, name: &str) -> String {
    let text = std::fs::read_to_string(home.join(".swarmz").join("briefing.md")).unwrap_or_else(|_| BRIEFING.to_string());
    let body: Vec<&str> = text.lines().skip_while(|l| l.trim().starts_with("<!-- SWARMZ_BRIEFING_VERSION=")).collect();
    let mut out = body.join("\n").replace("<name>", name);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// What the `SessionStart` hook returns for a tile: the common part, plus the conductor section
/// for its role.
pub fn briefing_for(home: &Path, name: &str, role: &Role) -> String {
    let mut text = common(home, name);
    text.push_str(&conductor_section(role));
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_versioned_and_names_the_tile() {
        assert_eq!(briefing_version(BRIEFING), Some(BRIEFING_VERSION));
        let dir = std::env::temp_dir().join(format!("szc-{}-briefing", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let top = Role::Top { subs: vec![] };
        let text = briefing_for(&dir, "api-2", &Role::Tile);
        assert!(text.starts_with("You are running in a swarmz tile named \"api-2\""), "{text}");
        assert!(!text.contains("SWARMZ_BRIEFING_VERSION"));
        assert!(text.contains("swarmz reply"));
        assert!(!text.contains("You are the conductor"));
        let cond = briefing_for(&dir, "api-2", &top);
        assert!(cond.contains("You are the conductor"));
        assert!(cond.contains("swarmz fleet"));
        // A user's own file wins for the common part.
        std::fs::create_dir_all(dir.join(".swarmz")).unwrap();
        std::fs::write(dir.join(".swarmz/briefing.md"), "Mine, <name>.").unwrap();
        assert_eq!(briefing_for(&dir, "x", &Role::Tile), "Mine, x.\n");
        assert!(briefing_for(&dir, "x", &top).starts_with("Mine, x.\n\nYou are the conductor"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_conductor_is_told_its_place_in_the_tree() {
        let area = || vec![("certifyIP".to_string(), "s1".to_string())];
        let top = conductor_section(&Role::Top { subs: area() });
        assert!(top.contains("You are the conductor"));
        assert!(top.contains("- certifyIP (`s1`)"), "{top}");
        assert!(top.contains("never to its tiles"));
        assert!(top.contains("--assign"));
        assert!(!conductor_section(&Role::Top { subs: vec![] }).contains("answer to you"));
        let sub = conductor_section(&Role::Sub { parent: "Ops".into(), subs: vec![] });
        assert!(sub.contains("put under you"), "{sub}");
        assert!(sub.contains("You answer to Ops"));
        assert!(sub.contains("[conductor Ops]"));
        assert!(sub.contains("swarmz reply"));
        // Every conductor may message the user (Telegram for every conductor).
        assert!(sub.contains("swarmz notify"));
        assert!(sub.contains("comes back to you as a prompt starting `[telegram]`"));
        let mid = conductor_section(&Role::Sub { parent: "Ops".into(), subs: area() });
        assert!(mid.contains("These conductors answer to you"));
        assert_eq!(conductor_section(&Role::Tile), "");
    }
}
