use crate::paths::{build_id, ensure_dir, now_iso, session_paths, socket_live, write_meta, Meta};
use crate::proto::{encode, json, parse_resize, read_frame, ExitInfo, Hello, Info, Kind, ScreenRequest, Welcome, MAX_FRAME, PROTOCOL_VERSION};
use crate::pty::{PtySession, SpawnSpec};
use crate::ring::{Ring, REPLAY_PREFIX, RING_CAP};
use crate::screen::{fit_snapshot, snapshot, SCROLLBACK};
use std::io::Write;
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const VIEWER_QUEUE_CAP: usize = 8 * 1024 * 1024;

/// The label of viewers that never type and never set the size (the tool's own queries).
pub const TOOL_VIEWER: &str = "tool";

pub struct HolderConfig {
    pub tile: String,
    pub name: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub dir: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub cwd_fallback: bool,
    pub viewer_queue_cap: usize,
}

struct Viewer {
    id: u64,
    label: String,
    /// `None` until the viewer reports a real size (a `Hello` or `Resize` without zeros) or types.
    size: Option<(u16, u16)>,
    /// When the viewer last sent a sized `Hello` or `Data` (or the first real `Resize` after a
    /// sizeless `Hello`); 0 means never, and such a viewer never sets the size.
    last_active: u64,
    tx: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    stream: UnixStream,
}

struct Shared {
    // Lock order: ring, viewers, applied, screen. The Screen handler takes screen alone and releases it before viewers.
    ring: Mutex<Ring>,
    viewers: Mutex<Vec<Viewer>>,
    session: OnceLock<Arc<PtySession>>,
    welcome: OnceLock<Welcome>,
    applied: Mutex<(u16, u16)>,
    screen: Mutex<vt100::Parser>,
    clock: AtomicU64,
    next_id: AtomicU64,
    cap: usize,
}

impl Shared {
    fn enqueue(v: &Viewer, frame: Vec<u8>, cap: usize) -> bool {
        let len = frame.len();
        if v.queued.load(Ordering::SeqCst) + len > cap {
            let _ = v.stream.shutdown(Shutdown::Both);
            return false;
        }
        v.queued.fetch_add(len, Ordering::SeqCst);
        v.tx.send(frame).is_ok()
    }

    fn broadcast(&self, viewers: &mut Vec<Viewer>, frame: &[u8]) {
        let cap = self.cap;
        viewers.retain(|v| Shared::enqueue(v, frame.to_vec(), cap));
    }

    /// Applies the size of the most recently active viewer (§3.5). Lock order: viewers, then
    /// applied.
    fn apply_active_size(&self, viewers: &[Viewer]) {
        let Some(size) = viewers
            .iter()
            .filter(|v| v.label != TOOL_VIEWER && v.last_active > 0)
            .filter_map(|v| v.size.map(|s| (v.last_active, s)))
            .max_by_key(|(at, _)| *at)
            .map(|(_, s)| s)
        else {
            return;
        };
        let mut applied = self.applied.lock().unwrap();
        if *applied != size {
            *applied = size;
            if let Some(s) = self.session.get() {
                let _ = s.resize(size.0, size.1);
            }
            self.screen.lock().unwrap().screen_mut().set_size(size.1, size.0);
        }
    }

    fn touch(&self, id: u64) {
        let mut vs = self.viewers.lock().unwrap();
        let now = self.clock.fetch_add(1, Ordering::SeqCst);
        let applied = *self.applied.lock().unwrap();
        if let Some(v) = vs.iter_mut().find(|v| v.id == id && v.label != TOOL_VIEWER) {
            v.last_active = now;
            // A viewer that never said its size types at the size already applied.
            v.size.get_or_insert(applied);
        }
        self.apply_active_size(&vs);
    }

    /// A viewer's new size. The first real size from a viewer whose `Hello` had none counts as
    /// that `Hello`, making it the most recently active viewer; zeros are ignored.
    fn resize_viewer(&self, id: u64, size: (u16, u16)) {
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        let mut vs = self.viewers.lock().unwrap();
        if let Some(v) = vs.iter_mut().find(|v| v.id == id) {
            v.size = Some(size);
            if v.last_active == 0 && v.label != TOOL_VIEWER {
                v.last_active = self.clock.fetch_add(1, Ordering::SeqCst);
            }
        }
        self.apply_active_size(&vs);
    }

    fn wait_drained(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            let busy = self.viewers.lock().unwrap().iter().any(|v| v.queued.load(Ordering::SeqCst) > 0);
            if !busy {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Runs a holder for one tile until its shell exits; returns the shell's exit code.
pub fn run_holder(cfg: HolderConfig) -> Result<Option<i32>, String> {
    ensure_dir(&cfg.dir).map_err(|e| format!("could not create {}: {e}", cfg.dir.display()))?;
    let paths = session_paths(&cfg.dir, &cfg.tile)?;
    // A live holder already owns this tile's socket: never steal it out from under it. Only a
    // dead socket (stale file, nothing listening) is safe to unlink and rebind.
    if socket_live(&paths.socket) {
        return Err(format!("a session holder is already listening on {}", paths.socket.display()));
    }
    let _ = std::fs::remove_file(&paths.socket);
    let listener = UnixListener::bind(&paths.socket).map_err(|e| format!("could not listen on {}: {e}", paths.socket.display()))?;
    let _ = std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600));

    let shared = Arc::new(Shared {
        ring: Mutex::new(Ring::new(RING_CAP)),
        viewers: Mutex::new(Vec::new()),
        session: OnceLock::new(),
        welcome: OnceLock::new(),
        applied: Mutex::new((cfg.cols, cfg.rows)),
        screen: Mutex::new(vt100::Parser::new(cfg.rows, cfg.cols, SCROLLBACK)),
        clock: AtomicU64::new(1),
        next_id: AtomicU64::new(1),
        cap: cfg.viewer_queue_cap,
    });

    let (exit_tx, exit_rx) = mpsc::channel::<Option<i32>>();
    let on_data_shared = shared.clone();
    let session = PtySession::spawn(
        SpawnSpec {
            program: cfg.program.clone(),
            args: cfg.args.clone(),
            cwd: cfg.cwd.clone(),
            env: cfg.env.clone(),
            cols: cfg.cols,
            rows: cfg.rows,
        },
        move |bytes| {
            let mut ring = on_data_shared.ring.lock().unwrap();
            ring.push(&bytes);
            on_data_shared.screen.lock().unwrap().process(&bytes);
            let frame = encode(Kind::Data, &bytes);
            let mut vs = on_data_shared.viewers.lock().unwrap();
            on_data_shared.broadcast(&mut vs, &frame);
        },
        move |code| {
            let _ = exit_tx.send(code);
        },
    )?;
    let shell_pid = session.shell_pid();
    let _ = shared.session.set(Arc::new(session));
    let started_at = now_iso();
    let _ = shared.welcome.set(Welcome {
        v: PROTOCOL_VERSION,
        shell_pid,
        cwd: cfg.cwd.clone(),
        started_at: started_at.clone(),
        cols: cfg.cols,
        rows: cfg.rows,
    });
    let meta = Meta {
        v: PROTOCOL_VERSION,
        pid: std::process::id(),
        shell_pid,
        cwd: cfg.cwd.clone(),
        name: cfg.name.clone(),
        started_at,
        exited_at: None,
        exit_code: None,
        cwd_fallback: cfg.cwd_fallback,
        build: Some(build_id()),
    };
    write_meta(&paths.meta, &meta).map_err(|e| format!("could not write {}: {e}", paths.meta.display()))?;

    let acc = shared.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(s) = stream {
                let sh = acc.clone();
                std::thread::spawn(move || handle_viewer(sh, s));
            }
        }
    });

    let code = exit_rx.recv().unwrap_or(None);
    // Let the reader thread hand over the shell's last output before announcing the exit.
    std::thread::sleep(Duration::from_millis(50));
    // Remove the socket before broadcasting Exit, not after: otherwise a viewer could connect
    // in between and never receive an Exit frame of its own, waiting forever.
    let _ = std::fs::remove_file(&paths.socket);
    {
        let _ring = shared.ring.lock().unwrap();
        let mut vs = shared.viewers.lock().unwrap();
        shared.broadcast(&mut vs, &encode(Kind::Exit, &json(&ExitInfo { code })));
    }
    let _ = write_meta(&paths.meta, &Meta { exited_at: Some(now_iso()), exit_code: Some(code.unwrap_or(-1)), ..meta });
    shared.wait_drained(Duration::from_secs(1));
    Ok(code)
}

fn handle_viewer(shared: Arc<Shared>, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(mut reader) = stream.try_clone() else { return };
    let hello = match read_frame(&mut reader) {
        Ok(Some(f)) if f.kind == Kind::Hello as u8 => serde_json::from_slice::<Hello>(&f.payload).ok(),
        _ => None,
    };
    let Some(hello) = hello else { return };
    let _ = stream.set_read_timeout(None);
    let Some(mut welcome) = shared.welcome.get().cloned() else { return };
    if hello.v != PROTOCOL_VERSION {
        let mut s = &stream;
        let _ = s.write_all(&encode(Kind::Welcome, &json(&welcome)));
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let queued = Arc::new(AtomicUsize::new(0));
    let Ok(mut wstream) = stream.try_clone() else { return };
    let wq = queued.clone();
    std::thread::spawn(move || {
        for buf in rx {
            let n = buf.len();
            if wstream.write_all(&buf).is_err() {
                break;
            }
            wq.fetch_sub(n, Ordering::SeqCst);
        }
        let _ = wstream.shutdown(Shutdown::Both);
    });

    let id = shared.next_id.fetch_add(1, Ordering::SeqCst);
    // Tool viewers only ask questions: no history, and no redraw of the programs on screen.
    let is_tool = hello.viewer == TOOL_VIEWER;
    // A zero in the Hello means the viewer does not know its size yet (a window reattaching
    // before it has laid out): it must not resize the session to a guess.
    let size = (hello.cols > 0 && hello.rows > 0).then_some((hello.cols, hello.rows));
    {
        let ring = shared.ring.lock().unwrap();
        let mut vs = shared.viewers.lock().unwrap();
        let Ok(vstream) = stream.try_clone() else { return };
        let viewer = Viewer {
            id,
            label: hello.viewer.clone(),
            size,
            last_active: if size.is_some() && !is_tool { shared.clock.fetch_add(1, Ordering::SeqCst) } else { 0 },
            tx,
            queued,
            stream: vstream,
        };
        // The size the replay below was written at, before this viewer's own size applies.
        let applied = *shared.applied.lock().unwrap();
        (welcome.cols, welcome.rows) = applied;
        let replay = if is_tool {
            Vec::new()
        } else {
            let mut r = REPLAY_PREFIX.to_vec();
            r.extend(ring.replay());
            r
        };
        Shared::enqueue(&viewer, encode(Kind::Welcome, &json(&welcome)), usize::MAX);
        Shared::enqueue(&viewer, encode(Kind::Replay, &replay), usize::MAX);
        vs.push(viewer);
        shared.apply_active_size(&vs);
    }
    if !is_tool {
        if let Some(s) = shared.session.get() {
            s.signal_foreground(libc::SIGWINCH);
        }
    }

    loop {
        let frame = match read_frame(&mut reader) {
            Ok(Some(f)) => f,
            _ => break,
        };
        match Kind::from_u8(frame.kind) {
            Some(Kind::Data) => {
                shared.touch(id);
                if let Some(s) = shared.session.get() {
                    let _ = s.write(&frame.payload);
                }
            }
            Some(Kind::Resize) => {
                if let Some(size) = parse_resize(&frame.payload) {
                    shared.resize_viewer(id, size);
                }
            }
            Some(Kind::Terminate) => {
                if let Some(s) = shared.session.get() {
                    s.terminate();
                }
            }
            Some(Kind::Info) => {
                // The screen lock alone, released before viewers are locked (lock order).
                let bracketed_paste = Some(shared.screen.lock().unwrap().screen().bracketed_paste());
                let info = match shared.session.get() {
                    Some(s) => Info { cwd: s.cwd(), foreground_busy: s.foreground_busy(), foreground_command: s.foreground_command(), bracketed_paste },
                    None => Info { cwd: None, foreground_busy: None, foreground_command: None, bracketed_paste },
                };
                let vs = shared.viewers.lock().unwrap();
                if let Some(v) = vs.iter().find(|v| v.id == id) {
                    Shared::enqueue(v, encode(Kind::InfoReply, &json(&info)), usize::MAX);
                }
            }
            Some(Kind::Screen) => {
                let want = serde_json::from_slice::<ScreenRequest>(&frame.payload).map(|r| r.lines).unwrap_or(200).clamp(1, SCROLLBACK + 500);
                // Built with only the screen lock held; viewers are locked afterwards (lock order).
                let snap = snapshot(&mut shared.screen.lock().unwrap(), want);
                // A reply over MAX_FRAME would read as the session ending: drop the oldest lines.
                let payload = fit_snapshot(snap, MAX_FRAME - 1024);
                let vs = shared.viewers.lock().unwrap();
                if let Some(v) = vs.iter().find(|v| v.id == id) {
                    Shared::enqueue(v, encode(Kind::ScreenReply, &payload), usize::MAX);
                }
            }
            _ => {}
        }
    }

    let mut vs = shared.viewers.lock().unwrap();
    vs.retain(|v| v.id != id);
    shared.apply_active_size(&vs);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::session_paths;
    use crate::proto::{read_frame, write_frame, Hello, Kind, PROTOCOL_VERSION};
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn start(tag: &str, cap: usize) -> (PathBuf, crate::paths::SessionPaths, std::thread::JoinHandle<Result<Option<i32>, String>>) {
        let dir = PathBuf::from(format!("/tmp/szs-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        crate::paths::ensure_dir(&dir).unwrap();
        let cfg = HolderConfig {
            tile: "t1".into(),
            name: "t1".into(),
            cwd: dir.to_string_lossy().into_owned(),
            program: "/bin/sh".into(),
            args: vec![],
            env: vec![("PS1".into(), "$ ".into())],
            dir: dir.clone(),
            cols: 80,
            rows: 24,
            cwd_fallback: false,
            viewer_queue_cap: cap,
        };
        let paths = session_paths(&dir, "t1").unwrap();
        let handle = std::thread::spawn(move || run_holder(cfg));
        let deadline = Instant::now() + Duration::from_secs(5);
        while UnixStream::connect(&paths.socket).is_err() {
            assert!(Instant::now() < deadline, "holder socket never appeared");
            std::thread::sleep(Duration::from_millis(20));
        }
        (dir, paths, handle)
    }

    struct Viewer {
        s: UnixStream,
        out: Vec<u8>,
        exit: Option<Option<i32>>,
        replay: Vec<u8>,
        welcome: crate::proto::Welcome,
        // How much of `out` has already been searched for a needle in `wait_for`, less a
        // needle's worth of overlap so a match straddling two reads is still found. Without
        // this, `wait_for` would re-scan the whole (unboundedly growing) buffer on every frame,
        // which is quadratic and, over a multi-megabyte transfer, dwarfs the transfer itself.
        scanned: usize,
    }

    impl Viewer {
        fn connect(paths: &crate::paths::SessionPaths, label: &str, cols: u16, rows: u16) -> Viewer {
            let mut s = UnixStream::connect(&paths.socket).unwrap();
            let hello = Hello { v: PROTOCOL_VERSION, cols, rows, viewer: label.into() };
            write_frame(&mut s, Kind::Hello, &serde_json::to_vec(&hello).unwrap()).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let w = read_frame(&mut s).unwrap().unwrap();
            assert_eq!(w.kind, Kind::Welcome as u8);
            let welcome = serde_json::from_slice(&w.payload).unwrap();
            let r = read_frame(&mut s).unwrap().unwrap();
            assert_eq!(r.kind, Kind::Replay as u8);
            Viewer { s, out: Vec::new(), exit: None, replay: r.payload, welcome, scanned: 0 }
        }

        fn send(&mut self, bytes: &[u8]) {
            write_frame(&mut self.s, Kind::Data, bytes).unwrap();
        }

        fn frame(&mut self, kind: Kind, payload: &[u8]) {
            write_frame(&mut self.s, kind, payload).unwrap();
        }

        /// Reads until `needle` appears in the output (or an Exit arrives), up to `secs`.
        fn wait_for(&mut self, needle: &str, secs: u64) -> bool {
            self.s.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
            let deadline = Instant::now() + Duration::from_secs(secs);
            while Instant::now() < deadline {
                // An empty needle means "wait for the Exit frame", handled below; every string
                // trivially "contains" "", so this check must not fire for it or wait_for("")
                // would return before ever reading a frame.
                if !needle.is_empty() {
                    // Scans only what hasn't been searched yet (plus a needle's worth of
                    // overlap, so a match straddling two reads is still found), rather than the
                    // whole accumulated buffer every time: over a multi-megabyte transfer that
                    // re-scan is quadratic and dwarfs the transfer itself.
                    // The size test clears `out` mid-flight to look only at what comes next;
                    // when that has shrunk `out` past where we last scanned, there is nothing
                    // carried over to re-check.
                    self.scanned = self.scanned.min(self.out.len());
                    let start = self.scanned.saturating_sub(needle.len().saturating_sub(1));
                    let hit = String::from_utf8_lossy(&self.out[start..]).contains(needle);
                    self.scanned = self.out.len();
                    if hit {
                        return true;
                    }
                }
                match read_frame(&mut self.s) {
                    Ok(Some(f)) if f.kind == Kind::Data as u8 => self.out.extend(f.payload),
                    Ok(Some(f)) if f.kind == Kind::Exit as u8 => {
                        let e: crate::proto::ExitInfo = serde_json::from_slice(&f.payload).unwrap();
                        self.exit = Some(e.code);
                        return needle.is_empty();
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => return false,
                    Err(_) => {}
                }
            }
            // On timeout, an empty needle must not trivially read as "found" (every string
            // "contains" ""): report whether an Exit frame actually arrived, so a caller waiting
            // for exit fails the assertion instead of hanging forever in `h.join()`.
            if needle.is_empty() {
                self.exit.is_some()
            } else {
                String::from_utf8_lossy(&self.out).contains(needle)
            }
        }
    }

    #[test]
    fn two_viewers_see_the_same_output() {
        let (_d, p, h) = start("two", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        let mut b = Viewer::connect(&p, "phone", 80, 24);
        a.send(b"echo hello-$((1+1))\n");
        assert!(a.wait_for("hello-2", 5));
        assert!(b.wait_for("hello-2", 5));
        a.send(b"exit 0\n");
        assert!(a.wait_for("", 5));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn a_new_viewer_gets_the_history_as_replay() {
        let (_d, p, h) = start("replay", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        a.send(b"echo past-$((3+4))\n");
        assert!(a.wait_for("past-7", 5));
        let c = Viewer::connect(&p, "window", 80, 24);
        assert!(c.replay.starts_with(b"\x1b[!p"));
        assert!(String::from_utf8_lossy(&c.replay).contains("past-7"));
        a.send(b"exit 0\n");
        assert!(a.wait_for("", 5));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn exit_reaches_viewers_and_cleans_up() {
        let (_d, p, h) = start("exit", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        a.send(b"exit 7\n");
        assert!(a.wait_for("", 5));
        assert_eq!(a.exit, Some(Some(7)));
        assert_eq!(h.join().unwrap().unwrap(), Some(7));
        assert!(!p.socket.exists());
        let meta = crate::paths::read_meta(&p.meta).unwrap();
        assert_eq!(meta.exit_code, Some(7));
        assert!(meta.exited_at.is_some());
    }

    #[test]
    fn a_viewer_with_another_protocol_version_is_turned_away() {
        let (_d, p, h) = start("ver", VIEWER_QUEUE_CAP);
        let mut s = UnixStream::connect(&p.socket).unwrap();
        let hello = Hello { v: 99, cols: 80, rows: 24, viewer: "window".into() };
        write_frame(&mut s, Kind::Hello, &serde_json::to_vec(&hello).unwrap()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(read_frame(&mut s).unwrap().unwrap().kind, Kind::Welcome as u8);
        let mut rest = Vec::new();
        let _ = s.read_to_end(&mut rest);
        assert!(rest.is_empty(), "no replay or data for a mismatched viewer");
        let mut a = Viewer::connect(&p, "window", 80, 24);
        a.send(b"exit 0\n");
        assert!(a.wait_for("", 5));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn the_most_recent_typist_sets_the_size_and_tools_never_do() {
        let (_d, p, h) = start("size", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        let mut b = Viewer::connect(&p, "phone", 100, 30);
        b.send(b"stty size\n");
        assert!(b.wait_for("30 100", 5));
        a.send(b"stty size\n");
        assert!(a.wait_for("24 80", 5));
        let _t = Viewer::connect(&p, "tool", 50, 10);
        a.out.clear();
        a.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(a.wait_for("sz-24x80", 5));
        // A resize from the active viewer applies at once.
        a.frame(Kind::Resize, &crate::proto::resize_payload(90, 20));
        a.out.clear();
        a.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(a.wait_for("sz-20x90", 5));
        // When the active viewer leaves, the next most recent (b) applies.
        drop(a);
        std::thread::sleep(Duration::from_millis(300));
        b.out.clear();
        b.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(b.wait_for("sz-30x100", 5));
        b.send(b"exit 0\n");
        assert!(b.wait_for("", 5));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn a_sizeless_hello_keeps_the_applied_size_until_the_viewer_resizes_or_types() {
        let (_d, p, h) = start("nosize", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 90, 20);
        assert_eq!((a.welcome.cols, a.welcome.rows), (80, 24), "the welcome carries the size before this viewer's");
        a.send(b"stty size\n");
        assert!(a.wait_for("20 90", 5));
        // A reattaching window that has not laid out yet: no resize, and it reads the size the
        // replay was written at.
        let mut b = Viewer::connect(&p, "window", 0, 0);
        assert_eq!((b.welcome.cols, b.welcome.rows), (90, 20));
        std::thread::sleep(Duration::from_millis(200));
        a.out.clear();
        a.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(a.wait_for("sz-20x90", 5));
        // Zeros in a Resize are ignored too.
        b.frame(Kind::Resize, &crate::proto::resize_payload(0, 0));
        a.out.clear();
        a.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(a.wait_for("sz-20x90", 5));
        // Typing adopts the applied size rather than inventing one.
        b.out.clear();
        b.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(b.wait_for("sz-20x90", 5));
        // When it leaves, nothing it never reported is applied; a still applies.
        let mut c = Viewer::connect(&p, "window", 0, 0);
        c.frame(Kind::Resize, &crate::proto::resize_payload(70, 15));
        c.out.clear();
        c.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(c.wait_for("sz-15x70", 5), "the first real resize counts as the viewer's hello");
        drop(c);
        std::thread::sleep(Duration::from_millis(300));
        a.out.clear();
        a.send(b"echo sz-$(stty size | tr ' ' x)\n");
        assert!(a.wait_for("sz-20x90", 5));
        let d = Viewer::connect(&p, "window", 0, 0);
        assert_eq!((d.welcome.cols, d.welcome.rows), (90, 20));
        a.send(b"exit 0\n");
        assert!(a.wait_for("", 5));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn tool_viewers_get_no_replay_and_no_redraw() {
        let (_d, p, h) = start("toolview", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        a.send(b"echo hist-$((2*21)); sh -c 'trap \"printf %s-%s\\\\n got winch\" WINCH; while :; do sleep 0.1; done'\n");
        assert!(a.wait_for("hist-42", 5));
        std::thread::sleep(Duration::from_millis(400));
        let t = Viewer::connect(&p, "tool", 0, 0);
        assert!(t.replay.is_empty(), "a tool viewer gets an empty replay: {:?}", String::from_utf8_lossy(&t.replay));
        assert!(!a.wait_for("got-winch", 1), "a tool viewer must not make programs redraw");
        // A window viewer (sizeless, so no resize of its own) does.
        let w = Viewer::connect(&p, "window", 0, 0);
        assert!(String::from_utf8_lossy(&w.replay).contains("hist-42"));
        assert!(a.wait_for("got-winch", 5));
        a.frame(Kind::Terminate, b"");
        assert!(a.wait_for("", 8));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn terminate_ends_the_session() {
        let (_d, p, h) = start("term", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        a.send(b"sleep 100\n");
        std::thread::sleep(Duration::from_millis(300));
        a.frame(Kind::Terminate, b"");
        assert!(a.wait_for("", 8));
        assert!(a.exit.is_some());
        h.join().unwrap().unwrap();
    }

    #[test]
    fn info_reports_folder_and_foreground() {
        let (d, p, h) = start("info", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        let ask = |v: &mut Viewer| -> crate::proto::Info {
            v.frame(Kind::Info, b"");
            v.s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            loop {
                let f = read_frame(&mut v.s).unwrap().unwrap();
                if f.kind == Kind::InfoReply as u8 {
                    return serde_json::from_slice(&f.payload).unwrap();
                }
            }
        };
        let idle = ask(&mut a);
        let real = std::fs::canonicalize(&d).unwrap();
        assert_eq!(idle.cwd.as_deref(), Some(real.to_str().unwrap()));
        assert_eq!(idle.foreground_busy, Some(false));
        assert_eq!(idle.bracketed_paste, Some(false));
        a.send(b"printf '\\033[?2004h'; echo paste-on\n");
        assert!(a.wait_for("paste-on", 5));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(ask(&mut a).bracketed_paste, Some(true));
        a.send(b"sleep 5\n");
        std::thread::sleep(Duration::from_millis(400));
        let busy = ask(&mut a);
        assert_eq!(busy.foreground_busy, Some(true));
        assert_eq!(busy.foreground_command.as_deref(), Some("sleep"));
        a.frame(Kind::Terminate, b"");
        assert!(a.wait_for("", 8));
        h.join().unwrap().unwrap();
    }

    #[test]
    fn a_viewer_that_stops_reading_is_dropped_without_stalling_others() {
        let (_d, p, h) = start("slow", 64 * 1024);
        let mut stuck = Viewer::connect(&p, "tool", 80, 24);
        // Set the drain timeout now, while the connection is still fully alive: once the holder
        // evicts and fully closes its end (all clones dropped, not just shut down), some
        // platforms refuse further socket-option calls on our end of an already-gone peer
        // (getpeername-style EINVAL) even though plain reads keep working fine and correctly
        // reach EOF.
        stuck.s.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
        let mut fast = Viewer::connect(&p, "window", 80, 24);
        fast.send(b"head -c 3000000 /dev/zero | tr '\\0' a; echo; echo done-$((40+2))\n");
        assert!(fast.wait_for("done-42", 30), "holder stalled on a viewer that never reads");
        // The stuck viewer should have been disconnected once its queue went over cap: its
        // socket should reach EOF (or otherwise error out) within a reasonable time, rather than
        // sitting open forever.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match read_frame(&mut stuck.s) {
                Ok(None) => break,
                Err(e) if e.kind() != std::io::ErrorKind::WouldBlock && e.kind() != std::io::ErrorKind::TimedOut => break,
                _ => {}
            }
            assert!(Instant::now() < deadline, "stuck viewer's socket never reached EOF");
        }
        fast.send(b"exit 0\n");
        assert!(fast.wait_for("", 5));
        h.join().unwrap().unwrap();
    }
}
