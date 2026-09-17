use crate::paths::{build_id, ensure_dir, format_iso, now_iso, read_meta, session_paths, socket_live, write_meta, Meta};
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
    /// When the viewer last said a size (a sized `Hello`, a real `Resize`, or `Data` adopting the
    /// applied size); 0 means never, and such a viewer is never picked to own the size.
    spoke_at: u64,
    tx: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    stream: UnixStream,
}

/// What made the holder settle the size, for the `SWARMZ_SIZE_LOG` diagnostic.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SizeCause {
    Hello,
    /// User input: it takes ownership of the size.
    Data,
    /// A frame the emulator sent by itself (focus, mouse, a reply): ownership does not move.
    Report,
    Resize,
    Leave,
}

impl SizeCause {
    fn as_str(self) -> &'static str {
        match self {
            SizeCause::Hello => "hello",
            SizeCause::Data => "data",
            SizeCause::Report => "report",
            SizeCause::Resize => "resize",
            SizeCause::Leave => "leave",
        }
    }
}

fn fmt_size(size: Option<(u16, u16)>) -> String {
    match size {
        Some((c, r)) => format!("{c}x{r}"),
        None => "-".into(),
    }
}

/// One line per size decision, for `SWARMZ_SIZE_LOG`. `asked` is the size of the viewer that
/// caused the decision, `owner` the viewer whose size now applies.
fn size_log_line(at: &str, cause: SizeCause, who: u64, label: &str, asked: Option<(u16, u16)>, owner: Option<u64>, applied: (u16, u16), changed: bool) -> String {
    format!(
        "{at} {cause} viewer={who} label={label} asked={asked} owner={owner} applied={applied} {verdict}\n",
        cause = cause.as_str(),
        asked = fmt_size(asked),
        owner = owner.map(|o| o.to_string()).unwrap_or_else(|| "-".into()),
        applied = fmt_size(Some(applied)),
        verdict = if changed { "changed" } else { "kept" },
    )
}

/// The size log's timestamp, with milliseconds: the flipping this diagnoses can happen several
/// times a second, and whole seconds would lose the order.
fn size_log_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}Z", format_iso(d.as_secs() as i64).trim_end_matches('Z'), d.subsec_millis())
}

/// The size diagnostic's file, from `SWARMZ_SIZE_LOG`. Unset or empty means no log. It is read
/// once, when the holder starts: every holder is its own process, started per tile.
fn size_log_path(var: Option<std::ffi::OsString>) -> Option<PathBuf> {
    var.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Whether a `Data` payload is only terminal reports — things the emulator sends by itself, with
/// nobody typing: focus in/out (Claude Code turns focus reporting on), mouse reports, and the
/// replies to cursor-position, device-status and device-attribute queries. Two windows trading
/// focus would otherwise trade the session's size back and forth. Anything else, including a
/// partial or malformed sequence, counts as user input: failing towards "the user typed" is the
/// safer default. Every byte still reaches the program either way; only ownership is decided here.
fn is_report_only(payload: &[u8]) -> bool {
    let mut i = 0;
    while i < payload.len() {
        match report_len(&payload[i..]) {
            Some(n) => i += n,
            None => return false,
        }
    }
    true
}

/// The length of the complete terminal report at the start of `b`, or `None` if there is none.
fn report_len(b: &[u8]) -> Option<usize> {
    if b.len() < 3 || b[0] != 0x1b || b[1] != b'[' {
        return None;
    }
    match b[2] {
        // Focus in and focus out.
        b'I' | b'O' => return Some(3),
        // X10 mouse report: three bytes of button and position follow, any value at all.
        b'M' => return (b.len() >= 6).then_some(6),
        _ => {}
    }
    // A parameterised report: SGR mouse (`ESC [ < … M|m`), cursor position (`ESC [ … R`), device
    // status (`ESC [ [?] … n`) and device attributes (`ESC [ ?|> … c`).
    let prefix = matches!(b[2], b'<' | b'?' | b'>').then_some(b[2]);
    let start = 2 + usize::from(prefix.is_some());
    let mut i = start;
    while i < b.len() && (b[i].is_ascii_digit() || b[i] == b';') {
        i += 1;
    }
    if i == start || i >= b.len() {
        return None;
    }
    let ok = match b[i] {
        b'M' | b'm' => prefix == Some(b'<'),
        b'R' => prefix.is_none(),
        b'n' => prefix.is_none() || prefix == Some(b'?'),
        b'c' => prefix == Some(b'?') || prefix == Some(b'>'),
        _ => false,
    };
    ok.then_some(i + 1)
}

struct Shared {
    // Lock order: ring, viewers, owner, applied, screen. The Screen handler takes screen alone and releases it before viewers.
    ring: Mutex<Ring>,
    viewers: Mutex<Vec<Viewer>>,
    session: OnceLock<Arc<PtySession>>,
    welcome: OnceLock<Welcome>,
    /// The viewer whose size the session uses: the one that most recently typed, or, until
    /// anybody has, the one that most recently said a size (§3.5).
    owner: Mutex<Option<u64>>,
    applied: Mutex<(u16, u16)>,
    screen: Mutex<vt100::Parser>,
    clock: AtomicU64,
    next_id: AtomicU64,
    cap: usize,
    /// The session's metadata file, marked when a `Terminate` arrives.
    meta_path: PathBuf,
    /// Where to append the size diagnostic, from `SWARMZ_SIZE_LOG` at startup; `None` is off.
    size_log: Option<PathBuf>,
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

    /// Applies the owner's size (§3.5). The owner is the viewer that most recently typed: while it
    /// is here and has a size, another viewer's `Hello` or `Resize` is remembered but applies
    /// nothing, so two windows on one tile cannot trade its size back and forth. With no owner —
    /// a fresh session, or one whose owner has left — the viewer that most recently said a size
    /// takes over, and its size applies at once. Tool viewers are never owners.
    /// Lock order: viewers (held by the caller), then owner, then applied, then screen.
    fn apply_active_size(&self, viewers: &[Viewer], cause: SizeCause, who: u64) {
        let sized = |v: &&Viewer| v.label != TOOL_VIEWER && v.size.is_some();
        let mut owner = self.owner.lock().unwrap();
        let chosen = (*owner)
            .and_then(|id| viewers.iter().find(|v| v.id == id).filter(sized))
            .or_else(|| viewers.iter().filter(sized).filter(|v| v.spoke_at > 0).max_by_key(|v| v.spoke_at));
        let Some((id, size)) = chosen.map(|v| (v.id, v.size.unwrap())) else {
            // Nobody can set a size yet (only tool viewers, or none at all): keep what is applied.
            *owner = None;
            drop(owner);
            let applied = *self.applied.lock().unwrap();
            self.log_size(cause, who, viewers, None, applied, false);
            return;
        };
        *owner = Some(id);
        drop(owner);
        let mut applied = self.applied.lock().unwrap();
        let changed = *applied != size;
        if changed {
            *applied = size;
            if let Some(s) = self.session.get() {
                let _ = s.resize(size.0, size.1);
            }
            self.screen.lock().unwrap().screen_mut().set_size(size.1, size.0);
        }
        drop(applied);
        self.log_size(cause, who, viewers, Some(id), size, changed);
    }

    /// Appends one line per size decision to the `SWARMZ_SIZE_LOG` file. Nothing is written when
    /// the variable was unset, and a write that fails is ignored: this is a diagnostic, never a
    /// dependency.
    fn log_size(&self, cause: SizeCause, who: u64, viewers: &[Viewer], owner: Option<u64>, applied: (u16, u16), changed: bool) {
        let Some(path) = self.size_log.as_ref() else {
            return;
        };
        let v = viewers.iter().find(|v| v.id == who);
        let line = size_log_line(
            &size_log_now(),
            cause,
            who,
            v.map(|v| v.label.as_str()).unwrap_or("-"),
            v.and_then(|v| v.size),
            owner,
            applied,
            changed,
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = f.write_all(line.as_bytes());
        }
    }

    /// The clock value a joining viewer starts with: a real size counts as having spoken, a
    /// sizeless `Hello` (or any tool viewer) does not.
    fn spoke_now(&self, size: Option<(u16, u16)>, is_tool: bool) -> u64 {
        if size.is_some() && !is_tool {
            self.clock.fetch_add(1, Ordering::SeqCst)
        } else {
            0
        }
    }

    /// Adds a viewer that has already been sent its `Welcome` and `Replay`, and settles the size.
    fn join(&self, viewers: &mut Vec<Viewer>, viewer: Viewer) {
        let id = viewer.id;
        viewers.push(viewer);
        self.apply_active_size(viewers, SizeCause::Hello, id);
    }

    /// Drops a viewer and settles the size again: if it owned the size, someone else takes over.
    fn leave(&self, id: u64) {
        let mut vs = self.viewers.lock().unwrap();
        vs.retain(|v| v.id != id);
        self.apply_active_size(&vs, SizeCause::Leave, id);
    }

    /// A `Data` frame from a viewer. Real input makes that viewer the owner of the size; a frame
    /// the emulator sent by itself (focus, mouse, a reply to a query) does not, or two windows
    /// trading focus over one tile would trade its size too. The bytes reach the program either
    /// way; this only decides ownership.
    fn touch(&self, id: u64, payload: &[u8]) {
        let typed = !is_report_only(payload);
        let mut vs = self.viewers.lock().unwrap();
        let applied = *self.applied.lock().unwrap();
        let mut owns = false;
        if typed {
            if let Some(v) = vs.iter_mut().find(|v| v.id == id && v.label != TOOL_VIEWER) {
                v.spoke_at = self.clock.fetch_add(1, Ordering::SeqCst);
                // A viewer that never said its size types at the size already applied.
                v.size.get_or_insert(applied);
                owns = true;
            }
        }
        if owns {
            *self.owner.lock().unwrap() = Some(id);
        }
        self.apply_active_size(&vs, if typed { SizeCause::Data } else { SizeCause::Report }, id);
    }

    /// A viewer's new size: remembered always, applied only when that viewer owns the size.
    /// Zeros are ignored.
    fn resize_viewer(&self, id: u64, size: (u16, u16)) {
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        let mut vs = self.viewers.lock().unwrap();
        if let Some(v) = vs.iter_mut().find(|v| v.id == id && v.label != TOOL_VIEWER) {
            v.size = Some(size);
            v.spoke_at = self.clock.fetch_add(1, Ordering::SeqCst);
        }
        self.apply_active_size(&vs, SizeCause::Resize, id);
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
        owner: Mutex::new(None),
        applied: Mutex::new((cfg.cols, cfg.rows)),
        screen: Mutex::new(vt100::Parser::new(cfg.rows, cfg.cols, SCROLLBACK)),
        clock: AtomicU64::new(1),
        next_id: AtomicU64::new(1),
        cap: cfg.viewer_queue_cap,
        meta_path: paths.meta.clone(),
        size_log: size_log_path(std::env::var_os("SWARMZ_SIZE_LOG")),
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
        screen: true,
        terminating_at: None,
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
            spoke_at: shared.spoke_now(size, is_tool),
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
        shared.join(&mut vs, viewer);
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
                shared.touch(id, &frame.payload);
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
                // Marked at once: the shell can take seconds to exit, and until then the session
                // still looks live to anyone who only checks the pid and socket.
                if let Some(mut m) = read_meta(&shared.meta_path) {
                    if m.exited_at.is_none() && m.terminating_at.is_none() {
                        m.terminating_at = Some(now_iso());
                        let _ = write_meta(&shared.meta_path, &m);
                    }
                }
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

    shared.leave(id);
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

    /// Drives `Shared`'s size decisions on their own: no shell, no sockets to speak of, so a
    /// test can say exactly who joined, typed, resized and left, and read the applied size.
    struct SizeFixture {
        sh: Arc<Shared>,
        /// The far ends of each viewer's channel and socket, kept alive for the fixture's life.
        keep: Vec<(mpsc::Receiver<Vec<u8>>, UnixStream)>,
    }

    impl SizeFixture {
        fn new(cols: u16, rows: u16) -> SizeFixture {
            let sh = Arc::new(Shared {
                ring: Mutex::new(Ring::new(RING_CAP)),
                viewers: Mutex::new(Vec::new()),
                session: OnceLock::new(),
                welcome: OnceLock::new(),
                owner: Mutex::new(None),
                applied: Mutex::new((cols, rows)),
                screen: Mutex::new(vt100::Parser::new(rows, cols, SCROLLBACK)),
                clock: AtomicU64::new(1),
                next_id: AtomicU64::new(1),
                cap: VIEWER_QUEUE_CAP,
                meta_path: PathBuf::from("/nonexistent/szsize-meta.json"),
                size_log: None,
            });
            SizeFixture { sh, keep: Vec::new() }
        }

        /// The same fixture with the size diagnostic on, as `SWARMZ_SIZE_LOG` turns it on.
        fn logging_to(cols: u16, rows: u16, log: &std::path::Path) -> SizeFixture {
            let mut f = SizeFixture::new(cols, rows);
            Arc::get_mut(&mut f.sh).unwrap().size_log = size_log_path(Some(log.as_os_str().to_owned()));
            f
        }

        /// Mirrors the `Hello` path: zeros mean "no size yet".
        fn join(&mut self, label: &str, cols: u16, rows: u16) -> u64 {
            let size = (cols > 0 && rows > 0).then_some((cols, rows));
            let is_tool = label == TOOL_VIEWER;
            let id = self.sh.next_id.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = mpsc::channel();
            let (mine, theirs) = UnixStream::pair().unwrap();
            let viewer = super::Viewer {
                id,
                label: label.into(),
                size,
                spoke_at: self.sh.spoke_now(size, is_tool),
                tx,
                queued: Arc::new(AtomicUsize::new(0)),
                stream: theirs,
            };
            {
                let mut vs = self.sh.viewers.lock().unwrap();
                self.sh.join(&mut vs, viewer);
            }
            self.keep.push((rx, mine));
            id
        }

        fn types(&self, id: u64) {
            self.sh.touch(id, b"ls\r");
        }

        /// A `Data` frame the emulator sent by itself.
        fn reports(&self, id: u64, payload: &[u8]) {
            assert!(is_report_only(payload), "the fixture's report must read as one");
            self.sh.touch(id, payload);
        }

        fn resize(&self, id: u64, cols: u16, rows: u16) {
            self.sh.resize_viewer(id, (cols, rows));
        }

        fn leave(&self, id: u64) {
            self.sh.leave(id);
        }

        fn applied(&self) -> (u16, u16) {
            *self.sh.applied.lock().unwrap()
        }

        /// The screen model's size, as (cols, rows).
        fn screen_size(&self) -> (u16, u16) {
            let sh = self.sh.screen.lock().unwrap();
            let (rows, cols) = sh.screen().size();
            (cols, rows)
        }
    }

    #[test]
    fn two_viewers_with_different_sizes_settle_with_nobody_typing() {
        let mut f = SizeFixture::new(80, 24);
        let a = f.join("window", 89, 128);
        assert_eq!(f.applied(), (89, 128), "the first viewer to give a size owns it");
        let b = f.join("window", 55, 70);
        assert_eq!(f.applied(), (89, 128), "a second window's hello must not take the size");
        // Both panes keep reporting their own size as they lay out and re-fit. Nobody types.
        for _ in 0..5 {
            f.resize(b, 55, 70);
            assert_eq!(f.applied(), (89, 128), "a viewer that has not typed cannot change the size");
            f.resize(a, 89, 128);
            assert_eq!(f.applied(), (89, 128));
        }
        assert_eq!(f.screen_size(), (89, 128), "the screen model follows the applied size");
    }

    #[test]
    fn typing_hands_the_size_over() {
        let mut f = SizeFixture::new(80, 24);
        let a = f.join("window", 89, 128);
        let b = f.join("window", 55, 70);
        assert_eq!(f.applied(), (89, 128));
        f.types(b);
        assert_eq!(f.applied(), (55, 70), "the viewer that types owns the size");
        f.resize(b, 60, 75);
        assert_eq!(f.applied(), (60, 75), "the owner's resize applies");
        f.resize(a, 89, 128);
        assert_eq!(f.applied(), (60, 75), "a resize from the other window still does nothing");
        f.types(a);
        assert_eq!(f.applied(), (89, 128), "typing takes the size back");
        assert_eq!(f.screen_size(), (89, 128));
    }

    #[test]
    fn one_viewer_always_gets_its_size() {
        let mut f = SizeFixture::new(80, 24);
        let a = f.join("window", 90, 20);
        assert_eq!(f.applied(), (90, 20));
        f.resize(a, 100, 30);
        assert_eq!(f.applied(), (100, 30), "the only viewer resizes before typing");
        f.types(a);
        f.resize(a, 110, 40);
        assert_eq!(f.applied(), (110, 40), "and after typing");
    }

    #[test]
    fn when_the_owner_leaves_the_remaining_viewer_applies() {
        let mut f = SizeFixture::new(80, 24);
        let a = f.join("window", 89, 128);
        let b = f.join("window", 55, 70);
        f.types(a);
        assert_eq!(f.applied(), (89, 128));
        f.leave(a);
        assert_eq!(f.applied(), (55, 70), "the size falls to the viewer that most recently said one");
        f.resize(b, 50, 60);
        assert_eq!(f.applied(), (50, 60), "and that viewer now owns it");
    }

    #[test]
    fn focus_and_mouse_reports_leave_the_size_with_the_typist() {
        let mut f = SizeFixture::new(80, 24);
        let a = f.join("window", 89, 128);
        let b = f.join("window", 55, 70);
        f.types(a);
        assert_eq!(f.applied(), (89, 128));
        // The other window is clicked and the pointer crosses it: its emulator reports focus and
        // mouse on its own, with nobody typing there.
        for _ in 0..3 {
            f.reports(b, b"\x1b[O");
            f.reports(b, b"\x1b[I");
            f.reports(b, b"\x1b[<0;40;12M");
            f.reports(b, b"\x1b[<0;40;12m");
            f.reports(a, b"\x1b[O");
            assert_eq!(f.applied(), (89, 128), "reports must never move the size");
        }
        // Real input there still does.
        f.types(b);
        assert_eq!(f.applied(), (55, 70));
    }

    #[test]
    fn report_only_payloads_are_told_from_typing() {
        // Terminal reports, which the emulator sends by itself.
        for r in [
            &b"\x1b[I"[..],
            b"\x1b[O",
            b"\x1b[M !!",
            b"\x1b[<0;40;12M",
            b"\x1b[<35;120;40m",
            b"\x1b[12;40R",
            b"\x1b[0n",
            b"\x1b[?62;1;6c",
            b"\x1b[>0;95;0c",
            b"\x1b[?50n",
        ] {
            assert!(is_report_only(r), "report: {:?}", String::from_utf8_lossy(r));
        }
        // Several in one frame, in any mix.
        assert!(is_report_only(b"\x1b[O\x1b[I\x1b[<0;1;1M\x1b[<0;1;1m\x1b[3;9R"));
        // An empty frame types nothing, so it cannot claim the size either.
        assert!(is_report_only(b""));
        // Real input, including a report with a keystroke after it.
        for k in [
            &b"\x1b[Ihello"[..],
            b"\x1b[Ox",
            b"\x1b[<0;1;1M\r",
            b"a",
            b"\r",
            b"\x03",
            b"\x1b[A",
            b"\x1b[200~pasted\x1b[201~",
            // Partial or malformed: read as typing, the safer default.
            b"\x1b[",
            b"\x1b[<0;40;12",
            b"\x1b[M!",
            b"\x1b[999",
            b"\x1b[;R\x1b",
        ] {
            assert!(!is_report_only(k), "input: {:?}", String::from_utf8_lossy(k));
        }
    }

    #[test]
    fn the_size_log_line_says_who_asked_and_what_applied() {
        let now = size_log_now();
        assert_eq!(now.len(), 24, "an ISO timestamp with milliseconds: {now}");
        assert!(now.ends_with('Z') && now.as_bytes()[19] == b'.', "{now}");

        assert_eq!(
            size_log_line("2026-09-17T14:53:31Z", SizeCause::Resize, 4, "window", Some((89, 128)), Some(4), (89, 128), true),
            "2026-09-17T14:53:31Z resize viewer=4 label=window asked=89x128 owner=4 applied=89x128 changed\n"
        );
        assert_eq!(
            size_log_line("2026-09-17T14:53:32Z", SizeCause::Hello, 5, "window", Some((55, 70)), Some(4), (89, 128), false),
            "2026-09-17T14:53:32Z hello viewer=5 label=window asked=55x70 owner=4 applied=89x128 kept\n"
        );
        assert_eq!(
            size_log_line("2026-09-17T14:53:33Z", SizeCause::Leave, 4, "-", None, None, (89, 128), false),
            "2026-09-17T14:53:33Z leave viewer=4 label=- asked=- owner=- applied=89x128 kept\n"
        );
        assert_eq!(
            size_log_line("2026-09-17T14:53:34Z", SizeCause::Report, 5, "window", Some((55, 70)), Some(4), (89, 128), false),
            "2026-09-17T14:53:34Z report viewer=5 label=window asked=55x70 owner=4 applied=89x128 kept\n"
        );
    }

    #[test]
    fn the_size_log_records_every_decision_and_only_when_asked_for() {
        assert_eq!(size_log_path(None), None, "unset: no log");
        assert_eq!(size_log_path(Some(std::ffi::OsString::new())), None, "empty: no log");
        assert_eq!(size_log_path(Some("/tmp/sz.log".into())), Some(PathBuf::from("/tmp/sz.log")));

        let dir = PathBuf::from(format!("/tmp/szs-{}-sizelog", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::paths::ensure_dir(&dir).unwrap();
        let log = dir.join("size.log");

        // Off: nothing is written at all.
        let mut off = SizeFixture::new(80, 24);
        off.join("window", 89, 128);
        assert!(!log.exists());

        let mut f = SizeFixture::logging_to(80, 24, &log);
        let a = f.join("window", 89, 128);
        let b = f.join("window", 55, 70);
        f.resize(b, 55, 71);
        f.reports(b, b"\x1b[I");
        f.types(b);
        f.leave(a);
        let text = std::fs::read_to_string(&log).unwrap();
        let causes: Vec<&str> = text.lines().map(|l| l.split(' ').nth(1).unwrap()).collect();
        assert_eq!(causes, ["hello", "hello", "resize", "report", "data", "leave"]);
        assert!(text.contains("hello viewer=2 label=window asked=55x70 owner=1 applied=89x128 kept"), "{text}");
        assert!(text.contains("report viewer=2 label=window asked=55x71 owner=1 applied=89x128 kept"), "{text}");
        assert!(text.contains("data viewer=2 label=window asked=55x71 owner=2 applied=55x71 changed"), "{text}");
        assert!(text.lines().last().unwrap().contains("leave viewer=1 label=- asked=- owner=2 applied=55x71 kept"), "{text}");

        // A path that cannot be written is ignored, not fatal.
        let mut bad = SizeFixture::logging_to(80, 24, &dir.join("nope").join("size.log"));
        bad.join("window", 90, 20);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_viewers_never_own_the_size() {
        let mut f = SizeFixture::new(80, 24);
        let t = f.join(TOOL_VIEWER, 50, 10);
        assert_eq!(f.applied(), (80, 24), "a tool viewer's hello applies nothing");
        let a = f.join("window", 89, 128);
        assert_eq!(f.applied(), (89, 128));
        f.resize(t, 50, 10);
        assert_eq!(f.applied(), (89, 128), "a tool viewer's resize applies nothing");
        f.types(t);
        assert_eq!(f.applied(), (89, 128), "a tool viewer never becomes the owner");
        f.leave(a);
        assert_eq!(f.applied(), (89, 128), "and never inherits the size either");
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
    fn focus_and_mouse_reports_over_the_socket_do_not_take_the_size() {
        let (_d, p, h) = start("focusreport", VIEWER_QUEUE_CAP);
        let mut a = Viewer::connect(&p, "window", 80, 24);
        let mut b = Viewer::connect(&p, "window", 100, 30);
        a.send(b"stty size\n");
        assert!(a.wait_for("24 80", 5));
        // The other window is clicked and the pointer crosses it: its emulator sends these by
        // itself, and they still reach the program — they just do not take the size.
        b.send(b"\x1b[I");
        b.send(b"\x1b[<0;10;5M");
        b.send(b"\x1b[<0;10;5m");
        b.send(b"\x1b[O");
        std::thread::sleep(Duration::from_millis(300));
        a.out.clear();
        // Ctrl-U first: those reports are sitting in the shell's line buffer.
        a.send(b"\x15echo sz-$(stty size | tr ' ' x)\n");
        assert!(a.wait_for("sz-24x80", 5), "reports from the other window must not resize");
        // Real typing there still hands the size over.
        b.out.clear();
        b.send(b"\x15echo sz-$(stty size | tr ' ' x)\n");
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
