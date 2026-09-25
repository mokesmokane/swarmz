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
use std::collections::BTreeMap;
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

/// A sub-conductor (conductor tree spec §2, as amended): the conductor it answers to, and the
/// tiles that answer to it, listed by hand.
#[derive(Debug, Clone, PartialEq)]
pub struct Sub {
    pub parent: String,
    pub tiles: Vec<String>,
}

/// The sub-conductors as written, before the tree drops the ones that do not hang together.
fn raw_subs(ws: &Workspace) -> BTreeMap<String, Sub> {
    let mut out = BTreeMap::new();
    let Some(map) = ws.extra.get("conductors").and_then(|v| v.as_object()) else { return out };
    for (id, v) in map {
        let Some(parent) = v.get("parent").and_then(|p| p.as_str()) else { continue };
        let tiles: Vec<String> = v.get("tiles").and_then(|f| f.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).filter(|t| crate::paths::valid_tile_id(t)).map(str::to_string).collect()).unwrap_or_default();
        if crate::paths::valid_tile_id(id) && crate::paths::valid_tile_id(parent) {
            out.insert(id.clone(), Sub { parent: parent.to_string(), tiles });
        }
    }
    out
}

/// Who answers to whom (conductor tree spec §2): the top conductor and the sub-conductors that
/// hang together (their tile exists, their chain of parents reaches the top without a loop).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Tree {
    pub top: Option<String>,
    pub subs: BTreeMap<String, Sub>,
}

impl Tree {
    pub fn of(ws: &Workspace) -> Tree {
        let top = conductor_of(ws).filter(|t| def_of(ws, t).is_some());
        let mut subs = raw_subs(ws);
        subs.retain(|id, _| def_of(ws, id).is_some() && Some(id) != top.as_ref());
        let Some(top_id) = top.clone() else { return Tree { top: None, subs: BTreeMap::new() } };
        let reaches = |id: &str, subs: &BTreeMap<String, Sub>| -> bool {
            let mut at = id.to_string();
            for _ in 0..=subs.len() {
                match subs.get(&at) {
                    Some(s) if s.parent == top_id => return true,
                    Some(s) => at = s.parent.clone(),
                    None => return false,
                }
            }
            false
        };
        let keep: Vec<String> = subs.keys().filter(|id| reaches(id, &subs)).cloned().collect();
        subs.retain(|id, _| keep.contains(id));
        Tree { top, subs }
    }

    pub fn is_conductor(&self, id: &str) -> bool {
        self.top.as_deref() == Some(id) || self.subs.contains_key(id)
    }

    /// The conductor `tile` answers to: a sub-conductor's parent; for any other tile the
    /// sub-conductor whose list names it (the first by id, should two), else the top. None for
    /// the top itself, or when there is no top.
    pub fn owner(&self, _ws: &Workspace, tile: &str) -> Option<String> {
        let top = self.top.clone()?;
        if tile == top {
            return None;
        }
        if let Some(s) = self.subs.get(tile) {
            return Some(s.parent.clone());
        }
        Some(self.subs.iter().find(|(_, s)| s.tiles.iter().any(|t| t == tile)).map(|(id, _)| id.clone()).unwrap_or(top))
    }

    /// The conductors above `tile`, nearest first.
    pub fn ancestors(&self, ws: &Workspace, tile: &str) -> Vec<String> {
        let mut out = vec![];
        let mut at = tile.to_string();
        for _ in 0..=self.subs.len() + 1 {
            match self.owner(ws, &at) {
                Some(o) if !out.contains(&o) => {
                    out.push(o.clone());
                    at = o;
                }
                _ => break,
            }
        }
        out
    }

    /// Whether `caller` may move `tile` under `to` (spec §4): the tile answers to the caller,
    /// and `to` is a sub-conductor directly under the caller.
    pub fn may_assign(&self, ws: &Workspace, caller: &str, tile: &str, to: &str) -> bool {
        self.owner(ws, tile).as_deref() == Some(caller) && self.subs.get(to).is_some_and(|s| s.parent == caller)
    }
}

/// The tile the tool was run from: `SWARMZ_TERMINAL_ID`, set in every holder's shell. None from
/// the desktop app, the phone's gate, or a bare shell.
pub fn caller_tile() -> Option<String> {
    std::env::var("SWARMZ_TERMINAL_ID").ok().filter(|t| !t.is_empty() && crate::paths::valid_tile_id(t))
}

/// Commands that read another tile's conversation or screen: refused for every tile, the
/// conductor included (spec §2).
const READ_OTHER: &[&str] = &["transcript", "image"];
/// A screenful of another tile is the conductor's to see (spec §2, capped in `main`).
const SCREEN: &[&str] = &["output"];
/// The most lines the conductor may read of another tile's screen.
pub const SCREEN_MAX: usize = 200;
/// Commands that act on another tile: its own conductor's alone (conductor tree spec §3).
const ACT: &[&str] = &["send", "ask", "key", "answer", "pending", "close", "restart"];
/// Commands with no target tile that any conductor may run (a sub-conductor's `fleet` is
/// filtered, and a tile its `new` starts joins its list).
const CONDUCTING: &[&str] = &["fleet", "new", "on", "notify"];
/// Following the user's Telegram chat: the top conductor's Mac alone (Telegram gives one
/// follower per bot); a message to any conductor is still routed to it.
const TOP_ONLY: &[&str] = &["telegram-follow"];
/// Set, deny, clear and remove are the user's (desktop, phone) and never a tile's.
const USER_ONLY: &[&str] = &["conductor-set", "conductor-clear"];

/// Whether `caller` (a tile id, or None for the desktop and the phone) may run `sub` against
/// `target` (a tile id when the command names one), in the tree of `ws`. Only the ordinary path
/// is guarded: this is a guardrail, not a sandbox.
pub fn allowed(ws: &Workspace, caller: Option<&str>, sub: &str, target: Option<&str>) -> Result<(), CliError> {
    let Some(caller) = caller else { return Ok(()) };
    let own = target.is_some_and(|t| t == caller);
    let denied = |why: String| Err(CliError::new("denied", why));
    if USER_ONLY.contains(&sub) {
        return denied("only the user can set or clear a conductor; run `swarmz conductor --claim` to ask".into());
    }
    if own {
        return Ok(());
    }
    if READ_OTHER.contains(&sub) {
        return denied("a tile's conversation is its own; ask it with `swarmz ask` instead".into());
    }
    let tree = Tree::of(ws);
    let none_set = || -> String {
        if tree.top.is_none() { "no conductor is set; run `swarmz conductor --claim` to ask for the role".into() } else { "only a conductor acts on other tiles; run `swarmz conductor --claim` to ask for the role".into() }
    };
    if TOP_ONLY.contains(&sub) {
        return if tree.top.as_deref() == Some(caller) { Ok(()) } else if tree.is_conductor(caller) { denied("only the top conductor's Mac follows the Telegram chat".into()) } else { denied(none_set()) };
    }
    if CONDUCTING.contains(&sub) {
        return if tree.is_conductor(caller) { Ok(()) } else { denied(none_set()) };
    }
    let Some(target) = target else { return Ok(()) };
    if SCREEN.contains(&sub) {
        return if tree.ancestors(ws, target).iter().any(|a| a == caller) { Ok(()) } else if tree.is_conductor(caller) { denied(format!("{} is not under you", title_of(ws, target))) } else { denied(none_set()) };
    }
    if ACT.contains(&sub) {
        if tree.owner(ws, target).as_deref() == Some(caller) {
            return Ok(());
        }
        if !tree.is_conductor(caller) {
            return denied(none_set());
        }
        // Under us but further down: through the conductor in between.
        let chain = tree.ancestors(ws, target);
        return match chain.iter().position(|a| a == caller) {
            Some(i) if i > 0 => denied(format!("{} answers to {}; ask or tell them instead", title_of(ws, target), title_of(ws, &chain[i - 1]))),
            _ => denied(format!("{} is not under you", title_of(ws, target))),
        };
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

/// `{conductor, conductors, claim}` as `swarmz conductor` reports them: the top, the
/// sub-conductors that hang together, and a pending claim.
pub fn state(ws: &Workspace) -> Value {
    let tree = Tree::of(ws);
    let subs: serde_json::Map<String, Value> = tree.subs.iter().map(|(id, s)| (id.clone(), json!({"parent": s.parent, "tiles": s.tiles}))).collect();
    json!({"v": 1, "conductor": conductor_of(ws), "conductors": subs, "claim": claim_of(ws), "conductorAt": conductor_at(ws)})
}

/// When the conductor fields (`conductor`, `conductors`, `conductorClaim`) last changed: the
/// desktop keeps whichever copy of them is newer, whatever the whole file's revision says, so a
/// Mac saving from an older copy cannot write old roles over a new one (tree spec §7).
pub fn conductor_at(ws: &Workspace) -> Option<String> {
    ws.extra.get("conductorAt").and_then(|v| v.as_str()).map(str::to_string)
}

/// Marks a change to the conductor fields: the revision, and their own stamp.
fn touched(ws: &mut Workspace, by: &str, now: &str) {
    ws.extra.insert("conductorAt".into(), json!(now));
    bump_revision(ws, by, now);
}

/// Records a claim by `tile` (spec §3): `{tile, title, at}`, and with `sub` a claim to be a
/// sub-conductor under the conductor `tile` answers to now (tree spec §4). It replaces an older
/// claim. Claiming what the tile already is changes nothing. Returns whether the workspace
/// changed.
pub fn claim(ws: &mut Workspace, tile: &str, sub: bool, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    let tree = Tree::of(ws);
    let title = title_of(ws, tile);
    let record = if !sub {
        if tree.top.as_deref() == Some(tile) {
            return Ok(false);
        }
        json!({"tile": tile, "title": title, "at": now})
    } else {
        if tree.top.as_deref() == Some(tile) {
            return Err(CliError::new("usage", "the top conductor is above every sub-conductor already"));
        }
        if tree.subs.contains_key(tile) {
            return Ok(false);
        }
        let parent = tree.owner(ws, tile).ok_or_else(|| CliError::new("denied", "no conductor is set to answer to; claim the top role first (`swarmz conductor --claim`)"))?;
        json!({"tile": tile, "title": title, "at": now, "sub": true, "parent": parent})
    };
    ws.extra.insert("conductorClaim".into(), record);
    touched(ws, by, now);
    Ok(true)
}

/// Makes `tile` the top conductor and clears any claim, or, when the pending claim is `tile`'s
/// and asks to be a sub-conductor, makes it one. Returns whether the workspace changed.
pub fn set(ws: &mut Workspace, tile: &str, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    if let Some(c) = claim_of(ws).filter(|c| c["tile"].as_str() == Some(tile) && c["sub"] == json!(true)) {
        let parent = c["parent"].as_str().map(str::to_string).or_else(|| Tree::of(ws).owner(ws, tile)).ok_or_else(|| CliError::new("denied", "no conductor is set to answer to"))?;
        ws.extra.remove("conductorClaim");
        set_sub(ws, tile, &parent, by, now)?;
        return Ok(true);
    }
    let same = conductor_of(ws).as_deref() == Some(tile) && claim_of(ws).is_none();
    if same {
        return Ok(false);
    }
    ws.extra.insert("conductor".into(), json!(tile));
    ws.extra.remove("conductorClaim");
    // The top is nobody's sub-conductor, and in nobody's list.
    if let Some(m) = subs_mut(ws) {
        m.remove(tile);
        if m.is_empty() {
            ws.extra.remove("conductors");
        }
    }
    unlist(ws, tile);
    touched(ws, by, now);
    Ok(true)
}

fn subs_mut(ws: &mut Workspace) -> Option<&mut serde_json::Map<String, Value>> {
    ws.extra.get_mut("conductors").and_then(|v| v.as_object_mut())
}

/// Takes `tile` out of every sub-conductor's list. Returns whether any list changed.
fn unlist(ws: &mut Workspace, tile: &str) -> bool {
    let mut changed = false;
    if let Some(m) = subs_mut(ws) {
        for v in m.values_mut() {
            if let Some(a) = v.get_mut("tiles").and_then(|t| t.as_array_mut()) {
                let before = a.len();
                a.retain(|x| x.as_str() != Some(tile));
                changed |= a.len() != before;
            }
        }
    }
    changed
}

/// Makes `tile` a sub-conductor under `parent` (tree spec §4), keeping its tiles if it is one
/// already: the parent must be the top or a sub-conductor, and not `tile` or anything under it.
/// Returns whether the workspace changed.
pub fn set_sub(ws: &mut Workspace, tile: &str, parent: &str, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    let tree = Tree::of(ws);
    if tree.top.as_deref() == Some(tile) {
        return Err(CliError::new("usage", "that tile is the top conductor; clear it first"));
    }
    if !tree.is_conductor(parent) || parent == tile || tree.ancestors(ws, parent).iter().any(|a| a == tile) {
        return Err(CliError::new("usage", format!("{} cannot be its parent: the parent must be a conductor above it", title_of(ws, parent))));
    }
    if tree.subs.get(tile).is_some_and(|s| s.parent == parent) {
        return Ok(false);
    }
    let tiles = tree.subs.get(tile).map(|s| s.tiles.clone()).unwrap_or_default();
    // A conductor is placed by its parent, not by a list.
    unlist(ws, tile);
    let entry = json!({"parent": parent, "tiles": tiles});
    match subs_mut(ws) {
        Some(m) => {
            m.insert(tile.to_string(), entry);
        }
        None => {
            ws.extra.insert("conductors".into(), json!({ tile: entry }));
        }
    }
    touched(ws, by, now);
    Ok(true)
}

/// Puts `tile` under sub-conductor `to`, or back under the top when `to` is the top (tree spec
/// §4). A tile is in one list at most, so it leaves any other. Returns whether the workspace
/// changed.
pub fn assign(ws: &mut Workspace, tile: &str, to: &str, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    let tree = Tree::of(ws);
    if tree.is_conductor(tile) {
        return Err(CliError::new("usage", "a conductor is placed by its parent: use `conductor --set <tile> --parent <conductor>`"));
    }
    if tree.top.as_deref() != Some(to) && !tree.subs.contains_key(to) {
        return Err(CliError::new("usage", format!("{} is not a conductor", title_of(ws, to))));
    }
    if tree.owner(ws, tile).as_deref() == Some(to) {
        return Ok(false);
    }
    unlist(ws, tile);
    if tree.top.as_deref() != Some(to) {
        if let Some(a) = subs_mut(ws).and_then(|m| m.get_mut(to)).and_then(|v| {
            if v.get("tiles").and_then(|t| t.as_array()).is_none() {
                v["tiles"] = json!([]);
            }
            v.get_mut("tiles").and_then(|t| t.as_array_mut())
        }) {
            a.push(json!(tile));
        }
    }
    touched(ws, by, now);
    Ok(true)
}

/// Turns sub-conductor `tile` back into an ordinary tile (tree spec §4): its tiles and the
/// sub-conductors under it go to its parent. Returns whether the workspace changed.
pub fn remove_sub(ws: &mut Workspace, tile: &str, by: &str, now: &str) -> bool {
    let Some(entry) = subs_mut(ws).and_then(|m| m.remove(tile)) else { return false };
    let parent = entry.get("parent").and_then(|p| p.as_str()).unwrap_or_default().to_string();
    let tiles: Vec<Value> = entry.get("tiles").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    if let Some(m) = subs_mut(ws) {
        for v in m.values_mut() {
            if v.get("parent").and_then(|p| p.as_str()) == Some(tile) {
                v["parent"] = json!(parent);
            }
        }
        // The parent's list takes the tiles when the parent is a sub-conductor; under the top a
        // tile needs no list.
        if let Some(a) = m.get_mut(&parent).and_then(|v| v.get_mut("tiles")).and_then(|t| t.as_array_mut()) {
            a.extend(tiles);
        }
        if m.is_empty() {
            ws.extra.remove("conductors");
        }
    }
    touched(ws, by, now);
    true
}

/// Clears the conductor and any claim. Returns whether the workspace changed.
pub fn clear(ws: &mut Workspace, by: &str, now: &str) -> bool {
    let had = ws.extra.remove("conductor").is_some() | ws.extra.remove("conductorClaim").is_some();
    if had {
        touched(ws, by, now);
    }
    had
}

/// Denies a pending claim (keeps the conductor). Returns the denied claim's tile, if any.
pub fn deny(ws: &mut Workspace, by: &str, now: &str) -> Option<String> {
    let tile = claim_of(ws).and_then(|c| c.get("tile").and_then(|t| t.as_str()).map(str::to_string))?;
    ws.extra.remove("conductorClaim");
    touched(ws, by, now);
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

/// The line a new sub-conductor is told (tree spec §4).
pub fn sub_outcome_line(parent_title: &str) -> String {
    format!("[swarmz] you are now a conductor under {parent_title}: run ~/.swarmz/bin/swarmz briefing to see what you can do, and ~/.swarmz/bin/swarmz fleet to see your tiles")
}

/// The line the desktop or the tool types into a claimant once the user has decided.
pub fn outcome_line(approved: bool) -> &'static str {
    if approved {
        "[swarmz] you are the conductor now: run ~/.swarmz/bin/swarmz briefing to see what you can do, and ~/.swarmz/bin/swarmz fleet to see every tile"
    } else {
        "[swarmz] the conductor claim was denied; carry on with your own work"
    }
}

/// The ssh command that runs the tool on another Mac over the shared master (spec §2, `--on`),
/// anonymously: the local guard has decided, and `deliver`'s `send` must not be re-guarded there
/// as the replying tile.
pub fn remote_command(host: &str, args: &[String]) -> std::process::Command {
    remote_command_as(host, args, None)
}

/// [`remote_command`] with the caller's tile identity carried across (`--on`): the remote
/// shell inherits nothing, and `ask` needs to know which tile asks (its title marks the line),
/// as the remote guard needs to know who acts.
pub fn remote_command_as(host: &str, args: &[String], identity: Option<(&str, &str)>) -> std::process::Command {
    let prefix = match identity {
        Some((id, name)) => format!("SWARMZ_TERMINAL_ID={} SWARMZ_TERMINAL_NAME={} ", sh_quote(id), sh_quote(name)),
        None => String::new(),
    };
    let remote = std::iter::once(format!("{prefix}~/.swarmz/bin/swarmz")).chain(args.iter().map(|a| sh_quote(a))).collect::<Vec<_>>().join(" ");
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
        let ok = |c: Option<&str>, caller: Option<&str>, sub: &str, target: Option<&str>| allowed(&ws(c), caller, sub, target).is_ok();
        // The desktop and the phone (no tile) do anything.
        assert!(ok(None, None, "send", Some("t2")));
        assert!(ok(None, None, "conductor-set", None));
        assert!(ok(None, None, "transcript", Some("t2")));
        // A tile acts on itself.
        assert!(ok(None, Some("t2"), "send", Some("t2")));
        assert!(ok(None, Some("t2"), "transcript", Some("t2")));
        // Nobody reads another tile's conversation, the conductor included; a glance at its
        // screen is the conductor's alone.
        assert!(!ok(Some("c1"), Some("c1"), "transcript", Some("t2")));
        assert!(!ok(Some("c1"), Some("c1"), "image", Some("t2")));
        assert!(ok(Some("c1"), Some("c1"), "output", Some("t2")));
        assert!(!ok(Some("c1"), Some("t2"), "output", Some("c1")));
        assert!(ok(Some("c1"), Some("t2"), "output", Some("t2")));
        // Only the conductor acts on others, and on the fleet.
        assert!(!ok(Some("c1"), Some("t2"), "send", Some("c1")));
        assert!(!ok(None, Some("t2"), "fleet", None));
        assert!(ok(Some("c1"), Some("c1"), "send", Some("t2")));
        assert!(ok(Some("c1"), Some("c1"), "fleet", None));
        assert!(ok(Some("c1"), Some("c1"), "on", None));
        // Set and clear are never a tile's.
        assert!(!ok(Some("c1"), Some("c1"), "conductor-set", None));
        assert!(allowed(&ws(None), Some("t2"), "send", Some("c1")).unwrap_err().message.contains("--claim"));
    }

    /// top c1 → certify s1 (tiles a, r, and the stale id "gone") → desk s2 (tile b); o is in no
    /// list, so it answers to the top.
    fn tree_ws() -> Workspace {
        let def = |id: &str| TerminalDef { id: id.into(), name: id.into(), cwd: "/p".into(), ssh: None, claude: None, command: None, extra: Map::new() };
        let mut w = Workspace {
            version: 1,
            terminals: ["c1", "s1", "s2", "a", "b", "o", "r"].iter().map(|id| def(id)).collect(),
            layout: Value::Null,
            extra: Map::new(),
        };
        w.extra.insert("conductor".into(), json!("c1"));
        w.extra.insert("conductors".into(), json!({
            "s1": {"parent": "c1", "tiles": ["a", "r", "gone"]},
            "s2": {"parent": "s1", "tiles": ["b"]},
        }));
        w
    }

    #[test]
    fn owners_follow_the_lists_and_parents() {
        let w = tree_ws();
        let t = Tree::of(&w);
        assert_eq!(t.top.as_deref(), Some("c1"));
        let owner = |id: &str| t.owner(&w, id);
        assert_eq!(owner("c1"), None);
        assert_eq!(owner("s1").as_deref(), Some("c1"));
        assert_eq!(owner("s2").as_deref(), Some("s1"));
        assert_eq!(owner("a").as_deref(), Some("s1"));
        assert_eq!(owner("r").as_deref(), Some("s1"));
        assert_eq!(owner("b").as_deref(), Some("s2"));
        assert_eq!(owner("o").as_deref(), Some("c1"), "in no list: the top");
        assert_eq!(t.ancestors(&w, "b"), vec!["s2", "s1", "c1"]);
        assert_eq!(t.ancestors(&w, "c1"), Vec::<String>::new());
        assert!(t.may_assign(&w, "c1", "o", "s1"), "the top hands its own tile to its child");
        assert!(!t.may_assign(&w, "c1", "a", "s1"), "a is not the top's to move");
        assert!(!t.may_assign(&w, "c1", "o", "s2"), "s2 is not directly under the top");
        assert!(t.may_assign(&w, "s1", "a", "s2"));
    }

    #[test]
    fn loops_orphans_and_entries_without_a_top_are_ignored() {
        let mut w = tree_ws();
        w.extra.insert("conductors".into(), json!({
            "s1": {"parent": "s2", "tiles": ["a"]},
            "s2": {"parent": "s1", "tiles": ["b"]},
            "o": {"parent": "gone", "tiles": []},
            "zz": {"parent": "c1", "tiles": []},
            "r": {"parent": "c1", "tiles": ["bad id!", "a"]},
        }));
        let t = Tree::of(&w);
        assert!(!t.subs.contains_key("s1") && !t.subs.contains_key("s2"), "a loop never reaches the top");
        assert!(!t.subs.contains_key("o"), "an orphan");
        assert!(!t.subs.contains_key("zz"), "no such tile");
        assert_eq!(t.subs["r"].tiles, vec!["a".to_string()], "bad ids are dropped");
        assert_eq!(t.owner(&w, "a").as_deref(), Some("r"), "the looped entries' lists count for nothing");
        assert_eq!(t.owner(&w, "b").as_deref(), Some("c1"));
        w.extra.remove("conductor");
        assert_eq!(Tree::of(&w), Tree::default());
    }

    #[test]
    fn a_conductor_acts_on_its_children_and_glances_at_any_descendant() {
        let w = tree_ws();
        let ok = |caller: &str, sub: &str, target: Option<&str>| allowed(&w, Some(caller), sub, target);
        assert!(ok("c1", "send", Some("s1")).is_ok());
        assert!(ok("c1", "ask", Some("o")).is_ok());
        let e = ok("c1", "send", Some("a")).unwrap_err();
        assert_eq!(e.code, "denied");
        assert!(e.message.contains("answers to s1"), "{}", e.message);
        assert!(ok("c1", "send", Some("b")).unwrap_err().message.contains("answers to s1"));
        assert!(ok("c1", "output", Some("b")).is_ok());
        assert!(ok("s1", "output", Some("b")).is_ok());
        assert!(ok("s1", "send", Some("a")).is_ok());
        assert!(ok("s1", "restart", Some("s2")).is_ok());
        assert!(ok("s1", "send", Some("b")).unwrap_err().message.contains("answers to s2"));
        assert!(ok("s1", "send", Some("o")).unwrap_err().message.contains("not under you"));
        assert!(ok("s1", "send", Some("c1")).is_err());
        assert!(ok("s2", "output", Some("a")).is_err());
        assert!(ok("s1", "output", Some("o")).is_err());
        assert!(ok("c1", "transcript", Some("b")).is_err());
        assert!(ok("s1", "image", Some("a")).is_err());
        assert!(ok("s2", "fleet", None).is_ok());
        assert!(ok("s1", "new", None).is_ok());
        assert!(ok("s1", "on", None).is_ok());
        assert!(ok("a", "fleet", None).is_err());
        assert!(ok("c1", "notify", None).is_ok());
        // Any conductor may message the user (Telegram for every conductor); only the top follows the chat.
        assert!(ok("s1", "notify", None).is_ok());
        assert!(ok("s1", "telegram-follow", None).is_err());
        assert!(ok("a", "notify", None).is_err());
        assert!(ok("a", "send", Some("a")).is_ok());
        assert!(ok("a", "send", Some("o")).is_err());
        assert!(ok("s1", "conductor-set", None).is_err());
    }

    #[test]
    fn subs_are_claimed_set_assigned_and_removed() {
        let mut w = tree_ws();
        w.extra.remove("conductors");
        // A sub claim, under the claimant's conductor; approving it makes an empty sub-conductor.
        assert!(claim(&mut w, "s1", true, "mini", "t1").unwrap());
        let c = claim_of(&w).unwrap();
        assert_eq!((c["sub"].as_bool(), c["parent"].as_str()), (Some(true), Some("c1")));
        assert!(set(&mut w, "s1", "mini", "t2").unwrap());
        assert_eq!(conductor_of(&w).as_deref(), Some("c1"));
        assert!(claim_of(&w).is_none());
        assert_eq!(Tree::of(&w).subs["s1"], Sub { parent: "c1".into(), tiles: vec![] });
        assert!(!claim(&mut w, "s1", true, "mini", "t3").unwrap(), "already a sub-conductor");
        assert!(claim(&mut w, "c1", true, "mini", "t3").is_err());
        let mut none = tree_ws();
        none.extra.remove("conductor");
        assert_eq!(claim(&mut none, "a", true, "mini", "t4").unwrap_err().code, "denied");
        // Assign tiles; a tile is in one list at most; the top's id takes it back.
        assert!(assign(&mut w, "a", "s1", "mini", "t5").unwrap());
        assert!(!assign(&mut w, "a", "s1", "mini", "t6").unwrap());
        assert!(set_sub(&mut w, "s2", "s1", "mini", "t7").unwrap());
        assert!(assign(&mut w, "a", "s2", "mini", "t8").unwrap());
        let t = Tree::of(&w);
        assert_eq!((t.subs["s1"].tiles.clone(), t.subs["s2"].tiles.clone()), (vec![], vec!["a".to_string()]));
        assert!(assign(&mut w, "a", "c1", "mini", "t9").unwrap());
        assert_eq!(Tree::of(&w).owner(&w, "a").as_deref(), Some("c1"));
        assert!(assign(&mut w, "s2", "s1", "mini", "t10").is_err(), "a conductor is placed by --parent");
        assert!(assign(&mut w, "a", "o", "mini", "t10").is_err(), "not a conductor");
        // Parents: no loops, not the top, a conductor only.
        assert!(set_sub(&mut w, "s1", "s2", "mini", "t11").is_err(), "a loop");
        assert!(set_sub(&mut w, "o", "o", "mini", "t11").is_err());
        assert!(set_sub(&mut w, "o", "a", "mini", "t11").is_err());
        assert!(set_sub(&mut w, "c1", "s1", "mini", "t11").is_err(), "the top is not a sub");
        // Becoming a sub-conductor takes a tile out of any list, and keeps its own on a move.
        assign(&mut w, "o", "s1", "mini", "t12").unwrap();
        assign(&mut w, "b", "s2", "mini", "t12").unwrap();
        assert!(set_sub(&mut w, "o", "s1", "mini", "t13").unwrap());
        assert!(Tree::of(&w).subs["s1"].tiles.is_empty());
        assert!(set_sub(&mut w, "s2", "c1", "mini", "t14").unwrap());
        assert_eq!(Tree::of(&w).subs["s2"].tiles, vec!["b".to_string()]);
        // Removing one hands its tiles and sub-conductors to its parent.
        set_sub(&mut w, "s2", "s1", "mini", "t15").unwrap();
        assert!(remove_sub(&mut w, "s2", "mini", "t16"));
        assert!(!remove_sub(&mut w, "s2", "mini", "t17"));
        assert_eq!(Tree::of(&w).owner(&w, "b").as_deref(), Some("s1"));
        assert!(remove_sub(&mut w, "s1", "mini", "t18"));
        let t = Tree::of(&w);
        assert_eq!(t.owner(&w, "b").as_deref(), Some("c1"));
        assert_eq!(t.subs["o"].parent, "c1", "a child sub-conductor moves up");
        // Making a sub the top removes its entry and its listing.
        set(&mut w, "o", "mini", "t19").unwrap();
        assert_eq!(conductor_of(&w).as_deref(), Some("o"));
        assert!(w.extra.get("conductors").is_none());
        assert_eq!(state(&w)["conductors"], json!({}));
    }

    #[test]
    fn claims_are_recorded_and_resolved() {
        let mut w = ws(None);
        assert!(claim(&mut w, "t2", false, "mini", "t1").unwrap());
        assert_eq!(conductor_at(&w).as_deref(), Some("t1"), "every conductor write stamps the fields");
        assert_eq!(state(&w)["conductorAt"], "t1");
        assert_eq!(claim_of(&w).unwrap()["title"], "web");
        assert_eq!(w.extra["sync"]["revision"], 1);
        assert!(claim(&mut w, "nope", false, "mini", "t1").is_err());
        // Approve: the claim becomes the conductor.
        assert!(set(&mut w, "t2", "mini", "t2").unwrap());
        assert_eq!(conductor_of(&w).as_deref(), Some("t2"));
        assert!(claim_of(&w).is_none());
        assert!(!set(&mut w, "t2", "mini", "t3").unwrap(), "already so: nothing to write");
        // The conductor's own claim changes nothing.
        assert!(!claim(&mut w, "t2", false, "mini", "t4").unwrap());
        // A new claim, denied, keeps the conductor.
        claim(&mut w, "c1", false, "mini", "t5").unwrap();
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
        // `--on` carries the caller across, quoted, so the remote `ask` knows who asks.
        let c = remote_command_as("me@box", &["ask".into(), "t2".into(), "--".into(), "how far?".into()], Some(("c1", "the swarm's tile")));
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.last().unwrap(), "SWARMZ_TERMINAL_ID='c1' SWARMZ_TERMINAL_NAME='the swarm'\\''s tile' ~/.swarmz/bin/swarmz 'ask' 't2' '--' 'how far?'");
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
