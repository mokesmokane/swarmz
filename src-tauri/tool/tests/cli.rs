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

/// A PATH without the developer's own tools: a session that types a Claude line must never start
/// the real Claude Code installed on this Mac.
const SAFE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// The tool with this test's HOME, a plain `/bin/sh` for holders, and `SAFE_PATH`.
fn tool_command(home: &Path) -> Command {
    let mut cmd = Command::new(EXE);
    cmd.env("HOME", home).env("SWARMZ_HOLDER_SHELL", "/bin/sh").env("PATH", SAFE_PATH);
    cmd
}

/// A spawned long-running tool process, killed and reaped when the test ends, pass or fail.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
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
        let _ = self.0.kill();
        let _ = self.0.wait();
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

    // Restart refuses a running tile, and brings a closed one back.
    let (code, r) = tool_env(&h.path, &["restart", &id], MINI);
    assert_eq!((code, r["code"].as_str()), (1, Some("running")));
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
