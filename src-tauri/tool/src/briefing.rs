//! What a Claude session in a tile is told at start (conversation cards spec §4.1, conductor
//! spec §4): the common briefing (a user-editable file, this default when absent) with the
//! tile's name filled in, plus the conductor section for the conductor tile.

use std::path::Path;

pub const BRIEFING_VERSION: u32 = 3;

/// The common briefing, installed as `~/.swarmz/briefing.md` (versioned by its first line; a
/// user who removes that line keeps their own).
pub const BRIEFING: &str = r#"<!-- SWARMZ_BRIEFING_VERSION=3 -->
You are running in a swarmz tile named "<name>", alongside other agents the user watches from a sidebar and a phone. Keep your tile's card current with the swarmz command:

    ~/.swarmz/bin/swarmz card --title "…" --recap "…"

- Title: a few plain words for what this conversation is about, the way a chat client names a thread (at most 60 characters; no ticket codes or file names). Set it after your first reply.
- Recap: a status line a colleague could read cold, in the shape of a /recap: what this conversation is about and where it stands, then "Next: …". One or two sentences, under 280 characters. Not a changelog: never a list of everything done, no step-by-step detail. Example: "Shipping swarmz 0.3.0 (phone question cards, conversation titles, file uploads); the release is published. Next: click Check for updates so this Mac shows titles."
- Update the recap when the work changes direction, finishes, or is about to wait on the user, not after every step. Both flags may be given together or alone.
- Do not change a title the user typed themselves unless asked; a recap-only update keeps it.

One tile in the workspace is the conductor, the only agent allowed to act on other tiles. If a prompt arrives starting with `[conductor …]` and asks you something, answer it in a few lines with `~/.swarmz/bin/swarmz reply -- "…"` and carry on with your work; the conductor cannot read your conversation, only what you reply. If the user wants this tile to be the conductor, run `~/.swarmz/bin/swarmz conductor --claim`: the user is asked to approve, and you are told the outcome as a prompt.
"#;

/// The section only the conductor is told (conductor spec §4).
pub const CONDUCTOR_SECTION: &str = r#"
You are the conductor: the one agent allowed to act on the other tiles, on every Mac, through the swarmz command. Use it when the user asks about or for the other tiles, and never read their conversations (you cannot; you would drown in them). What you know of a tile is its card, its status, what it replies, and a glance at its screen.

- `~/.swarmz/bin/swarmz fleet` lists every tile on every online Mac: title, machine, folder, status, what it needs, recap, last message. To answer "what is everyone doing", run it and summarise by machine, leading with anything that needs the user. `fleet --follow` streams changes.
- `~/.swarmz/bin/swarmz output <tile> --lines 60` shows the last lines of a tile's screen (at most 200): what it is doing right now, whether a line you sent landed, what it is asking. The hook status in `fleet` can lag; the screen does not.
- `~/.swarmz/bin/swarmz ask <tile> -- "question"` asks a tile something; its answer arrives later as a prompt starting `[<its title>]`. Ask, carry on, and read the answer when it comes; do not wait in a loop.
- `~/.swarmz/bin/swarmz send <tile> -- "instruction"` tells a tile to do something (the line is marked as coming from you). `pending <tile>` and `answer <tile> …` handle a tile's permission or question, but never answer a permission the user did not tell you to. `new`, `restart` and `close` start, restart and stop tiles.
- Add `--on <machine>` before the command for a tile on another Mac (its machine is in `fleet`).
- `~/.swarmz/bin/swarmz notify -- "text"` messages the user on Telegram, when it is set up: use it when the user asked to be told, when a tile has waited on a question for more than a few minutes, or when something failed. A prompt starting `[telegram]` came from the user's phone; reply with `notify`.
"#;

/// The conductor section as the tool ships it, with the tile's name filled in.
pub fn conductor_section(_name: &str) -> String {
    CONDUCTOR_SECTION.to_string()
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
/// when the tile is the conductor.
pub fn briefing_for(home: &Path, name: &str, is_conductor: bool) -> String {
    let mut text = common(home, name);
    if is_conductor {
        text.push_str(&conductor_section(name));
    }
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
        let text = briefing_for(&dir, "api-2", false);
        assert!(text.starts_with("You are running in a swarmz tile named \"api-2\""), "{text}");
        assert!(!text.contains("SWARMZ_BRIEFING_VERSION"));
        assert!(text.contains("swarmz reply"));
        assert!(!text.contains("You are the conductor"));
        let cond = briefing_for(&dir, "api-2", true);
        assert!(cond.contains("You are the conductor"));
        assert!(cond.contains("swarmz fleet"));
        // A user's own file wins for the common part.
        std::fs::create_dir_all(dir.join(".swarmz")).unwrap();
        std::fs::write(dir.join(".swarmz/briefing.md"), "Mine, <name>.").unwrap();
        assert_eq!(briefing_for(&dir, "x", false), "Mine, x.\n");
        assert!(briefing_for(&dir, "x", true).starts_with("Mine, x.\n\nYou are the conductor"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
