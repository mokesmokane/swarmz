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
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let out_path = std::env::temp_dir().join(format!("szc-out-{}-{seq}.json", std::process::id()));
    let stdout = std::fs::File::create(&out_path).unwrap();
    let status = Command::new(EXE)
        .args(args)
        .env("HOME", home)
        .env("SWARMZ_HOLDER_SHELL", "/bin/sh")
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
