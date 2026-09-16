use crate::paths::{clear_stale, ensure_dir, home_dir, live_session, session_paths, socket_live, Meta};
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
    /// The holder's build id; None for a holder started by a tool that predates it, which applies
    /// a zero-size `Hello` literally instead of ignoring it.
    #[serde(default)]
    pub build: Option<u64>,
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
        build: meta.build,
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

/// Opens (creating if needed) `<dir>/<tile>.lock`, always 0600, and takes an exclusive `flock` on
/// it, retrying a non-blocking attempt every 50ms for up to 10s. The file is never deleted: it
/// exists purely to serialise concurrent `hold` calls for the same tile, so only one of them ever
/// starts a holder. Callers keep the returned `File` alive for as long as the critical section
/// runs; dropping it (on any return path) closes the fd and releases the lock.
///
/// The attempt is non-blocking (`LOCK_EX | LOCK_NB`, polled) rather than a single blocking
/// `flock`, so a `hold` that is itself stuck (or just very slow: waiting out the 5s spawn timeout
/// below) can never wedge every other `hold` for the same tile behind it indefinitely. Past the
/// 10s deadline this returns a `busy` error instead of continuing to wait.
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
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(file);
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(CliError::new("failed", format!("could not lock {}: {err}", path.display())));
        }
        if Instant::now() > deadline {
            return Err(CliError::new("busy", "another start for this tile is still running"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
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
    if socket_live(&paths.socket) {
        // Something is listening on this tile's socket, but `live_session` above was still
        // None, so there is no metadata we trust (missing, corrupt, or naming a pid that isn't
        // running). Whatever it is, it already owns the socket: never spawn a second holder on
        // top of it.
        return Err(CliError::new("busy", format!("a holder is running for {} without valid metadata", req.tile)));
    }
    // The holder runs from `/` (below), so a relative folder is resolved here, against ours.
    let requested = std::env::current_dir().map(|d| d.join(&req.cwd)).unwrap_or_else(|_| Path::new(&req.cwd).to_path_buf());
    let (cwd, fallback) = if requested.is_dir() {
        (requested.to_string_lossy().into_owned(), false)
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
    // The holder lives for days: it must not keep whatever folder we were started in busy (an
    // unmountable volume, a folder the user deletes). The shell gets its own folder via `--cwd`.
    cmd.current_dir("/");
    detach(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| CliError::new("failed", format!("could not start the session holder: {e}")))?;

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(meta) = live_session(&paths) {
            // Reap it in the background so it doesn't linger as a zombie once `hold` exits; the
            // holder itself keeps running detached regardless of what happens to this `Child`.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(result(&paths.socket, meta, false));
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                // It already exited on its own: nothing left to kill, and killing by pid here
                // would risk hitting an unrelated process that has since reused it.
                return Err(CliError::new("failed", format!("the session holder did not start: {}", log_tail(&paths.log, log_start))));
            }
            Ok(None) => {
                if Instant::now() > deadline {
                    // Still running but never got as far as listening. `kill`/`wait` act on this
                    // exact `Child` (tracked by the kernel via the process's `wait()` state, not
                    // by re-resolving its pid), so there is no risk of the pid having been reused
                    // by another process by now.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CliError::new("failed", format!("the session holder did not start: {}", log_tail(&paths.log, log_start))));
                }
            }
            Err(e) => {
                return Err(CliError::new("failed", format!("could not check on the session holder: {e}")));
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Makes `cmd` start detached: a new session with no controlling terminal, and every inherited
/// file descriptor beyond stdio marked close-on-exec.
pub fn detach(cmd: &mut Command) {
    // A new session with no controlling terminal: hang-ups aimed at whoever started us (the
    // app, an ssh session) never reach the holder, and it is reparented to launchd once its
    // starter exits.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // macOS has no `pipe2()`: creating a pipe and marking it close-on-exec are two
            // separate syscalls, so a `fork()` on one thread of a multi-threaded process (the
            // app, or this very CLI run concurrently from several threads) can land in the gap
            // between them on another thread and inherit a write end that was never meant to
            // survive exec. Inherited by an ordinary short-lived child that would just be a
            // leaked fd; inherited by this holder it is fatal, because the holder runs for
            // days, so whoever's stdout/stderr that pipe belongs to never sees EOF and hangs
            // forever waiting to read it (this is exactly the hang `tests/cli.rs`'s concurrent
            // `hold` test hit). Mark every fd we didn't set up ourselves close-on-exec: std's own
            // exec-error-reporting pipe is already CLOEXEC, so this can't break failure
            // reporting, and both `getdtablesize` and `fcntl` are async-signal-safe, so they're
            // safe to call here, after `fork` and before `exec`. The result is ignored: EBADF
            // for an fd that was never open is expected and the common case, and there is
            // nothing safer to do about any other errno in this post-fork, pre-exec context
            // than to keep going.
            let limit = libc::getdtablesize().clamp(0, 65_536);
            for fd in 3..limit {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            Ok(())
        });
    }
}

/// The last few log lines written since `start` (an earlier attempt's byte offset into the same,
/// shared log file), for an error message. Never lines from a previous session's holder.
fn log_tail(path: &Path, start: u64) -> String {
    let log_bytes = std::fs::read(path).unwrap_or_default();
    let start = (start as usize).min(log_bytes.len());
    let tail_str = String::from_utf8_lossy(&log_bytes[start..]);
    tail_str.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}
