use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use swarmz_tool::attach::attach;
use swarmz_tool::client::HolderClient;
use swarmz_tool::hold::{hold, holder_program, CliError, HoldRequest};
use swarmz_tool::paths::{home_dir, live_session, session_paths, sessions_dir};
use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};
use swarmz_tool::server::{run_holder, HolderConfig, VIEWER_QUEUE_CAP};

const VALUED: &[&str] = &["--cwd", "--name", "--cols", "--rows", "--env", "--dir"];
const ALLOWED_FLAGS: &[&str] = &["--require-cwd", "--cwd-fallback"];

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
            if VALUED.contains(&s.as_str()) {
                // A missing value, or one that looks like another option (starts with `--`), is
                // always a usage error rather than being silently swallowed as this option's
                // value.
                let v = raw
                    .get(i + 1)
                    .filter(|v| !v.starts_with("--"))
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

fn exe() -> Result<PathBuf, CliError> {
    std::env::current_exe().map_err(|e| CliError::new("failed", format!("cannot locate this program: {e}")))
}

fn run(raw: &[String]) -> Result<serde_json::Value, CliError> {
    let a = Args::parse(raw)?;
    match a.positional.first().map(String::as_str) {
        Some("version") => {
            a.expect_positional(1, "version")?;
            Ok(json!({ "v": 1, "tool": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION }))
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
            Ok(serde_json::to_value(r).expect("hold result serialises"))
        }
        Some("info") => {
            a.expect_positional(2, "info <tile>")?;
            let tile = tile_arg(&a)?;
            let paths = session_paths(&sessions_dir(), &tile).map_err(|e| CliError::new("invalid", e))?;
            if live_session(&paths).is_none() {
                return Ok(json!({ "v": 1, "running": false }));
            }
            let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "tool".into() };
            let client = HolderClient::connect(&paths.socket, &hello, |_, _| {}, |_| {}).map_err(|e| CliError::new("failed", e))?;
            let info = client.info(Duration::from_secs(3)).ok_or_else(|| CliError::new("failed", "the session did not answer"))?;
            Ok(json!({
                "v": 1,
                "running": true,
                "cwd": info.cwd,
                "foregroundBusy": info.foreground_busy,
                "foregroundCommand": info.foreground_command,
            }))
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
        _ => Err(CliError::new("usage", "usage: swarmz <version|hold|info|attach> …")),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    match run(&raw) {
        Ok(v) => {
            println!("{v}");
        }
        Err(e) => {
            println!("{}", json!({ "v": 1, "error": e.message, "code": e.code }));
            std::process::exit(1);
        }
    }
}
