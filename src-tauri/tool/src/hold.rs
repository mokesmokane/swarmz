use crate::paths::{clear_stale, ensure_dir, home_dir, live_session, session_paths, Meta};
use crate::proto::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct CliError {
    pub message: String,
    pub code: &'static str,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>) -> CliError {
        CliError { message: message.into(), code }
    }
}

impl From<String> for CliError {
    fn from(message: String) -> CliError {
        CliError { message, code: "failed" }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HoldRequest {
    pub tile: String,
    pub name: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
    pub require_cwd: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldResult {
    pub v: u32,
    pub socket: String,
    pub existed: bool,
    pub pid: u32,
    pub shell_pid: Option<u32>,
    pub cwd: String,
    pub cwd_fallback: bool,
}

fn result(socket: &Path, meta: Meta, existed: bool) -> HoldResult {
    HoldResult {
        v: PROTOCOL_VERSION,
        socket: socket.to_string_lossy().into_owned(),
        existed,
        pid: meta.pid,
        shell_pid: meta.shell_pid,
        cwd: meta.cwd,
        cwd_fallback: meta.cwd_fallback,
    }
}

/// The shell a holder runs: `$SWARMZ_HOLDER_SHELL` without arguments (tests), else a login
/// `$SHELL`.
pub fn holder_program() -> (String, Vec<String>) {
    if let Ok(p) = std::env::var("SWARMZ_HOLDER_SHELL") {
        if !p.is_empty() {
            return (p, vec![]);
        }
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string()])
}

/// Finds the tile's live holder or starts a detached one, and waits until it is listening.
pub fn hold(exe: &Path, dir: &Path, req: &HoldRequest) -> Result<HoldResult, CliError> {
    let paths = session_paths(dir, &req.tile).map_err(|e| CliError::new("invalid", e))?;
    ensure_dir(dir).map_err(|e| CliError::new("failed", format!("could not create {}: {e}", dir.display())))?;
    if let Some(meta) = live_session(&paths) {
        return Ok(result(&paths.socket, meta, true));
    }
    clear_stale(&paths);
    let (cwd, fallback) = if Path::new(&req.cwd).is_dir() {
        (req.cwd.clone(), false)
    } else if req.require_cwd {
        return Err(CliError::new("cwd_missing", format!("{} is not a directory", req.cwd)));
    } else {
        (home_dir().to_string_lossy().into_owned(), true)
    };
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)
        .map_err(|e| CliError::new("failed", format!("could not open {}: {e}", paths.log.display())))?;
    let log2 = log.try_clone().map_err(|e| CliError::new("failed", e.to_string()))?;

    let mut cmd = Command::new(exe);
    cmd.arg("__holder")
        .arg(&req.tile)
        .arg("--name").arg(&req.name)
        .arg("--cwd").arg(&cwd)
        .arg("--cols").arg(req.cols.to_string())
        .arg("--rows").arg(req.rows.to_string())
        .arg("--dir").arg(dir);
    if fallback {
        cmd.arg("--cwd-fallback");
    }
    for (k, v) in &req.env {
        cmd.arg("--env").arg(format!("{k}={v}"));
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log2));
    // A new session with no controlling terminal: hang-ups aimed at whoever started us (the
    // app, an ssh session) never reach the holder, and it is reparented to launchd once its
    // starter exits.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| CliError::new("failed", format!("could not start the session holder: {e}")))?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(meta) = live_session(&paths) {
            return Ok(result(&paths.socket, meta, false));
        }
        if !crate::paths::pid_alive(pid) || Instant::now() > deadline {
            let log = std::fs::read_to_string(&paths.log).unwrap_or_default();
            let tail: String = log.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(CliError::new("failed", format!("the session holder did not start: {tail}")));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
