use crate::paths::{clear_stale, ensure_dir, home_dir, live_session, session_paths, Meta};
use crate::proto::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
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

/// Opens (creating if needed) `<dir>/<tile>.lock`, always 0600, and takes a blocking exclusive
/// `flock` on it. The file is never deleted: it exists purely to serialise concurrent `hold`
/// calls for the same tile, so only one of them ever starts a holder. Callers keep the returned
/// `File` alive for as long as the critical section runs; dropping it (on any return path) closes
/// the fd and releases the lock.
fn acquire_tile_lock(dir: &Path, tile: &str) -> Result<File, CliError> {
    let path = dir.join(format!("{tile}.lock"));
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| CliError::new("failed", format!("could not open {}: {e}", path.display())))?;
    // `mode()` on `OpenOptions` only applies when the file is created; re-assert 0600 in case an
    // earlier version of this file was left with different permissions.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc != 0 {
        return Err(CliError::new("failed", format!("could not lock {}: {}", path.display(), std::io::Error::last_os_error())));
    }
    Ok(file)
}

/// Finds the tile's live holder or starts a detached one, and waits until it is listening.
///
/// Holds an exclusive flock on `<dir>/<tile>.lock` across the whole decision: the live check, the
/// stale-record cleanup, spawning `__holder`, and waiting for it to start listening. Without this,
/// concurrent callers for the same tile all see no live session, all spawn a holder, and each new
/// holder's `run_holder` unlinks and rebinds the socket out from under the one before it, leaking
/// every holder but the last as an unreachable orphan. With the lock, only the caller holding it
/// can decide to spawn, and every other caller either blocks until that decision is durably
/// recorded (in the session's `Meta`) and then observes the same live session, or is itself the
/// only one that gets to spawn.
pub fn hold(exe: &Path, dir: &Path, req: &HoldRequest) -> Result<HoldResult, CliError> {
    let paths = session_paths(dir, &req.tile).map_err(|e| CliError::new("invalid", e))?;
    ensure_dir(dir).map_err(|e| CliError::new("failed", format!("could not create {}: {e}", dir.display())))?;
    let _lock = acquire_tile_lock(dir, &req.tile)?;

    if let Some(meta) = live_session(&paths) {
        return Ok(result(&paths.socket, meta, true));
    }
    // Safe to clear now: we hold the tile's lock, so no other `hold` call can be mid-spawn for
    // this tile, and `run_holder` itself refuses to steal a socket that is still live.
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
    // Only ever report log lines written by *this* spawn attempt in an error: the log file is
    // shared across every holder this tile has ever had, and without this offset a failure here
    // could show a previous session's last words instead of this one's.
    let log_start = log.metadata().map(|m| m.len()).unwrap_or(0);
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
            // Whether it died on its own or just never got as far as listening, don't leave it
            // running out of our sight: kill it before reporting the failure.
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            let log_bytes = std::fs::read(&paths.log).unwrap_or_default();
            let start = (log_start as usize).min(log_bytes.len());
            let tail_str = String::from_utf8_lossy(&log_bytes[start..]);
            let tail: String = tail_str.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(CliError::new("failed", format!("the session holder did not start: {tail}")));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
