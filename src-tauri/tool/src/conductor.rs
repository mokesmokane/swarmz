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

/// A sub-conductor (conductor tree spec §2): the conductor it answers to, and the folder
/// prefixes whose tiles answer to it.
#[derive(Debug, Clone, PartialEq)]
pub struct Sub {
    pub parent: String,
    pub folders: Vec<String>,
}

/// A folder prefix as stored and compared: trimmed, no trailing `/` (except the root itself).
/// It is a string prefix, so `…/projects/certifyip` covers `certifyip_services` and
/// `certifyip-desktop`.
pub fn norm_folder(f: &str) -> String {
    let t = f.trim();
    if t.len() > 1 { t.trim_end_matches('/').to_string() } else { t.to_string() }
}

/// A folder a scope may name: absolute or `~/…`, no control characters.
pub fn valid_folder(f: &str) -> bool {
    let t = f.trim();
    (t.starts_with('/') || t.starts_with("~/")) && t.len() <= 1024 && !t.chars().any(|c| c.is_control())
}

/// The sub-conductors as written, before the tree drops the ones that do not hang together.
fn raw_subs(ws: &Workspace) -> BTreeMap<String, Sub> {
    let mut out = BTreeMap::new();
    let Some(map) = ws.extra.get("conductors").and_then(|v| v.as_object()) else { return out };
    for (id, v) in map {
        let Some(parent) = v.get("parent").and_then(|p| p.as_str()) else { continue };
        let folders: Vec<String> = v.get("folders").and_then(|f| f.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).filter(|f| valid_folder(f)).map(norm_folder).collect()).unwrap_or_default();
        if crate::paths::valid_tile_id(id) && crate::paths::valid_tile_id(parent) {
            out.insert(id.clone(), Sub { parent: parent.to_string(), folders });
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
        // Keep only the entries whose parents lead to the top within as many steps as there are
        // entries; anything else is an orphan or a loop.
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
    /// sub-conductor whose folder prefix matches its folder longest, else the top. None for the
    /// top itself, or when there is no top.
    pub fn owner(&self, ws: &Workspace, tile: &str) -> Option<String> {
        let top = self.top.clone()?;
        if tile == top {
            return None;
        }
        if let Some(s) = self.subs.get(tile) {
            return Some(s.parent.clone());
        }
        let folder = def_of(ws, tile).map(tile_folder);
        let best = folder.and_then(|f| {
            self.subs
                .iter()
                .flat_map(|(id, s)| s.folders.iter().map(move |p| (id, p)))
                .filter(|(_, p)| f.starts_with(p.as_str()))
                .max_by_key(|(_, p)| p.len())
                .map(|(id, _)| id.clone())
        });
        Some(best.unwrap_or(top))
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

    /// Whether a sub-conductor may start a tile in `folder` (spec §3: inside its scope); the
    /// top may start one anywhere.
    pub fn may_create_in(&self, caller: &str, folder: &str) -> bool {
        if self.top.as_deref() == Some(caller) {
            return true;
        }
        let f = norm_folder(folder);
        self.subs.get(caller).is_some_and(|s| s.folders.iter().any(|p| f.starts_with(p.as_str())))
    }
}

/// The folder a tile's scope is decided by: the ssh folder for an ssh tile, else its cwd.
pub fn tile_folder(def: &TerminalDef) -> String {
    let f = def.ssh.as_ref().and_then(|s| s.cwd.clone()).filter(|c| !c.trim().is_empty()).unwrap_or_else(|| def.cwd.clone());
    norm_folder(&f)
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
/// filtered, its `new` held to its scope by the caller).
const CONDUCTING: &[&str] = &["fleet", "new", "on"];
/// The user's channel: the top conductor's alone.
const TOP_ONLY: &[&str] = &["notify", "telegram-follow"];
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
        return if tree.top.as_deref() == Some(caller) { Ok(()) } else if tree.is_conductor(caller) { denied("only the top conductor talks to the user; raise it with your parent through `swarmz reply`".into()) } else { denied(none_set()) };
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
    let subs: serde_json::Map<String, Value> = tree.subs.iter().map(|(id, s)| (id.clone(), json!({"parent": s.parent, "folders": s.folders}))).collect();
    json!({"v": 1, "conductor": conductor_of(ws), "conductors": subs, "claim": claim_of(ws)})
}

/// Records a claim by `tile` (spec §3): `{tile, title, at}`, and with `folders` a claim to be a
/// sub-conductor for them under the conductor `tile` answers to now (tree spec §4). It replaces
/// an older claim. Claiming what the tile already is changes nothing. Returns whether the
/// workspace changed.
pub fn claim(ws: &mut Workspace, tile: &str, folders: &[String], by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    let tree = Tree::of(ws);
    let title = title_of(ws, tile);
    let record = if folders.is_empty() {
        if tree.top.as_deref() == Some(tile) {
            return Ok(false);
        }
        json!({"tile": tile, "title": title, "at": now})
    } else {
        if let Some(bad) = folders.iter().find(|f| !valid_folder(f)) {
            return Err(CliError::new("usage", format!("{bad:?} is not an absolute folder")));
        }
        if tree.top.as_deref() == Some(tile) {
            return Err(CliError::new("usage", "the top conductor already covers every folder"));
        }
        let parent = tree.owner(ws, tile).ok_or_else(|| CliError::new("denied", "no conductor is set to answer to; claim the top role first (`swarmz conductor --claim`)"))?;
        let folders: Vec<String> = folders.iter().map(|f| norm_folder(f)).collect();
        if tree.subs.get(tile).is_some_and(|s| s.parent == parent && s.folders == folders) {
            return Ok(false);
        }
        json!({"tile": tile, "title": title, "at": now, "folders": folders, "parent": parent})
    };
    ws.extra.insert("conductorClaim".into(), record);
    bump_revision(ws, by, now);
    Ok(true)
}

/// Makes `tile` the top conductor and clears any claim, or, when the pending claim is `tile`'s
/// and names folders, makes it the sub-conductor it asked to be. Returns whether the workspace
/// changed.
pub fn set(ws: &mut Workspace, tile: &str, by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    if let Some(c) = claim_of(ws).filter(|c| c["tile"].as_str() == Some(tile) && c["folders"].is_array()) {
        let folders: Vec<String> = c["folders"].as_array().unwrap().iter().filter_map(|f| f.as_str().map(str::to_string)).collect();
        let parent = c["parent"].as_str().map(str::to_string).or_else(|| Tree::of(ws).owner(ws, tile)).ok_or_else(|| CliError::new("denied", "no conductor is set to answer to"))?;
        ws.extra.remove("conductorClaim");
        set_sub(ws, tile, &parent, &folders, by, now)?;
        return Ok(true);
    }
    let same = conductor_of(ws).as_deref() == Some(tile) && claim_of(ws).is_none();
    if same {
        return Ok(false);
    }
    ws.extra.insert("conductor".into(), json!(tile));
    ws.extra.remove("conductorClaim");
    // The top is nobody's sub-conductor.
    if let Some(m) = ws.extra.get_mut("conductors").and_then(|v| v.as_object_mut()) {
        m.remove(tile);
    }
    bump_revision(ws, by, now);
    Ok(true)
}

/// Makes `tile` a sub-conductor for `folders` under `parent` (tree spec §4): the parent must be
/// the top or a sub-conductor, and not `tile` or anything under it. Returns whether the
/// workspace changed.
pub fn set_sub(ws: &mut Workspace, tile: &str, parent: &str, folders: &[String], by: &str, now: &str) -> Result<bool, CliError> {
    if def_of(ws, tile).is_none() {
        return Err(CliError::new("unknown_tile", format!("no tile {tile} in the workspace")));
    }
    if folders.is_empty() {
        return Err(CliError::new("usage", "a sub-conductor needs at least one --folder"));
    }
    if let Some(bad) = folders.iter().find(|f| !valid_folder(f)) {
        return Err(CliError::new("usage", format!("{bad:?} is not an absolute folder")));
    }
    let tree = Tree::of(ws);
    if tree.top.as_deref() == Some(tile) {
        return Err(CliError::new("usage", "that tile is the top conductor; clear it first"));
    }
    if !tree.is_conductor(parent) || parent == tile || tree.ancestors(ws, parent).iter().any(|a| a == tile) {
        return Err(CliError::new("usage", format!("{} cannot be its parent: the parent must be a conductor above it", title_of(ws, parent))));
    }
    let folders: Vec<String> = folders.iter().map(|f| norm_folder(f)).collect();
    if tree.subs.get(tile).is_some_and(|s| s.parent == parent && s.folders == folders) {
        return Ok(false);
    }
    let entry = json!({"parent": parent, "folders": folders});
    match ws.extra.get_mut("conductors").and_then(|v| v.as_object_mut()) {
        Some(m) => {
            m.insert(tile.to_string(), entry);
        }
        None => {
            ws.extra.insert("conductors".into(), json!({ tile: entry }));
        }
    }
    bump_revision(ws, by, now);
    Ok(true)
}

/// Turns sub-conductor `tile` back into an ordinary tile; its tiles go back to its parent.
/// Returns whether the workspace changed.
pub fn remove_sub(ws: &mut Workspace, tile: &str, by: &str, now: &str) -> bool {
    let removed = ws.extra.get_mut("conductors").and_then(|v| v.as_object_mut()).is_some_and(|m| m.remove(tile).is_some());
    if removed {
        if ws.extra.get("conductors").and_then(|v| v.as_object()).is_some_and(|m| m.is_empty()) {
            ws.extra.remove("conductors");
        }
        bump_revision(ws, by, now);
    }
    removed
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

/// The line a new sub-conductor is told (tree spec §4).
pub fn sub_outcome_line(parent_title: &str, folders: &[String]) -> String {
    format!(
        "[swarmz] you are now the conductor for {} under {parent_title}: run ~/.swarmz/bin/swarmz briefing to see what you can do, and ~/.swarmz/bin/swarmz fleet to see your tiles",
        folders.join(", ")
    )
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

    /// top (c1 at /p) → certify (s1 at /p/certifyip_services/a, folders /p/certifyip) → desk
    /// (s2 at /p/certifyip-desktop, folders /p/certifyip-desktop); ordinary tiles a (in
    /// certifyip_services), b (in certifyip-desktop), o (elsewhere), r (an ssh tile whose remote
    /// folder is in certifyip).
    fn tree_ws() -> Workspace {
        let def = |id: &str, cwd: &str| TerminalDef { id: id.into(), name: id.into(), cwd: cwd.into(), ssh: None, claude: None, command: None, extra: Map::new() };
        let mut r = def("r", "/Users/me");
        r.ssh = Some(serde_json::from_value(json!({"host": "me@box", "cwd": "/p/certifyip_services/b/"})).unwrap());
        let mut w = Workspace {
            version: 1,
            terminals: vec![def("c1", "/p"), def("s1", "/p/certifyip_services/a"), def("s2", "/p/certifyip-desktop"), def("a", "/p/certifyip_services/a"), def("b", "/p/certifyip-desktop/src"), def("o", "/q"), r],
            layout: Value::Null,
            extra: Map::new(),
        };
        w.extra.insert("conductor".into(), json!("c1"));
        w.extra.insert("conductors".into(), json!({
            "s1": {"parent": "c1", "folders": ["/p/certifyip/"]},
            "s2": {"parent": "s1", "folders": ["/p/certifyip-desktop"]},
        }));
        w
    }

    #[test]
    fn owners_follow_the_longest_folder_prefix_and_parents() {
        let w = tree_ws();
        let t = Tree::of(&w);
        assert_eq!(t.top.as_deref(), Some("c1"));
        assert_eq!(t.subs["s1"].folders, vec!["/p/certifyip".to_string()]);
        let owner = |id: &str| t.owner(&w, id);
        assert_eq!(owner("c1"), None);
        assert_eq!(owner("s1").as_deref(), Some("c1"), "a sub answers to its parent, whatever its folder");
        assert_eq!(owner("s2").as_deref(), Some("s1"));
        assert_eq!(owner("a").as_deref(), Some("s1"), "certifyip_services is under the string prefix certifyip");
        assert_eq!(owner("b").as_deref(), Some("s2"), "the longest prefix wins");
        assert_eq!(owner("o").as_deref(), Some("c1"), "no scope: the top");
        assert_eq!(owner("r").as_deref(), Some("s1"), "an ssh tile's remote folder decides");
        assert_eq!(t.ancestors(&w, "b"), vec!["s2", "s1", "c1"]);
        assert_eq!(t.ancestors(&w, "c1"), Vec::<String>::new());
        assert!(t.may_create_in("s1", "/p/certifyip_x/new"));
        assert!(!t.may_create_in("s1", "/q/new"));
        assert!(t.may_create_in("c1", "/anywhere"));
        assert!(!t.may_create_in("a", "/p/certifyip"));
    }

    #[test]
    fn loops_orphans_and_entries_without_a_top_are_ignored() {
        let mut w = tree_ws();
        w.extra.insert("conductors".into(), json!({
            "s1": {"parent": "s2", "folders": ["/p/certifyip"]},
            "s2": {"parent": "s1", "folders": ["/p/certifyip-desktop"]},
            "a": {"parent": "gone", "folders": ["/p/x"]},
            "zz": {"parent": "c1", "folders": ["/p/y"]},
            "o": {"parent": "c1", "folders": ["relative/not/allowed"]},
        }));
        let t = Tree::of(&w);
        assert!(!t.subs.contains_key("s1") && !t.subs.contains_key("s2"), "a loop never reaches the top");
        assert!(!t.subs.contains_key("a"), "an orphan");
        assert!(!t.subs.contains_key("zz"), "no such tile");
        assert_eq!(t.subs["o"].folders, Vec::<String>::new(), "bad folders are dropped, the entry stays");
        assert_eq!(t.owner(&w, "b").as_deref(), Some("c1"));
        w.extra.remove("conductor");
        assert_eq!(Tree::of(&w), Tree::default());
    }

    #[test]
    fn a_conductor_acts_on_its_children_and_glances_at_any_descendant() {
        let w = tree_ws();
        let ok = |caller: &str, sub: &str, target: Option<&str>| allowed(&w, Some(caller), sub, target);
        // The top acts on its children (a sub-conductor, a tile outside every scope) ...
        assert!(ok("c1", "send", Some("s1")).is_ok());
        assert!(ok("c1", "ask", Some("o")).is_ok());
        // ... not on a grandchild, and is told whom to go through.
        let e = ok("c1", "send", Some("a")).unwrap_err();
        assert_eq!(e.code, "denied");
        assert!(e.message.contains("answers to s1"), "{}", e.message);
        assert!(ok("c1", "send", Some("b")).unwrap_err().message.contains("answers to s1"));
        // A glance reaches every depth.
        assert!(ok("c1", "output", Some("b")).is_ok());
        assert!(ok("s1", "output", Some("b")).is_ok());
        // A sub-conductor acts on its own tiles and its sub-conductor, not on its parent or a
        // sibling area, and glances only below itself.
        assert!(ok("s1", "send", Some("a")).is_ok());
        assert!(ok("s1", "restart", Some("s2")).is_ok());
        assert!(ok("s1", "send", Some("b")).unwrap_err().message.contains("answers to s2"));
        assert!(ok("s1", "send", Some("o")).unwrap_err().message.contains("not under you"));
        assert!(ok("s1", "send", Some("c1")).is_err());
        assert!(ok("s2", "output", Some("a")).is_err());
        assert!(ok("s1", "output", Some("o")).is_err());
        // Conversations stay closed at every level.
        assert!(ok("c1", "transcript", Some("b")).is_err());
        assert!(ok("s1", "image", Some("a")).is_err());
        // Any conductor may run the fleet, start tiles and reach another Mac; only the top
        // talks to the user.
        assert!(ok("s2", "fleet", None).is_ok());
        assert!(ok("s1", "new", None).is_ok());
        assert!(ok("s1", "on", None).is_ok());
        assert!(ok("a", "fleet", None).is_err());
        assert!(ok("c1", "notify", None).is_ok());
        assert!(ok("s1", "notify", None).unwrap_err().message.contains("swarmz reply"));
        assert!(ok("s1", "telegram-follow", None).is_err());
        // An ordinary tile under a sub-conductor still acts on itself only.
        assert!(ok("a", "send", Some("a")).is_ok());
        assert!(ok("a", "send", Some("o")).is_err());
        assert!(ok("s1", "conductor-set", None).is_err());
    }

    #[test]
    fn a_folder_claim_becomes_a_sub_conductor_under_the_claimants_conductor() {
        let mut w = tree_ws();
        w.extra.remove("conductors");
        let folders = vec!["/p/certifyip/".to_string()];
        assert!(claim(&mut w, "a", &folders, "mini", "t1").unwrap());
        let c = claim_of(&w).unwrap();
        assert_eq!((c["parent"].as_str(), c["folders"][0].as_str()), (Some("c1"), Some("/p/certifyip")));
        // Approving it (the desktop's `--set <tile>`) makes the sub-conductor, not a new top.
        assert!(set(&mut w, "a", "mini", "t2").unwrap());
        assert_eq!(conductor_of(&w).as_deref(), Some("c1"));
        assert!(claim_of(&w).is_none());
        let t = Tree::of(&w);
        assert_eq!(t.subs["a"], Sub { parent: "c1".into(), folders: vec!["/p/certifyip".into()] });
        assert_eq!(t.owner(&w, "s1").as_deref(), Some("a"), "s1 is now an ordinary tile in a's scope");
        // The same claim again changes nothing; a bad folder or no top is refused.
        assert!(!claim(&mut w, "a", &folders, "mini", "t3").unwrap());
        assert!(claim(&mut w, "o", &["rel".to_string()], "mini", "t4").is_err());
        assert!(claim(&mut w, "c1", &folders, "mini", "t4").is_err());
        let mut none = tree_ws();
        none.extra.remove("conductor");
        assert_eq!(claim(&mut none, "a", &folders, "mini", "t5").unwrap_err().code, "denied");
        // Set directly, with a parent below the top; a parent under the tile itself is refused.
        assert!(set_sub(&mut w, "b", "a", &["/p/certifyip-desktop".to_string()], "mini", "t6").unwrap());
        assert_eq!(Tree::of(&w).owner(&w, "b").as_deref(), Some("a"));
        assert!(set_sub(&mut w, "a", "b", &folders, "mini", "t7").is_err(), "a loop");
        assert!(set_sub(&mut w, "o", "o", &folders, "mini", "t7").is_err());
        assert!(set_sub(&mut w, "o", "c1", &[], "mini", "t7").is_err());
        assert!(set_sub(&mut w, "c1", "a", &folders, "mini", "t7").is_err(), "the top is not a sub");
        // Removing a sub-conductor hands its tiles back to its parent.
        assert!(remove_sub(&mut w, "a", "mini", "t8"));
        assert!(!remove_sub(&mut w, "a", "mini", "t9"));
        assert!(!Tree::of(&w).subs.contains_key("b"), "b's parent is gone, so b drops out too");
        // Making a sub the top removes its sub entry.
        set_sub(&mut w, "b", "c1", &["/p/certifyip-desktop".to_string()], "mini", "t10").unwrap();
        set(&mut w, "b", "mini", "t11").unwrap();
        assert_eq!(conductor_of(&w).as_deref(), Some("b"));
        assert!(w.extra["conductors"].get("b").is_none());
        assert_eq!(state(&w)["conductors"], json!({}));
    }

    #[test]
    fn claims_are_recorded_and_resolved() {
        let mut w = ws(None);
        assert!(claim(&mut w, "t2", &[], "mini", "t1").unwrap());
        assert_eq!(claim_of(&w).unwrap()["title"], "web");
        assert_eq!(w.extra["sync"]["revision"], 1);
        assert!(claim(&mut w, "nope", &[], "mini", "t1").is_err());
        // Approve: the claim becomes the conductor.
        assert!(set(&mut w, "t2", "mini", "t2").unwrap());
        assert_eq!(conductor_of(&w).as_deref(), Some("t2"));
        assert!(claim_of(&w).is_none());
        assert!(!set(&mut w, "t2", "mini", "t3").unwrap(), "already so: nothing to write");
        // The conductor's own claim changes nothing.
        assert!(!claim(&mut w, "t2", &[], "mini", "t4").unwrap());
        // A new claim, denied, keeps the conductor.
        claim(&mut w, "c1", &[], "mini", "t5").unwrap();
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
