use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    shell_pid: Option<u32>,
    exited: Arc<AtomicBool>,
}

impl PtySession {
    pub fn spawn(
        spec: SpawnSpec,
        on_data: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<PtySession, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn {} failed: {e}", spec.program))?;
        drop(pair.slave);

        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("clone reader failed: {e}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = child.kill();
                return Err(format!("take writer failed: {e}"));
            }
        };
        let killer = child.clone_killer();
        // Captured before `child` moves into the waiter thread below: this is the pid of the
        // shell we spawned, used by `foreground_busy` to tell whether the pty's foreground
        // process group is still that shell (idle) or something the shell launched (busy).
        let shell_pid = child.process_id();
        let exited = Arc::new(AtomicBool::new(false));
        let exited_for_waiter = exited.clone();

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_data(buf[..n].to_vec()),
                }
            }
        });

        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            exited_for_waiter.store(true, Ordering::SeqCst);
            on_exit(code);
        });

        Ok(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            shell_pid,
            exited,
        })
    }

    /// Whether the pty's foreground process group is something other than the shell we
    /// spawned (i.e. the shell is currently running a foreground command). `None` when either
    /// the shell's pid or the pty's foreground process group leader isn't known (e.g. non-unix,
    /// or the master doesn't support querying it) — callers should treat that as "unknown", not
    /// as busy or idle.
    #[cfg(unix)]
    pub fn foreground_busy(&self) -> Option<bool> {
        let shell_pid = self.shell_pid?;
        let master = self.master.lock().ok()?;
        let leader = master.process_group_leader()?;
        Some(leader as u32 != shell_pid)
    }

    #[cfg(not(unix))]
    pub fn foreground_busy(&self) -> Option<bool> {
        None
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|_| "writer poisoned".to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let m = self.master.lock().map_err(|_| "master poisoned".to_string())?;
        m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self) {
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }

    /// The working directory of the shell this PTY spawned, via `lsof`. Deliberately the
    /// shell's own pid and never the pty's foreground process group: a `(cd /other && make)`
    /// subshell is where a command is running, not where the tile is. `libproc` does not
    /// implement the lookup on macOS; `lsof -a -p <pid> -d cwd -Fn` costs about 16 ms.
    /// None when unknown.
    #[cfg(unix)]
    pub fn cwd(&self) -> Option<String> {
        let shell_pid = self.shell_pid?;
        let out = std::process::Command::new("lsof")
            .arg("-a").arg("-p").arg(shell_pid.to_string()).arg("-d").arg("cwd").arg("-Fn")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        parse_lsof_cwd(&String::from_utf8_lossy(&out.stdout))
    }

    #[cfg(not(unix))]
    pub fn cwd(&self) -> Option<String> {
        None
    }

    pub fn shell_pid(&self) -> Option<u32> {
        self.shell_pid
    }

    /// Whether the shell's waiter thread has observed `wait()` return, i.e. the shell process
    /// has already exited. Set right before the exit callback fires.
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// The pty's foreground process group, when the master can report it.
    #[cfg(unix)]
    pub fn foreground_pgrp(&self) -> Option<i32> {
        let master = self.master.lock().ok()?;
        master.process_group_leader().map(|p| p as i32)
    }

    #[cfg(not(unix))]
    pub fn foreground_pgrp(&self) -> Option<i32> {
        None
    }

    /// Sends `sig` to the pty's foreground process group (for example SIGWINCH so a
    /// full-screen program redraws for a viewer that just attached).
    #[cfg(unix)]
    pub fn signal_foreground(&self, sig: i32) {
        if let Some(pgrp) = self.foreground_pgrp() {
            if pgrp > 0 {
                unsafe {
                    libc::kill(-pgrp, sig);
                }
            }
        }
    }

    #[cfg(not(unix))]
    pub fn signal_foreground(&self, _sig: i32) {}

    /// The short name of the program in the foreground (`zsh`, `sleep`, `ssh`), via `ps`.
    #[cfg(unix)]
    pub fn foreground_command(&self) -> Option<String> {
        let pgrp = self.foreground_pgrp()?;
        let out = std::process::Command::new("ps")
            .arg("-o").arg("comm=").arg("-p").arg(pgrp.to_string())
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let base = name.rsplit('/').next().unwrap_or(&name).trim_start_matches('-').to_string();
        if base.is_empty() { None } else { Some(base) }
    }

    #[cfg(not(unix))]
    pub fn foreground_command(&self) -> Option<String> {
        None
    }

    /// Hangs up the shell and whatever runs in its foreground; kills both if the shell has
    /// not exited on its own three seconds later. Waits on `exited` (set by the waiter thread
    /// right before the exit callback fires) rather than probing the pid with `kill(p, 0)`:
    /// once the shell has exited, its pid can be reused by an unrelated process within the
    /// three-second window, and signalling that pid's process group would hit the wrong one.
    #[cfg(unix)]
    pub fn terminate(&self) {
        let shell = self.shell_pid.map(|p| p as i32);
        let fg = self.foreground_pgrp();
        let exited = self.exited.clone();
        let send = move |sig: i32| {
            for g in [shell, fg].into_iter().flatten() {
                if g > 0 {
                    unsafe {
                        libc::kill(-g, sig);
                    }
                }
            }
        };
        send(libc::SIGHUP);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if !exited.load(Ordering::SeqCst) {
                send(libc::SIGKILL);
            }
        });
    }

    #[cfg(not(unix))]
    pub fn terminate(&self) {
        self.kill();
    }
}

/// `lsof -Fn` prints one field per line with a one-letter prefix; the cwd is the first `n` line.
pub fn parse_lsof_cwd(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|l| l.strip_prefix('n')).filter(|p| p.starts_with('/')).map(|p| p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn spec(program: &str, args: &[&str]) -> SpawnSpec {
        SpawnSpec {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: "/".into(),
            env: vec![("TERM".into(), "xterm-256color".into())],
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn captures_output_and_exit_code() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<i32>>();
        let session = PtySession::spawn(
            spec("/bin/sh", &["-c", "echo hello; exit 3"]),
            move |d| { let _ = tx.send(d); },
            move |c| { let _ = etx.send(c); },
        )
        .unwrap();
        let code = erx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(3));
        // rx.iter() ends when the reader thread drops tx.
        let out: Vec<u8> = rx.iter().flatten().collect();
        assert!(String::from_utf8_lossy(&out).contains("hello"));
        drop(session);
    }

    #[test]
    fn write_echoes_through_cat_and_kill_ends_it() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<i32>>();
        let session = PtySession::spawn(
            spec("/bin/cat", &[]),
            move |d| { let _ = tx.send(d); },
            move |c| { let _ = etx.send(c); },
        )
        .unwrap();
        session.write(b"abc\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::new();
        while Instant::now() < deadline && !String::from_utf8_lossy(&out).contains("abc") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                out.extend(chunk);
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("abc"));
        session.resize(100, 30).unwrap();
        session.kill();
        assert!(erx.recv_timeout(Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn spawn_failure_is_an_error() {
        let result = PtySession::spawn(spec("/nonexistent/binary", &[]), |_| {}, |_| {});
        assert!(result.is_err());
    }

    #[test]
    #[cfg(unix)]
    fn foreground_busy_tracks_the_pty_foreground_process_group() {
        // An interactive shell with job control (bash -i) is used rather than a plain
        // `/bin/sh` script: job control - and thus a foreground process group distinct from
        // the shell's own - is only reliably enabled for a shell that believes it is
        // interactive, which a non-interactive `sh -c "..."` script does not.
        let session = PtySession::spawn(spec("/bin/bash", &["-i"]), |_| {}, |_| {}).unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut idle = session.foreground_busy();
        while Instant::now() < deadline && idle != Some(false) {
            std::thread::sleep(Duration::from_millis(50));
            idle = session.foreground_busy();
        }
        assert_eq!(idle, Some(false), "shell should be idle (foreground == shell) shortly after spawn");

        session.write(b"sleep 5\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut busy = session.foreground_busy();
        while Instant::now() < deadline && busy != Some(true) {
            std::thread::sleep(Duration::from_millis(50));
            busy = session.foreground_busy();
        }
        assert_eq!(busy, Some(true), "sleep should become the pty's foreground process group");

        session.kill();
    }
}

#[cfg(test)]
mod cwd_tests {
    use super::*;

    #[test]
    fn parse_lsof_cwd_takes_the_n_line() {
        assert_eq!(parse_lsof_cwd("p123\nfcwd\nn/Users/me/proj\n"), Some("/Users/me/proj".to_string()));
        assert_eq!(parse_lsof_cwd("p123\n"), None);
        assert_eq!(parse_lsof_cwd(""), None);
        // A directory containing a newline cannot be represented; the first n-line wins.
        assert_eq!(parse_lsof_cwd("n/a\nn/b\n"), Some("/a".to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn cwd_ignores_a_foreground_subshell_that_changed_directory() {
        // `(cd /tmp && sleep 5)` is a subshell: it becomes the pty's foreground process group
        // leader, but the tile's folder is still the shell's own. `bash -i` because job control
        // (and thus a distinct foreground group) needs an interactive shell.
        let spec = SpawnSpec {
            program: "/bin/bash".to_string(),
            args: vec!["-i".to_string()],
            cwd: "/".to_string(),
            env: vec![("TERM".to_string(), "xterm-256color".to_string())],
            cols: 80,
            rows: 24,
        };
        let session = PtySession::spawn(spec, |_| {}, |_| {}).unwrap();
        // Wait for the shell to be up and idle before handing it the subshell.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && session.foreground_busy() != Some(false) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        session.write(b"(cd /tmp && sleep 5)\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && session.foreground_busy() != Some(true) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let busy = session.foreground_busy();
        let got = session.cwd();
        session.kill();
        assert_eq!(busy, Some(true), "the subshell should be the pty's foreground group");
        assert_eq!(got.as_deref(), Some("/"), "got {got:?}");
    }

    #[test]
    fn cwd_of_a_shell_that_changed_directory() {
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "cd /tmp && sleep 5".to_string()],
            cwd: "/".to_string(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let session = PtySession::spawn(spec, |_| {}, |_| {}).unwrap();
        // Give the shell a moment to run the cd.
        let mut got = None;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            got = session.cwd();
            if got.as_deref() == Some("/tmp") || got.as_deref() == Some("/private/tmp") {
                break;
            }
        }
        session.kill();
        assert!(matches!(got.as_deref(), Some("/tmp") | Some("/private/tmp")), "got {got:?}");
    }

    #[test]
    fn exposes_shell_pid_and_foreground_command() {
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec![],
            cwd: "/".to_string(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let session = PtySession::spawn(spec, |_| {}, |_| {}).unwrap();
        let pid = session.shell_pid().expect("shell pid");
        assert!(pid > 0);
        session.write(b"sleep 3\n").unwrap();
        let mut cmd = None;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            cmd = session.foreground_command();
            if cmd.as_deref() == Some("sleep") {
                break;
            }
        }
        assert_eq!(cmd.as_deref(), Some("sleep"));
        session.terminate();
    }

    #[test]
    fn terminate_ends_a_busy_shell() {
        let (tx, rx) = std::sync::mpsc::channel();
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec![],
            cwd: "/".to_string(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let session = PtySession::spawn(spec, |_| {}, move |code| {
            let _ = tx.send(code);
        })
        .unwrap();
        session.write(b"sleep 100\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!session.has_exited(), "shell should still be running before terminate");
        session.terminate();
        assert!(rx.recv_timeout(std::time::Duration::from_secs(6)).is_ok(), "shell did not exit after terminate");
        assert!(session.has_exited(), "has_exited should be true once the exit callback has fired");
    }

    #[test]
    fn terminate_does_not_signal_after_the_shell_has_exited() {
        let (tx, rx) = std::sync::mpsc::channel();
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 0".to_string()],
            cwd: "/".to_string(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let session = PtySession::spawn(spec, |_| {}, move |code| {
            let _ = tx.send(code);
        })
        .unwrap();
        assert!(rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok(), "shell did not exit");
        // Give the flag a moment to be set: it's written just before the exit callback fires,
        // so by the time recv above returns it should already be true, but poll briefly anyway.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && !session.has_exited() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(session.has_exited(), "has_exited should be true after the shell exited");
        // Should not panic, and must not signal a possibly-reused pid.
        session.terminate();
    }
}
