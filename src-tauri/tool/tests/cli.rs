use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};
use swarmz_tool::client::HolderClient;
use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};

const EXE: &str = env!("CARGO_BIN_EXE_swarmz-tool");

fn home(tag: &str) -> PathBuf {
    let h = PathBuf::from(format!("/tmp/szc-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&h);
    std::fs::create_dir_all(&h).unwrap();
    h
}

fn tool(home: &PathBuf, args: &[&str]) -> (i32, serde_json::Value) {
    let out = Command::new(EXE)
        .args(args)
        .env("HOME", home)
        .env("SWARMZ_HOLDER_SHELL", "/bin/sh")
        .output()
        .unwrap();
    let v = serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
    (out.status.code().unwrap_or(-1), v)
}

fn end(socket: &str) {
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "tool".into() };
    if let Ok(c) = HolderClient::connect(std::path::Path::new(socket), &hello, |_, _| {}, |_| {}) {
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
    let (code, v) = tool(&h, &["version"]);
    assert_eq!(code, 0);
    assert_eq!(v["v"], 1);
    assert_eq!(v["protocol"], PROTOCOL_VERSION);
    assert!(v["tool"].as_str().is_some());
}

#[test]
fn hold_starts_once_then_finds_the_same_session() {
    let h = home("hold");
    let cwd = h.to_string_lossy().into_owned();
    let (c1, a) = tool(&h, &["hold", "t1", "--cwd", &cwd, "--name", "one", "--cols", "90", "--rows", "30"]);
    assert_eq!(c1, 0, "{a}");
    assert_eq!(a["existed"], false);
    assert!(a["pid"].as_i64().unwrap() > 0);
    let (_, b) = tool(&h, &["hold", "t1", "--cwd", &cwd, "--name", "one"]);
    assert_eq!(b["existed"], true);
    assert_eq!(a["pid"], b["pid"]);
    let (_, info) = tool(&h, &["info", "t1"]);
    assert_eq!(info["running"], true);
    let real = std::fs::canonicalize(&h).unwrap();
    assert_eq!(info["cwd"], real.to_string_lossy().as_ref());
    end(a["socket"].as_str().unwrap());
}

#[test]
fn the_shell_carries_the_tile_id() {
    let h = home("env");
    let cwd = h.to_string_lossy().into_owned();
    let (_, a) = tool(&h, &["hold", "t2", "--cwd", &cwd, "--name", "two", "--env", "EXTRA=yes"]);
    let out = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let o = out.clone();
    let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
    let c = HolderClient::connect(std::path::Path::new(a["socket"].as_str().unwrap()), &hello, move |b, _| o.lock().unwrap().extend(b), |_| {}).unwrap();
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
    let script = format!("'{EXE}' hold t3 --cwd '{}' --name three > '{}/out.json'; exit 0", h.display(), h.display());
    let status = Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .env("HOME", &h)
        .env("SWARMZ_HOLDER_SHELL", "/bin/sh")
        .status()
        .unwrap();
    assert!(status.success());
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(h.join("out.json")).unwrap()).unwrap();
    let pid = v["pid"].as_i64().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(pid_alive(pid), "holder died with its starter");
    let ppid = Command::new("ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&ppid.stdout).trim(), "1", "holder should be reparented to launchd");
    end(v["socket"].as_str().unwrap());
}

#[test]
fn missing_folders_fall_back_to_home_unless_required() {
    let h = home("cwd");
    let (code, e) = tool(&h, &["hold", "t4", "--cwd", "/definitely/not/here", "--name", "four", "--require-cwd"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "cwd_missing");
    assert!(e["error"].as_str().unwrap().contains("/definitely/not/here is not a directory"));
    let (code, v) = tool(&h, &["hold", "t4", "--cwd", "/definitely/not/here", "--name", "four"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["cwdFallback"], true);
    assert_eq!(v["cwd"], h.to_string_lossy().as_ref());
    end(v["socket"].as_str().unwrap());
}

#[test]
fn bad_input_is_a_json_error() {
    let h = home("bad");
    let (code, e) = tool(&h, &["hold", "a/b", "--cwd", "/tmp", "--name", "x"]);
    assert_eq!(code, 1);
    assert_eq!(e["v"], 1);
    assert!(e["error"].as_str().unwrap().contains("invalid tile id"));
    let (code, e) = tool(&h, &["nonsense"]);
    assert_eq!(code, 1);
    assert_eq!(e["code"], "usage");
}

#[test]
fn a_stale_record_is_replaced_by_a_fresh_session() {
    let h = home("stale");
    let dir = h.join(".swarmz/sessions");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("t5.json"), r#"{"v":1,"pid":999999,"shellPid":null,"cwd":"/","name":"x","startedAt":"t"}"#).unwrap();
    let cwd = h.to_string_lossy().into_owned();
    let (code, v) = tool(&h, &["hold", "t5", "--cwd", &cwd, "--name", "five"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["existed"], false);
    assert_ne!(v["pid"], 999999);
    end(v["socket"].as_str().unwrap());
}

#[test]
fn info_for_a_missing_session_says_not_running() {
    let h = home("none");
    let (code, v) = tool(&h, &["info", "t6"]);
    assert_eq!(code, 0);
    assert_eq!(v["running"], false);
}
