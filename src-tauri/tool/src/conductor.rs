//! The conductor (conductor spec §2–§3): the one tile allowed to act on the others. Who it is
//! lives in the shared workspace (`conductor`, and a pending `conductorClaim`); the guard here
//! is what every cross-tile command checks; `ask`/`reply` carry short questions and answers
//! between the conductor and a tile as typed prompts; `fleet` is `ls` across every Mac.

use crate::hold::CliError;
use crate::newtile::bump_revision;
use crate::phone::machine_hosts;
use crate::proc::run_with_timeout;
use crate::util::sh_quote;
use crate::workspace::{TerminalDef, Workspace};
use serde_json::{json, Value};
use std::time::Duration;

/// The most characters a `reply` carries into the conductor.
pub const REPLY_MAX: usize = 1000;
/// The most characters `fleet` keeps of a recap or last message.
pub const FLEET_TEXT_MAX: usize = 280;

pub fn conductor_of(ws: &Workspace) -> Option<String> {
    ws.extra.get("conductor").and_then(|v| v.as_str()).filter(|s| crate::paths::valid_tile_id(s)).map(str::to_string)
}

pub fn claim_of(ws: &Workspace) -> Option<Value> {
    ws.extra.get("conductorClaim").filter(|v| v.is_object()).cloned()
}

/// The tile the tool was run from: `SWARMZ_TERMINAL_ID`, set in every holder's shell. None from
/// the desktop app, the phone's gate, or a bare shell.
pub fn caller_tile() -> Option<String> {
    std::env::var("SWARMZ_TERMINAL_ID").ok().filter(|t| !t.is_empty() && crate::paths::valid_tile_id(t))
}

/// Commands that read another tile's conversation or screen: refused for every tile, the
/// conductor included (spec §2).
const READ_OTHER: &[&str] = &["transcript", "output", "image"];
/// Commands that act on another tile, or on the fleet: the conductor's alone (spec §3).
const CROSS: &[&str] = &["send", "ask", "key", "answer", "pending", "close", "restart", "new", "fleet", "notify", "on"];
/// Set and clear are the user's (desktop, phone) and never a tile's.
const USER_ONLY: &[&str] = &["conductor-set", "conductor-clear"];

/// Whether `caller` (a tile id, or None for the desktop and the phone) may run `sub` against
/// `target` (a tile id when the command names one). Only the ordinary path is guarded: this is a
/// guardrail, not a sandbox.
pub fn allowed(conductor: Option<&str>, caller: Option<&str>, sub: &str, target: Option<&str>) -> Result<(), CliError> {
    let Some(caller) = caller else { return Ok(()) };
    let own = target.is_some_and(|t| t == caller);
    let denied = |why: &str| Err(CliError::new("denied", why.to_string()));
    if USER_ONLY.contains(&sub) {
        return denied("only the user can set or clear the conductor; run `swarmz conductor --claim` to ask");
    }
    if READ_OTHER.contains(&sub) && !own {
        return denied("a tile's conversation and screen are its own; ask it with `swarmz ask` instead");
    }
    if CROSS.contains(&sub) && !own && conductor != Some(caller) {
        return denied(match conductor {
            Some(_) => "only the conductor acts on other tiles; run `swarmz conductor --claim` to ask for the role",
            None => "no conductor is set; run `swarmz conductor --claim` to ask for the role",
        });
    }
    Ok(())
}

/// A tile's title for prompts: its card's title, else its name, else its id.
pub fn title_of(ws: &Workspace, tile: &str) -> String {
    ws.terminals
        .iter()
        .find(|d| d.id == tile)
        .map(|d| crate::card::read(&d.extra).and_then(|c| c.get("title").and_then(|t| t.as_str()).map(str::to_string)).unwrap_or_else(|| d.name.clone()))
        .unwrap_or_else(|| tile.to_string())
}

pub fn def_of<'a>(ws: &'a Workspace, tile: &str) -> Option<&'a TerminalDef> {
    ws.terminals.iter().find(|d| d.id == tile)
}

/// `{conductor, claim}` as `swarmz conductor` reports them.
pub fn state(ws: &Workspace) -> Value {
    json!({"v": 1, "conductor": conductor_of(ws), "claim": claim_of(ws)})
}

/// Records a claim by `tile` (spec §3): `{tile, title, at}`, replacing an older one. A claim by
/// the conductor is a no-op. Returns whether the workspace changed.
pub fn claim(ws: &mut Workspace, tile: &str, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    if conductor_of(ws).as_deref() == Some(tile) {
        return Ok(false);
    }
    let title = title_of(ws, tile);
    ws.extra.insert("conductorClaim".into(), json!({"tile": tile, "title": title, "at": now}));
    bump_revision(ws, by, now);
    Ok(true)
}

/// Makes `tile` the conductor and clears any claim. Returns whether the workspace changed.
pub fn set(ws: &mut Workspace, tile: &str, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    let same = conductor_of(ws).as_deref() == Some(tile) && claim_of(ws).is_none();
    if same {
        return Ok(false);
    }
    ws.extra.insert("conductor".into(), json!(tile));
    ws.extra.remove("conductorClaim");
    bump_revision(ws, by, now);
    Ok(true)
}

/// Clears the conductor and any claim. Returns whether the workspace changed.
pub fn clear(ws: &mut Workspace, by: &str, now: &str) -> bool {
    let had = ws.extra.remove("conductor").is_some() | ws.extra.remove("conductorClaim").is_some();
    if had {
        bump_revision(ws, by, now);
    }
    had
}

/// Denies a pending claim (keeps the conductor). Returns the denied claim's tile, if any.
pub fn deny(ws: &mut Workspace, by: &str, now: &str) -> Option<String> {
    let tile = claim_of(ws).and_then(|c| c.get("tile").and_then(|t| t.as_str()).map(str::to_string))?;
    ws.extra.remove("conductorClaim");
    bump_revision(ws, by, now);
    Some(tile)
}

/// The line `ask` types into a tile (spec §2): who is asking, the question, how to answer.
pub fn ask_line(conductor_title: &str, question: &str) -> String {
    // ASCII only: a plain shell's line editing scrambles wide characters in a pasted line.
    format!("[conductor {conductor_title}] {} (answer with: ~/.swarmz/bin/swarmz reply -- \"...\")", question.trim())
}

/// The line `reply` types into the conductor: the replying tile's title, then the text, cut.
pub fn reply_line(tile_title: &str, text: &str) -> String {
    let body: String = text.trim().chars().take(REPLY_MAX).collect();
    format!("[{tile_title}] {body}")
}

/// The line the desktop or the tool types into a claimant once the user has decided.
pub fn outcome_line(approved: bool) -> &'static str {
    if approved {
        "[swarmz] you are the conductor now: run ~/.swarmz/bin/swarmz briefing to see what you can do, and ~/.swarmz/bin/swarmz fleet to see every tile"
    } else {
        "[swarmz] the conductor claim was denied; carry on with your own work"
    }
}

/// The ssh command that runs the tool on another Mac over the shared master (spec §2, `--on`).
pub fn remote_command(host: &str, args: &[String]) -> std::process::Command {
    let remote = std::iter::once("~/.swarmz/bin/swarmz".to_string()).chain(args.iter().map(|a| sh_quote(a))).collect::<Vec<_>>().join(" ");
    let mut c = std::process::Command::new("ssh");
    c.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ControlPath=~/.swarmz/ssh/%C", "-o", "ControlMaster=auto", "-o", "ControlPersist=10m", "--", host, &remote]);
    c
}

/// The ssh destination for `machine`, from the workspace's machine entries and the default user.
pub fn host_for(ws: &Workspace, self_machine: Option<&str>, default_user: &str, machine: &str) -> Option<String> {
    machine_hosts(ws, self_machine, default_user, &[machine.to_string()]).into_iter().find(|(m, _)| m == machine).map(|(_, h)| h)
}

fn cut(v: &mut Value, key: &str) {
    if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
        if s.chars().count() > FLEET_TEXT_MAX {
            let short: String = s.chars().take(FLEET_TEXT_MAX).collect();
            v[key] = json!(short);
        }
    }
}

/// `fleet` (spec §2): this Mac's rows plus every reachable Mac's, each row's long texts cut,
/// and which Macs answered.
pub fn fleet(local: Vec<Value>, hosts: &[(String, String)], timeout: Duration) -> Value {
    let handles: Vec<_> = hosts
        .iter()
        .cloned()
        .map(|(machine, host)| {
            std::thread::spawn(move || {
                let c = remote_command(&host, &["ls".to_string()]);
                match run_with_timeout(c, timeout, "ssh") {
                    Ok(done) if done.status.success() => match serde_json::from_str::<Value>(done.stdout.trim()) {
                        Ok(v) => (machine, Ok(v["tiles"].as_array().cloned().unwrap_or_default())),
                        Err(e) => (machine, Err(format!("bad reply: {e}"))),
                    },
                    Ok(done) => (machine, Err(crate::util::last_non_blank(&done.stderr).unwrap_or_else(|| format!("ssh exited with {:?}", done.status.code())))),
                    Err(e) => (machine, Err(e)),
                }
            })
        })
        .collect();
    let mut tiles: Vec<Value> = local;
    let mut machines: Vec<Value> = vec![];
    for h in handles {
        match h.join() {
            Ok((machine, Ok(rows))) => {
                machines.push(json!({"machine": machine, "ok": true}));
                for mut r in rows {
                    r["machine"] = json!(machine);
                    tiles.push(r);
                }
            }
            Ok((machine, Err(e))) => machines.push(json!({"machine": machine, "ok": false, "error": e})),
            Err(_) => machines.push(json!({"ok": false, "error": "the ssh thread panicked"})),
        }
    }
    for t in &mut tiles {
        cut(t, "recap");
        cut(t, "lastMessage");
    }
    json!({"v": 1, "tiles": tiles, "machines": machines})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn ws(conductor: Option<&str>) -> Workspace {
        let def = |id: &str, name: &str| TerminalDef { id: id.into(), name: name.into(), cwd: "/p".into(), ssh: None, claude: None, command: None, extra: Map::new() };
        let mut w = Workspace { version: 1, terminals: vec![def("c1", "api"), def("t2", "web")], layout: Value::Null, extra: Map::new() };
        if let Some(c) = conductor {
            w.extra.insert("conductor".into(), json!(c));
        }
        w
    }

    #[test]
    fn the_guard_lets_the_user_through_and_holds_tiles_to_their_own() {
        let ok = |c: Option<&str>, caller: Option<&str>, sub: &str, target: Option<&str>| allowed(c, caller, sub, target).is_ok();
        // The desktop and the phone (no tile) do anything.
        assert!(ok(None, None, "send", Some("t2")));
        assert!(ok(None, None, "conductor-set", None));
        assert!(ok(None, None, "transcript", Some("t2")));
        // A tile acts on itself.
        assert!(ok(None, Some("t2"), "send", Some("t2")));
        assert!(ok(None, Some("t2"), "transcript", Some("t2")));
        // Nobody reads another tile's conversation, the conductor included.
        assert!(!ok(Some("c1"), Some("c1"), "transcript", Some("t2")));
        assert!(!ok(Some("c1"), Some("c1"), "output", Some("t2")));
        // Only the conductor acts on others, and on the fleet.
        assert!(!ok(Some("c1"), Some("t2"), "send", Some("c1")));
        assert!(!ok(None, Some("t2"), "fleet", None));
        assert!(ok(Some("c1"), Some("c1"), "send", Some("t2")));
        assert!(ok(Some("c1"), Some("c1"), "fleet", None));
        assert!(ok(Some("c1"), Some("c1"), "on", None));
        // Set and clear are never a tile's.
        assert!(!ok(Some("c1"), Some("c1"), "conductor-set", None));
        assert!(allowed(None, Some("t2"), "send", Some("c1")).unwrap_err().message.contains("--claim"));
    }

    #[test]
    fn claims_are_recorded_and_resolved() {
        let mut w = ws(None);
        assert!(claim(&mut w, "t2", "mini", "t1").unwrap());
        assert_eq!(claim_of(&w).unwrap()["title"], "web");
        assert_eq!(w.extra["sync"]["revision"], 1);
        assert!(claim(&mut w, "nope", "mini", "t1").is_err());
        // Approve: the claim becomes the conductor.
        assert!(set(&mut w, "t2", "mini", "t2").unwrap());
        assert_eq!(conductor_of(&w).as_deref(), Some("t2"));
        assert!(claim_of(&w).is_none());
        assert!(!set(&mut w, "t2", "mini", "t3").unwrap(), "already so: nothing to write");
        // The conductor's own claim changes nothing.
        assert!(!claim(&mut w, "t2", "mini", "t4").unwrap());
        // A new claim, denied, keeps the conductor.
        claim(&mut w, "c1", "mini", "t5").unwrap();
        assert_eq!(deny(&mut w, "mini", "t6").as_deref(), Some("c1"));
        assert_eq!(conductor_of(&w).as_deref(), Some("t2"));
        assert!(clear(&mut w, "mini", "t7"));
        assert!(conductor_of(&w).is_none());
        assert!(!clear(&mut w, "mini", "t8"));
        assert_eq!(state(&w)["conductor"], Value::Null);
    }

    #[test]
    fn lines_carry_who_and_what() {
        assert_eq!(ask_line("Ops", " is the load test done? "), "[conductor Ops] is the load test done? (answer with: ~/.swarmz/bin/swarmz reply -- \"...\")");
        assert_eq!(reply_line("certifyIP", "yes, 2 min ago"), "[certifyIP] yes, 2 min ago");
        assert_eq!(reply_line("x", &"a".repeat(2000)).chars().count(), REPLY_MAX + 4);
        assert!(outcome_line(true).contains("you are the conductor"));
        let w = ws(None);
        assert_eq!(title_of(&w, "t2"), "web");
        assert_eq!(title_of(&w, "zz"), "zz");
    }

    #[test]
    fn the_remote_command_quotes_every_word() {
        let c = remote_command("me@box", &["send".into(), "t2".into(), "--".into(), "it's done".into()]);
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.last().unwrap(), "~/.swarmz/bin/swarmz 'send' 't2' '--' 'it'\\''s done'");
        assert_eq!(args[args.len() - 2], "me@box");
    }

    #[test]
    fn fleet_merges_local_rows_and_cuts_long_texts() {
        let long = "r".repeat(500);
        let v = fleet(vec![json!({"id": "a", "recap": long, "lastMessage": "short"})], &[], Duration::from_secs(1));
        assert_eq!(v["tiles"][0]["recap"].as_str().unwrap().chars().count(), FLEET_TEXT_MAX);
        assert_eq!(v["tiles"][0]["lastMessage"], "short");
        assert_eq!(v["machines"].as_array().unwrap().len(), 0);
    }
}
