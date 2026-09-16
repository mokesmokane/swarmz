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
    bundled_candidate().filter(|p| p.is_file())
}

fn bundled_candidate() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join("swarmz-tool"))
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
            match install_from(&src, &dest) {
                Ok(_) => {}
                // An older installed copy still runs sessions; better than none.
                Err(e) if dest.is_file() => eprintln!("swarmz: keeping the installed tool: {e}"),
                Err(e) => return Err(e),
            }
        }
        *checked = true;
    }
    if dest.is_file() {
        Ok(dest)
    } else {
        let bundled = bundled_candidate().map(|p| p.display().to_string()).unwrap_or_else(|| "(unknown)".into());
        Err(format!(
            "the swarmz tool is not installed at {} and no bundled copy was found at {bundled}",
            dest.display()
        ))
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

/// Rust's architecture name against `uname -m`'s.
pub fn arch_matches(rust_arch: &str, uname: &str) -> bool {
    let uname = uname.trim();
    match rust_arch {
        "aarch64" => uname == "arm64" || uname == "aarch64",
        other => !uname.is_empty() && other == uname,
    }
}

/// True when `uname -sm`'s output names a Darwin machine whose architecture matches
/// `rust_arch`. This app never ships a tool build for anything else.
pub fn remote_platform_matches(rust_arch: &str, uname_sm: &str) -> bool {
    let mut parts = uname_sm.trim().split_whitespace();
    let os = parts.next().unwrap_or("");
    let machine = parts.next().unwrap_or("");
    os == "Darwin" && arch_matches(rust_arch, machine)
}

/// Remote shell command that installs stdin as `~/.swarmz/bin/swarmz` only when exactly `len`
/// bytes arrived.
pub fn remote_install_command(len: usize) -> String {
    format!(
        "mkdir -p ~/.swarmz/bin && cat > ~/.swarmz/bin/swarmz.tmp.$$ && [ \"$(wc -c < ~/.swarmz/bin/swarmz.tmp.$$ | tr -d ' ')\" -eq {len} ] && chmod 755 ~/.swarmz/bin/swarmz.tmp.$$ && mv -f ~/.swarmz/bin/swarmz.tmp.$$ ~/.swarmz/bin/swarmz || {{ rm -f ~/.swarmz/bin/swarmz.tmp.$$; exit 1; }}"
    )
}

/// Deletes install temp files left behind by a crashed or killed install more than 10 minutes
/// ago. Never touches a temp file young enough that a concurrent install might still own it.
pub fn remote_sweep_command() -> &'static str {
    "find ~/.swarmz/bin -name 'swarmz.tmp.*' -mmin +10 -delete 2>/dev/null; true"
}

/// The probe run by `remote_ready`: labelled `uname:`/`version:`/`sum:` lines so parsing never
/// depends on their order, even if login-shell startup prints banners around them.
fn remote_probe_command() -> &'static str {
    "echo \"uname:$(uname -sm)\"; v=$(~/.swarmz/bin/swarmz version 2>/dev/null); echo \"version:$v\"; s=$(cksum < ~/.swarmz/bin/swarmz 2>/dev/null); echo \"sum:$s\"; true"
}

/// Pulls the `uname:`, `version:` and `sum:` labelled values out of `remote_probe_command`'s
/// stdout. `version`/`sum` are `None` when the label's value was blank (tool or file missing).
fn parse_probe(stdout: &str) -> (String, Option<String>, Option<String>) {
    let mut uname = String::new();
    let mut version = None;
    let mut sum = None;
    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("uname:") {
            uname = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("version:") {
            version = Some(v.trim().to_string()).filter(|s| !s.is_empty());
        } else if let Some(v) = line.strip_prefix("sum:") {
            sum = Some(v.trim().to_string()).filter(|s| !s.is_empty());
        }
    }
    (uname, version, sum)
}

/// Parses a `swarmz version` reply (`{"v":1,"tool":"<version>","protocol":N}`) into
/// `(protocol, tool)`. `None` when it isn't that shape.
fn parse_version(text: &str) -> Option<(u64, String)> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let protocol = v["protocol"].as_u64()?;
    let tool = v["tool"].as_str()?.to_string();
    Some((protocol, tool))
}

/// Compares dot-separated numeric version strings component-wise (`"1.2" == "1.2.0"`); a
/// non-numeric or missing component compares as 0, so unparsable text is never "newer".
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::Equal;
    let parts = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        match pa.get(i).copied().unwrap_or(0).cmp(&pb.get(i).copied().unwrap_or(0)) {
            Equal => continue,
            other => return other,
        }
    }
    Equal
}

/// Whether `remote_ready` should (re)install our exact bytes onto the remote machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallDecision {
    Install,
    Skip,
}

/// Decides `Install` vs `Skip` from our own `(protocol, tool version)`, the remote probe's
/// parsed `(protocol, tool version)` (`None` when the remote tool is missing or its `version`
/// output was unreadable), and whether the two binaries' checksums matched.
///
/// Installs when the remote is missing/unreadable, on a different protocol, or running an
/// older tool version; also when the tool versions are equal but the checksums differ (dev
/// builds, which share a version string across rebuilds). Skips only when the protocol already
/// matches and the remote's tool version is newer, or equal with a matching checksum.
pub fn decide_install(local_protocol: u64, local_tool: &str, remote: Option<(u64, &str)>, sums_match: bool) -> InstallDecision {
    let Some((remote_protocol, remote_tool)) = remote else {
        return InstallDecision::Install;
    };
    if remote_protocol != local_protocol {
        return InstallDecision::Install;
    }
    use std::cmp::Ordering::{Equal, Less};
    match version_cmp(remote_tool, local_tool) {
        Less => InstallDecision::Install,
        Equal if !sums_match => InstallDecision::Install,
        _ => InstallDecision::Skip,
    }
}

fn ssh_run(host: &str, remote: &str, input: Option<&[u8]>, secs: u64) -> Result<crate::remote::Finished, String> {
    let host = crate::remote::validate_host(host)?;
    let mut cmd = crate::agents::ssh_command(&host)?;
    cmd.arg(remote);
    crate::remote::run_with_timeout_input(cmd, Duration::from_secs(secs), "ssh", input)
}

/// Ensures `host` has this app's tool, installing (or reinstalling) it when `decide_install`
/// calls for it.
///
/// Returns `Err` when the host isn't reachable, the local tool can't be read or asked its own
/// version, or an install was attempted and failed. Returns `Ok(false)` when the remote machine
/// isn't a matching Darwin build (nothing is uploaded), or an install completed but the remote
/// tool still doesn't speak our protocol afterwards. Returns `Ok(true)` when the remote tool,
/// already or after installing, speaks our protocol.
pub fn remote_ready(host: &str) -> Result<bool, String> {
    let local = bundled_path().or_else(|| Some(installed_path()).filter(|p| p.is_file())).ok_or("no local swarmz tool to copy")?;
    let local_bytes = std::fs::read(&local).map_err(|e| e.to_string())?;

    let probe = ssh_run(host, remote_probe_command(), None, 10)?;
    if !probe.status.success() {
        return Err(format!("not reachable: {}", probe.stderr.trim()));
    }
    let (uname, version, sum) = parse_probe(&probe.stdout);
    if !remote_platform_matches(std::env::consts::ARCH, &uname) {
        return Ok(false);
    }

    let local_version_out = {
        let mut c = Command::new(&local);
        c.arg("version");
        crate::remote::run_with_timeout(c, Duration::from_secs(5), "swarmz")?
    };
    let (local_protocol, local_tool) = parse_version(&local_version_out.stdout)
        .ok_or_else(|| format!("the local swarmz tool at {} returned an unreadable version", local.display()))?;
    let local_sum = {
        let mut c = Command::new("cksum");
        c.stdin(std::process::Stdio::piped());
        let out = crate::remote::run_with_timeout_input(c, Duration::from_secs(5), "cksum", Some(&local_bytes))?;
        out.stdout.trim().to_string()
    };
    let sums_match = sum.as_deref() == Some(local_sum.as_str());
    let remote_version = version.as_deref().and_then(parse_version);
    let remote_for_decision = remote_version.as_ref().map(|(p, t)| (*p, t.as_str()));

    if decide_install(local_protocol, &local_tool, remote_for_decision, sums_match) == InstallDecision::Skip {
        return Ok(true);
    }

    // Best-effort hygiene: a crashed install long ago can leave a temp file behind forever.
    // Never blocks the install itself on failure (e.g. no permission to list the directory yet).
    let _ = ssh_run(host, remote_sweep_command(), None, 10);
    let secs = 30 + (local_bytes.len() as u64) / 64_000;
    let done = ssh_run(host, &remote_install_command(local_bytes.len()), Some(&local_bytes), secs)?;
    if !done.status.success() {
        return Err(if done.stderr.trim().is_empty() { "could not install the swarmz tool".into() } else { done.stderr.trim().to_string() });
    }
    let check = ssh_run(host, "~/.swarmz/bin/swarmz version", None, 10)?;
    Ok(parse_version(&check.stdout).map(|(p, _)| p) == Some(local_protocol))
}

/// Turns the tool's own JSON reply into `Err` when it carries an `error` field, or when the
/// output can't be parsed as JSON at all (the message then includes the process's stderr,
/// trimmed) — mirroring what `hold_with_env` already does for `hold`.
fn parse_tool_reply(stdout: &str, stderr: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("unreadable reply ({e}): {}", stderr.trim()))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    Ok(v)
}

/// The remote tool's `info` for a tile.
pub fn remote_info(host: &str, id: &str) -> Result<serde_json::Value, String> {
    if !swarmz_tool::paths::valid_tile_id(id) {
        return Err(format!("invalid tile id {id:?}"));
    }
    let done = ssh_run(host, &format!("~/.swarmz/bin/swarmz info {id}"), None, 10)?;
    parse_tool_reply(&done.stdout, &done.stderr)
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
        let target = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| manifest.join("target"));
        let target = if target.is_absolute() { target } else { manifest.join(target) };
        target.join("debug/swarmz-tool")
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

    #[test]
    fn architectures_match_between_rust_and_uname_names() {
        assert!(arch_matches("aarch64", "arm64"));
        assert!(arch_matches("x86_64", "x86_64"));
        assert!(!arch_matches("aarch64", "x86_64"));
        assert!(!arch_matches("aarch64", ""));
    }

    #[test]
    fn remote_install_writes_only_a_complete_copy() {
        let d = tmp("rinst");
        let payload = b"tool-bytes-123";
        let run = |bytes: &[u8]| {
            let mut child = std::process::Command::new("sh")
                .arg("-c")
                .arg(remote_install_command(payload.len()))
                .env("HOME", &d)
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            child.stdin.take().unwrap().write_all(bytes).unwrap();
            child.wait().unwrap()
        };
        assert!(!run(b"short").success());
        assert!(!installed_path_in(&d).exists());
        assert!(run(payload).success());
        assert_eq!(std::fs::read(installed_path_in(&d)).unwrap(), payload);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(installed_path_in(&d)).unwrap().permissions().mode() & 0o777, 0o755);
        let leftovers: Vec<_> = std::fs::read_dir(d.join(".swarmz/bin")).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("tmp")).collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn remote_platform_requires_darwin_and_a_matching_machine() {
        assert!(remote_platform_matches("aarch64", "Darwin arm64"));
        assert!(remote_platform_matches("x86_64", "Darwin x86_64"));
        assert!(!remote_platform_matches("aarch64", "Linux arm64"));
        assert!(!remote_platform_matches("aarch64", "Darwin x86_64"));
        assert!(!remote_platform_matches("aarch64", ""));
    }

    #[test]
    fn parse_probe_reads_labelled_lines_regardless_of_banner_noise_and_order() {
        let out = "welcome banner\nuname:Darwin arm64\nversion:{\"v\":1,\"tool\":\"1.2.0\",\"protocol\":2}\nsum:1234 999\n";
        let (uname, version, sum) = parse_probe(out);
        assert_eq!(uname, "Darwin arm64");
        assert_eq!(version.as_deref(), Some("{\"v\":1,\"tool\":\"1.2.0\",\"protocol\":2}"));
        assert_eq!(sum.as_deref(), Some("1234 999"));
    }

    #[test]
    fn parse_probe_treats_blank_labelled_values_as_absent() {
        let (uname, version, sum) = parse_probe("uname:Darwin arm64\nversion:\nsum:\n");
        assert_eq!(uname, "Darwin arm64");
        assert_eq!(version, None);
        assert_eq!(sum, None);
    }

    #[test]
    fn version_cmp_compares_numeric_dot_separated_parts() {
        assert_eq!(version_cmp("1.2.0", "1.2"), std::cmp::Ordering::Equal);
        assert_eq!(version_cmp("1.10.0", "1.9.0"), std::cmp::Ordering::Greater);
        assert_eq!(version_cmp("1.2.0", "1.2.1"), std::cmp::Ordering::Less);
        assert_eq!(version_cmp("abc", "1.0.0"), std::cmp::Ordering::Less);
    }

    #[test]
    fn decide_install_when_remote_version_is_missing_or_unreadable() {
        assert_eq!(decide_install(2, "1.2.0", None, false), InstallDecision::Install);
    }

    #[test]
    fn decide_install_when_protocol_differs() {
        assert_eq!(decide_install(2, "1.2.0", Some((1, "9.9.9")), true), InstallDecision::Install);
    }

    #[test]
    fn decide_install_when_remote_tool_is_older() {
        assert_eq!(decide_install(2, "1.3.0", Some((2, "1.2.9")), true), InstallDecision::Install);
    }

    #[test]
    fn decide_install_when_versions_match_but_checksums_differ() {
        assert_eq!(decide_install(2, "1.2.0", Some((2, "1.2.0")), false), InstallDecision::Install);
    }

    #[test]
    fn decide_install_skips_when_versions_and_checksums_match() {
        assert_eq!(decide_install(2, "1.2.0", Some((2, "1.2.0")), true), InstallDecision::Skip);
    }

    #[test]
    fn decide_install_skips_a_newer_remote_on_the_same_protocol() {
        assert_eq!(decide_install(2, "1.2.0", Some((2, "1.3.0")), false), InstallDecision::Skip);
    }

    #[test]
    fn remote_sweep_deletes_only_stale_temp_files() {
        let d = tmp("rsweep");
        let setup = "mkdir -p ~/.swarmz/bin && touch ~/.swarmz/bin/swarmz.tmp.fresh && touch -t $(date -v-20M +%Y%m%d%H%M) ~/.swarmz/bin/swarmz.tmp.stale";
        let script = format!("{setup} && {}", remote_sweep_command());
        let status = std::process::Command::new("sh").arg("-c").arg(&script).env("HOME", &d).status().unwrap();
        assert!(status.success());
        assert!(d.join(".swarmz/bin/swarmz.tmp.fresh").exists());
        assert!(!d.join(".swarmz/bin/swarmz.tmp.stale").exists());
    }

    #[test]
    fn parse_tool_reply_surfaces_the_tools_own_error() {
        let err = parse_tool_reply("{\"v\":1,\"error\":\"tile x1 is not running\",\"code\":\"failed\"}\n", "").unwrap_err();
        assert_eq!(err, "tile x1 is not running");
    }

    #[test]
    fn parse_tool_reply_rejects_garbage_output_and_reports_stderr() {
        let err = parse_tool_reply("not json at all", "ssh: Could not resolve hostname").unwrap_err();
        assert!(err.contains("Could not resolve hostname"), "{err}");
    }

    #[test]
    fn parse_tool_reply_rejects_empty_output() {
        let err = parse_tool_reply("", "").unwrap_err();
        assert!(err.contains("unreadable"), "{err}");
    }
}
