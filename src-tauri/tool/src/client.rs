use crate::proto::{encode, json, read_frame, resize_payload, ExitInfo, Hello, Info, Kind, Welcome, PROTOCOL_VERSION};
use std::io::Write;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The viewer side of the session holder protocol: connects to a holder's socket, streams
/// output to `on_output`, and lets the caller write, resize, terminate or ask for `Info`.
///
/// Dropping a `HolderClient` detaches it (the holder keeps running); `on_exit` only runs when
/// the holder itself reports the shell exiting, never as a side effect of dropping or detaching.
pub struct HolderClient {
    stream: UnixStream,
    writer: Mutex<UnixStream>,
    info_tx: Arc<Mutex<Option<mpsc::Sender<Info>>>>,
    /// Held for a whole `info()` round trip so concurrent callers take turns.
    info_call: Mutex<()>,
    closing: Arc<AtomicBool>,
    welcome: Welcome,
}

impl HolderClient {
    pub fn connect(
        socket: &Path,
        hello: &Hello,
        on_output: impl Fn(Vec<u8>, bool) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<HolderClient, String> {
        let stream = UnixStream::connect(socket).map_err(|e| format!("could not reach the session at {}: {e}", socket.display()))?;
        let mut w = stream.try_clone().map_err(|e| e.to_string())?;
        w.write_all(&encode(Kind::Hello, &json(hello))).map_err(|e| e.to_string())?;
        let mut r = stream.try_clone().map_err(|e| e.to_string())?;
        r.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
        let first = read_frame(&mut r)
            .map_err(|e| format!("the session did not answer: {e}"))?
            .ok_or_else(|| "the session closed the connection".to_string())?;
        if first.kind != Kind::Welcome as u8 {
            return Err("the session sent an unexpected greeting".into());
        }
        let welcome: Welcome = serde_json::from_slice(&first.payload).map_err(|e| e.to_string())?;
        if welcome.v != PROTOCOL_VERSION {
            return Err(format!(
                "the session holder speaks protocol {}, this app speaks protocol {}",
                welcome.v, PROTOCOL_VERSION
            ));
        }
        // The holder always sends the Replay frame immediately after Welcome, even when there is
        // no history yet, so it is already sitting in the socket buffer by the time we get here.
        // Read it synchronously and hand it to `on_output` before returning: callers rely on a
        // successful `connect()` meaning the replay has already been delivered, not racing a
        // background thread for it (see `writes_reads_marks_replay_and_reports_exit`, which
        // checks the replay count right after `connect()` returns).
        let second = read_frame(&mut r)
            .map_err(|e| format!("the session did not answer: {e}"))?
            .ok_or_else(|| "the session closed the connection".to_string())?;
        if second.kind != Kind::Replay as u8 {
            return Err(format!("expected a replay frame, got kind {}", second.kind));
        }
        on_output(second.payload, true);
        r.set_read_timeout(None).map_err(|e| e.to_string())?;

        let info_tx: Arc<Mutex<Option<mpsc::Sender<Info>>>> = Arc::new(Mutex::new(None));
        let closing = Arc::new(AtomicBool::new(false));
        let (it, cl) = (info_tx.clone(), closing.clone());
        std::thread::spawn(move || {
            let mut on_exit = Some(on_exit);
            loop {
                match read_frame(&mut r) {
                    Ok(Some(f)) => match Kind::from_u8(f.kind) {
                        // Unreachable under the current protocol: the holder sends exactly one
                        // Replay frame, immediately after Welcome, and `connect()` already
                        // consumes it synchronously above. Kept as harmless defensive handling
                        // in case that ever changes.
                        Some(Kind::Replay) => on_output(f.payload, true),
                        Some(Kind::Data) => on_output(f.payload, false),
                        Some(Kind::Exit) => {
                            let code = serde_json::from_slice::<ExitInfo>(&f.payload).ok().and_then(|e| e.code);
                            if let Some(cb) = on_exit.take() {
                                cb(code);
                            }
                            break;
                        }
                        Some(Kind::InfoReply) => {
                            if let Ok(info) = serde_json::from_slice::<Info>(&f.payload) {
                                if let Some(tx) = it.lock().unwrap().take() {
                                    let _ = tx.send(info);
                                }
                            }
                        }
                        _ => {}
                    },
                    _ => {
                        if !cl.load(Ordering::SeqCst) {
                            if let Some(cb) = on_exit.take() {
                                cb(None);
                            }
                        }
                        break;
                    }
                }
            }
        });

        Ok(HolderClient { stream, writer: Mutex::new(w), info_tx, info_call: Mutex::new(()), closing, welcome })
    }

    pub fn welcome(&self) -> &Welcome {
        &self.welcome
    }

    fn send(&self, kind: Kind, payload: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|_| "writer poisoned".to_string())?;
        w.write_all(&encode(kind, payload)).map_err(|e| e.to_string())
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.send(Kind::Data, bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.send(Kind::Resize, &resize_payload(cols, rows))
    }

    pub fn terminate(&self) -> Result<(), String> {
        self.send(Kind::Terminate, b"")
    }

    /// Safe to call from several threads: an `InfoReply` carries no correlation id, so calls
    /// take turns (a waiting call's own `timeout` starts once its turn comes).
    pub fn info(&self, timeout: Duration) -> Option<Info> {
        let _turn = self.info_call.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        *self.info_tx.lock().ok()? = Some(tx);
        self.send(Kind::Info, b"").ok()?;
        rx.recv_timeout(timeout).ok()
    }

    /// Disconnects without ending the session.
    pub fn detach(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

impl Drop for HolderClient {
    fn drop(&mut self) {
        self.detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{Hello, PROTOCOL_VERSION};
    use crate::server::{run_holder, HolderConfig, VIEWER_QUEUE_CAP};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    fn start(tag: &str) -> (PathBuf, PathBuf, std::thread::JoinHandle<Result<Option<i32>, String>>) {
        let dir = PathBuf::from(format!("/tmp/szk-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        crate::paths::ensure_dir(&dir).unwrap();
        let cfg = HolderConfig {
            tile: "c1".into(),
            name: "c1".into(),
            cwd: dir.to_string_lossy().into_owned(),
            program: "/bin/sh".into(),
            args: vec![],
            env: vec![],
            dir: dir.clone(),
            cols: 80,
            rows: 24,
            cwd_fallback: false,
            viewer_queue_cap: VIEWER_QUEUE_CAP,
        };
        let sock = crate::paths::session_paths(&dir, "c1").unwrap().socket;
        let h = std::thread::spawn(move || run_holder(cfg));
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::os::unix::net::UnixStream::connect(&sock).is_err() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        (dir, sock, h)
    }

    fn hello() -> Hello {
        Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() }
    }

    fn wait(out: &Arc<Mutex<Vec<u8>>>, needle: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if String::from_utf8_lossy(&out.lock().unwrap()).contains(needle) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn writes_reads_marks_replay_and_reports_exit() {
        let (_d, sock, h) = start("basic");
        let out = Arc::new(Mutex::new(Vec::new()));
        let replays = Arc::new(Mutex::new(0usize));
        let (etx, erx) = mpsc::channel();
        let (o, r) = (out.clone(), replays.clone());
        let c = HolderClient::connect(&sock, &hello(), move |b, replay| {
            if replay {
                *r.lock().unwrap() += 1;
            } else {
                o.lock().unwrap().extend(b);
            }
        }, move |code| {
            let _ = etx.send(code);
        })
        .unwrap();
        assert_eq!(c.welcome().v, PROTOCOL_VERSION);
        assert_eq!(*replays.lock().unwrap(), 1);
        c.write(b"echo cli-$((5*5))\n").unwrap();
        assert!(wait(&out, "cli-25"));
        c.write(b"exit 3\n").unwrap();
        assert_eq!(erx.recv_timeout(Duration::from_secs(5)).unwrap(), Some(3));
        assert_eq!(h.join().unwrap().unwrap(), Some(3));
    }

    #[test]
    fn resize_and_info() {
        let (d, sock, h) = start("info");
        let out = Arc::new(Mutex::new(Vec::new()));
        let o = out.clone();
        let c = HolderClient::connect(&sock, &hello(), move |b, _| o.lock().unwrap().extend(b), |_| {}).unwrap();
        c.resize(101, 33).unwrap();
        c.write(b"echo sz-$(stty size | tr ' ' x)\n").unwrap();
        assert!(wait(&out, "sz-33x101"));
        let info = c.info(Duration::from_secs(3)).unwrap();
        let real = std::fs::canonicalize(&d).unwrap();
        assert_eq!(info.cwd.as_deref(), Some(real.to_str().unwrap()));
        assert_eq!(info.foreground_busy, Some(false));
        c.terminate().unwrap();
        assert!(h.join().unwrap().is_ok());
    }

    #[test]
    fn detaching_leaves_the_holder_running_and_never_reports_exit() {
        let (_d, sock, h) = start("detach");
        let (etx, erx) = mpsc::channel::<Option<i32>>();
        let c = HolderClient::connect(&sock, &hello(), |_, _| {}, move |code| {
            let _ = etx.send(code);
        })
        .unwrap();
        c.write(b"echo kept-$((6*7))\n").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        drop(c);
        assert!(erx.recv_timeout(Duration::from_millis(500)).is_err());
        let out = Arc::new(Mutex::new(Vec::new()));
        let o = out.clone();
        let again = HolderClient::connect(&sock, &hello(), move |b, _| o.lock().unwrap().extend(b), |_| {}).unwrap();
        assert!(wait(&out, "kept-42"), "replay should carry the earlier output");
        again.terminate().unwrap();
        assert!(h.join().unwrap().is_ok());
    }

    #[test]
    fn refuses_a_holder_speaking_another_protocol() {
        let dir = PathBuf::from(format!("/tmp/szk-{}-fake", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("f.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let _ = crate::proto::read_frame(&mut s);
                let w = crate::proto::Welcome { v: 99, shell_pid: None, cwd: "/".into(), started_at: "t".into() };
                let _ = crate::proto::write_frame(&mut s, crate::proto::Kind::Welcome, &crate::proto::json(&w));
            }
        });
        let err = HolderClient::connect(&sock, &hello(), |_, _| {}, |_| {}).err().unwrap();
        assert!(err.contains("protocol 99"), "{err}");
    }

    #[test]
    fn refuses_a_holder_that_skips_the_replay_frame() {
        let dir = PathBuf::from(format!("/tmp/szk-{}-noreplay", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("f.sock");
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let _ = crate::proto::read_frame(&mut s);
                let w = crate::proto::Welcome { v: PROTOCOL_VERSION, shell_pid: None, cwd: "/".into(), started_at: "t".into() };
                let _ = crate::proto::write_frame(&mut s, crate::proto::Kind::Welcome, &crate::proto::json(&w));
                // A well-behaved holder always follows Welcome with Replay; this one sends Data
                // instead, so `connect()` must fail loudly rather than silently drop the frame.
                let _ = crate::proto::write_frame(&mut s, crate::proto::Kind::Data, b"surprise");
            }
        });
        let err = HolderClient::connect(&sock, &hello(), |_, _| {}, |_| {}).err().unwrap();
        assert!(err.contains("expected a replay frame"), "{err}");
        assert!(err.contains(&(Kind::Data as u8).to_string()), "{err}");
    }
}
