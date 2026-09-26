use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use swarmz_tool::client::HolderClient;
use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};

const EXE: &str = env!("CARGO_BIN_EXE_swarmz-tool");

/// A per-test HOME under /tmp. Dropping it -- including when a failed `assert!` unwinds the test
/// -- terminates every holder `track()` was told about and removes the directory, so a failing
/// test never leaks a detached holder process or a stale `/tmp/szc-*` tree behind it.
struct TestHome {
    path: PathBuf,
    sockets: Mutex<Vec<String>>,
}

impl TestHome {
    fn new(tag: &str) -> Arc<TestHome> {
        let h = PathBuf::from(format!("/tmp/szc-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        Arc::new(TestHome { path: h, sockets: Mutex::new(Vec::new()) })
    }

    fn track(&self, socket: &str) {
        self.sockets.lock().unwrap().push(socket.to_string());
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        for s in self.sockets.get_mut().unwrap().drain(..) {
            end(&s);
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn home(tag: &str) -> Arc<TestHome> {
    TestHome::new(tag)
}

/// Runs the tool and parses its stdout as JSON.
///
/// Deliberately avoids `Command::output()`'s piped stdout/stderr: on macOS, `pipe()` and marking
/// it close-on-exec are two separate syscalls, so concurrent `fork()`s from other threads of this
/// same (multi-threaded) test process can race that window and inherit the not-yet-CLOEXEC'd pipe
/// write end into an unrelated grandchild. A `hold` call spawns a detached, long-lived holder
/// that grandchild is exactly that: if it inherited our pipe, reading our stdout would then block
/// forever waiting for an EOF that never comes, since the holder still holds the write end open.
/// `concurrent_hold_for_the_same_tile_converges_on_one_holder` runs several `hold`s from several
/// threads at once and reproduced this hang before this function stopped using pipes. Writing
/// stdout to a private, uniquely-named file and waiting with `status()` (no pipes at all) sidesteps
/// the race entirely, for every caller, not just the concurrent one.
fn tool(home: &Path, args: &[&str]) -> (i32, serde_json::Value) {
    tool_env(home, args, &[])
}

/// `tool` with extra environment for the tool process.
fn tool_env(home: &Path, args: &[&str], env: &[(&str, &str)]) -> (i32, serde_json::Value) {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let out_path = std::env::temp_dir().join(format!("szc-out-{}-{seq}.json", std::process::id()));
    let stdout = std::fs::File::create(&out_path).unwrap();
    let status = tool_command(home)
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null())
        .status()
        .unwrap();
    let bytes = std::fs::read(&out_path).unwrap_or_default();
    let _ = std::fs::remove_file(&out_path);
    let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status.code().unwrap_or(-1), v)
}

/// `tool_env` with bytes on stdin (for `upload`).
fn tool_env_input(home: &Path, args: &[&str], env: &[(&str, &str)], input: &[u8]) -> (i32, serde_json::Value) {
    let mut child = tool_command(home)
        .args(args)
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all(input);
    }
    let out = child.wait_with_output().unwrap();
    let v = serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
    (out.status.code().unwrap_or(-1), v)
}

/// A PATH without the developer's own tools: a session that types a Claude line must never start
/// the real Claude Code installed on this Mac.
const SAFE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// The tool with this test's HOME, a plain `/bin/sh` for holders, and `SAFE_PATH`.
fn tool_command(home: &Path) -> Command {
    let mut cmd = Command::new(EXE);
    cmd.env("HOME", home).env("SWARMZ_HOLDER_SHELL", "/bin/sh").env("PATH", SAFE_PATH);
    // The tests may themselves run inside a swarmz tile: the tool must not take that tile's
    // identity (the conductor guard reads it). Tests that act as a tile set it explicitly.
    cmd.env_remove("SWARMZ_TERMINAL_ID").env_remove("SWARMZ_TERMINAL_NAME");
    cmd
}

/// A spawned long-running tool process, killed and reaped when the test ends, pass or fail.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        // Only a child not yet reaped is signalled: its pid cannot have been reused.
        if let Ok(None) = self.0.try_wait() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

/// `KillOnDrop` for a tool process on a pty.
struct PtyChild(Box<dyn portable_pty::Child + Send + Sync>);

impl std::ops::Deref for PtyChild {
    type Target = Box<dyn portable_pty::Child + Send + Sync>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for PtyChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        // portable-pty's `kill` signals `id()` even after the child was reaped, when the pid may
        // already belong to someone else: only signal a child that is still ours.
        if let Ok(None) = self.0.try_wait() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn end(socket: &str) {
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "tool".into() };
    if let Ok(c) = HolderClient::connect(Path::new(socket), &hello, |_, _| {}, |_| {}) {
        let _ = c.terminate();
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn pid_alive(pid: i64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn version_prints_tool_and_protocol() {
    let h = home("ver");
    let (code, v) = tool(&h.path, &["version"]);
    assert_eq!(code, 0);
    assert_eq!(v["v"], 1);
    assert_eq!(v["protocol"], PROTOCOL_VERSION);
    assert!(v["tool"].as_str().is_some());
    assert!(v["build"].as_u64().is_some_and(|b| b > 0), "{v}");
}

fn wait_dead(pid: i64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

#[test]
fn close_ends_a_running_session_and_says_when_there_was_none() {
    let h = home("close");
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, a) = tool(&h.path, &["hold", "t10", "--cwd", &cwd, "--name", "ten"]);
    assert_eq!(code, 0, "{a}");
    h.track(a["socket"].as_str().unwrap());
    let pid = a["pid"].as_i64().unwrap();
    // Something busy in the foreground, as a Claude would be.
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
    let c = HolderClient::connect(Path::new(a["socket"].as_str().unwrap()), &hello, |_, _| {}, |_| {}).unwrap();
    c.write(b"sleep 100\n").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let (code, v) = tool(&h.path, &["close", "t10"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v, serde_json::json!({ "v": 1, "closed": true }));
    assert!(wait_dead(pid), "the holder is still running after close");
    let (code, info) = tool(&h.path, &["info", "t10"]);
    assert_eq!((code, &info["running"]), (0, &serde_json::json!(false)));
    let (code, again) = tool(&h.path, &["close", "t10"]);
    assert_eq!(code, 0, "{again}");
    assert_eq!(again, serde_json::json!({ "v": 1, "closed": false }));
    let (code, never) = tool(&h.path, &["close", "nothing-here"]);
    assert_eq!((code, never["closed"].as_bool()), (0, Some(false)), "{never}");
    let (code, bad) = tool(&h.path, &["close", "../x"]);
    assert_eq!((code, bad["code"].as_str()), (1, Some("invalid")), "{bad}");
    let (code, extra) = tool(&h.path, &["close"]);
    assert_eq!((code, extra["code"].as_str()), (1, Some("usage")), "{extra}");
}

#[test]
fn the_holder_runs_from_root_and_its_shell_drops_stale_ssh_variables() {
    let h = home("holder-env");
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, a) = tool_env(
        &h.path,
        &["hold", "t13", "--cwd", &cwd, "--name", "thirteen", "--env", "SSH_CLIENT=explicit"],
        &[("SSH_AUTH_SOCK", "/stale/agent"), ("SSH_TTY", "/dev/ttys999"), ("SSH_CONNECTION", "1 2 3 4"), ("SSH_CLIENT", "1 2 3")],
    );
    assert_eq!(code, 0, "{a}");
    h.track(a["socket"].as_str().unwrap());
    let pid = a["pid"].as_i64().unwrap();
    let lsof = Command::new("lsof").args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).output().unwrap();
    let text = String::from_utf8_lossy(&lsof.stdout).into_owned();
    assert!(text.lines().any(|l| l == "n/"), "the holder should run from /: {text:?}");
    let (_, info) = tool(&h.path, &["info", "t13"]);
    let real = std::fs::canonicalize(&h.path).unwrap();
    assert_eq!(info["cwd"], real.to_string_lossy().as_ref(), "the shell still starts in the tile folder");

    let out = Arc::new(Mutex::new(Vec::new()));
    let o = out.clone();
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
    let c = HolderClient::connect(Path::new(a["socket"].as_str().unwrap()), &hello, move |b, _| o.lock().unwrap().extend(b), |_| {}).unwrap();
    c.write(b"echo \"ssh=[$SSH_AUTH_SOCK][$SSH_TTY][$SSH_CONNECTION][$SSH_CLIENT]\"\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !String::from_utf8_lossy(&out.lock().unwrap()).contains("ssh=[][][][explicit]") {
        assert!(Instant::now() < deadline, "stale ssh variables reached the shell: {}", String::from_utf8_lossy(&out.lock().unwrap()));
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn the_holder_drops_claude_codes_own_environment() {
    let h = home("holder-claude-env");
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, a) = tool_env(
        &h.path,
        &["hold", "t14", "--cwd", &cwd, "--name", "fourteen"],
        &[("CLAUDE_CODE_CHILD_SESSION", "1"), ("CLAUDECODE", "1"), ("CLAUDE_PID", "5")],
    );
    assert_eq!(code, 0, "{a}");
    h.track(a["socket"].as_str().unwrap());

    let out = Arc::new(Mutex::new(Vec::new()));
    let o = out.clone();
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
    let c = HolderClient::connect(Path::new(a["socket"].as_str().unwrap()), &hello, move |b, _| o.lock().unwrap().extend(b), |_| {}).unwrap();
    c.write(b"echo \"claude=[$CLAUDE_CODE_CHILD_SESSION][$CLAUDECODE][$CLAUDE_PID]\"\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !String::from_utf8_lossy(&out.lock().unwrap()).contains("claude=[][][]") {
        assert!(Instant::now() < deadline, "Claude Code's own variables reached the shell: {}", String::from_utf8_lossy(&out.lock().unwrap()));
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn attach_refuses_to_attach_the_tile_it_runs_in() {
    let h = home("attach-self");
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, e) = tool_env(&h.path, &["attach", "t11", "--cwd", &cwd], &[("SWARMZ_TERMINAL_ID", "t11")]);
    assert_eq!(code, 1, "{e}");
    assert_eq!(e["code"], "self");
    let (_, info) = tool(&h.path, &["info", "t11"]);
    assert_eq!(info["running"], false, "no session may be started for a refused attach");
}

#[test]
fn a_failed_attach_prints_only_its_error() {
    let h = home("attach-fail");
    let dir = swarmz_tool::paths::sessions_dir_in(&h.path);
    swarmz_tool::paths::ensure_dir(&dir).unwrap();
    let paths = swarmz_tool::paths::session_paths(&dir, "t12").unwrap();
    // A "holder" that is live by every check `hold` makes, but hangs up on every viewer.
    let listener = UnixListener::bind(&paths.socket).unwrap();
    std::thread::spawn(move || {
        for s in listener.incoming() {
            drop(s);
        }
    });
    let meta = swarmz_tool::paths::Meta {
        v: PROTOCOL_VERSION,
        pid: std::process::id(),
        shell_pid: None,
        cwd: "/".into(),
        name: "t12".into(),
        started_at: "t".into(),
        exited_at: None,
        exit_code: None,
        cwd_fallback: false,
        build: None,
        screen: false,
        terminating_at: None,
    };
    swarmz_tool::paths::write_meta(&paths.meta, &meta).unwrap();
    // `tool` parses the whole of stdout as one JSON value, so a marker ahead of it fails this.
    let (code, e) = tool(&h.path, &["attach", "t12"]);
    assert_eq!(code, 1, "{e}");
    assert_eq!(e["code"], "failed", "stdout must hold nothing but the error: {e}");
}

#[test]
fn hold_starts_once_then_finds_the_same_session() {
    let h = home("hold");
    let cwd = h.path.to_string_lossy().into_owned();
    let (c1, a) = tool(&h.path, &["hold", "t1", "--cwd", &cwd, "--name", "one", "--cols", "90", "--rows", "30"]);
    assert_eq!(c1, 0, "{a}");
    h.track(a["socket"].as_str().unwrap());
    assert_eq!(a["existed"], false);
    assert!(a["pid"].as_i64().unwrap() > 0);
    assert!(a["build"].as_u64().is_some_and(|b| b > 0), "a holder reports its build: {a}");
    let (c2, b) = tool(&h.path, &["hold", "t1", "--cwd", &cwd, "--name", "one"]);
    assert_eq!(c2, 0, "{b}");
    assert_eq!(b["existed"], true);
    assert_eq!(a["pid"], b["pid"]);
    let (c3, info) = tool(&h.path, &["info", "t1"]);
    assert_eq!(c3, 0, "{info}");
    assert_eq!(info["running"], true);
    let real = std::fs::canonicalize(&h.path).unwrap();
    assert_eq!(info["cwd"], real.to_string_lossy().as_ref());
}

#[test]
fn the_shell_carries_the_tile_id() {
    let h = home("env");
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, a) = tool(&h.path, &["hold", "t2", "--cwd", &cwd, "--name", "two", "--env", "EXTRA=yes"]);
    assert_eq!(code, 0, "{a}");
    h.track(a["socket"].as_str().unwrap());
    let out = Arc::new(Mutex::new(Vec::new()));
    let o = out.clone();
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
    let c = HolderClient::connect(Path::new(a["socket"].as_str().unwrap()), &hello, move |b, _| o.lock().unwrap().extend(b), |_| {}).unwrap();
    c.write(b"echo id=$SWARMZ_TERMINAL_ID/$SWARMZ_TERMINAL_NAME/$EXTRA/$TERM\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !String::from_utf8_lossy(&out.lock().unwrap()).contains("id=t2/two/yes/xterm-256color") {
        assert!(Instant::now() < deadline, "env not set: {}", String::from_utf8_lossy(&out.lock().unwrap()));
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = c.terminate();
    std::thread::sleep(Duration::from_millis(300));
}

#[test]
fn the_holder_outlives_the_process_that_started_it() {
    let h = home("orphan");
    let script = format!("'{EXE}' hold t3 --cwd '{}' --name three > '{}/out.json'; exit 0", h.path.display(), h.path.display());
    let status = Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .env("HOME", &h.path)
        .env("SWARMZ_HOLDER_SHELL", "/bin/sh")
        .env("PATH", SAFE_PATH)
        .status()
        .unwrap();
    assert!(status.success());
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(h.path.join("out.json")).unwrap()).unwrap();
    h.track(v["socket"].as_str().unwrap());
    let pid = v["pid"].as_i64().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(pid_alive(pid), "holder died with its starter");
    let ppid = Command::new("ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&ppid.stdout).trim(), "1", "holder should be reparented to launchd");
}

#[test]
fn missing_folders_fall_back_to_home_unless_required() {
    let h = home("cwd");
    let (code, e) = tool(&h.path, &["hold", "t4", "--cwd", "/definitely/not/here", "--name", "four", "--require-cwd"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "cwd_missing");
    assert!(e["error"].as_str().unwrap().contains("/definitely/not/here is not a directory"));
    let (code, v) = tool(&h.path, &["hold", "t4", "--cwd", "/definitely/not/here", "--name", "four"]);
    assert_eq!(code, 0, "{v}");
    h.track(v["socket"].as_str().unwrap());
    assert_eq!(v["cwdFallback"], true);
    assert_eq!(v["cwd"], h.path.to_string_lossy().as_ref());
}

#[test]
fn bad_input_is_a_json_error() {
    let h = home("bad");
    let (code, e) = tool(&h.path, &["hold", "a/b", "--cwd", "/tmp", "--name", "x"]);
    assert_eq!(code, 1);
    assert_eq!(e["v"], 1);
    assert!(e["error"].as_str().unwrap().contains("invalid tile id"));
    let (code, e) = tool(&h.path, &["nonsense"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn unknown_flags_are_rejected() {
    let h = home("unknown-flag");
    let (code, e) = tool(&h.path, &["hold", "t1", "--cwd", "/tmp", "--name", "x", "--bogus"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn extra_positional_arguments_are_rejected() {
    let h = home("extra-pos");
    let (code, e) = tool(&h.path, &["hold", "t1", "extra", "--cwd", "/tmp", "--name", "x"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn a_valued_option_needs_a_real_value() {
    let h = home("missing-val");
    // Missing entirely (end of args).
    let (code, e) = tool(&h.path, &["hold", "t1", "--cwd"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
    // Present but looks like another option.
    let (code, e) = tool(&h.path, &["hold", "t1", "--cwd", "--name", "x"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn bad_env_keys_are_rejected() {
    let h = home("bad-env");
    let (code, e) = tool(&h.path, &["hold", "t1", "--cwd", "/tmp", "--name", "x", "--env", "1BAD=yes"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn zero_rows_is_a_usage_error() {
    let h = home("rows-zero");
    let (code, e) = tool(&h.path, &["hold", "t1", "--cwd", "/tmp", "--name", "x", "--rows", "0"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn a_stale_record_is_replaced_by_a_fresh_session() {
    let h = home("stale");
    let dir = h.path.join(".swarmz/sessions");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("t5.json"), r#"{"v":1,"pid":999999,"shellPid":null,"cwd":"/","name":"x","startedAt":"t"}"#).unwrap();
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, v) = tool(&h.path, &["hold", "t5", "--cwd", &cwd, "--name", "five"]);
    assert_eq!(code, 0, "{v}");
    h.track(v["socket"].as_str().unwrap());
    assert_eq!(v["existed"], false);
    assert_ne!(v["pid"], 999999);
}

#[test]
fn info_for_a_missing_session_says_not_running() {
    let h = home("none");
    let (code, v) = tool(&h.path, &["info", "t6"]);
    assert_eq!(code, 0);
    assert_eq!(v["running"], false);
}

#[test]
fn hold_refuses_a_second_holder_when_the_socket_is_live_without_metadata() {
    let h = home("busy-no-meta");
    let dir = h.path.join(".swarmz/sessions");
    std::fs::create_dir_all(&dir).unwrap();
    // A live listener standing in for a holder that hasn't written `Meta` yet (or whose metadata
    // is unreadable): `live_session` reports None, but the socket is genuinely live. `hold` must
    // recognise this and refuse to bind a second holder over it, rather than treating it as free.
    let listener = UnixListener::bind(dir.join("t8.sock")).unwrap();
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, e) = tool(&h.path, &["hold", "t8", "--cwd", &cwd, "--name", "eight"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "busy");
    assert!(e["error"].as_str().unwrap().contains("without valid metadata"), "{e}");
    drop(listener);
}

#[test]
fn concurrent_hold_for_the_same_tile_converges_on_one_holder() {
    let h = home("concurrent");
    let cwd = h.path.to_string_lossy().into_owned();
    let attempts = 5;
    let handles: Vec<_> = (0..attempts)
        .map(|_| {
            let home_path = h.path.clone();
            let cwd = cwd.clone();
            std::thread::spawn(move || tool(&home_path, &["hold", "r1", "--cwd", &cwd, "--name", "r1"]))
        })
        .collect();
    let results: Vec<(i32, serde_json::Value)> = handles.into_iter().map(|j| j.join().unwrap()).collect();

    for (code, v) in &results {
        assert_eq!(*code, 0, "{v}");
    }
    let first_socket = results[0].1["socket"].as_str().unwrap().to_string();
    let first_pid = results[0].1["pid"].clone();
    for (_, v) in &results {
        assert_eq!(v["pid"], first_pid, "every caller should see the same holder: {v}");
        assert_eq!(v["socket"].as_str().unwrap(), first_socket, "every caller should see the same socket: {v}");
    }
    let existed_false = results.iter().filter(|(_, v)| v["existed"].as_bool() == Some(false)).count();
    assert_eq!(existed_false, 1, "exactly one caller should have started the holder: {results:?}");
    h.track(&first_socket);

    // Exactly one `__holder` process should exist for this tile. `pgrep -fl` matches and prints
    // the full command line, so filtering it by both the marker and this test's own cwd (unique
    // per test run) rules out any other test's holder for a similarly-named tile.
    let out = Command::new("pgrep").args(["-fl", "__holder r1"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let count = text.lines().filter(|l| l.contains(&cwd)).count();
    assert_eq!(count, 1, "expected exactly one holder for r1, found:\n{text}");
}

#[test]
fn the_holder_marks_a_leaked_pipe_fd_close_on_exec() {
    let h = home("fd-leak");
    let cwd = h.path.to_string_lossy().into_owned();

    // A pipe deliberately left without close-on-exec, standing in for the write end of some
    // *other*, unrelated `Command::output()` call's stdout pipe that a racing fork() (from
    // another thread, e.g. the app spawning several `hold`s at once) could hand to this `hold`
    // invocation -- see the comment in `hold()`'s `pre_exec` closure for why that race exists on
    // macOS. Rust's `Command` does not close arbitrary fds it doesn't know about, so if `hold`
    // (and, through it, the detached holder it spawns) doesn't mark it close-on-exec
    // deliberately, the write end leaks all the way down into a process that outlives this test
    // by days.
    let mut fds = [0i32; 2];
    let rc = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(rc, 0, "pipe() failed: {}", std::io::Error::last_os_error());
    let (read_fd, write_fd) = (fds[0], fds[1]);
    // Non-blocking so the poll loop below can enforce its own deadline instead of the raw `read`
    // blocking forever when the fix regresses (a blocking read would just trade one hang for
    // another).
    unsafe {
        libc::fcntl(read_fd, libc::F_SETFL, libc::O_NONBLOCK);
    }

    // `tool()` spawns `swarmz-tool hold` with plain `Command::spawn`, which inherits our open,
    // non-CLOEXEC `write_fd` exactly as an unrelated racing fork() would.
    let (code, v) = tool(&h.path, &["hold", "t7", "--cwd", &cwd, "--name", "seven"]);
    assert_eq!(code, 0, "{v}");
    h.track(v["socket"].as_str().unwrap());

    // Only a lingering copy in the holder should matter from here: close ours.
    unsafe {
        libc::close(write_fd);
    }

    // The holder is still alive. If it still holds the write end open, the kernel considers the
    // pipe to still have a writer and `read` never returns 0, however long we wait.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buf = [0u8; 1];
    let mut eof = false;
    loop {
        let n = unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, 1) };
        if n == 0 {
            eof = true;
            break;
        }
        if n < 0 {
            let err = std::io::Error::last_os_error();
            assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock, "unexpected read error: {err}");
        }
        if Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        libc::close(read_fd);
    }
    assert!(eof, "read end of the pipe never saw EOF: the holder is still holding a leaked fd open");
}

fn run_attach(
    h: &PathBuf,
    tile: &str,
) -> (PtyChild, std::sync::Arc<std::sync::Mutex<Vec<u8>>>, Box<dyn std::io::Write + Send>) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut cmd = CommandBuilder::new(EXE);
    cmd.args(["attach", tile, "--cwd", &h.to_string_lossy(), "--name", tile]);
    cmd.env("HOME", h);
    cmd.env("SWARMZ_HOLDER_SHELL", "/bin/sh");
    cmd.env("PATH", SAFE_PATH);
    let child = PtyChild(pair.slave.spawn_command(cmd).unwrap());
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer = pair.master.take_writer().unwrap();
    let out = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let o = out.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = std::io::Read::read(&mut reader, &mut buf) {
            if n == 0 {
                break;
            }
            o.lock().unwrap().extend_from_slice(&buf[..n]);
        }
    });
    std::mem::forget(pair.master);
    (child, out, writer)
}

fn wait_out(out: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>, needle: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if String::from_utf8_lossy(&out.lock().unwrap()).contains(needle) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn attach_bridges_a_terminal_and_reattaches_after_a_drop() {
    let h = home("attach");
    // Tracked up front (before any assertion that could unwind the test) so `TestHome`'s drop
    // guard terminates the holder even if this test fails partway through.
    let paths = swarmz_tool::paths::session_paths(&swarmz_tool::paths::sessions_dir_in(&h.path), "t7").unwrap();
    h.track(&paths.socket.to_string_lossy());
    let (mut child, out, mut w) = run_attach(&h.path, "t7");
    assert!(wait_out(&out, "\x1b]1337;swarmz-attach;new=1;end=1\x07"), "first attach must say new=1");
    assert!(wait_out(&out, swarmz_tool::attach::REPLAY_END_MARKER), "a new session's (empty) replay is marked too");
    std::io::Write::write_all(&mut w, b"echo bridged-$((2+3))\r").unwrap();
    assert!(wait_out(&out, "bridged-5"));
    // Simulate the ssh connection dropping.
    child.kill().unwrap();
    let _ = child.wait();
    std::thread::sleep(Duration::from_millis(300));
    let (_, info) = tool(&h.path, &["info", "t7"]);
    assert_eq!(info["running"], true, "the session must survive the bridge going away");
    let (mut child2, out2, mut w2) = run_attach(&h.path, "t7");
    assert!(wait_out(&out2, "\x1b]1337;swarmz-attach;new=0;end=1\x07"), "reattach must say new=0");
    assert!(wait_out(&out2, "bridged-5"), "reattach must replay the history");
    assert!(wait_out(&out2, swarmz_tool::attach::REPLAY_END_MARKER), "reattach must mark the end of the replay");
    {
        let text = String::from_utf8_lossy(&out2.lock().unwrap()).into_owned();
        let attach_at = text.find("\x1b]1337;swarmz-attach;new=0;end=1\x07").unwrap();
        let replay_at = text.find("\x1b[!p").expect("the replay prefix");
        let history_at = text.find("bridged-5").unwrap();
        let end_at = text.find(swarmz_tool::attach::REPLAY_END_MARKER).unwrap();
        assert!(attach_at < replay_at && replay_at < history_at && history_at < end_at, "order was wrong: {text:?}");
        assert_eq!(text.matches(swarmz_tool::attach::REPLAY_END_MARKER).count(), 1);
        assert_eq!(replay_at, attach_at + swarmz_tool::attach::marker(false).len(), "the replay must follow the attach marker directly: {text:?}");
    }
    std::io::Write::write_all(&mut w2, b"echo live-$((3+4))\r").unwrap();
    assert!(wait_out(&out2, "live-7"));
    {
        let text = String::from_utf8_lossy(&out2.lock().unwrap()).into_owned();
        let end_at = text.find(swarmz_tool::attach::REPLAY_END_MARKER).unwrap();
        assert!(text.rfind("live-7").unwrap() > end_at, "live output must follow the end marker");
    }
    std::io::Write::write_all(&mut w2, b"exit 4\r").unwrap();
    let status = child2.wait().unwrap();
    assert_eq!(status.exit_code(), 4);
}

#[test]
fn attach_reports_a_nonzero_exit_when_the_holder_vanishes() {
    let h = home("attach-vanish");
    let paths = swarmz_tool::paths::session_paths(&swarmz_tool::paths::sessions_dir_in(&h.path), "t9").unwrap();
    h.track(&paths.socket.to_string_lossy());
    let (mut child, out, _w) = run_attach(&h.path, "t9");
    assert!(wait_out(&out, "\x1b]1337;swarmz-attach;new=1;end=1\x07"), "first attach must say new=1");

    // Kill the holder itself (not the shell inside it, and not the attach process): the session's
    // own metadata carries its pid.
    let meta = swarmz_tool::paths::read_meta(&paths.meta).expect("holder must have written its meta by now");
    let rc = unsafe { libc::kill(meta.pid as i32, libc::SIGKILL) };
    assert_eq!(rc, 0, "could not signal the holder: {}", std::io::Error::last_os_error());

    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        if let Ok(Some(s)) = child.try_wait() {
            break s;
        }
        assert!(Instant::now() < deadline, "attach never exited after the holder vanished");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_ne!(status.exit_code(), 0, "a vanished holder must not look like a clean exit");
}

fn write_ws(home: &Path, terminals: serde_json::Value, machines: serde_json::Value) {
    std::fs::create_dir_all(home.join(".swarmz")).unwrap();
    let ws = serde_json::json!({"version": 1, "layout": null, "terminals": terminals, "machines": machines,
        "sync": {"revision": 4, "updatedAt": "2026-09-16T10:00:00.000Z", "updatedBy": "mini"}});
    std::fs::write(home.join(".swarmz/workspace.json"), ws.to_string()).unwrap();
}

const MINI: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini")];

fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[test]
fn ls_sessions_and_prune() {
    let h = home("ls");
    let cwd = h.path.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([{"id": "t1", "name": "one", "cwd": cwd, "origin": "mini"}, {"id": "t2", "name": "two", "cwd": "/nowhere", "origin": "mini"}]), serde_json::json!({}));
    let (code, v) = tool_env(&h.path, &["hold", "t1", "--cwd", &cwd, "--name", "one"], MINI);
    assert_eq!(code, 0, "{v}");
    h.track(v["socket"].as_str().unwrap());
    let (_, orphan) = tool_env(&h.path, &["hold", "zz", "--cwd", &cwd, "--name", "orphan"], MINI);
    h.track(orphan["socket"].as_str().unwrap());

    let (code, v) = tool_env(&h.path, &["ls"], MINI);
    assert_eq!(code, 0, "{v}");
    let tiles = v["tiles"].as_array().unwrap();
    assert_eq!(tiles.len(), 2);
    assert_eq!((tiles[0]["id"].as_str(), tiles[0]["running"].as_bool(), tiles[0]["kind"].as_str()), (Some("t1"), Some(true), Some("shell")));
    assert_eq!(tiles[1]["running"], false);
    assert_eq!(tiles[0]["machine"], "mini");

    let (_, s) = tool_env(&h.path, &["sessions"], MINI);
    let rows = s["sessions"].as_array().unwrap();
    let known: Vec<(String, bool, bool)> = rows.iter().map(|r| (r["id"].as_str().unwrap().to_string(), r["known"].as_bool().unwrap(), r["running"].as_bool().unwrap())).collect();
    assert_eq!(known, vec![("t1".to_string(), true, true), ("zz".to_string(), false, true)]);

    let (_, p) = tool_env(&h.path, &["prune"], MINI);
    assert_eq!(p["removed"], 0);
    let (code, bad) = tool_env(&h.path, &["ls", "extra"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("usage")));
}

#[test]
fn new_tiles_are_held_typed_and_recorded_and_restart_brings_them_back() {
    let h = home("new");
    let proj = h.path.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let folder = proj.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));

    // Tracks a new tile's session before anything can fail, so a failing test still ends it.
    let track = |v: &serde_json::Value| {
        let id = v["tile"]["id"].as_str().unwrap_or_default().to_string();
        if let Ok(p) = swarmz_tool::paths::session_paths(&h.path.join(".swarmz/sessions"), &id) {
            h.track(p.socket.to_str().unwrap());
        }
        id
    };
    let (code, v) = tool_env(&h.path, &["new", "--folder", &folder, "--skip-permissions"], MINI);
    let id = track(&v);
    assert_eq!(code, 0, "{v}");
    let tile = &v["tile"];
    assert_eq!((tile["name"].as_str(), tile["kind"].as_str(), tile["running"].as_bool()), (Some("proj"), Some("claude"), Some(true)));
    let paths = swarmz_tool::paths::session_paths(&h.path.join(".swarmz/sessions"), &id).unwrap();

    let ws: serde_json::Value = serde_json::from_slice(&std::fs::read(h.path.join(".swarmz/workspace.json")).unwrap()).unwrap();
    assert_eq!(ws["sync"]["revision"], 5);
    assert_eq!(ws["sync"]["updatedBy"], "mini");
    let def = &ws["terminals"][0];
    assert_eq!((def["origin"].as_str(), def["cwd"].as_str()), (Some("mini"), Some(folder.as_str())));
    assert_eq!((def["claude"]["started"].as_bool(), def["claude"]["skipPermissions"].as_bool()), (Some(false), Some(true)));
    let sid = def["claude"]["sessionId"].as_str().unwrap().to_string();
    assert!(swarmz_tool::util::valid_uuid(&sid));

    // The Claude line was typed into the session. It is longer than the 80-column screen, so
    // the rows are joined before searching.
    let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: "tool".into() };
    let c = HolderClient::connect(&paths.socket, &hello, |_, _| {}, |_| {}).unwrap();
    let want = format!("claude --dangerously-skip-permissions --session-id {sid}");
    let joined = || c.screen(50, Duration::from_secs(2)).map(|s| s.lines.iter().map(swarmz_tool::screen::line_text).collect::<String>()).unwrap_or_default();
    assert!(wait_until(|| joined().contains(&want)), "{}", joined());

    // A second tile in the same folder gets the next name.
    let (code, v2) = tool_env(&h.path, &["new", "--folder", &folder], MINI);
    track(&v2);
    assert_eq!(code, 0, "{v2}");
    assert_eq!(v2["tile"]["name"], "proj-2");

    // Claude never started here (there is no `claude` on the test PATH), so the shell is idle:
    // restart starts it again in that shell, resuming the tile's conversation.
    let c = tool_client(paths.socket.to_str().unwrap());
    assert!(wait_until(|| c.info(Duration::from_secs(2)).and_then(|i| i.foreground_busy) == Some(false)));
    let (code, r) = tool_env(&h.path, &["restart", &id], MINI);
    assert_eq!((code, r["resumed"].as_bool()), (0, Some(true)), "{r}");
    assert!(wait_until(|| screen_has(&c, "claude --dangerously-skip-permissions --resume")));
    // Something running in front is left alone.
    let (code, _) = tool_env(&h.path, &["send", &id, "--", "sleep 30"], MINI);
    assert_eq!(code, 0);
    assert!(wait_until(|| c.info(Duration::from_secs(2)).and_then(|i| i.foreground_busy) == Some(true)));
    let (code, r) = tool_env(&h.path, &["restart", &id], MINI);
    assert_eq!((code, r["code"].as_str()), (1, Some("running")));
    drop(c);
    // A closed tile is brought back.
    let (_, closed) = tool_env(&h.path, &["close", &id], MINI);
    assert_eq!(closed["closed"], true);
    let (code, r) = tool_env(&h.path, &["restart", &id], MINI);
    assert_eq!(code, 0, "{r}");
    assert_eq!(r["tile"]["running"], true);
    h.track(paths.socket.to_str().unwrap());
    let (code, r) = tool_env(&h.path, &["restart", "not-a-tile"], MINI);
    assert_eq!((code, r["code"].as_str()), (1, Some("unknown")));

    // Folder checks and a missing machine name.
    let (code, bad) = tool_env(&h.path, &["new", "--folder", "relative"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("invalid")));
    let (code, bad) = tool_env(&h.path, &["new", "--folder", "/definitely/not/here"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("cwd_missing")));
    let (code, bad) = tool_env(&h.path, &["new", "--folder", &folder], &[("SWARMZ_MACHINE", "")]);
    assert_eq!((code, bad["code"].as_str()), (1, Some("no_machine")));
}

#[test]
fn a_new_tile_s_def_is_kept_while_its_session_starts_and_dropped_once_it_is_closed() {
    let h = home("keepdef");
    let proj = h.path.join("kproj");
    std::fs::create_dir_all(&proj).unwrap();
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    let (code, v) = tool_env(&h.path, &["new", "--folder", proj.to_str().unwrap()], MINI);
    let id = v["tile"]["id"].as_str().unwrap_or_default().to_string();
    let sessions = h.path.join(".swarmz/sessions");
    let paths = swarmz_tool::paths::session_paths(&sessions, &id).unwrap();
    h.track(paths.socket.to_str().unwrap());
    assert_eq!(code, 0, "{v}");
    let kept = sessions.join(format!("{id}.def.json"));
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&kept).map(|m| m.permissions().mode() & 0o777);
        assert_eq!(mode.ok(), Some(0o600));
    }
    let ws_file = h.path.join(".swarmz/workspace.json");
    let has_def = || std::fs::read_to_string(&ws_file).unwrap_or_default().contains(&id);
    assert!(has_def());
    // An app saves its older copy over the file: the helper puts the tile back.
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    assert!(!has_def());
    assert!(wait_until(has_def), "the def was not added back");
    // The app closes the tile: it ends the session, whose shell takes a while to exit, then
    // saves without the tile. The helper stops as soon as the end is asked for.
    let meta = || -> serde_json::Value { serde_json::from_slice(&std::fs::read(&paths.meta).unwrap()).unwrap() };
    assert_eq!(meta()["screen"], true);
    assert!(meta().get("terminatingAt").is_none());
    let c = HolderClient::connect(&paths.socket, &Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: "tool".into() }, |_, _| {}, |_| {}).unwrap();
    c.write(b"trap '' HUP; echo hup-ignored\r").unwrap();
    assert!(wait_until(|| c.screen(50, Duration::from_secs(2)).is_some_and(|s| s.lines.iter().any(|l| swarmz_tool::screen::line_text(l) == "hup-ignored"))));
    c.terminate().unwrap();
    assert!(wait_until(|| meta()["terminatingAt"].is_string()), "{}", meta());
    assert!(swarmz_tool::paths::live_session(&paths).is_some(), "the shell should still be ending");
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    assert!(wait_until(|| !kept.exists()), "the helper did not stop");
    assert!(!has_def());
    assert!(wait_until(|| swarmz_tool::paths::live_session(&paths).is_none()));
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!has_def());
    // The helper's file is never mistaken for a session.
    let (_, s) = tool_env(&h.path, &["sessions"], MINI);
    assert!(s["sessions"].as_array().unwrap().iter().all(|r| r["id"] == id.as_str()), "{s}");
}

#[test]
fn folders_and_machines() {
    let h = home("folders");
    std::fs::create_dir_all(h.path.join("b")).unwrap();
    std::fs::create_dir_all(h.path.join("a")).unwrap();
    let (code, v) = tool_env(&h.path, &["folders", h.path.to_str().unwrap()], MINI);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["dirs"], serde_json::json!(["a", "b"]));
    let (_, home_list) = tool_env(&h.path, &["folders"], MINI);
    assert_eq!(home_list["path"], h.path.to_str().unwrap());

    write_ws(&h.path, serde_json::json!([]), serde_json::json!({"studio": {"alias": "Studio", "color": "#ff0000", "lastUsed": "t"}}));
    // With SWARMZ_MACHINE set Tailscale is never asked: the workspace's machines and this Mac.
    let (code, m) = tool_env(&h.path, &["machines"], MINI);
    assert_eq!(code, 0, "{m}");
    let ms = m["machines"].as_array().unwrap();
    assert_eq!(ms.len(), 2);
    assert_eq!((ms[0]["name"].as_str(), ms[0]["self"].as_bool(), ms[0]["online"].as_bool()), (Some("mini"), Some(true), Some(true)));
    assert_eq!((ms[1]["name"].as_str(), ms[1]["alias"].as_str(), ms[1]["color"].as_str()), (Some("studio"), Some("Studio"), Some("#ff0000")));
    assert!(ms[1]["online"].is_null());
}

#[test]
fn watch_streams_a_snapshot_then_changes() {
    let h = home("watch");
    let cwd = h.path.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([{"id": "w1", "name": "one", "cwd": cwd, "origin": "mini"}]), serde_json::json!({}));
    let out_path = h.path.join("watch.out");
    let _child = KillOnDrop(
        tool_command(&h.path)
            .arg("watch")
            .env("SWARMZ_MACHINE", "mini")
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&out_path).unwrap())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let read = || std::fs::read_to_string(&out_path).unwrap_or_default();
    assert!(wait_until(|| read().contains("\"snapshot\"")), "{}", read());
    let (_, held) = tool_env(&h.path, &["hold", "w1", "--cwd", &cwd, "--name", "one"], MINI);
    h.track(held["socket"].as_str().unwrap());
    assert!(wait_until(|| read().lines().any(|l| l.contains("\"type\":\"tile\"") && l.contains("\"running\":true"))), "{}", read());
    // An unreadable workspace keeps the tiles watch already reported.
    {
        use std::os::unix::fs::PermissionsExt;
        let file = h.path.join(".swarmz/workspace.json");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::thread::sleep(Duration::from_millis(2500));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!read().contains("\"type\":\"gone\""), "{}", read());
    }
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    assert!(wait_until(|| read().contains("\"type\":\"gone\"")), "{}", read());
    for line in read().lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["v"], 1);
    }
}

fn tool_client(socket: &str) -> HolderClient {
    let hello = Hello { v: PROTOCOL_VERSION, cols: 0, rows: 0, viewer: "tool".into() };
    HolderClient::connect(Path::new(socket), &hello, |_, _| {}, |_| {}).unwrap()
}

fn screen_has(c: &HolderClient, needle: &str) -> bool {
    c.screen(200, Duration::from_secs(2)).is_some_and(|s| s.lines.iter().any(|l| swarmz_tool::screen::line_text(l).contains(needle)))
}

fn held(h: &TestHome, tile: &str) -> String {
    let cwd = h.path.to_string_lossy().into_owned();
    let (code, v) = tool_env(&h.path, &["hold", tile, "--cwd", &cwd, "--name", tile], MINI);
    if let Some(s) = v["socket"].as_str() {
        h.track(s);
    }
    assert_eq!(code, 0, "{v}");
    v["socket"].as_str().unwrap().to_string()
}

/// Runs a script in the tile that reports exactly the next `len` bytes it is sent, with bracketed
/// paste turned on first when `paste` is set, and returns what `send` delivered.
fn capture_send(h: &TestHome, tile: &str, paste: bool, text: &str, len: usize) -> Vec<u8> {
    let socket = held(h, tile);
    let cap = h.path.join(format!("{tile}.bin"));
    let script = h.path.join(format!("{tile}.sh"));
    let on = if paste { "printf '\\033[?2004h'\n" } else { "" };
    std::fs::write(&script, format!("stty raw -echo\n{on}printf 'ready\\n'\ndd bs=1 count={len} of='{}' 2>/dev/null\nprintf '\\033[?2004l'\nstty sane\n", cap.display())).unwrap();
    let c = tool_client(&socket);
    c.write(format!("sh '{}'\n", script.display()).as_bytes()).unwrap();
    assert!(wait_until(|| screen_has(&c, "ready")));
    let (code, v) = tool_env(&h.path, &["send", tile, "--", text], MINI);
    assert_eq!((code, v["sent"].as_bool()), (0, Some(true)), "{v}");
    assert!(wait_until(|| std::fs::metadata(&cap).map(|m| m.len() as usize == len).unwrap_or(false)));
    std::fs::read(&cap).unwrap()
}

#[test]
fn send_types_a_bracketed_paste_then_enter_for_a_program_that_asks() {
    let h = home("send");
    let want = swarmz_tool::input::paste_bytes("--hi there").unwrap();
    let mut expected = want.clone();
    expected.push(b'\r');
    assert_eq!(capture_send(&h, "s1", true, "--hi there", want.len() + 1), expected);
}

#[test]
fn send_types_plain_text_then_enter_into_a_shell() {
    let h = home("send-raw");
    let got = capture_send(&h, "s2", false, "echo\x1b hi", "echo hi".len() + 1);
    assert_eq!(got, b"echo hi\r".to_vec());
}

/// Prints a Claude-style permission dialog.
const DIALOG_PRINT: &str = r#"printf '%s\n' '' '────────────────────────────' ' Bash command' '' '   npm test' '   Run the tests' '' ' Do you want to proceed?' ' ❯ 1. Yes' "   2. Yes, and don't ask again for npm test commands in /p" '   3. No' '' ' Esc to cancel · Tab to amend'
"#;

/// Shows the dialog and reports the one key it gets. The terminal is raw (with output processing
/// kept, so the lines still start at the left) before the dialog appears, so no answer can arrive
/// while it is still line-buffered.
const DIALOG_SH: &str = r#"stty raw -echo opost
printf '%s\n' '' '────────────────────────────' ' Bash command' '' '   npm test' '   Run the tests' '' ' Do you want to proceed?' ' ❯ 1. Yes' "   2. Yes, and don't ask again for npm test commands in /p" '   3. No' '' ' Esc to cancel · Tab to amend'
c=$(dd bs=1 count=1 2>/dev/null)
stty sane
printf '\033[2J\033[H'
printf 'chose:%s\n' "$(printf %s "$c" | od -An -c | tr -d ' \n')"
"#;

#[test]
fn pending_answer_key_and_output_against_a_fake_dialog() {
    let h = home("dialog");
    let socket = held(&h, "d1");
    let script = h.path.join("dialog.sh");
    std::fs::write(&script, DIALOG_SH).unwrap();
    let c = tool_client(&socket);
    let run = format!("sh '{}'\n", script.display());

    let (_, none) = tool_env(&h.path, &["pending", "d1"], MINI);
    assert!(none["pending"].is_null(), "{none}");

    c.write(run.as_bytes()).unwrap();
    let mut p = serde_json::Value::Null;
    assert!(wait_until(|| {
        p = tool_env(&h.path, &["pending", "d1"], MINI).1;
        !p["pending"].is_null()
    }));
    assert_eq!((p["pending"]["tool"].as_str(), p["pending"]["summary"].as_str()), (Some("Bash command"), Some("npm test")));
    assert_eq!(p["pending"]["options"].as_array().unwrap().len(), 3);

    let (code, bad) = tool_env(&h.path, &["answer", "d1", "maybe"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("usage")));
    let (_, stale) = tool_env(&h.path, &["answer", "d1", "yes", "--summary", "rm -rf /"], MINI);
    assert_eq!(stale["ignored"], true);
    let (code, a) = tool_env(&h.path, &["answer", "d1", "always", "--summary", "npm test"], MINI);
    assert_eq!(code, 0, "{a}");
    assert_eq!((a["answered"].as_bool(), a["option"]["n"].as_u64()), (Some(true), Some(2)));
    assert!(wait_until(|| {
        let (_, o) = tool_env(&h.path, &["output", "d1", "--lines", "20"], MINI);
        o["lines"].as_array().is_some_and(|ls| ls.iter().any(|l| l.to_string().contains("chose:2")))
    }));
    let (_, gone) = tool_env(&h.path, &["pending", "d1"], MINI);
    assert!(gone["pending"].is_null());
    let (_, late) = tool_env(&h.path, &["answer", "d1", "yes"], MINI);
    assert_eq!(late["ignored"], true);

    c.write(run.as_bytes()).unwrap();
    assert!(wait_until(|| !tool_env(&h.path, &["pending", "d1"], MINI).1["pending"].is_null()));
    let (code, k) = tool_env(&h.path, &["key", "d1", "esc"], MINI);
    assert_eq!((code, k["sent"].as_bool()), (0, Some(true)));
    assert!(wait_until(|| screen_has(&c, "chose:033")));
    let (code, bad) = tool_env(&h.path, &["key", "d1", "f13"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("usage")));
}

/// Shows Claude's single-select question dialog (2.1.278) and reports the one key it gets.
const QUESTION_SH: &str = r#"stty raw -echo opost
printf '%s\n' '' '────────────────────────────' ' ☐ Button colour' 'Which colour should the button be?' '❯ 1. Red' '     A bold red button' '  2. Blue' '     A classic blue button' '  3. Type something.' '────────────────────────────' '  4. Chat about this' 'Enter to select · ↑/↓ to navigate · Esc to cancel'
c=$(dd bs=1 count=1 2>/dev/null)
stty sane
printf '\033[2J\033[H'
printf 'chose:%s\n' "$(printf %s "$c" | od -An -c | tr -d ' \n')"
"#;

/// Shows a multi-select question with the cursor on its first option and reports the 10 bytes
/// it gets: three ↓ (3 bytes each, past Square and Type something) and Enter is what
/// `answer submit` types from there.
const MULTI_SH: &str = r#"stty raw -echo opost
printf '%s\n' '' '────────────────────────────' '←  ☒ Size  ☐ Shape  ✔ Submit  →' 'Which shapes do you want?' '❯ 1. [ ] Circle' '  Round.' '  2. [✔] Square' '  Four sides.' '  3. [ ] Type something' '     Submit' '────────────────────────────' '  4. Chat about this' 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
c=$(dd bs=1 count=10 2>/dev/null)
stty sane
printf '\033[2J\033[H'
printf 'chose:%s\n' "$(printf %s "$c" | od -An -c | tr -d ' \n')"
"#;

#[test]
fn a_question_from_claude_is_pending_and_answered_by_its_digit() {
    let h = home("question");
    let socket = held(&h, "q1");
    let script = h.path.join("question.sh");
    std::fs::write(&script, QUESTION_SH).unwrap();
    let c = tool_client(&socket);
    c.write(format!("sh '{}'\n", script.display()).as_bytes()).unwrap();
    let mut p = serde_json::Value::Null;
    assert!(wait_until(|| {
        p = tool_env(&h.path, &["pending", "q1"], MINI).1;
        !p["pending"].is_null()
    }));
    let q = &p["pending"];
    assert_eq!((q["kind"].as_str(), q["tool"].as_str(), q["summary"].as_str()), (Some("question"), Some("AskUserQuestion"), Some("Which colour should the button be?")));
    assert_eq!((q["multi"].as_bool(), q["submit"].as_bool()), (Some(false), Some(false)));
    let opts = q["options"].as_array().unwrap();
    assert_eq!(opts.len(), 2, "Type something and Chat about this are not answers: {q}");
    assert_eq!((opts[1]["n"].as_u64(), opts[1]["label"].as_str(), opts[1]["description"].as_str()), (Some(2), Some("Blue"), Some("A classic blue button")));
    // The tile row says the same while the question shows.
    let cwd = h.path.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([{"id": "q1", "name": "q1", "cwd": cwd, "origin": "mini",
        "claude": {"enabled": true, "sessionId": "s-q1", "skipPermissions": false, "started": true}}]), serde_json::json!({}));
    let (_, ls) = tool_env(&h.path, &["ls"], MINI);
    let row = ls["tiles"].as_array().unwrap().iter().find(|t| t["id"] == "q1").unwrap();
    assert_eq!((row["status"].as_str(), row["needs"].as_str(), row["summary"].as_str()), (Some("blocked"), Some("question"), Some("Which colour should the button be?")));
    // Permission words fit no option; a digit does, guarded by the summary.
    let (code, bad) = tool_env(&h.path, &["answer", "q1", "yes"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("no_option")));
    let (_, stale) = tool_env(&h.path, &["answer", "q1", "2", "--summary", "Which size?"], MINI);
    assert_eq!(stale["ignored"], true);
    let (code, a) = tool_env(&h.path, &["answer", "q1", "2", "--summary", "Which colour should the button be?"], MINI);
    assert_eq!(code, 0, "{a}");
    assert_eq!((a["answered"].as_bool(), a["option"]["n"].as_u64(), a["toggled"].as_bool()), (Some(true), Some(2), Some(false)));
    assert!(wait_until(|| screen_has(&c, "chose:2")));
    assert!(tool_env(&h.path, &["pending", "q1"], MINI).1["pending"].is_null());

    // A multi-select question: a digit ticks a box, `submit` walks ↓ to Submit and presses Enter.
    let multi = h.path.join("multi.sh");
    std::fs::write(&multi, MULTI_SH).unwrap();
    c.write(format!("sh '{}'\n", multi.display()).as_bytes()).unwrap();
    assert!(wait_until(|| {
        p = tool_env(&h.path, &["pending", "q1"], MINI).1;
        !p["pending"].is_null()
    }));
    let q = &p["pending"];
    assert_eq!((q["multi"].as_bool(), q["submit"].as_bool()), (Some(true), Some(true)));
    let opts = q["options"].as_array().unwrap();
    assert_eq!(opts.iter().map(|o| o["checked"].as_bool()).collect::<Vec<_>>(), vec![Some(false), Some(true)]);
    let (code, a) = tool_env(&h.path, &["answer", "q1", "submit"], MINI);
    assert_eq!(code, 0, "{a}");
    assert!(a["option"].is_null());
    assert!(wait_until(|| screen_has(&c, "chose:033[B033[B033[B\\r")));
}

#[test]
fn upload_writes_stdin_into_the_paste_folder_and_prune_sweeps_it() {
    let h = home("upload");
    let payload: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
    let (code, v) = tool_env_input(&h.path, &["upload", "--name", "IMG 1.jpg", "--size", &payload.len().to_string()], MINI, &payload);
    assert_eq!(code, 0, "{v}");
    let path = std::path::PathBuf::from(v["path"].as_str().unwrap());
    assert!(path.is_absolute() && path.starts_with(h.path.join(".swarmz/paste")), "{}", path.display());
    assert!(path.file_name().unwrap().to_string_lossy().ends_with("-IMG_1.jpg"));
    assert_eq!(v["size"].as_u64(), Some(payload.len() as u64));
    assert_eq!(std::fs::read(&path).unwrap(), payload);
    // Short: nothing left. Over the cap: refused. Missing flags: usage.
    let (code, short) = tool_env_input(&h.path, &["upload", "--name", "x.bin", "--size", "100"], MINI, b"abc");
    assert_eq!((code, short["code"].as_str()), (1, Some("short")));
    assert_eq!(std::fs::read_dir(h.path.join(".swarmz/paste")).unwrap().count(), 1);
    let (code, big) = tool_env_input(&h.path, &["upload", "--name", "x.bin", "--size", "99999999"], MINI, b"");
    assert_eq!((code, big["code"].as_str()), (1, Some("too_large")));
    let (code, none) = tool_env_input(&h.path, &["upload", "--name", "x.bin"], MINI, b"");
    assert_eq!((code, none["code"].as_str()), (1, Some("usage")));
    // The gate lets a phone key run it, with stdin passed through.
    let (code, gated) = tool_env_input(&h.path, &["ssh-gate"], &[("SWARMZ_MACHINE", "mini"), ("SSH_ORIGINAL_COMMAND", "swarmz upload --name 'a b.txt' --size 5")], b"hello");
    assert_eq!(code, 0, "{gated}");
    assert!(gated["path"].as_str().unwrap().ends_with("-a_b.txt"));
    // prune reports the sweep; nothing here is old enough.
    let (_, p) = tool_env(&h.path, &["prune"], MINI);
    assert_eq!(p["pasteRemoved"].as_u64(), Some(0));
    assert_eq!(std::fs::read_dir(h.path.join(".swarmz/paste")).unwrap().count(), 2);
}

#[test]
fn the_conductor_is_claimed_approved_and_the_only_tile_that_acts_on_others() {
    let h = home("conductor");
    let cwd = h.path.to_string_lossy().into_owned();
    let cs = held(&h, "c1");
    let ts = held(&h, "t2");
    let c1 = tool_client(&cs);
    let t2 = tool_client(&ts);
    write_ws(&h.path, serde_json::json!([
        {"id": "c1", "name": "api", "cwd": cwd, "origin": "mini", "claude": {"enabled": true, "sessionId": "s-c1", "skipPermissions": false, "started": true}},
        {"id": "t2", "name": "web", "cwd": cwd, "origin": "mini", "claude": {"enabled": true, "sessionId": "s-t2", "skipPermissions": false, "started": true}}
    ]), serde_json::json!({}));
    let as_c1: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "c1"), ("SWARMZ_TERMINAL_NAME", "api")];
    let as_t2: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "t2"), ("SWARMZ_TERMINAL_NAME", "web")];
    let user: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")];

    // No conductor: a tile may not act on another, nor read it.
    let (_, none) = tool_env(&h.path, &["conductor"], user);
    assert!(none["conductor"].is_null() && none["claim"].is_null(), "{none}");
    let (code, d) = tool_env(&h.path, &["send", "c1", "--", "hi"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, d) = tool_env(&h.path, &["transcript", "c1"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, d) = tool_env(&h.path, &["output", "c1", "--lines", "10"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, d) = tool_env(&h.path, &["fleet"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    // A tile acts on itself.
    let (code, ok) = tool_env(&h.path, &["send", "t2", "--", "echo mine"], as_t2);
    assert_eq!((code, ok["sent"].as_bool()), (0, Some(true)));
    // Set and clear are the user's.
    let (code, d) = tool_env(&h.path, &["conductor", "--set", "t2"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));

    // A claim, approved by the user: the claimant is told.
    let (code, c) = tool_env(&h.path, &["conductor", "--claim"], as_t2);
    assert_eq!((code, c["claimed"].as_bool(), c["pending"].as_bool()), (0, Some(true), Some(true)));
    let (_, st) = tool_env(&h.path, &["conductor"], user);
    assert_eq!((st["conductor"].as_str(), st["claim"]["tile"].as_str(), st["claim"]["title"].as_str()), (None, Some("t2"), Some("web")));
    // `ls` carries the claim beside the rows (spec §7), and no row is the conductor yet.
    let (_, ls) = tool_env(&h.path, &["ls"], user);
    assert_eq!((ls["conductor"].as_str(), ls["claim"]["tile"].as_str()), (None, Some("t2")));
    assert!(ls["tiles"].as_array().unwrap().iter().all(|t| t.get("conductor").is_none()), "{ls}");
    let (code, st) = tool_env(&h.path, &["conductor", "--set", "t2"], user);
    assert_eq!((code, st["conductor"].as_str()), (0, Some("t2")));
    assert!(st["claim"].is_null());
    let (_, ls) = tool_env(&h.path, &["ls"], user);
    assert_eq!((ls["conductor"].as_str(), ls["claim"].is_null()), (Some("t2"), true));
    let flags: Vec<(&str, bool)> = ls["tiles"].as_array().unwrap().iter().map(|t| (t["id"].as_str().unwrap(), t["conductor"].as_bool() == Some(true))).collect();
    assert!(flags.contains(&("t2", true)) && flags.contains(&("c1", false)), "{flags:?}");
    assert!(wait_until(|| screen_has(&t2, "you are the conductor")));
    // The conductor's own claim changes nothing.
    let (_, c) = tool_env(&h.path, &["conductor", "--claim"], as_t2);
    assert_eq!((c["pending"].as_bool(), c["conductor"].as_bool()), (Some(false), Some(true)));

    // The conductor speaks to a tile, marked; asks it; sees the fleet; still cannot read it.
    let (code, ok) = tool_env(&h.path, &["send", "c1", "--", "do the thing"], as_t2);
    assert_eq!((code, ok["sent"].as_bool()), (0, Some(true)));
    assert!(wait_until(|| screen_has(&c1, "[conductor web] do the thing")));
    let (code, ok) = tool_env(&h.path, &["ask", "c1", "--", "how far along?"], as_t2);
    assert_eq!((code, ok["asked"].as_bool()), (0, Some(true)));
    assert!(wait_until(|| screen_has(&c1, "[conductor web] how far along?")));
    assert!(screen_has(&c1, "swarmz reply"));
    let (code, d) = tool_env(&h.path, &["transcript", "c1"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    // A glance at another tile's screen is the conductor's, capped and never followed.
    let (code, o) = tool_env(&h.path, &["output", "c1", "--lines", "10"], as_t2);
    assert_eq!(code, 0, "{o}");
    assert!(o["lines"].is_array(), "{o}");
    let (code, d) = tool_env(&h.path, &["output", "c1", "--lines", "201"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("usage")));
    let (code, d) = tool_env(&h.path, &["output", "c1", "--follow"], as_t2);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, f) = tool_env(&h.path, &["fleet"], as_t2);
    assert_eq!(code, 0, "{f}");
    let ids: Vec<&str> = f["tiles"].as_array().unwrap().iter().filter_map(|t| t["id"].as_str()).collect();
    assert!(ids.contains(&"c1") && ids.contains(&"t2"), "{ids:?}");
    assert_eq!(f["machines"].as_array().unwrap().len(), 0, "no tailnet in tests");
    // The tile replies; the answer lands in the conductor, marked with the tile's title.
    let (code, r) = tool_env(&h.path, &["reply", "--", "about half; tests next"], as_c1);
    assert_eq!((code, r["replied"].as_bool()), (0, Some(true)));
    assert!(wait_until(|| screen_has(&t2, "[api] about half; tests next")));

    // Another tile's claim, denied: the conductor stays, and the claimant is told.
    let (_, c) = tool_env(&h.path, &["conductor", "--claim"], as_c1);
    assert_eq!(c["pending"].as_bool(), Some(true));
    let (code, st) = tool_env(&h.path, &["conductor", "--deny"], user);
    assert_eq!((code, st["conductor"].as_str()), (0, Some("t2")));
    assert!(st["claim"].is_null());
    assert!(wait_until(|| screen_has(&c1, "claim was denied")));

    // Each tile's briefing: the conductor section for the conductor alone.
    let out = tool_command(&h.path).args(["briefing"]).envs(as_t2.iter().copied()).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.starts_with("You are running in a swarmz tile named \"web\""), "{text}");
    assert!(text.contains("You are the conductor"), "{text}");
    let out = tool_command(&h.path).args(["briefing"]).envs(as_c1.iter().copied()).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("swarmz reply") && !text.contains("You are the conductor"), "{text}");

    // The phone's gate reads and sets it, and --on refuses what must stay local.
    let (code, g) = tool_env(&h.path, &["ssh-gate"], &[("SWARMZ_MACHINE", "mini"), ("SSH_ORIGINAL_COMMAND", "swarmz conductor")]);
    assert_eq!((code, g["conductor"].as_str()), (0, Some("t2")));
    let (code, d) = tool_env(&h.path, &["--on", "box", "hold", "x"], user);
    assert_eq!((code, d["code"].as_str()), (1, Some("usage")));
    let (code, d) = tool_env(&h.path, &["--on", "box", "send", "c1", "--", "x"], as_c1);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, st) = tool_env(&h.path, &["conductor", "--clear"], user);
    assert_eq!(code, 0);
    assert!(st["conductor"].is_null());
}

#[test]
fn card_sets_reads_and_keeps_a_user_title() {
    let h = home("card");
    let cwd = h.path.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([
        {"id": "c1", "name": "api", "cwd": cwd, "origin": "mini", "claude": {"enabled": true, "sessionId": "s-c1", "skipPermissions": false, "started": true}},
        {"id": "c2", "name": "web", "cwd": cwd, "origin": "mini"}
    ]), serde_json::json!({}));
    // Nothing yet, and the tile must be named somehow.
    let (_, none) = tool_env(&h.path, &["card", "--tile", "c1"], MINI);
    assert!(none["card"].is_null(), "{none}");
    // No tile given and none in the environment (this test may itself run inside a tile).
    let (code, bad) = tool_env(&h.path, &["card", "--title", "x"], &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")]);
    assert_eq!((code, bad["code"].as_str()), (1, Some("usage")));
    let (code, bad) = tool_env(&h.path, &["card", "--tile", "nope", "--title", "x"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("unknown_tile")));
    // The tile id comes from the shell's environment, as it does for an agent in a tile.
    let env_tile: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "c1")];
    let (code, set) = tool_env(&h.path, &["card", "--title", " Phone: answer questions ", "--recap", "Parsed the dialog.\nNext: the card."], env_tile);
    assert_eq!(code, 0, "{set}");
    assert_eq!((set["card"]["title"].as_str(), set["card"]["by"].as_str()), (Some("Phone: answer questions"), Some("agent")));
    assert_eq!(set["card"]["recap"].as_str(), Some("Parsed the dialog.\nNext: the card."));
    let ws: serde_json::Value = serde_json::from_slice(&std::fs::read(h.path.join(".swarmz/workspace.json")).unwrap()).unwrap();
    assert_eq!(ws["sync"]["revision"], 5, "the revision is bumped: {}", ws["sync"]);
    assert_eq!(ws["sync"]["updatedBy"], "mini");
    assert_eq!(ws["terminals"][0]["card"]["title"], "Phone: answer questions");
    assert!(ws["terminals"][1].get("card").is_none(), "the other tile is untouched");
    // A recap-only update keeps the title; a user title is kept by an agent's recap and
    // replaced only by an agent's title.
    let (_, r) = tool_env(&h.path, &["card", "--recap", "All green."], env_tile);
    assert_eq!((r["card"]["title"].as_str(), r["card"]["recap"].as_str()), (Some("Phone: answer questions"), Some("All green.")));
    let (_, u) = tool_env(&h.path, &["card", "--tile", "c1", "--title", "Mine", "--user"], MINI);
    assert_eq!((u["card"]["title"].as_str(), u["card"]["by"].as_str(), u["card"]["recap"].as_str()), (Some("Mine"), Some("user"), Some("All green.")));
    let (_, r2) = tool_env(&h.path, &["card", "--title", "Theirs", "--recap", "More."], env_tile);
    assert_eq!((r2["card"]["title"].as_str(), r2["card"]["by"].as_str()), (Some("Theirs"), Some("agent")));
    // The row carries the card; a tile without one has no title until it is prompted.
    let (_, ls) = tool_env(&h.path, &["ls"], MINI);
    let rows = ls["tiles"].as_array().unwrap();
    let c1 = rows.iter().find(|t| t["id"] == "c1").unwrap();
    assert_eq!((c1["title"].as_str(), c1["recap"].as_str(), c1["cardBy"].as_str()), (Some("Theirs"), Some("More."), Some("agent")));
    let c2 = rows.iter().find(|t| t["id"] == "c2").unwrap();
    assert!(c2["title"].is_null() && c2["recap"].is_null());
    // Clearing a user title with an empty one keeps the recap and hands the title back.
    let (_, cleared) = tool_env(&h.path, &["card", "--tile", "c1", "--title", "", "--user"], MINI);
    assert!(cleared["card"]["title"].is_null(), "{cleared}");
    assert_eq!(cleared["card"]["recap"].as_str(), Some("More."));
    // The gate lets a phone key run it.
    let (code, gated) = tool_env(&h.path, &["ssh-gate"], &[("SWARMZ_MACHINE", "mini"), ("SSH_ORIGINAL_COMMAND", "swarmz card --tile c1")]);
    assert_eq!(code, 0, "{gated}");
    assert_eq!(gated["card"]["recap"].as_str(), Some("More."));
}

#[test]
fn stats_reports_this_macs_numbers_and_claude_sessions() {
    let h = home("stats");
    let cwd = h.path.to_string_lossy().into_owned();
    let claude = serde_json::json!({"enabled": true, "sessionId": "5e2b8a52-0000-4000-8000-000000000001", "skipPermissions": false, "started": true});
    write_ws(&h.path, serde_json::json!([
        {"id": "c1", "name": "api", "cwd": cwd, "origin": "mini", "claude": claude},
        {"id": "s1", "name": "sh", "cwd": cwd, "origin": "mini"}
    ]), serde_json::json!({}));
    let (code, v) = tool_env(&h.path, &["stats"], MINI);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["claude"], serde_json::json!({"working": 0, "needsYou": 0, "idle": 0, "stopped": 1}));
    let cpu = v["cpu"]["percent"].as_f64().unwrap();
    assert!((0.0..=100.0).contains(&cpu), "{v}");
    assert!(v["cpu"]["cores"].as_u64().unwrap() >= 1);
    assert!(v["memory"]["usedPercent"].as_f64().is_some_and(|p| p > 0.0 && p <= 100.0), "{v}");
    assert!(v["disk"]["freeBytes"].as_u64().unwrap() > 0);
    assert!(v["uptimeSeconds"].as_u64().unwrap() > 0);
    // The phone's gate lets it through too.
    let (code, g) = tool_env(&h.path, &["ssh-gate"], &[("SWARMZ_MACHINE", "mini"), ("SSH_ORIGINAL_COMMAND", "swarmz stats")]);
    assert_eq!(code, 0, "{g}");
    assert!(g["cpu"].is_object());
}

#[test]
fn a_tree_of_conductors_acts_on_children_and_glances_below() {
    let h = home("ctree");
    let dir = h.path.to_string_lossy().into_owned();
    let hold_in = |tile: &str| -> String {
        let (code, v) = tool_env(&h.path, &["hold", tile, "--cwd", &dir, "--name", tile], MINI);
        if let Some(s) = v["socket"].as_str() {
            h.track(s);
        }
        assert_eq!(code, 0, "{v}");
        v["socket"].as_str().unwrap().to_string()
    };
    let top = tool_client(&hold_in("top"));
    let sub = tool_client(&hold_in("sub"));
    let a = tool_client(&hold_in("a"));
    let _b = tool_client(&hold_in("b"));
    let claude = serde_json::json!({"enabled": true, "sessionId": "s", "skipPermissions": false, "started": true});
    write_ws(&h.path, serde_json::json!([
        {"id": "top", "name": "ops", "cwd": dir, "origin": "mini", "claude": claude},
        {"id": "sub", "name": "certify", "cwd": dir, "origin": "mini", "claude": claude},
        {"id": "a", "name": "alpha", "cwd": dir, "origin": "mini", "claude": claude},
        {"id": "b", "name": "bravo", "cwd": dir, "origin": "mini", "claude": claude}
    ]), serde_json::json!({}));
    let as_ = |id: &'static str, name: &'static str| -> Vec<(&'static str, &'static str)> { vec![("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", id), ("SWARMZ_TERMINAL_NAME", name)] };
    let user: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")];

    // The user makes `top` the top conductor and `sub` a conductor under it, and gives it a and b.
    assert_eq!(tool_env(&h.path, &["conductor", "--set", "top"], user).0, 0);
    let (code, st) = tool_env(&h.path, &["conductor", "--set", "sub", "--parent", "top"], user);
    assert_eq!(code, 0, "{st}");
    assert_eq!(st["conductors"]["sub"]["parent"], "top");
    assert!(wait_until(|| screen_has(&sub, "you are now a conductor under ops")));
    for t in ["a", "b"] {
        let (code, st) = tool_env(&h.path, &["conductor", "--assign", t, "--to", "sub"], user);
        assert_eq!(code, 0, "{st}");
    }
    let (_, st) = tool_env(&h.path, &["conductor"], user);
    assert_eq!(st["conductors"]["sub"]["tiles"], serde_json::json!(["a", "b"]));
    // A tile may not set one; --assign needs --to.
    let (code, d) = tool_env(&h.path, &["conductor", "--set", "a", "--parent", "top"], &as_("sub", "certify"));
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, d) = tool_env(&h.path, &["conductor", "--assign", "a"], user);
    assert_eq!((code, d["code"].as_str()), (1, Some("usage")));

    // The top reaches its child conductor, not the tiles under it; it can still glance at them.
    let (code, ok) = tool_env(&h.path, &["ask", "sub", "--", "how is certifyIP?"], &as_("top", "ops"));
    assert_eq!((code, ok["asked"].as_bool()), (0, Some(true)));
    assert!(wait_until(|| screen_has(&sub, "[conductor ops] how is certifyIP?")));
    let (code, d) = tool_env(&h.path, &["send", "a", "--", "hi"], &as_("top", "ops"));
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    assert!(d["error"].as_str().unwrap().contains("answers to certify"), "{d}");
    let (code, o) = tool_env(&h.path, &["output", "b", "--lines", "5"], &as_("top", "ops"));
    assert_eq!(code, 0, "{o}");
    // The sub-conductor acts on its own tiles, not on its parent; it may message the user (here
    // Telegram is not set up anywhere, so it is told so).
    let (code, ok) = tool_env(&h.path, &["send", "a", "--", "echo from-certify"], &as_("sub", "certify"));
    assert_eq!((code, ok["sent"].as_bool()), (0, Some(true)));
    assert!(wait_until(|| screen_has(&a, "[conductor certify] echo from-certify")));
    assert_eq!(tool_env(&h.path, &["send", "top", "--", "x"], &as_("sub", "certify")).1["code"], "denied");
    assert_eq!(tool_env(&h.path, &["notify", "--", "x"], &as_("sub", "certify")).1["code"], "not_configured");
    // Replies go to the conductor each tile answers to.
    assert_eq!(tool_env(&h.path, &["reply", "--", "alpha is green"], &as_("a", "alpha")).0, 0);
    assert!(wait_until(|| screen_has(&sub, "[alpha] alpha is green")));
    assert!(!screen_has(&top, "alpha is green"));
    assert_eq!(tool_env(&h.path, &["reply", "--", "all green"], &as_("sub", "certify")).0, 0);
    assert!(wait_until(|| screen_has(&top, "[certify] all green")));
    assert_eq!(tool_env(&h.path, &["reply", "--", "x"], &as_("top", "ops")).1["code"], "denied");
    // A sub-conductor's fleet is its own tiles; the top's is everything.
    let ids = |f: &serde_json::Value| -> Vec<String> {
        let mut v: Vec<String> = f["tiles"].as_array().unwrap().iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect();
        v.sort();
        v
    };
    assert_eq!(ids(&tool_env(&h.path, &["fleet"], &as_("sub", "certify")).1), vec!["a", "b", "sub"]);
    assert_eq!(ids(&tool_env(&h.path, &["fleet"], &as_("top", "ops")).1), vec!["a", "b", "sub", "top"]);
    // Every conductor's row is marked, and `ls` carries the tree.
    let (_, ls) = tool_env(&h.path, &["ls"], user);
    let marked: Vec<&str> = ls["tiles"].as_array().unwrap().iter().filter(|t| t["conductor"] == true).filter_map(|t| t["id"].as_str()).collect();
    assert_eq!(marked.len(), 2, "{marked:?}");
    assert_eq!(ls["conductors"]["sub"]["tiles"][0], "a");
    // Briefings: the top hears about the conductor under it, the sub-conductor about its place.
    let brief = |id: &'static str, name: &'static str| String::from_utf8(tool_command(&h.path).args(["briefing"]).envs(as_(id, name)).output().unwrap().stdout).unwrap();
    assert!(brief("top", "ops").contains("- certify (`sub`)"));
    assert!(brief("sub", "certify").contains("You answer to ops"));
    let plain = brief("a", "alpha");
    assert!(!plain.contains("You are the conductor") && !plain.contains("You answer to"), "{plain}");

    // A conductor hands only its own tiles to a conductor directly under it.
    let (code, d) = tool_env(&h.path, &["conductor", "--assign", "a", "--to", "top"], &as_("sub", "certify"));
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));

    // b asks to be a conductor under sub; the user approves; sub acts on b, the top does not.
    let (code, c) = tool_env(&h.path, &["conductor", "--claim", "--sub"], &as_("b", "bravo"));
    assert_eq!((code, c["pending"].as_bool()), (0, Some(true)), "{c}");
    let (_, st) = tool_env(&h.path, &["conductor"], user);
    assert_eq!((st["claim"]["sub"].as_bool(), st["claim"]["parent"].as_str()), (Some(true), Some("sub")));
    let (code, st) = tool_env(&h.path, &["conductor", "--set", "b"], user);
    assert_eq!(code, 0, "{st}");
    assert_eq!((st["conductor"].as_str(), st["conductors"]["b"]["parent"].as_str()), (Some("top"), Some("sub")));
    assert_eq!(st["conductors"]["sub"]["tiles"], serde_json::json!(["a"]), "a conductor leaves the list it was in");
    let (_, r) = tool_env(&h.path, &["restart", "b"], &as_("sub", "certify"));
    assert_ne!(r["code"].as_str(), Some("denied"), "{r}");
    assert_eq!(tool_env(&h.path, &["restart", "b"], &as_("top", "ops")).1["code"], "denied");

    // Removing sub hands a and b back to the top.
    let (code, st) = tool_env(&h.path, &["conductor", "--remove", "sub"], user);
    assert_eq!(code, 0);
    assert!(st["conductors"].get("sub").is_none());
    assert_eq!(st["conductors"]["b"]["parent"], "top");
    assert_eq!(tool_env(&h.path, &["send", "a", "--", "echo back-to-top"], &as_("top", "ops")).0, 0);
}

/// A stand-in for api.telegram.org on 127.0.0.1: records every request's path and JSON body;
/// `sendMessage` is always accepted, and each `getUpdates` hands out the next canned batch (then
/// none). `SWARMZ_TELEGRAM_API` points the tool at it.
struct FakeTelegram {
    base: String,
    seen: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
}

impl FakeTelegram {
    fn start(batches: Vec<serde_json::Value>) -> FakeTelegram {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(vec![]));
        let record = seen.clone();
        std::thread::spawn(move || {
            let mut batches = batches.into_iter();
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    continue;
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).unwrap();
                let json: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
                let reply = if path.ends_with("/getUpdates") {
                    serde_json::json!({"ok": true, "result": batches.next().unwrap_or_else(|| serde_json::json!([]))})
                } else {
                    serde_json::json!({"ok": true, "result": {"message_id": 1}})
                };
                record.lock().unwrap().push((path, json));
                let text = reply.to_string();
                let mut stream = reader.into_inner();
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len()).as_bytes());
            }
        });
        FakeTelegram { base, seen }
    }

    fn requests(&self) -> Vec<(String, serde_json::Value)> {
        self.seen.lock().unwrap().clone()
    }
}

fn borrow(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

#[test]
fn telegram_notifies_the_user_and_follows_their_replies_into_the_conductor() {
    let h = home("telegram");
    let cwd = h.path.to_string_lossy().into_owned();
    let cs = held(&h, "c1");
    let ts = held(&h, "t2");
    let c1 = tool_client(&cs);
    let t2 = tool_client(&ts);
    write_ws(&h.path, serde_json::json!([
        {"id": "c1", "name": "api", "cwd": cwd, "origin": "mini", "claude": {"enabled": true, "sessionId": "s-c1", "skipPermissions": false, "started": true}},
        {"id": "t2", "name": "web", "cwd": cwd, "origin": "mini", "claude": {"enabled": true, "sessionId": "s-t2", "skipPermissions": false, "started": true}}
    ]), serde_json::json!({}));
    let as_t2: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "t2"), ("SWARMZ_TERMINAL_NAME", "web")];
    let user: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")];

    // Nothing set up: notify says so, whoever asks.
    let (code, d) = tool_env(&h.path, &["notify", "--", "hi"], user);
    assert_eq!((code, d["code"].as_str()), (1, Some("not_configured")));

    let updates = serde_json::json!([
        {"update_id": 10, "message": {"chat": {"id": 4242}, "text": "approve"}},
        {"update_id": 11, "message": {"chat": {"id": 9999}, "text": "not you"}},
        {"update_id": 12, "message": {"chat": {"id": 4242}, "text": "how is it going?"}}
    ]);
    // The second poll: the user replies to a sub-conductor's message.
    let replies = serde_json::json!([
        {"update_id": 13, "message": {"chat": {"id": 4242}, "text": "go ahead", "reply_to_message": {"text": "api\nneed a decision"}}}
    ]);
    let fake = FakeTelegram::start(vec![updates, replies]);
    swarmz_tool::telegram::write(&h.path, &swarmz_tool::telegram::Config { token: "123:abc".into(), chat_id: "4242".into() }).unwrap();
    // Each caller's environment plus the fake API's address.
    let base = fake.base.clone();
    let api_env = |env: &[(&str, &str)]| -> Vec<(String, String)> {
        env.iter().map(|(k, v)| (k.to_string(), v.to_string())).chain(std::iter::once(("SWARMZ_TELEGRAM_API".to_string(), base.clone()))).collect()
    };
    let with_api = |env: &[(&str, &str)]| -> Vec<(String, String)> { api_env(env) };

    // The user (no tile) may notify; a tile that is not the conductor may not.
    let (code, n) = tool_env(&h.path, &["notify", "--tile", "c1", "--", "tests <pass> & ship"], &borrow(&with_api(user)));
    assert_eq!((code, n["notified"].as_bool()), (0, Some(true)), "{n}");
    let (code, d) = tool_env(&h.path, &["notify", "--", "hi"], &borrow(&with_api(as_t2)));
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let reqs = fake.requests();
    assert_eq!(reqs.len(), 1, "{reqs:?}");
    assert_eq!(reqs[0].0, "/bot123:abc/sendMessage");
    assert_eq!(reqs[0].1["chat_id"], "4242");
    assert_eq!(reqs[0].1["parse_mode"], "HTML");
    assert_eq!(reqs[0].1["text"], "<b>api</b>\ntests &lt;pass&gt; &amp; ship");

    // A claim goes to Telegram too.
    let (code, c) = tool_env(&h.path, &["conductor", "--claim"], &borrow(&with_api(as_t2)));
    assert_eq!((code, c["pending"].as_bool()), (0, Some(true)));
    let reqs = fake.requests();
    assert_eq!(reqs.len(), 2);
    assert!(reqs[1].1["text"].as_str().unwrap().contains("<b>web</b> asks to be the conductor"), "{reqs:?}");

    // Following once: "approve" answers the claim (and Telegram hears back), another chat's
    // message is dropped, and plain text lands in the conductor as a [telegram] prompt.
    let (code, t) = tool_env(&h.path, &["conductor", "--set", "c1"], user);
    assert_eq!((code, t["conductor"].as_str()), (0, Some("c1")));
    // With a top set, a plain claim asks for a place under it; replacing the top takes --top.
    let (_, c) = tool_env(&h.path, &["conductor", "--claim"], &borrow(&with_api(as_t2)));
    assert_eq!(c["pending"].as_bool(), Some(true));
    let (_, st) = tool_env(&h.path, &["conductor"], user);
    assert_eq!((st["claim"]["sub"].as_bool(), st["claim"]["parent"].as_str()), (Some(true), Some("c1")));
    let (_, c) = tool_env(&h.path, &["conductor", "--claim", "--top"], &borrow(&with_api(as_t2)));
    assert_eq!(c["pending"].as_bool(), Some(true));
    let n_before = fake.requests().len();
    // Only the conductor or the user may follow.
    let (code, d) = tool_env(&h.path, &["telegram-follow", "--once"], &borrow(&with_api(as_t2)));
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let out = tool_command(&h.path).args(["telegram-follow", "--once"]).envs(with_api(user)).stderr(Stdio::piped()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let lines: Vec<serde_json::Value> = String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
    let outcomes: Vec<&str> = lines.iter().filter_map(|l| l["outcome"].as_str()).collect();
    assert_eq!(outcomes, vec!["approved", "delivered"], "{lines:?}");
    let (_, st) = tool_env(&h.path, &["conductor"], user);
    assert_eq!((st["conductor"].as_str(), st["claim"].is_null()), (Some("t2"), true));
    let reqs = fake.requests();
    let after: Vec<&(String, serde_json::Value)> = reqs[n_before..].iter().collect();
    assert_eq!(after[0].0, "/bot123:abc/getUpdates");
    assert_eq!(after[0].1["offset"], 0);
    assert!(after.iter().any(|(p, b)| p.ends_with("sendMessage") && b["text"].as_str().unwrap().contains("<b>web</b> is the conductor now")), "{after:?}");
    // The new conductor (t2) got the text; c1, replaced, did not.
    assert!(wait_until(|| screen_has(&t2, "[telegram] how is it going?")));
    assert!(!screen_has(&c1, "[telegram]"));

    // Any conductor may message the user, headed with its title, and a reply to its message
    // goes to it rather than the top.
    let (code, s) = tool_env(&h.path, &["conductor", "--set", "c1", "--parent", "t2"], user);
    assert_eq!(code, 0, "{s}");
    let as_c1: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "c1"), ("SWARMZ_TERMINAL_NAME", "api")];
    let (code, n) = tool_env(&h.path, &["notify", "--", "need a decision"], &borrow(&with_api(as_c1)));
    assert_eq!((code, n["notified"].as_bool()), (0, Some(true)), "{n}");
    assert_eq!(fake.requests().last().unwrap().1["text"], "<b>api</b>\nneed a decision");
    let out = tool_command(&h.path).args(["telegram-follow", "--once"]).envs(with_api(user)).stderr(Stdio::piped()).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("\"delivered\""), "{}", String::from_utf8_lossy(&out.stdout));
    assert!(wait_until(|| screen_has(&c1, "[telegram] go ahead")));
    assert!(!screen_has(&t2, "go ahead"));
}

#[test]
fn a_dialog_that_is_not_live_is_never_answered() {
    let h = home("stale-dialog");
    let socket = held(&h, "q1");
    let print = h.path.join("print.sh");
    std::fs::write(&print, DIALOG_PRINT).unwrap();
    let c = tool_client(&socket);
    let ignored = |why: &str| {
        let (code, v) = tool_env(&h.path, &["answer", "q1", "yes"], MINI);
        assert_eq!((code, v["ignored"].as_bool()), (0, Some(true)), "{why}: {v}");
    };

    // Quoted in output, with the shell's prompt and more output below it.
    c.write(format!("sh '{}'; echo quoted-done\n", print.display()).as_bytes()).unwrap();
    assert!(wait_until(|| screen_has(&c, "quoted-done")));
    let (_, p) = tool_env(&h.path, &["pending", "q1"], MINI);
    assert!(p["pending"].is_null(), "{p}");
    ignored("quoted");

    // Scrolled off the screen.
    c.write(b"clear; i=0; while [ $i -lt 40 ]; do echo; i=$((i+1)); done; echo scrolled-done\n").unwrap();
    c.write(format!("sh '{}'; i=0; while [ $i -lt 40 ]; do echo; i=$((i+1)); done; echo scrolled-done2\n", print.display()).as_bytes()).unwrap();
    assert!(wait_until(|| screen_has(&c, "scrolled-done2")));
    let (_, p) = tool_env(&h.path, &["pending", "q1"], MINI);
    assert!(p["pending"].is_null(), "{p}");
    ignored("scrolled");

    // Live on screen: the screen decides, whatever order the hooks were logged in. The previous
    // tool's PostToolUse landed after this PermissionRequest, and the request logged describes
    // another question than the one showing.
    let cwd = h.path.to_string_lossy().into_owned();
    write_ws(&h.path, serde_json::json!([{"id": "q1", "name": "q1", "cwd": cwd, "origin": "mini"}]), serde_json::json!({}));
    std::fs::create_dir_all(h.path.join(".swarmz/agents")).unwrap();
    let log = [
        "2026-09-16T10:00:00Z\tq1\tUserPromptSubmit\t{}".to_string(),
        format!("2026-09-16T10:00:01Z\tq1\tPermissionRequest\t{}", serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "rm -rf build"}})),
        "2026-09-16T10:00:02Z\tq1\tPostToolUse\t{}".to_string(),
    ];
    std::fs::write(h.path.join(".swarmz/agents/events.log"), log.join("\n") + "\n").unwrap();
    let script = h.path.join("dialog.sh");
    std::fs::write(&script, DIALOG_SH).unwrap();
    c.write(format!("clear; sh '{}'\n", script.display()).as_bytes()).unwrap();
    assert!(wait_until(|| !tool_env(&h.path, &["pending", "q1"], MINI).1["pending"].is_null()));
    let (_, p) = tool_env(&h.path, &["pending", "q1"], MINI);
    assert_eq!((p["pending"]["tool"].as_str(), p["pending"]["summary"].as_str()), (Some("Bash command"), Some("npm test")), "{p}");
    let (_, rows) = tool_env(&h.path, &["ls"], MINI);
    let row = &rows["tiles"][0];
    assert_eq!((row["status"].as_str(), row["needs"].as_str(), row["summary"].as_str()), (Some("blocked"), Some("permission"), Some("npm test")), "{rows}");
    // A notification for the logged question never answers the one on screen.
    let (_, v) = tool_env(&h.path, &["answer", "q1", "yes", "--summary", "rm -rf build"], MINI);
    assert_eq!((v["ignored"].as_bool(), v["reason"].as_str()), (Some(true), Some("a different question is showing")), "{v}");
    let (code, v) = tool_env(&h.path, &["answer", "q1", "yes", "--summary", "npm test"], MINI);
    assert_eq!((code, v["answered"].as_bool()), (0, Some(true)), "{v}");
    assert!(wait_until(|| screen_has(&c, "chose:1")));
}

#[test]
fn a_session_the_log_never_mentions_is_answered_from_its_screen() {
    let h = home("unlogged-dialog");
    let socket = held(&h, "u1");
    let script = h.path.join("dialog.sh");
    std::fs::write(&script, DIALOG_SH).unwrap();
    // The log has events for the tile, none about this dialog (a subagent's request is never
    // logged): the dialog on screen is still pending and can be answered.
    std::fs::create_dir_all(h.path.join(".swarmz/agents")).unwrap();
    std::fs::write(h.path.join(".swarmz/agents/events.log"), "2026-09-16T10:00:00Z\tu1\tUserPromptSubmit\t{}\n").unwrap();
    let c = tool_client(&socket);
    c.write(format!("sh '{}'\n", script.display()).as_bytes()).unwrap();
    assert!(wait_until(|| !tool_env(&h.path, &["pending", "u1"], MINI).1["pending"].is_null()));
    let (code, v) = tool_env(&h.path, &["answer", "u1", "no"], MINI);
    assert_eq!((code, v["option"]["n"].as_u64()), (0, Some(3)), "{v}");
    assert!(wait_until(|| screen_has(&c, "chose:3")));
}

#[test]
fn output_follow_streams_updates_and_ends_with_exit() {
    let h = home("follow");
    let socket = held(&h, "f1");
    let out_path = h.path.join("follow.out");
    let mut child = KillOnDrop(
        tool_command(&h.path)
            .args(["output", "f1", "--follow", "--lines", "50"])
            .env("SWARMZ_MACHINE", "mini")
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&out_path).unwrap())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let read = || std::fs::read_to_string(&out_path).unwrap_or_default();
    assert!(wait_until(|| read().contains("\"cols\"")));
    tool_client(&socket).write(b"echo hello-follow\n").unwrap();
    assert!(wait_until(|| read().lines().any(|l| l.contains("\"update\"") && l.contains("hello-follow"))), "{}", read());
    let (_, closed) = tool_env(&h.path, &["close", "f1"], MINI);
    assert_eq!(closed["closed"], true);
    assert!(wait_until(|| read().contains("\"type\":\"exit\"")), "{}", read());
    assert!(wait_until(|| child.0.try_wait().ok().flatten().is_some()));
}

#[test]
fn transcript_pages_follows_and_serves_images() {
    let h = home("transcript");
    let sid = "5e2b8a52-0000-4000-8000-000000000001";
    write_ws(
        &h.path,
        serde_json::json!([
            {"id": "c1", "name": "api", "cwd": "/p", "origin": "mini", "claude": {"enabled": true, "sessionId": sid, "skipPermissions": false, "started": true}},
            {"id": "r1", "name": "remote", "cwd": "/p", "ssh": {"host": "me@studio"}, "claude": {"enabled": true, "sessionId": sid, "skipPermissions": false, "started": true}},
            {"id": "o1", "name": "other", "cwd": "/p", "origin": "studio", "claude": {"enabled": true, "sessionId": sid, "skipPermissions": false, "started": true}},
            {"id": "b1", "name": "bad", "cwd": "/p", "origin": "mini", "claude": {"enabled": true, "sessionId": "../../x", "skipPermissions": false, "started": true}},
            {"id": "g1", "name": "guessed", "cwd": "/p", "origin": "mini", "claude": {"enabled": true, "sessionId": sid, "skipPermissions": false, "started": true}}
        ]),
        serde_json::json!({}),
    );
    let tpath = h.path.join("t.jsonl");
    let user = |uuid: &str, content: serde_json::Value| serde_json::json!({"type": "user", "uuid": uuid, "timestamp": "t", "message": {"role": "user", "content": content}}).to_string();
    let asst = |uuid: &str, part: serde_json::Value| serde_json::json!({"type": "assistant", "uuid": uuid, "timestamp": "t", "message": {"id": uuid, "role": "assistant", "content": [part]}}).to_string();
    let lines = [
        user("u1", serde_json::json!("first")),
        asst("a1", serde_json::json!({"type": "text", "text": "reply one"})),
        user("u2", serde_json::json!([{"type": "text", "text": "look"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0K"}}])),
    ];
    std::fs::write(&tpath, lines.join("\n") + "\n").unwrap();
    std::fs::create_dir_all(h.path.join(".swarmz/agents")).unwrap();
    std::fs::write(
        h.path.join(".swarmz/agents/events.log"),
        format!("2026-09-16T10:00:00Z\tc1\tSessionStart\t{}\n", serde_json::json!({"session_id": sid, "transcript_path": tpath})),
    )
    .unwrap();

    let (code, v) = tool_env(&h.path, &["transcript", "c1", "--limit", "2"], MINI);
    assert_eq!(code, 0, "{v}");
    let texts: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["reply one", "look"]);
    assert_eq!(v["hasMore"], true);
    let (_, older) = tool_env(&h.path, &["transcript", "c1", "--before", "a1"], MINI);
    assert_eq!(older["messages"][0]["text"], "first");
    assert_eq!(older["hasMore"], false);
    let (_, img) = tool_env(&h.path, &["image", "c1", "u2-1"], MINI);
    assert_eq!((img["mime"].as_str(), img["base64"].as_str()), (Some("image/png"), Some("iVBORw0K")));
    let (code, missing) = tool_env(&h.path, &["image", "c1", "nope-3"], MINI);
    assert_eq!((code, missing["code"].as_str()), (1, Some("unknown")));
    let (code, bad) = tool_env(&h.path, &["image", "c1", "../x"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("invalid")));
    // Without a hook path, only this Mac's own tiles with a UUID session are guessed.
    for tile in ["r1", "o1", "b1"] {
        let (code, v) = tool_env(&h.path, &["transcript", tile], MINI);
        assert_eq!((code, v["code"].as_str()), (1, Some("unknown")), "{tile} {v}");
    }
    let (code, v) = tool_env(&h.path, &["transcript", "g1"], MINI);
    assert_eq!((code, v["messages"].as_array().map(Vec::len)), (0, Some(0)), "{v}");

    let out_path = h.path.join("t.out");
    let _child = KillOnDrop(
        tool_command(&h.path)
            .args(["transcript", "c1", "--follow", "--after", "u2"])
            .env("SWARMZ_MACHINE", "mini")
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&out_path).unwrap())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let read = || std::fs::read_to_string(&out_path).unwrap_or_default();
    assert!(wait_until(|| read().contains("\"messages\"")));
    let first: serde_json::Value = serde_json::from_str(read().lines().next().unwrap()).unwrap();
    assert_eq!(first["messages"][0]["id"], "u2");
    use std::io::Write as _;
    let mut f = std::fs::OpenOptions::new().append(true).open(&tpath).unwrap();
    writeln!(f, "{}", asst("a2", serde_json::json!({"type": "text", "text": "reply two"}))).unwrap();
    assert!(wait_until(|| read().contains("\"type\":\"message\"") && read().contains("reply two")), "{}", read());
    writeln!(f, "{}", asst("a2", serde_json::json!({"type": "tool_use", "id": "x", "name": "Bash", "input": {"command": "ls"}}))).unwrap();
    assert!(wait_until(|| read().contains("\"type\":\"update\"") && read().contains("Ran ls")), "{}", read());

    // Rewritten in place (shorter): a session event, then everything again.
    drop(f);
    std::fs::write(&tpath, user("u9", serde_json::json!("rewritten")) + "\n").unwrap();
    assert!(wait_until(|| read().contains("rewritten")), "{}", read());
    let out = read();
    let session_at = out.find(&format!("{{\"sessionId\":\"{sid}\",\"type\":\"session\",\"v\":1}}")).or_else(|| out.find("\"type\":\"session\"")).expect("a session event");
    assert!(session_at < out.find("rewritten").unwrap(), "{out}");
}

#[test]
fn a_continued_session_is_followed_into_its_new_file() {
    let h = home("continued");
    let old = "d2a228c3-0000-4000-8000-000000000001";
    let new = "fdad389a-0000-4000-8000-000000000002";
    write_ws(
        &h.path,
        serde_json::json!([
            {"id": "c1", "name": "api", "cwd": "/p", "origin": "mini", "claude": {"enabled": true, "sessionId": old, "skipPermissions": false, "started": true}},
            {"id": "g1", "name": "guessed", "cwd": "/p", "origin": "mini", "claude": {"enabled": true, "sessionId": old, "skipPermissions": false, "started": true}}
        ]),
        serde_json::json!({}),
    );
    let user = |uuid: &str, text: &str| serde_json::json!({"type": "user", "uuid": uuid, "timestamp": "t", "message": {"role": "user", "content": text}}).to_string();
    let asst = |uuid: &str, text: &str| serde_json::json!({"type": "assistant", "uuid": uuid, "timestamp": "t", "message": {"id": uuid, "role": "assistant", "content": [{"type": "text", "text": text}]}}).to_string();
    let continued = |from: &str, to: &str| serde_json::json!({"type": "continued-in", "timestamp": "t", "sessionId": from, "continuedInSessionId": to}).to_string();
    // The hook fold (c1) and the guess (g1) both name the old session.
    let dir = h.path.join(".claude/projects/-p");
    std::fs::create_dir_all(&dir).unwrap();
    let old_path = dir.join(format!("{old}.jsonl"));
    let new_path = dir.join(format!("{new}.jsonl"));
    std::fs::write(&old_path, [user("o1", "old question"), asst("o2", "old answer"), continued(old, new)].join("\n") + "\n").unwrap();
    std::fs::write(&new_path, [user("n1", "new question"), asst("n2", "new answer"), user("n3", "and more")].join("\n") + "\n").unwrap();
    std::fs::create_dir_all(h.path.join(".swarmz/agents")).unwrap();
    std::fs::write(
        h.path.join(".swarmz/agents/events.log"),
        format!("2026-09-16T10:00:00Z\tc1\tSessionStart\t{}\n", serde_json::json!({"session_id": old, "transcript_path": old_path})),
    )
    .unwrap();

    for tile in ["c1", "g1"] {
        let (code, v) = tool_env(&h.path, &["transcript", tile], MINI);
        assert_eq!(code, 0, "{v}");
        let texts: Vec<&str> = v["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert_eq!(texts, vec!["new question", "new answer", "and more"], "{tile}");
        assert!(v.get("reset").is_none(), "{v}");
    }

    let (code, v) = tool_env(&h.path, &["ls"], MINI);
    assert_eq!(code, 0, "{v}");
    for row in v["tiles"].as_array().unwrap() {
        assert_eq!((row["sessionId"].as_str(), row["lastMessage"].as_str()), (Some(new), Some("new answer")), "{row}");
    }

    // A known --after id resumes there; an unknown one gives the newest page and says reset.
    let (_, known) = tool_env(&h.path, &["transcript", "c1", "--after", "n2"], MINI);
    assert_eq!(known["messages"].as_array().map(Vec::len), Some(2), "{known}");
    assert!(known.get("reset").is_none(), "{known}");
    let (code, unknown) = tool_env(&h.path, &["transcript", "c1", "--after", "o2", "--limit", "2"], MINI);
    assert_eq!(code, 0, "{unknown}");
    let texts: Vec<&str> = unknown["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["new answer", "and more"]);
    assert_eq!((unknown["reset"].as_bool(), unknown["hasMore"].as_bool()), (Some(true), Some(true)), "{unknown}");

    // A follower moves on when the new file continues again, announcing the resolved session.
    let newer = "0badcafe-0000-4000-8000-000000000003";
    let out_path = h.path.join("t.out");
    let _child = KillOnDrop(
        tool_command(&h.path)
            .args(["transcript", "c1", "--follow"])
            .env("SWARMZ_MACHINE", "mini")
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&out_path).unwrap())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let read = || std::fs::read_to_string(&out_path).unwrap_or_default();
    assert!(wait_until(|| read().contains("\"messages\"")));
    std::fs::write(dir.join(format!("{newer}.jsonl")), user("z1", "newest question") + "\n").unwrap();
    use std::io::Write as _;
    let mut f = std::fs::OpenOptions::new().append(true).open(&new_path).unwrap();
    writeln!(f, "{}", continued(new, newer)).unwrap();
    drop(f);
    assert!(wait_until(|| read().contains("newest question")), "{}", read());
    let out = read();
    let session = out.find(&format!("{{\"sessionId\":\"{newer}\",\"type\":\"session\",\"v\":1}}")).expect(&out);
    assert!(session < out.find("newest question").unwrap(), "{out}");
}

#[test]
fn commands_on_a_missing_or_bad_tile_say_so() {
    let h = home("missing");
    for args in [["send", "nope", "hi"].as_slice(), &["pending", "nope"], &["output", "nope"], &["key", "nope", "esc"]] {
        let (code, v) = tool_env(&h.path, args, MINI);
        assert_eq!((code, v["code"].as_str()), (1, Some("not_running")), "{args:?} {v}");
    }
    let (code, v) = tool_env(&h.path, &["pending", "../etc"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("invalid")));
    let (code, v) = tool_env(&h.path, &["transcript", "nope"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("unknown")));
    // `--summary` takes a value that starts with `--`, as a command can.
    let (code, v) = tool_env(&h.path, &["answer", "nope", "yes", "--summary", "--force"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("not_running")), "{v}");
    let (code, v) = tool_env(&h.path, &["answer", "nope", "yes", "--summary"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("usage")), "{v}");
    let (code, v) = tool_env(&h.path, &["output", "nope", "--lines", "0"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("usage")));
    // A follower watches at most 5000 lines; a one-off read may ask for more.
    let (code, v) = tool_env(&h.path, &["output", "nope", "--follow", "--lines", "5001"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("usage")), "{v}");
    let (code, v) = tool_env(&h.path, &["output", "nope", "--follow", "--lines", "5000"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("not_running")), "{v}");
    let (code, v) = tool_env(&h.path, &["output", "nope", "--lines", "3000"], MINI);
    assert_eq!((code, v["code"].as_str()), (1, Some("not_running")), "{v}");
}

const TEST_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4Jm5mJ0x1bm9SZXBsYWNlVGhpc0tleUZvclRlc3Q";

#[test]
fn phone_keys_are_added_listed_and_revoked() {
    let h = home("phone");
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    let (code, v) = tool_env(&h.path, &["phone", "add", "--name", "Galaxy Fold", "--key", TEST_KEY], MINI);
    assert_eq!(code, 0, "{v}");
    assert_eq!((v["added"].as_bool(), v["machines"].as_array().map(|m| m.len())), (Some(true), Some(0)));
    let line = std::fs::read_to_string(h.path.join(".ssh/authorized_keys")).unwrap();
    assert!(line.starts_with("command=\"$HOME/.swarmz/bin/swarmz ssh-gate\",from=\"100.64.0.0/10,fd7a:115c:a1e0::/48\",no-port-forwarding"), "{line}");
    assert!(line.trim_end().ends_with("swarmz-phone:Galaxy Fold"));
    let (_, again) = tool_env(&h.path, &["phone", "add", "--name", "Galaxy Fold", "--key", TEST_KEY, "--local"], MINI);
    assert_eq!(again["added"], false);
    let (_, ls) = tool_env(&h.path, &["phone", "ls"], MINI);
    assert_eq!(ls["phones"][0]["device"], "Galaxy Fold");
    let (_, r) = tool_env(&h.path, &["phone", "revoke", "Galaxy Fold"], MINI);
    assert_eq!(r["removed"], 1);
    let (code, bad) = tool_env(&h.path, &["phone", "add", "--name", "x", "--key", "ssh-rsa AAAA"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("invalid")));
    let (code, bad) = tool_env(&h.path, &["phone", "wipe"], MINI);
    assert_eq!((code, bad["code"].as_str()), (1, Some("usage")));
}

const FIXTURE_ED25519: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPge3R3QFKHxzq6KmYIC6KzYNvdlN93DVMtK561x2P3x root@fixture";
const FIXTURE_ED25519_FP: &str = "SHA256:r1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD/hh6U";
const FIXTURE_RSA: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDsbYhsxRKkYgvHZKeNRhRVvfTfwODNFEaoBlEdeh2GlDKEupN0pfSKwKyj4vQESugdTd9CGG2z6c2Hl/DtS9GyfBQGpuXLkKT6HeM/XBPd7zlHTnPc8O54McBr7cURAH9OcXdTx6sowdybCTkuC8hRpL4LZfnmkhChHdyH4twO9rtGc+nUmWCXnwzkQzM78ToHJRnq5CH5mKgl+j4uktbf+WQbo3iKQTGY2aKzzlRMS/EoabXrnmzVrmDQmZ9wSkRWx0cqIJl9tX7lUvsMFC0pl7JtAb2HJycYN+BziV/hCQKOMLm0klYPMfgaj/N64TCbhQ2YBd5n1Qg/jHRAcLen root@fixture";
const FIXTURE_RSA_FP: &str = "SHA256:7CQ/ldJqhjJfG5HDFdkweMu4jkmliY+CecbtNbpO8J0";

/// A stand-in for `/etc/ssh`, so the test never reads the real one.
fn fixture_host_keys(home: &Path) -> String {
    let dir = home.join("etc-ssh");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ssh_host_ed25519_key.pub"), format!("{FIXTURE_ED25519}\n")).unwrap();
    std::fs::write(dir.join("ssh_host_rsa_key.pub"), format!("{FIXTURE_RSA}\n")).unwrap();
    std::fs::write(dir.join("ssh_host_ed25519_key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
    dir.to_string_lossy().into_owned()
}

#[test]
fn host_keys_prints_this_macs_name_user_and_fingerprints() {
    let h = home("hostkeys");
    let dir = fixture_host_keys(&h.path);
    let env = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_SSH_HOST_KEY_DIR", dir.as_str()), ("USER", "me")];
    let (code, v) = tool_env(&h.path, &["host-keys"], env);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["v"], 1);
    assert_eq!(v["host"], "mini");
    assert_eq!(v["user"], "me");
    let fps: Vec<&str> = v["fingerprints"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
    assert_eq!(fps, vec![FIXTURE_RSA_FP, FIXTURE_ED25519_FP], "{v}");

    // No host keys at all still prints the name and user, so the code is still worth showing.
    let empty = h.path.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let (code, v) = tool_env(
        &h.path,
        &["host-keys"],
        &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_SSH_HOST_KEY_DIR", empty.to_str().unwrap()), ("USER", "me")],
    );
    assert_eq!((code, v["fingerprints"].as_array().map(Vec::len)), (0, Some(0)), "{v}");

    // A name this Mac does not know, and a username that could be mistaken for an ssh option.
    let (code, v) = tool_env(&h.path, &["host-keys"], &[("SWARMZ_MACHINE", ""), ("SWARMZ_SSH_HOST_KEY_DIR", dir.as_str()), ("USER", "me")]);
    assert_eq!((code, v["code"].as_str()), (1, Some("failed")), "{v}");
    let (code, v) = tool_env(&h.path, &["host-keys"], &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_SSH_HOST_KEY_DIR", dir.as_str()), ("USER", "-oProxyCommand=x")]);
    assert_eq!((code, v["code"].as_str()), (1, Some("failed")), "{v}");

    let (code, v) = tool_env(&h.path, &["host-keys", "extra"], env);
    assert_eq!((code, v["code"].as_str()), (1, Some("usage")), "{v}");
}

/// Runs `ssh-gate` with `tool_command`'s HOME/PATH (never the developer's real one), the given
/// `SSH_ORIGINAL_COMMAND` (or none), and `SWARMZ_MACHINE=mini` so it never asks Tailscale.
fn gate(home: &Path, original: Option<&str>) -> (i32, serde_json::Value) {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let out_path = home.join(format!("gate-{seq}.out"));
    let mut cmd = tool_command(home);
    cmd.arg("ssh-gate").env("SWARMZ_MACHINE", "mini").env_remove("SSH_ORIGINAL_COMMAND");
    if let Some(o) = original {
        cmd.env("SSH_ORIGINAL_COMMAND", o);
    }
    let status = cmd.stdin(Stdio::null()).stdout(std::fs::File::create(&out_path).unwrap()).stderr(Stdio::null()).status().unwrap();
    let v = serde_json::from_slice(&std::fs::read(&out_path).unwrap()).unwrap_or(serde_json::Value::Null);
    (status.code().unwrap_or(-1), v)
}

#[test]
fn the_gate_runs_only_allowed_commands() {
    let h = home("gate");
    let (code, v) = gate(&h.path, Some("swarmz version"));
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["protocol"], PROTOCOL_VERSION);
    let exe = std::fs::canonicalize(EXE).unwrap();
    let (code, v) = gate(&h.path, Some(&format!("'{}' version", exe.display())));
    assert_eq!(code, 0, "{v}");
    // The literal word the phone fan-out sends names the installed tool.
    let (code, v) = gate(&h.path, Some("~/.swarmz/bin/swarmz version"));
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["protocol"], PROTOCOL_VERSION);
    for bad in [
        "swarmz attach t1",
        "swarmz ls; rm -rf ~",
        "swarmz phone add --name x --key y",
        "bash",
        "swarmz 'unterminated",
        "",
        "swarmz hold t1",
        "swarmz __keep-def t1",
        "swarmz ssh-gate",
        // The phone reads the QR code with its camera; it never runs this over ssh.
        "swarmz host-keys",
        "/tmp/swarmz version",
        "~/swarmz version",
        "'~/.swarmz/bin/swarmz ls'",
    ] {
        let (code, v) = gate(&h.path, Some(bad));
        assert_eq!((code, v["code"].as_str()), (126, Some("denied")), "{bad}: {v}");
    }
    let (code, v) = gate(&h.path, None);
    assert_eq!((code, v["code"].as_str()), (126, Some("denied")));
}

#[test]
fn phone_revoke_surfaces_a_broken_workspace_instead_of_reporting_success() {
    let h = home("phone-broken");
    write_ws(&h.path, serde_json::json!([]), serde_json::json!({}));
    let (code, v) = tool_env(&h.path, &["phone", "add", "--name", "Fold", "--key", TEST_KEY, "--local"], MINI);
    assert_eq!(code, 0, "{v}");
    // Corrupt the workspace after the local add: reading it fails, so fan-out must surface that
    // rather than treat it as "no other Macs".
    std::fs::write(h.path.join(".swarmz/workspace.json"), "not json").unwrap();
    let (code, v) = tool_env(&h.path, &["phone", "revoke", "Fold"], MINI);
    assert_eq!(code, 1, "{v}");
    assert_eq!(v["code"].as_str(), Some("failed"), "{v}");
    assert!(v["error"].as_str().unwrap().contains("revoked here"), "{v}");
    // The local revoke went ahead despite the workspace being unreadable for fan-out.
    let (_, ls) = tool_env(&h.path, &["phone", "ls"], MINI);
    assert!(ls["phones"].as_array().unwrap().is_empty(), "{ls}");
    // Reading never moved the broken file aside.
    assert_eq!(std::fs::read_to_string(h.path.join(".swarmz/workspace.json")).unwrap(), "not json");
}

#[test]
fn reading_commands_leave_a_broken_workspace_in_place() {
    let h = home("broken-read");
    std::fs::create_dir_all(h.path.join(".swarmz")).unwrap();
    let file = h.path.join(".swarmz/workspace.json");
    std::fs::write(&file, "{\"version\": 1, \"terminals\": [").unwrap();
    for args in [["ls"].as_slice(), &["machines"], &["sessions"], &["restart", "t1"], &["transcript", "t1"], &["phone", "revoke", "Fold"]] {
        tool_env(&h.path, args, MINI);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"version\": 1, \"terminals\": [", "{args:?}");
    }
    let entries: Vec<String> = std::fs::read_dir(h.path.join(".swarmz")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(!entries.iter().any(|n| n.contains("broken")), "{entries:?}");
}

#[test]
fn a_tile_keeps_its_own_board_and_the_log_carries_it() {
    let h = home("board");
    let me: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "t1")];
    let user: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")];
    let (code, v) = tool_env_input(&h.path, &["board"], me, br#"{"scheme":"moss","overview":{"goal":"Ship it","needsYou":true},"junk":1}"#);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["board"], serde_json::json!({"scheme": "Moss", "overview": {"goal": "Ship it", "needsYou": true}}));
    let log = std::fs::read_to_string(h.path.join(".swarmz/agents/events.log")).unwrap();
    assert!(log.contains("\tt1\tBoard\t{\"board\":{"), "{log}");
    // Anyone may read it; only the tile writes it; bad input is refused.
    let (code, g) = tool_env(&h.path, &["board", "--tile", "t1", "--get"], user);
    assert_eq!((code, g["board"]["overview"]["goal"].as_str()), (0, Some("Ship it")));
    let (code, d) = tool_env_input(&h.path, &["board", "--tile", "t2"], me, b"{\"overview\":{\"goal\":\"x\"}}");
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")));
    let (code, d) = tool_env_input(&h.path, &["board"], me, b"not json");
    assert_eq!((code, d["code"].as_str()), (1, Some("usage")));
    // Written inside a conversation (the hook log's SessionStart), it lands in History too.
    std::fs::write(h.path.join(".swarmz/agents/events.log"), "2026-09-26T09:00:00Z\tt1\tSessionStart\t{\"session_id\":\"sess-1\"}\n").unwrap();
    let (code, v) = tool_env_input(&h.path, &["board"], me, br#"{"overview":{"goal":"In a conversation"}}"#);
    assert_eq!((code, v["sessionId"].as_str()), (0, Some("sess-1")), "{v}");
    let (code, hist) = tool_env(&h.path, &["board", "--tile", "t1", "--history"], user);
    assert_eq!(code, 0, "{hist}");
    assert_eq!(hist["history"][0]["sessionId"], "sess-1");
    assert_eq!(hist["history"][0]["board"]["overview"]["goal"], "In a conversation");
    let (code, c) = tool_env(&h.path, &["board", "--clear"], me);
    assert_eq!((code, c["cleared"].as_bool()), (0, Some(true)));
    assert!(tool_env(&h.path, &["board", "--tile", "t1", "--get"], user).1["board"].is_null());
}

#[test]
fn a_board_request_never_types_into_a_shell_and_is_a_conductors_act() {
    let h = home("boardreq");
    let _s = held(&h, "t1");
    let user: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "")];
    std::thread::sleep(Duration::from_millis(500));
    // A plain shell has no Claude input box: nothing is typed.
    let (code, d) = tool_env(&h.path, &["board", "--request", "--tile", "t1"], user);
    assert_eq!((code, d["code"].as_str()), (1, Some("no_claude")), "{d}");
    // Another tile that is not its conductor may not ask.
    let other: &[(&str, &str)] = &[("SWARMZ_MACHINE", "mini"), ("SWARMZ_TERMINAL_ID", "t9")];
    let (code, d) = tool_env(&h.path, &["board", "--request", "--tile", "t1"], other);
    assert_eq!((code, d["code"].as_str()), (1, Some("denied")), "{d}");
    let _ = tool_env(&h.path, &["close", "t1"], user);
}
