use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use swarmz_tool::hold::HoldResult;

/// Comfortably above `hold`'s own limits (a 10 s per-tile lock wait plus a 5 s start wait), so the
/// app only gives up on a `hold` that is genuinely stuck.
const HOLD_TIMEOUT: Duration = Duration::from_secs(20);

pub fn installed_path_in(home: &Path) -> PathBuf {
    home.join(".swarmz").join("bin").join("swarmz")
}

pub fn installed_path() -> PathBuf {
    installed_path_in(&PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string())))
}

/// The copy shipped next to the app's own executable (`Contents/MacOS/swarmz-tool` in the
/// bundle, `target/<profile>/swarmz-tool` in development).
pub fn bundled_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("swarmz-tool");
    p.is_file().then_some(p)
}

/// Copies `src` to `dest` (mode 0755, atomically) unless it already has the same bytes.
pub fn install_from(src: &Path, dest: &Path) -> Result<bool, String> {
    let bytes = std::fs::read(src).map_err(|e| format!("could not read {}: {e}", src.display()))?;
    if std::fs::read(dest).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(false);
    }
    let parent = dest.parent().ok_or_else(|| format!("{} has no parent", dest.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    // Unique per call, not just per process: two threads installing at once must never write
    // into (or rename away) each other's temporary file.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dest.with_extension(format!("tmp-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
    let written = std::fs::write(&tmp, &bytes)
        .map_err(|e| format!("could not write {}: {e}", tmp.display()))
        .and_then(|_| std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string()))
        .and_then(|_| std::fs::rename(&tmp, dest).map_err(|e| format!("could not install {}: {e}", dest.display())));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map(|_| true)
}

/// The installed tool, refreshed from the bundled copy when that differs. The comparison runs
/// once per app run (and again only if the installed copy disappears), under a lock, because
/// every tile start calls this and many tiles start at once.
pub fn ensure_installed() -> Result<PathBuf, String> {
    static CHECKED: Mutex<bool> = Mutex::new(false);
    let mut checked = CHECKED.lock().unwrap_or_else(|e| e.into_inner());
    let dest = installed_path();
    if !*checked || !dest.is_file() {
        if let Some(src) = bundled_path() {
            install_from(&src, &dest)?;
        }
        *checked = true;
    }
    if dest.is_file() {
        Ok(dest)
    } else {
        Err("the swarmz tool is not installed and no bundled copy was found".into())
    }
}

/// Runs `swarmz hold` for a tile (the folder must exist unless the session is already live).
pub fn hold(tool: &Path, home: Option<&Path>, id: &str, name: &str, cwd: &str, cols: u16, rows: u16) -> Result<HoldResult, String> {
    hold_with_env(tool, home, &[], id, name, cwd, cols, rows)
}

/// `hold` with extra environment for the `hold` process itself (tests pick the holder's shell
/// this way instead of mutating the test process's environment).
#[allow(clippy::too_many_arguments)]
fn hold_with_env(
    tool: &Path,
    home: Option<&Path>,
    env: &[(&str, &str)],
    id: &str,
    name: &str,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<HoldResult, String> {
    let mut cmd = Command::new(tool);
    cmd.args(["hold", id, "--cwd", cwd, "--name", name, "--cols", &cols.to_string(), "--rows", &rows.to_string(), "--require-cwd"]);
    if let Some(h) = home {
        cmd.env("HOME", h);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let done = crate::remote::run_with_timeout(cmd, HOLD_TIMEOUT, "swarmz")?;
    let v: serde_json::Value = serde_json::from_str(done.stdout.trim())
        .map_err(|e| format!("swarmz hold returned something unreadable ({e}): {}", done.stderr.trim()))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    serde_json::from_value(v).map_err(|e| format!("swarmz hold returned an unexpected result: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = PathBuf::from(format!("/tmp/szb-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn install_copies_once_and_replaces_changed_bytes() {
        let d = tmp("inst");
        let src = d.join("src-tool");
        std::fs::write(&src, b"v1").unwrap();
        let dest = installed_path_in(&d);
        assert!(install_from(&src, &dest).unwrap());
        assert!(!install_from(&src, &dest).unwrap());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o755);
        std::fs::write(&src, b"v2").unwrap();
        assert!(install_from(&src, &dest).unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), b"v2");
        let _ = std::fs::remove_dir_all(&d);
    }

    fn built_tool() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let status = std::process::Command::new(env!("CARGO"))
            .args(["build", "-p", "swarmz-tool"])
            .current_dir(&manifest)
            .status()
            .unwrap();
        assert!(status.success(), "building swarmz-tool failed");
        manifest.join("target/debug/swarmz-tool")
    }

    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// Kills the holder if the test fails before terminating it, so no holder outlives a run.
    struct KillOnFail(u32, bool);
    impl Drop for KillOnFail {
        fn drop(&mut self) {
            if !self.1 && alive(self.0) {
                unsafe {
                    libc::kill(self.0 as i32, libc::SIGKILL);
                }
            }
        }
    }

    #[test]
    fn hold_starts_a_session_the_app_can_connect_to_and_reports_missing_folders() {
        let tool = built_tool();
        let home = tmp("hold");
        let sh = [("SWARMZ_HOLDER_SHELL", "/bin/sh")];
        let cwd = home.to_string_lossy().into_owned();
        let r = hold_with_env(&tool, Some(&home), &sh, "a1", "one", &cwd, 80, 24).unwrap();
        let mut guard = KillOnFail(r.pid, false);
        assert!(!r.existed);
        let again = hold_with_env(&tool, Some(&home), &sh, "a1", "one", "/not/there", 80, 24).unwrap();
        assert!(again.existed, "a live session is found even if its folder is gone");
        let err = hold_with_env(&tool, Some(&home), &sh, "a2", "two", "/not/there", 80, 24).unwrap_err();
        assert!(err.contains("/not/there is not a directory"), "{err}");
        let hello = swarmz_tool::proto::Hello { v: swarmz_tool::proto::PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
        let client = swarmz_tool::client::HolderClient::connect(std::path::Path::new(&r.socket), &hello, |_, _| {}, |_| {}).unwrap();
        let s: &dyn crate::session::TerminalSession = &client;
        assert_eq!(s.foreground_busy(), Some(false));
        let real = std::fs::canonicalize(&home).unwrap();
        assert_eq!(s.cwd().map(PathBuf::from), Some(real));
        // Terminating and dropping at once (what closing a tile does) still ends the holder.
        s.terminate();
        drop(client);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while alive(r.pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!alive(r.pid), "the holder is still running after terminate");
        guard.1 = true;
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn concurrent_info_calls_each_get_an_answer() {
        let tool = built_tool();
        let home = tmp("info");
        let cwd = home.to_string_lossy().into_owned();
        let r = hold_with_env(&tool, Some(&home), &[("SWARMZ_HOLDER_SHELL", "/bin/sh")], "c1", "c", &cwd, 80, 24).unwrap();
        let mut guard = KillOnFail(r.pid, false);
        let hello = swarmz_tool::proto::Hello { v: swarmz_tool::proto::PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
        let client = std::sync::Arc::new(
            swarmz_tool::client::HolderClient::connect(std::path::Path::new(&r.socket), &hello, |_, _| {}, |_| {}).unwrap(),
        );
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let c = client.clone();
                std::thread::spawn(move || {
                    let s: &dyn crate::session::TerminalSession = &*c;
                    if i % 2 == 0 { s.foreground_busy().is_some() } else { s.cwd().is_some() }
                })
            })
            .collect();
        for t in threads {
            assert!(t.join().unwrap(), "a concurrent info call got no answer");
        }
        crate::session::TerminalSession::terminate(&*client);
        drop(client);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while alive(r.pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!alive(r.pid));
        guard.1 = true;
        let _ = std::fs::remove_dir_all(&home);
    }
}
