use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use swarmz_tool::attach::attach;
use swarmz_tool::client::HolderClient;
use swarmz_tool::commands as cmd;
use swarmz_tool::hold::{hold, holder_program, CliError, HoldRequest};
use swarmz_tool::paths::{build_id, home_dir, live_session, session_paths, sessions_dir};
use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};
use swarmz_tool::server::{run_holder, HolderConfig, TOOL_VIEWER, VIEWER_QUEUE_CAP};

/// How long `close` waits for the session to end: above the holder's 3 s SIGHUP-to-SIGKILL grace.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

/// Variables that describe the connection or process that started the holder -- an ssh session
/// usually long gone by the time the shell uses them, or the Claude Code session this tool was
/// run from -- never the shell's own. Every variable whose name starts with `CLAUDE_CODE_` is
/// removed too (see `__holder` below).
const STALE_ENV: &[&str] = &["SSH_AUTH_SOCK", "SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT", "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"];

/// The most lines `output --follow` watches.
const MAX_FOLLOW_LINES: usize = 5000;

const VALUED: &[&str] = &["--cwd", "--name", "--cols", "--rows", "--env", "--dir", "--before", "--after", "--limit", "--lines", "--folder", "--key", "--summary", "--tile", "--title", "--recap", "--size", "--on", "--set", "--parent", "--remove", "--assign", "--to"];
const ALLOWED_FLAGS: &[&str] = &["--require-cwd", "--cwd-fallback", "--follow", "--skip-permissions", "--local", "--user", "--claim", "--clear", "--deny", "--once", "--sub", "--top"];

/// The conductor guard (conductor spec §3) for a command run from a tile: `sub` against
/// `target`. The desktop and the phone's gate carry no tile and pass.
fn guard(sub: &str, target: Option<&str>) -> Result<(), CliError> {
    let caller = swarmz_tool::conductor::caller_tile();
    if caller.is_none() {
        return Ok(());
    }
    let env = cmd::Env::from_process()?;
    let ws = cmd::guard_workspace(&env)?;
    swarmz_tool::conductor::allowed(&ws, caller.as_deref(), sub, target)
}

struct Args {
    positional: Vec<String>,
    opts: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Args {
    fn parse(raw: &[String]) -> Result<Args, CliError> {
        let mut a = Args { positional: vec![], opts: vec![], flags: vec![] };
        let mut i = 0;
        while i < raw.len() {
            let s = &raw[i];
            // Everything after a lone `--` is positional, so text such as `--hi` is never an option.
            if s == "--" {
                a.positional.extend(raw[i + 1..].iter().cloned());
                break;
            }
            if VALUED.contains(&s.as_str()) {
                // A missing value, or one that looks like another option (starts with `--`), is
                // always a usage error rather than being silently swallowed as this option's
                // value. `--summary` is exempt: it repeats a question, and a command can start
                // with `--`.
                let v = raw
                    .get(i + 1)
                    .filter(|v| s == "--summary" || !v.starts_with("--"))
                    .ok_or_else(|| CliError::new("usage", format!("{s} needs a value")))?;
                a.opts.push((s.clone(), v.clone()));
                i += 2;
            } else if s.starts_with("--") {
                if !ALLOWED_FLAGS.contains(&s.as_str()) {
                    return Err(CliError::new("usage", format!("unknown flag {s}")));
                }
                a.flags.push(s.clone());
                i += 1;
            } else {
                a.positional.push(s.clone());
                i += 1;
            }
        }
        Ok(a)
    }

    fn opt(&self, name: &str) -> Option<&str> {
        self.opts.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.opts.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect()
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    fn num(&self, name: &str, default: u16) -> Result<u16, CliError> {
        match self.opt(name) {
            None => Ok(default),
            Some(v) => {
                let n: u16 = v.parse().map_err(|_| CliError::new("usage", format!("{name} must be a number")))?;
                if n < 1 {
                    return Err(CliError::new("usage", format!("{name} must be at least 1")));
                }
                Ok(n)
            }
        }
    }

    fn envs(&self) -> Result<Vec<(String, String)>, CliError> {
        self.all("--env")
            .into_iter()
            .map(|kv| {
                let (k, v) = kv
                    .split_once('=')
                    .ok_or_else(|| CliError::new("usage", format!("--env expects KEY=VALUE, got {kv}")))?;
                if !is_valid_env_key(k) {
                    return Err(CliError::new("usage", format!("--env key {k:?} must match [A-Za-z_][A-Za-z0-9_]*")));
                }
                Ok((k.to_string(), v.to_string()))
            })
            .collect()
    }

    /// Rejects trailing positional arguments a command doesn't expect (beyond the command name
    /// itself plus, for most commands, one tile id).
    fn expect_positional(&self, n: usize, usage: &str) -> Result<(), CliError> {
        if self.positional.len() != n {
            return Err(CliError::new("usage", format!("usage: swarmz {usage}")));
        }
        Ok(())
    }
}

fn is_valid_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn tile_arg(a: &Args) -> Result<String, CliError> {
    a.positional.get(1).cloned().ok_or_else(|| CliError::new("usage", "missing tile id"))
}

/// A count option from 1 to `max`, or `default` when not given.
fn count(a: &Args, name: &str, default: usize, max: usize) -> Result<usize, CliError> {
    match a.opt(name) {
        None => Ok(default),
        Some(v) => v
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=max).contains(n))
            .ok_or_else(|| CliError::new("usage", format!("{name} must be a number from 1 to {max}"))),
    }
}

fn exe() -> Result<PathBuf, CliError> {
    std::env::current_exe().map_err(|e| CliError::new("failed", format!("cannot locate this program: {e}")))
}

fn run(raw: &[String]) -> Result<Option<serde_json::Value>, CliError> {
    let a = Args::parse(raw)?;
    // `--on <machine>`: the same command on another Mac (conductor spec §2), the conductor's
    // alone from a tile. The guard checks the target as this Mac would; the remote checks again.
    if let Some(machine) = a.opt("--on") {
        let sub = a.positional.first().cloned().unwrap_or_default();
        if matches!(sub.as_str(), "" | "hold" | "attach" | "ssh-gate" | "phone" | "conductor") || sub.starts_with("__") {
            return Err(CliError::new("usage", format!("{sub:?} cannot run with --on")));
        }
        guard("on", None)?;
        let env = cmd::Env::from_process()?;
        let host = cmd::host_for(&env, machine)?;
        let args: Vec<String> = strip_on(raw);
        // The remote shell inherits no environment: the caller's tile goes with the command, so
        // `ask` there knows who asks and the remote guard checks the same caller.
        let caller = swarmz_tool::conductor::caller_tile();
        let name = std::env::var("SWARMZ_TERMINAL_NAME").ok().filter(|n| !n.is_empty()).or_else(|| caller.clone());
        let identity = caller.as_deref().zip(name.as_deref());
        let status = swarmz_tool::conductor::remote_command_as(&host, &args, identity)
            .stdin(std::process::Stdio::null())
            .status()
            .map_err(|e| CliError::new("failed", format!("could not run ssh: {e}")))?;
        std::process::exit(status.code().unwrap_or(1));
    }
    match a.positional.first().map(String::as_str) {
        Some("conductor") => {
            a.expect_positional(1, "conductor [--claim [--top] | --set <tile> [--parent <tile>] | --assign <tile> --to <conductor> | --remove <tile> | --deny | --clear]")?;
            let env = cmd::Env::from_process()?;
            let action = if a.flag("--claim") {
                let tile = swarmz_tool::conductor::caller_tile().ok_or_else(|| CliError::new("usage", "--claim is run from a tile (SWARMZ_TERMINAL_ID is not set)"))?;
                // In a tree a plain claim asks for a place under the conductor the tile answers to;
                // replacing the top takes --top (conductor tree spec §4). With no top, it is the top.
                let ws = cmd::guard_workspace(&env)?;
                let top = swarmz_tool::conductor::Tree::of(&ws).top;
                let sub = a.flag("--sub") || (!a.flag("--top") && top.is_some() && top.as_deref() != Some(tile.as_str()));
                cmd::ConductorAction::Claim(tile, sub)
            } else if let Some(t) = a.opt("--set") {
                guard("conductor-set", None)?;
                match a.opt("--parent") {
                    Some(p) => cmd::ConductorAction::SetSub { tile: cmd::tile_arg(t)?, parent: cmd::tile_arg(p)? },
                    None => cmd::ConductorAction::Set(cmd::tile_arg(t)?),
                }
            } else if let Some(t) = a.opt("--assign") {
                let tile = cmd::tile_arg(t)?;
                let to = cmd::tile_arg(a.opt("--to").ok_or_else(|| CliError::new("usage", "--assign needs --to <conductor>"))?)?;
                // The user may assign anything; a conductor moves its own tile into a sub-conductor
                // directly under it (conductor tree spec §4).
                if let Some(caller) = swarmz_tool::conductor::caller_tile() {
                    let ws = cmd::guard_workspace(&env)?;
                    if !swarmz_tool::conductor::Tree::of(&ws).may_assign(&ws, &caller, &tile, &to) {
                        return Err(CliError::new("denied", "a conductor may only hand a tile that answers to it to a conductor directly under it"));
                    }
                }
                cmd::ConductorAction::Assign { tile, to }
            } else if let Some(t) = a.opt("--remove") {
                guard("conductor-set", None)?;
                cmd::ConductorAction::Remove(cmd::tile_arg(t)?)
            } else if a.flag("--deny") {
                guard("conductor-set", None)?;
                cmd::ConductorAction::Deny
            } else if a.flag("--clear") {
                guard("conductor-clear", None)?;
                cmd::ConductorAction::Clear
            } else {
                cmd::ConductorAction::Read
            };
            Ok(Some(cmd::conductor(&env, action)?))
        }
        Some("fleet") => {
            a.expect_positional(1, "fleet [--follow]")?;
            guard("fleet", None)?;
            cmd::fleet(&cmd::Env::from_process()?, a.flag("--follow"), &mut std::io::stdout())?;
            Ok(None)
        }
        Some("ask") => {
            a.expect_positional(3, "ask <tile> [--] <question>")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("ask", Some(&tile))?;
            let caller = swarmz_tool::conductor::caller_tile().ok_or_else(|| CliError::new("usage", "ask is run from the conductor tile"))?;
            Ok(Some(cmd::ask(&cmd::Env::from_process()?, &caller, &tile, &a.positional[2])?))
        }
        Some("reply") => {
            a.expect_positional(2, "reply [--] <text>")?;
            let caller = swarmz_tool::conductor::caller_tile().ok_or_else(|| CliError::new("usage", "reply is run from a tile (SWARMZ_TERMINAL_ID is not set)"))?;
            Ok(Some(cmd::reply(&cmd::Env::from_process()?, &caller, &a.positional[1])?))
        }
        Some("briefing") => {
            a.expect_positional(1, "briefing")?;
            let tile = swarmz_tool::conductor::caller_tile();
            let name = std::env::var("SWARMZ_TERMINAL_NAME").ok().filter(|n| !n.is_empty()).or_else(|| tile.clone()).unwrap_or_else(|| "this tile".to_string());
            print!("{}", cmd::briefing(&cmd::Env::from_process()?, tile.as_deref(), &name)?);
            Ok(None)
        }
        Some("notify") => {
            a.expect_positional(2, "notify [--tile <id>] [--] <text>")?;
            guard("notify", None)?;
            let tile = a.opt("--tile").map(cmd::tile_arg).transpose()?;
            let caller = swarmz_tool::conductor::caller_tile();
            Ok(Some(cmd::notify(&cmd::Env::from_process()?, caller.as_deref(), tile.as_deref(), &a.positional[1])?))
        }
        Some("telegram-follow") => {
            a.expect_positional(1, "telegram-follow [--once]")?;
            guard("telegram-follow", None)?;
            cmd::telegram_follow(&cmd::Env::from_process()?, a.flag("--once"), &mut std::io::stdout())?;
            Ok(None)
        }
        Some("stats") => {
            a.expect_positional(1, "stats")?;
            Ok(Some(cmd::stats(&cmd::Env::from_process()?)?))
        }
        Some("version") => {
            a.expect_positional(1, "version")?;
            Ok(Some(json!({ "v": 1, "tool": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION, "build": build_id() })))
        }
        Some("hold") => {
            a.expect_positional(2, "hold <tile> --cwd D --name N [--cols C] [--rows R] [--env K=V]... [--require-cwd]")?;
            let tile = tile_arg(&a)?;
            let req = HoldRequest {
                name: a.opt("--name").unwrap_or(&tile).to_string(),
                cwd: a.opt("--cwd").map(str::to_string).unwrap_or_else(|| home_dir().to_string_lossy().into_owned()),
                cols: a.num("--cols", 80)?,
                rows: a.num("--rows", 24)?,
                env: a.envs()?,
                require_cwd: a.flag("--require-cwd"),
                tile,
            };
            let r = hold(&exe()?, &sessions_dir(), &req)?;
            Ok(Some(serde_json::to_value(r).expect("hold result serialises")))
        }
        Some("info") => {
            a.expect_positional(2, "info <tile>")?;
            let tile = tile_arg(&a)?;
            let paths = session_paths(&sessions_dir(), &tile).map_err(|e| CliError::new("invalid", e))?;
            if live_session(&paths).is_none() {
                return Ok(Some(json!({ "v": 1, "running": false })));
            }
            let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: TOOL_VIEWER.into() };
            let client = HolderClient::connect(&paths.socket, &hello, |_, _| {}, |_| {}).map_err(|e| CliError::new("failed", e))?;
            let info = client.info(Duration::from_secs(3)).ok_or_else(|| CliError::new("failed", "the session did not answer"))?;
            Ok(Some(json!({
                "v": 1,
                "running": true,
                "cwd": info.cwd,
                "foregroundBusy": info.foreground_busy,
                "foregroundCommand": info.foreground_command,
                "bracketedPaste": info.bracketed_paste,
            })))
        }
        Some("close") => {
            a.expect_positional(2, "close <tile>")?;
            let tile = tile_arg(&a)?;
            guard("close", Some(&tile))?;
            let paths = session_paths(&sessions_dir(), &tile).map_err(|e| CliError::new("invalid", e))?;
            if live_session(&paths).is_none() {
                return Ok(Some(json!({ "v": 1, "closed": false })));
            }
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: TOOL_VIEWER.into() };
            // The holder may have ended between the check and here: nothing left to close.
            let Ok(client) = HolderClient::connect(&paths.socket, &hello, |_, _| {}, move |_| {
                let _ = tx.send(());
            }) else {
                return Ok(Some(json!({ "v": 1, "closed": false })));
            };
            client.terminate().map_err(|e| CliError::new("failed", format!("could not reach the session: {e}")))?;
            // The exit callback runs on the holder's Exit frame and when the connection ends.
            rx.recv_timeout(CLOSE_WAIT).map_err(|_| CliError::new("failed", "the session did not end in time"))?;
            Ok(Some(json!({ "v": 1, "closed": true })))
        }
        Some("attach") => {
            a.expect_positional(2, "attach <tile> [--cwd D] [--name N] [--env K=V]...")?;
            let tile = tile_arg(&a)?;
            let req = HoldRequest {
                name: a.opt("--name").unwrap_or(&tile).to_string(),
                cwd: a.opt("--cwd").map(str::to_string).unwrap_or_else(|| home_dir().to_string_lossy().into_owned()),
                cols: 80,
                rows: 24,
                env: a.envs()?,
                require_cwd: false,
                tile,
            };
            let code = attach(&exe()?, &sessions_dir(), req)?;
            std::process::exit(code);
        }
        Some("__holder") => {
            a.expect_positional(2, "__holder <tile> --name N --cwd D --dir D [--cols C] [--rows R] [--cwd-fallback] [--env K=V]...")?;
            let tile = tile_arg(&a)?;
            // Nothing else runs yet in this process, and the shell's environment is built from
            // ours; `--env` values are added on top afterwards, so they still apply.
            for k in STALE_ENV {
                std::env::remove_var(k);
            }
            let claude_code_env: Vec<String> = std::env::vars().map(|(k, _)| k).filter(|k| k.starts_with("CLAUDE_CODE_")).collect();
            for k in claude_code_env {
                std::env::remove_var(k);
            }
            let (program, args) = holder_program();
            let name = a.opt("--name").unwrap_or(&tile).to_string();
            let mut env = vec![
                ("TERM".to_string(), "xterm-256color".to_string()),
                ("COLORTERM".to_string(), "truecolor".to_string()),
                ("SWARMZ_TERMINAL_ID".to_string(), tile.clone()),
                ("SWARMZ_TERMINAL_NAME".to_string(), name.clone()),
            ];
            env.extend(a.envs()?);
            let cfg = HolderConfig {
                cwd: a.opt("--cwd").ok_or_else(|| CliError::new("usage", "missing --cwd"))?.to_string(),
                dir: PathBuf::from(a.opt("--dir").ok_or_else(|| CliError::new("usage", "missing --dir"))?),
                cols: a.num("--cols", 80)?,
                rows: a.num("--rows", 24)?,
                cwd_fallback: a.flag("--cwd-fallback"),
                viewer_queue_cap: VIEWER_QUEUE_CAP,
                program,
                args,
                env,
                name,
                tile,
            };
            let code = run_holder(cfg)?;
            std::process::exit(code.unwrap_or(0));
        }
        Some("__keep-def") => {
            a.expect_positional(2, "__keep-def <tile>")?;
            let tile = cmd::tile_arg(&tile_arg(&a)?)?;
            cmd::keep_def_main(&home_dir(), &tile)?;
            Ok(None)
        }
        Some("ls") => {
            a.expect_positional(1, "ls")?;
            Ok(Some(cmd::ls(&cmd::Env::from_process()?)?))
        }
        Some("watch") => {
            a.expect_positional(1, "watch")?;
            cmd::watch(&cmd::Env::from_process()?, &mut std::io::stdout())?;
            Ok(None)
        }
        Some("machines") => {
            a.expect_positional(1, "machines")?;
            Ok(Some(cmd::machines(&cmd::Env::from_process()?)?))
        }
        Some("sessions") => {
            a.expect_positional(1, "sessions")?;
            Ok(Some(cmd::sessions(&cmd::Env::from_process()?)?))
        }
        Some("upload") => {
            a.expect_positional(1, "upload --name <name> --size <bytes>")?;
            let name = a.opt("--name").ok_or_else(|| CliError::new("usage", "missing --name"))?;
            let size: u64 = a
                .opt("--size")
                .ok_or_else(|| CliError::new("usage", "missing --size"))?
                .parse()
                .map_err(|_| CliError::new("usage", "--size must be a number of bytes"))?;
            Ok(Some(cmd::upload(&cmd::Env::from_process()?, name, size)?))
        }
        Some("prune") => {
            a.expect_positional(1, "prune")?;
            Ok(Some(cmd::prune(&cmd::Env::from_process()?)?))
        }
        Some("folders") => {
            if a.positional.len() > 2 {
                return Err(CliError::new("usage", "usage: swarmz folders [<path>]"));
            }
            Ok(Some(cmd::folders(&cmd::Env::from_process()?, a.positional.get(1).map(String::as_str))?))
        }
        Some("new") => {
            a.expect_positional(1, "new --folder <dir> [--skip-permissions] [--name <name>]")?;
            guard("new", None)?;
            let folder = a.opt("--folder").ok_or_else(|| CliError::new("usage", "missing --folder"))?;
            let env = cmd::Env::from_process()?;
            let made = cmd::new_tile(&env, folder, a.flag("--skip-permissions"), a.opt("--name"))?;
            // A tile a sub-conductor starts is its own (conductor tree spec §3).
            if let (Some(caller), Some(id)) = (swarmz_tool::conductor::caller_tile(), made["tile"]["id"].as_str()) {
                let ws = cmd::guard_workspace(&env)?;
                if swarmz_tool::conductor::Tree::of(&ws).subs.contains_key(&caller) {
                    let _ = cmd::conductor(&env, cmd::ConductorAction::Assign { tile: id.to_string(), to: caller });
                }
            }
            Ok(Some(made))
        }
        Some("restart") => {
            a.expect_positional(2, "restart <tile>")?;
            let tile = cmd::tile_arg(&tile_arg(&a)?)?;
            guard("restart", Some(&tile))?;
            Ok(Some(cmd::restart(&cmd::Env::from_process()?, &tile)?))
        }
        Some("send") => {
            a.expect_positional(3, "send <tile> [--] <text>")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("send", Some(&tile))?;
            // A line from the conductor to another tile says who is speaking (conductor spec §2).
            let text = match swarmz_tool::conductor::caller_tile() {
                Some(c) if c != tile => {
                    let env = cmd::Env::from_process()?;
                    format!("[conductor {}] {}", cmd::title_of(&env, &c)?, a.positional[2])
                }
                _ => a.positional[2].clone(),
            };
            Ok(Some(cmd::send(&cmd::Env::from_process()?, &tile, &text)?))
        }
        Some("key") => {
            a.expect_positional(3, "key <tile> <esc|ctrl-c|tab|shift-tab|up|down|enter>")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("key", Some(&tile))?;
            Ok(Some(cmd::key(&cmd::Env::from_process()?, &tile, &a.positional[2])?))
        }
        Some("card") => {
            a.expect_positional(1, "card [--tile ID] [--title TEXT] [--recap TEXT] [--user]")?;
            Ok(Some(cmd::card(&cmd::Env::from_process()?, a.opt("--tile"), a.opt("--title"), a.opt("--recap"), a.flag("--user"))?))
        }
        Some("pending") => {
            a.expect_positional(2, "pending <tile>")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("pending", Some(&tile))?;
            Ok(Some(cmd::pending(&cmd::Env::from_process()?, &tile)?))
        }
        Some("answer") => {
            a.expect_positional(3, "answer <tile> <yes|always|no|deny|n> [--summary S]")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("answer", Some(&tile))?;
            Ok(Some(cmd::answer(&cmd::Env::from_process()?, &tile, &a.positional[2], a.opt("--summary"))?))
        }
        Some("output") => {
            a.expect_positional(2, "output <tile> [--lines N] [--follow]")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("output", Some(&tile))?;
            // The conductor gets a glance at another tile, not a feed (conductor spec §2).
            let other = swarmz_tool::conductor::caller_tile().is_some_and(|c| c != tile);
            if other && a.flag("--follow") {
                return Err(CliError::new("denied", "another tile's screen is a glance, not a feed: leave off --follow"));
            }
            // A follower re-reads its lines every 300 ms: keep that cheap.
            let max = if other { swarmz_tool::conductor::SCREEN_MAX } else if a.flag("--follow") { MAX_FOLLOW_LINES } else { 5000 };
            let lines = count(&a, "--lines", 200.min(max), max)?;
            cmd::output(&cmd::Env::from_process()?, &tile, lines, a.flag("--follow"), &mut std::io::stdout())?;
            Ok(None)
        }
        Some("transcript") => {
            a.expect_positional(2, "transcript <tile> [--before ID] [--after ID] [--limit N] [--follow]")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("transcript", Some(&tile))?;
            let limit = count(&a, "--limit", 50, 500)?;
            cmd::transcript(&cmd::Env::from_process()?, &tile, a.opt("--before"), a.opt("--after"), limit, a.flag("--follow"), &mut std::io::stdout())?;
            Ok(None)
        }
        Some("image") => {
            a.expect_positional(3, "image <tile> <imageId>")?;
            let tile = cmd::tile_arg(&a.positional[1])?;
            guard("image", Some(&tile))?;
            Ok(Some(cmd::image(&cmd::Env::from_process()?, &tile, &a.positional[2])?))
        }
        Some("phone") => match a.positional.get(1).map(String::as_str) {
            Some("add") => {
                a.expect_positional(2, "phone add --name <device> --key <pubkey> [--local]")?;
                let name = a.opt("--name").ok_or_else(|| CliError::new("usage", "missing --name"))?;
                let key = a.opt("--key").ok_or_else(|| CliError::new("usage", "missing --key"))?;
                Ok(Some(cmd::phone_add(&cmd::Env::from_process()?, name, key, a.flag("--local"))?))
            }
            Some("ls") => {
                a.expect_positional(2, "phone ls")?;
                Ok(Some(cmd::phone_ls(&cmd::Env::from_process()?)?))
            }
            Some("revoke") => {
                a.expect_positional(3, "phone revoke <device> [--local]")?;
                Ok(Some(cmd::phone_revoke(&cmd::Env::from_process()?, &a.positional[2], a.flag("--local"))?))
            }
            _ => Err(CliError::new("usage", "usage: swarmz phone <add|ls|revoke> …")),
        },
        Some("host-keys") => {
            a.expect_positional(1, "host-keys")?;
            Ok(Some(cmd::host_keys(&cmd::Env::from_process()?)?))
        }
        Some("ssh-gate") => {
            a.expect_positional(1, "ssh-gate")?;
            Err(cmd::ssh_gate(&cmd::Env::for_gate()?))
        }
        _ => Err(CliError::new("usage", "usage: swarmz <version|hold|info|close|attach|ls|watch|machines|sessions|prune|folders|new|restart|output|send|key|pending|answer|card|upload|conductor|fleet|ask|reply|briefing|transcript|image|phone|host-keys|ssh-gate> …")),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let is_gate = raw.first().map(String::as_str) == Some("ssh-gate");
    // Every failure while running `ssh-gate` is reported as a refusal, whatever raised it --
    // `Args::parse`, `expect_positional`, `Env::from_process`, or `ssh_gate` itself -- so a phone
    // key's forced command never leaks an internal error code (`usage`, `failed`, …) in place of
    // `denied`.
    let result = if is_gate { run(&raw).map_err(|e| CliError::new("denied", e.message)) } else { run(&raw) };
    match result {
        Ok(Some(v)) => {
            println!("{v}");
        }
        Ok(None) => {}
        Err(e) => {
            println!("{}", json!({ "v": 1, "error": e.message, "code": e.code }));
            std::process::exit(if is_gate { 126 } else { 1 });
        }
    }
}

/// `raw` without its `--on <machine>` pair, for the remote side.
fn strip_on(raw: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == "--on" {
            i += 2;
            continue;
        }
        if raw[i] == "--" {
            out.extend(raw[i..].iter().cloned());
            break;
        }
        out.push(raw[i].clone());
        i += 1;
    }
    out
}
