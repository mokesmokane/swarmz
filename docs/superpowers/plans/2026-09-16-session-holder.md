# Session Holder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tile's shell runs in a detached session holder on its home Mac, so tiles survive swarmz quitting or relaunching, and a tile whose home is another Mac attaches to that Mac's holder over ssh.

**Architecture:** A new Rust crate, `swarmz-tool` (in `src-tauri/tool/`, a Cargo workspace member), holds the PTY code, a framed socket protocol, the holder server, a client, and a CLI binary `swarmz-tool` (installed as `~/.swarmz/bin/swarmz`) with `version`, `hold`, `info` and `attach`. The app runs `swarmz hold` and connects to the holder's socket instead of owning a PTY; replayed output is emitted on its own event so clipboard and marker escapes are not re-run. Remote tiles type `ssh … swarmz attach …`, and an OSC marker tells the app whether the remote session is new.

**Tech Stack:** Rust (portable-pty, libc, serde_json, std Unix sockets), Tauri 2, TypeScript, zustand, xterm.js, vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-swarmz-phone-design.md` §2, §3 (and §11 spike results). The `Screen`/`ScreenReply` frames and the screen model (§3.4) belong to sub-project 2 and are not built here; the holder ignores unknown frame types, so adding them later is compatible.

## Global Constraints

- Frames: `type: u8`, `len: u32` big-endian, payload; max payload 16 MiB. Types: Hello 1, Welcome 2, Replay 3, Data 4, Resize 5, Exit 6, Terminate 7, Info 8, InfoReply 9. Unknown types are ignored. `PROTOCOL_VERSION = 1`.
- Hello `{v, cols, rows, viewer}`; Welcome `{v, shellPid, cwd, startedAt}`; Exit `{code}`; Info reply `{cwd, foregroundBusy, foregroundCommand}` (camelCase JSON).
- Sessions directory `~/.swarmz/sessions` (mode 0700); per tile `<tile>.sock` (0600), `<tile>.json`, `<tile>.log`. Tile ids match `^[A-Za-z0-9-]{1,64}$`. Socket paths longer than 100 bytes are refused.
- Replay: ring of the last 2 MiB; sent as `ESC [ ! p` followed by the ring from the first byte after its first `\n` once the ring has ever dropped bytes (the whole ring otherwise); SIGWINCH to the foreground process group after sending it.
- Size: the most recently active non-`tool` viewer (last `Hello` or `Data`) sets the PTY size; on its disconnect the next most recent applies; `tool` viewers never set it.
- Per-viewer queue cap 8 MiB; a viewer over the cap is disconnected; the holder never blocks on a viewer.
- Holder shell: `$SWARMZ_HOLDER_SHELL` (no args) when set, else `$SHELL -l` (fallback `/bin/zsh`); env `TERM=xterm-256color`, `COLORTERM=truecolor`, `SWARMZ_TERMINAL_ID`, `SWARMZ_TERMINAL_NAME`, plus `--env K=V`.
- Terminate: SIGHUP to the shell's and the foreground process groups, SIGKILL 3 s later if the shell is still alive.
- Attach marker: `ESC ] 1337 ; swarmz-attach ; new=<0|1> BEL`, written before the replay.
- CLI prints one JSON object; errors print `{"v":1,"error":…,"code":…}` and exit 1.
- The installed tool path is `~/.swarmz/bin/swarmz`; the bundled copy sits next to the app executable as `swarmz-tool`.
- Rust tests: run `cargo test --workspace` from `src-tauri`. Frontend: `npm test`, `npm run typecheck`. Never run `tauri dev`/`tauri build` during implementation.
- Commit messages follow `type(scope): summary` and end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src-tauri/Cargo.toml` | becomes a workspace root; depends on `swarmz-tool` |
| `src-tauri/tool/Cargo.toml` | the tool crate (lib `swarmz_tool` + bin `swarmz-tool`) |
| `src-tauri/tool/src/pty.rs` | moved from the app; gains pid/group helpers |
| `src-tauri/tool/src/proto.rs` | frames and message types |
| `src-tauri/tool/src/ring.rs` | replay ring buffer |
| `src-tauri/tool/src/paths.rs` | session paths, metadata, liveness, timestamps |
| `src-tauri/tool/src/server.rs` | the holder |
| `src-tauri/tool/src/client.rs` | `HolderClient` |
| `src-tauri/tool/src/hold.rs` | start-or-find a detached holder |
| `src-tauri/tool/src/attach.rs` | the ssh bridge |
| `src-tauri/tool/src/main.rs` | CLI |
| `src-tauri/tool/tests/cli.rs` | CLI integration tests |
| `src-tauri/src/session.rs` | `TerminalSession` trait for the app |
| `src-tauri/src/toolbin.rs` | install the tool, run `hold`, remote tool helpers |
| `src-tauri/src/commands.rs`, `lib.rs`, `registry.rs` | app wiring |
| `src/lib/ipc.ts`, `src/lib/xtermRegistry.ts`, `src/store.ts`, `src/lib/workspace.ts` | frontend wiring |
| `package.json`, `src-tauri/tauri.conf.json`, `CLAUDE.md` | build, bundle, docs |

---

### Task 1: Tool crate, workspace, protocol, and moving the PTY code

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/tool/Cargo.toml`, `src-tauri/tool/src/lib.rs`, `src-tauri/tool/src/main.rs`, `src-tauri/tool/src/proto.rs`
- Move: `src-tauri/src/pty.rs` → `src-tauri/tool/src/pty.rs` (with its tests)
- Modify: `src-tauri/src/lib.rs` (replace `pub mod pty;` with a re-export)

**Interfaces:**
- Produces: crate `swarmz_tool` with `pub mod proto; pub mod pty;`; `proto::{PROTOCOL_VERSION, MAX_FRAME, Kind, Frame, encode, write_frame, read_frame, resize_payload, parse_resize, json, Hello, Welcome, ExitInfo, Info}`; `pty::PtySession` gains `shell_pid() -> Option<u32>`, `foreground_pgrp() -> Option<i32>`, `signal_foreground(sig: i32)`, `foreground_command() -> Option<String>`, `terminate()`. The app keeps `crate::pty::…` paths via `pub use swarmz_tool::pty;`.

- [ ] **Step 1: Create the crate and workspace**

`src-tauri/Cargo.toml`: add at the top, before `[package]`:

```toml
[workspace]
members = ["tool"]
```

and under `[dependencies]` add `swarmz-tool = { path = "tool" }` and `libc = "0.2"`.

`src-tauri/tool/Cargo.toml`:

```toml
[package]
name = "swarmz-tool"
version = "0.1.0"
edition = "2021"
description = "swarmz session holder and command-line tool"

[lib]
name = "swarmz_tool"
path = "src/lib.rs"

[[bin]]
name = "swarmz-tool"
path = "src/main.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
portable-pty = "0.9"
libc = "0.2"
```

`src-tauri/tool/src/lib.rs`:

```rust
pub mod proto;
pub mod pty;
```

`src-tauri/tool/src/main.rs` (placeholder replaced in Task 6):

```rust
fn main() {
    println!("{}", serde_json::json!({ "v": 1, "tool": env!("CARGO_PKG_VERSION"), "protocol": swarmz_tool::proto::PROTOCOL_VERSION }));
}
```

Move the file: `git mv src-tauri/src/pty.rs src-tauri/tool/src/pty.rs`. In `src-tauri/src/lib.rs` replace `pub mod pty;` with `pub use swarmz_tool::pty;`.

- [ ] **Step 2: Write the failing tests**

Append to `src-tauri/tool/src/pty.rs`'s existing `cwd_tests` module (it keeps its current tests):

```rust
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
        session.terminate();
        assert!(rx.recv_timeout(std::time::Duration::from_secs(6)).is_ok(), "shell did not exit after terminate");
    }
```

Create `src-tauri/tool/src/proto.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, Kind::Data, b"hello").unwrap();
        write_frame(&mut buf, Kind::Terminate, b"").unwrap();
        assert_eq!(&buf[..5], &[4, 0, 0, 0, 5]);
        let mut r = Cursor::new(buf);
        let a = read_frame(&mut r).unwrap().unwrap();
        assert_eq!((a.kind, a.payload.as_slice()), (Kind::Data as u8, &b"hello"[..]));
        let b = read_frame(&mut r).unwrap().unwrap();
        assert_eq!((b.kind, b.payload.len()), (Kind::Terminate as u8, 0));
        assert!(read_frame(&mut r).unwrap().is_none());
    }

    #[test]
    fn truncated_and_oversized_frames_are_errors() {
        let mut r = Cursor::new(vec![4u8, 0, 0]);
        assert!(read_frame(&mut r).is_err());
        let mut big = vec![4u8];
        big.extend_from_slice(&((MAX_FRAME as u32) + 1).to_be_bytes());
        assert!(read_frame(&mut Cursor::new(big)).is_err());
    }

    #[test]
    fn kinds_and_resize_payloads() {
        assert_eq!(Kind::from_u8(9), Some(Kind::InfoReply));
        assert_eq!(Kind::from_u8(42), None);
        assert_eq!(parse_resize(&resize_payload(132, 43)), Some((132, 43)));
        assert_eq!(parse_resize(&[1, 2, 3]), None);
    }

    #[test]
    fn messages_use_camel_case() {
        let w = Welcome { v: 1, shell_pid: Some(7), cwd: "/p".into(), started_at: "t".into() };
        let v: serde_json::Value = serde_json::from_slice(&json(&w)).unwrap();
        assert_eq!(v["shellPid"], 7);
        assert_eq!(v["startedAt"], "t");
        let i = Info { cwd: None, foreground_busy: Some(true), foreground_command: Some("sleep".into()) };
        let v: serde_json::Value = serde_json::from_slice(&json(&i)).unwrap();
        assert_eq!(v["foregroundBusy"], true);
        assert_eq!(v["foregroundCommand"], "sleep");
        let h: Hello = serde_json::from_str(r#"{"v":1,"cols":80,"rows":24,"viewer":"window"}"#).unwrap();
        assert_eq!(h.viewer, "window");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test -p swarmz-tool 2>&1 | grep -E "error\[|cannot find|no method" | head`
Expected: compile errors for the missing proto items and the new `PtySession` methods.

- [ ] **Step 4: Implement**

Above the tests in `proto.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    Welcome = 2,
    Replay = 3,
    Data = 4,
    Resize = 5,
    Exit = 6,
    Terminate = 7,
    Info = 8,
    InfoReply = 9,
}

impl Kind {
    pub fn from_u8(b: u8) -> Option<Kind> {
        Some(match b {
            1 => Kind::Hello,
            2 => Kind::Welcome,
            3 => Kind::Replay,
            4 => Kind::Data,
            5 => Kind::Resize,
            6 => Kind::Exit,
            7 => Kind::Terminate,
            8 => Kind::Info,
            9 => Kind::InfoReply,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

pub fn encode(kind: Kind, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind as u8);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn write_frame(w: &mut impl Write, kind: Kind, payload: &[u8]) -> io::Result<()> {
    w.write_all(&encode(kind, payload))
}

/// Reads one frame. `Ok(None)` on a clean end of stream before a frame starts.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        let n = r.read(&mut head[got..])?;
        if n == 0 {
            return if got == 0 { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        got += n;
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some(Frame { kind: head[0], payload }))
}

pub fn resize_payload(cols: u16, rows: u16) -> [u8; 4] {
    let c = cols.to_be_bytes();
    let r = rows.to_be_bytes();
    [c[0], c[1], r[0], r[1]]
}

pub fn parse_resize(p: &[u8]) -> Option<(u16, u16)> {
    if p.len() != 4 {
        return None;
    }
    Some((u16::from_be_bytes([p[0], p[1]]), u16::from_be_bytes([p[2], p[3]])))
}

pub fn json<T: Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).expect("protocol messages always serialise")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub v: u32,
    pub cols: u16,
    pub rows: u16,
    pub viewer: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub v: u32,
    pub shell_pid: Option<u32>,
    pub cwd: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExitInfo {
    pub code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub cwd: Option<String>,
    pub foreground_busy: Option<bool>,
    pub foreground_command: Option<String>,
}
```

In `tool/src/pty.rs`, add `use std::time::Duration;` at the top and these methods inside `impl PtySession` (after `cwd`):

```rust
    pub fn shell_pid(&self) -> Option<u32> {
        self.shell_pid
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

    /// Hangs up the shell and whatever runs in its foreground; kills both if the shell is
    /// still alive three seconds later.
    #[cfg(unix)]
    pub fn terminate(&self) {
        let shell = self.shell_pid.map(|p| p as i32);
        let fg = self.foreground_pgrp();
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
            if let Some(p) = shell {
                if unsafe { libc::kill(p, 0) } == 0 {
                    send(libc::SIGKILL);
                }
            }
        });
    }

    #[cfg(not(unix))]
    pub fn terminate(&self) {
        self.kill();
    }
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --workspace 2>&1 | grep -E "test result|warning|error" | head`
Expected: every `test result: ok`, no warnings. The app's existing tests (including `commands.rs`'s `dummy_session`, which uses `crate::pty`) still compile through the re-export.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tool src-tauri/src/lib.rs src-tauri/src/pty.rs
git commit -m "feat(core): swarmz-tool crate with the frame protocol; PTY code moves into it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Replay ring, session paths and metadata

**Files:**
- Create: `src-tauri/tool/src/ring.rs`, `src-tauri/tool/src/paths.rs`
- Modify: `src-tauri/tool/src/lib.rs`

**Interfaces:**
- Produces: `ring::{RING_CAP, REPLAY_PREFIX, Ring}` with `Ring::new(cap)`, `push(&mut self, &[u8])`, `replay(&self) -> Vec<u8>` (prefix not included); `paths::{valid_tile_id, home_dir, sessions_dir, sessions_dir_in, ensure_dir, SessionPaths, session_paths, Meta, write_meta, read_meta, pid_alive, socket_live, live_session, clear_stale, now_iso, MAX_SOCKET_PATH}`.

- [ ] **Step 1: Write the failing tests**

`src-tauri/tool/src/ring.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_until_full() {
        let mut r = Ring::new(16);
        r.push(b"abc\n");
        r.push(b"def");
        assert_eq!(r.replay(), b"abc\ndef");
    }

    #[test]
    fn after_dropping_it_replays_from_the_first_line_boundary() {
        let mut r = Ring::new(10);
        r.push(b"\x1b[31mred\nline2\n");
        // 15 bytes into 10: the oldest 5 are gone; replay starts after the first newline left.
        assert_eq!(r.replay(), b"line2\n");
    }

    #[test]
    fn a_push_larger_than_the_ring_keeps_its_tail() {
        let mut r = Ring::new(4);
        r.push(b"123456789");
        assert_eq!(r.replay(), b"");
        r.push(b"\nab");
        assert_eq!(r.replay(), b"ab");
    }

    #[test]
    fn prefix_is_a_soft_reset() {
        assert_eq!(REPLAY_PREFIX, b"\x1b[!p");
        assert_eq!(RING_CAP, 2 * 1024 * 1024);
    }
}
```

`src-tauri/tool/src/paths.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::path::PathBuf::from(format!("/tmp/szp-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn tile_ids() {
        assert!(valid_tile_id("7035-abc-DEF"));
        assert!(!valid_tile_id(""));
        assert!(!valid_tile_id("a/b"));
        assert!(!valid_tile_id(&"x".repeat(65)));
    }

    #[test]
    fn ensure_dir_is_private() {
        let d = tmp("dir").join("sessions");
        ensure_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn meta_round_trips_and_liveness() {
        let d = tmp("meta");
        ensure_dir(&d).unwrap();
        let p = session_paths(&d, "t1").unwrap();
        assert!(p.socket.ends_with("t1.sock"));
        assert!(live_session(&p).is_none());
        let m = Meta {
            v: 1,
            pid: std::process::id(),
            shell_pid: Some(1),
            cwd: "/x".into(),
            name: "n".into(),
            started_at: now_iso(),
            exited_at: None,
            exit_code: None,
            cwd_fallback: false,
        };
        write_meta(&p.meta, &m).unwrap();
        assert_eq!(read_meta(&p.meta), Some(m.clone()));
        // No socket listening: not live, and clear_stale removes the metadata.
        assert!(live_session(&p).is_none());
        clear_stale(&p);
        assert!(read_meta(&p.meta).is_none());
        // A listening socket and a live pid make it live.
        let _l = std::os::unix::net::UnixListener::bind(&p.socket).unwrap();
        write_meta(&p.meta, &m).unwrap();
        assert_eq!(live_session(&p).map(|x| x.pid), Some(std::process::id()));
        // An exited session is never live.
        write_meta(&p.meta, &Meta { exit_code: Some(0), ..m }).unwrap();
        assert!(live_session(&p).is_none());
    }

    #[test]
    fn pids() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(999_999));
    }

    #[test]
    fn long_socket_paths_are_refused() {
        let d = std::path::PathBuf::from(format!("/tmp/{}", "d".repeat(90)));
        assert!(session_paths(&d, "t1").is_err());
    }

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso(1_789_466_669), "2026-09-15T10:04:29Z");
        assert!(now_iso().ends_with('Z'));
    }
}
```

Add `pub mod paths; pub mod ring;` to `lib.rs`.

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p swarmz-tool ring:: paths:: 2>&1 | grep -E "cannot find" | head -3`
Expected: missing items.

- [ ] **Step 3: Implement**

Above the tests in `ring.rs`:

```rust
use std::collections::VecDeque;

pub const RING_CAP: usize = 2 * 1024 * 1024;
/// DECSTR soft reset, sent before a replay so modes left over in the viewer are cleared.
pub const REPLAY_PREFIX: &[u8] = b"\x1b[!p";

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    dropped: bool,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: VecDeque::with_capacity(cap.min(64 * 1024)), cap, dropped: false }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
            self.dropped = true;
            return;
        }
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.dropped = true;
        }
        self.buf.extend(bytes);
    }

    /// What a new viewer should be shown. Once bytes have been dropped the ring may start inside
    /// an escape sequence or a line, so it replays from just after the first newline instead.
    pub fn replay(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        let all: Vec<u8> = a.iter().chain(b.iter()).copied().collect();
        if !self.dropped {
            return all;
        }
        match all.iter().position(|&c| c == b'\n') {
            Some(i) => all[i + 1..].to_vec(),
            None => Vec::new(),
        }
    }
}
```

Above the tests in `paths.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

/// macOS allows 104 bytes in a socket path; stay well inside it.
pub const MAX_SOCKET_PATH: usize = 100;

pub fn valid_tile_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()))
}

pub fn sessions_dir_in(home: &Path) -> PathBuf {
    home.join(".swarmz").join("sessions")
}

pub fn sessions_dir() -> PathBuf {
    sessions_dir_in(&home_dir())
}

pub fn ensure_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionPaths {
    pub socket: PathBuf,
    pub meta: PathBuf,
    pub log: PathBuf,
}

pub fn session_paths(dir: &Path, tile: &str) -> Result<SessionPaths, String> {
    if !valid_tile_id(tile) {
        return Err(format!("invalid tile id {tile:?}"));
    }
    let socket = dir.join(format!("{tile}.sock"));
    if socket.as_os_str().len() > MAX_SOCKET_PATH {
        return Err(format!("session socket path is too long: {}", socket.display()));
    }
    Ok(SessionPaths { socket, meta: dir.join(format!("{tile}.json")), log: dir.join(format!("{tile}.log")) })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub v: u32,
    pub pid: u32,
    pub shell_pid: Option<u32>,
    pub cwd: String,
    pub name: String,
    pub started_at: String,
    #[serde(default)]
    pub exited_at: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub cwd_fallback: bool,
}

pub fn write_meta(path: &Path, meta: &Meta) -> io::Result<()> {
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(meta).expect("meta serialises"))?;
    std::fs::rename(&tmp, path)
}

pub fn read_meta(path: &Path) -> Option<Meta> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn socket_live(path: &Path) -> bool {
    UnixStream::connect(path).is_ok()
}

/// The session's metadata when its holder is running and listening.
pub fn live_session(paths: &SessionPaths) -> Option<Meta> {
    let meta = read_meta(&paths.meta)?;
    if meta.exit_code.is_some() || meta.exited_at.is_some() || !pid_alive(meta.pid) || !socket_live(&paths.socket) {
        return None;
    }
    Some(meta)
}

/// Removes the socket and metadata of a session that is not live. The log is kept.
pub fn clear_stale(paths: &SessionPaths) {
    if live_session(paths).is_none() {
        let _ = std::fs::remove_file(&paths.socket);
        let _ = std::fs::remove_file(&paths.meta);
    }
}

pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_iso(secs)
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's civil-from-days).
pub fn format_iso(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test -p swarmz-tool 2>&1 | grep -E "test result|warning" | head -3`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tool/src
git commit -m "feat(core): replay ring and session paths for the holder

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The holder server

**Files:**
- Create: `src-tauri/tool/src/server.rs`
- Modify: `src-tauri/tool/src/lib.rs`

**Interfaces:**
- Consumes: `proto::*`, `ring::*`, `paths::*`, `pty::{PtySession, SpawnSpec}`.
- Produces: `server::{VIEWER_QUEUE_CAP, HolderConfig, run_holder}`; `HolderConfig { tile, name, cwd, program, args, env, dir, cols, rows, cwd_fallback, viewer_queue_cap }`; `run_holder(cfg: HolderConfig) -> Result<Option<i32>, String>` blocks until the shell exits and returns its code.

- [ ] **Step 1: Write the failing tests**

`server.rs` tests (add `pub mod server;` to `lib.rs`):

```rust
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
    }

    impl Viewer {
        fn connect(paths: &crate::paths::SessionPaths, label: &str, cols: u16, rows: u16) -> Viewer {
            let mut s = UnixStream::connect(&paths.socket).unwrap();
            let hello = Hello { v: PROTOCOL_VERSION, cols, rows, viewer: label.into() };
            write_frame(&mut s, Kind::Hello, &serde_json::to_vec(&hello).unwrap()).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let w = read_frame(&mut s).unwrap().unwrap();
            assert_eq!(w.kind, Kind::Welcome as u8);
            let r = read_frame(&mut s).unwrap().unwrap();
            assert_eq!(r.kind, Kind::Replay as u8);
            Viewer { s, out: Vec::new(), exit: None, replay: r.payload }
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
                if String::from_utf8_lossy(&self.out).contains(needle) {
                    return true;
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
            String::from_utf8_lossy(&self.out).contains(needle)
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
        let _stuck = Viewer::connect(&p, "tool", 80, 24);
        let mut fast = Viewer::connect(&p, "window", 80, 24);
        fast.send(b"head -c 3000000 /dev/zero | tr '\\0' a; echo; echo done-$((40+2))\n");
        assert!(fast.wait_for("done-42", 30), "holder stalled on a viewer that never reads");
        fast.send(b"exit 0\n");
        assert!(fast.wait_for("", 5));
        h.join().unwrap().unwrap();
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p swarmz-tool server:: 2>&1 | grep -E "cannot find" | head -3`
Expected: missing `HolderConfig`, `run_holder`, `VIEWER_QUEUE_CAP`.

- [ ] **Step 3: Implement**

Above the tests in `server.rs`:

```rust
use crate::paths::{ensure_dir, now_iso, session_paths, write_meta, Meta};
use crate::proto::{encode, json, parse_resize, read_frame, ExitInfo, Hello, Info, Kind, Welcome, PROTOCOL_VERSION};
use crate::pty::{PtySession, SpawnSpec};
use crate::ring::{Ring, REPLAY_PREFIX, RING_CAP};
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
    size: (u16, u16),
    last_active: u64,
    tx: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    stream: UnixStream,
}

struct Shared {
    // Lock order: ring, then viewers. Never take ring while holding viewers.
    ring: Mutex<Ring>,
    viewers: Mutex<Vec<Viewer>>,
    session: OnceLock<Arc<PtySession>>,
    welcome: OnceLock<Welcome>,
    applied: Mutex<(u16, u16)>,
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

    fn apply_active_size(&self, viewers: &[Viewer]) {
        let Some(active) = viewers.iter().filter(|v| v.label != "tool").max_by_key(|v| v.last_active) else {
            return;
        };
        let mut applied = self.applied.lock().unwrap();
        if *applied != active.size {
            *applied = active.size;
            if let Some(s) = self.session.get() {
                let _ = s.resize(active.size.0, active.size.1);
            }
        }
    }

    fn touch(&self, id: u64) {
        let mut vs = self.viewers.lock().unwrap();
        let now = self.clock.fetch_add(1, Ordering::SeqCst);
        if let Some(v) = vs.iter_mut().find(|v| v.id == id && v.label != "tool") {
            v.last_active = now;
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
    let _ = std::fs::remove_file(&paths.socket);
    let listener = UnixListener::bind(&paths.socket).map_err(|e| format!("could not listen on {}: {e}", paths.socket.display()))?;
    let _ = std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600));

    let shared = Arc::new(Shared {
        ring: Mutex::new(Ring::new(RING_CAP)),
        viewers: Mutex::new(Vec::new()),
        session: OnceLock::new(),
        welcome: OnceLock::new(),
        applied: Mutex::new((cfg.cols, cfg.rows)),
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
    let _ = shared.welcome.set(Welcome { v: PROTOCOL_VERSION, shell_pid, cwd: cfg.cwd.clone(), started_at: started_at.clone() });
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
    {
        let _ring = shared.ring.lock().unwrap();
        let mut vs = shared.viewers.lock().unwrap();
        shared.broadcast(&mut vs, &encode(Kind::Exit, &json(&ExitInfo { code })));
    }
    let _ = std::fs::remove_file(&paths.socket);
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
    let Some(welcome) = shared.welcome.get().cloned() else { return };
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
    {
        let ring = shared.ring.lock().unwrap();
        let mut vs = shared.viewers.lock().unwrap();
        let Ok(vstream) = stream.try_clone() else { return };
        let viewer = Viewer {
            id,
            label: hello.viewer.clone(),
            size: (hello.cols, hello.rows),
            last_active: shared.clock.fetch_add(1, Ordering::SeqCst),
            tx,
            queued,
            stream: vstream,
        };
        let mut replay = REPLAY_PREFIX.to_vec();
        replay.extend(ring.replay());
        Shared::enqueue(&viewer, encode(Kind::Welcome, &json(&welcome)), usize::MAX);
        Shared::enqueue(&viewer, encode(Kind::Replay, &replay), usize::MAX);
        vs.push(viewer);
        shared.apply_active_size(&vs);
    }
    if let Some(s) = shared.session.get() {
        s.signal_foreground(libc::SIGWINCH);
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
                    let mut vs = shared.viewers.lock().unwrap();
                    if let Some(v) = vs.iter_mut().find(|v| v.id == id) {
                        v.size = size;
                    }
                    shared.apply_active_size(&vs);
                }
            }
            Some(Kind::Terminate) => {
                if let Some(s) = shared.session.get() {
                    s.terminate();
                }
            }
            Some(Kind::Info) => {
                let info = match shared.session.get() {
                    Some(s) => Info { cwd: s.cwd(), foreground_busy: s.foreground_busy(), foreground_command: s.foreground_command() },
                    None => Info { cwd: None, foreground_busy: None, foreground_command: None },
                };
                let vs = shared.viewers.lock().unwrap();
                if let Some(v) = vs.iter().find(|v| v.id == id) {
                    Shared::enqueue(v, encode(Kind::InfoReply, &json(&info)), usize::MAX);
                }
            }
            _ => {}
        }
    }

    let mut vs = shared.viewers.lock().unwrap();
    vs.retain(|v| v.id != id);
    shared.apply_active_size(&vs);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test -p swarmz-tool server:: 2>&1 | grep -E "test |test result" | head -12`
Expected: 8 passed. If the slow-viewer test is slow, confirm it is the 3 MB transfer and not a stall (it must finish well inside 30 s).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tool/src
git commit -m "feat(core): session holder serves one shell to many viewers with replay, sizing and info

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: HolderClient

**Files:**
- Create: `src-tauri/tool/src/client.rs`
- Modify: `src-tauri/tool/src/lib.rs`

**Interfaces:**
- Consumes: `proto::*`; `server::{HolderConfig, run_holder, VIEWER_QUEUE_CAP}` in tests.
- Produces: `client::HolderClient` with `connect(socket: &Path, hello: &Hello, on_output: impl Fn(Vec<u8>, bool) + Send + 'static, on_exit: impl FnOnce(Option<i32>) + Send + 'static) -> Result<HolderClient, String>` (the `bool` is `true` for replayed bytes), `welcome(&self) -> &Welcome`, `write(&self, &[u8]) -> Result<(), String>`, `resize(&self, u16, u16) -> Result<(), String>`, `terminate(&self) -> Result<(), String>`, `info(&self, Duration) -> Option<Info>`, `detach(&self)`. Dropping a client detaches it; `on_exit` never runs after `detach`.

- [ ] **Step 1: Write the failing tests**

`client.rs` tests (add `pub mod client;` to `lib.rs`):

```rust
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
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p swarmz-tool client:: 2>&1 | grep -E "cannot find" | head -3`
Expected: `HolderClient` missing.

- [ ] **Step 3: Implement**

Above the tests in `client.rs`:

```rust
use crate::proto::{encode, json, read_frame, resize_payload, ExitInfo, Hello, Info, Kind, Welcome, PROTOCOL_VERSION};
use std::io::Write;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct HolderClient {
    stream: UnixStream,
    writer: Mutex<UnixStream>,
    info_tx: Arc<Mutex<Option<mpsc::Sender<Info>>>>,
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
        r.set_read_timeout(None).map_err(|e| e.to_string())?;

        let info_tx: Arc<Mutex<Option<mpsc::Sender<Info>>>> = Arc::new(Mutex::new(None));
        let closing = Arc::new(AtomicBool::new(false));
        let (it, cl) = (info_tx.clone(), closing.clone());
        std::thread::spawn(move || {
            let mut on_exit = Some(on_exit);
            loop {
                match read_frame(&mut r) {
                    Ok(Some(f)) => match Kind::from_u8(f.kind) {
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

        Ok(HolderClient { stream, writer: Mutex::new(w), info_tx, closing, welcome })
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

    pub fn info(&self, timeout: Duration) -> Option<Info> {
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
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test -p swarmz-tool 2>&1 | grep -E "test result|warning" | head -3`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tool/src
git commit -m "feat(core): HolderClient connects to a session holder and can detach without ending it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `hold` and the CLI (`version`, `hold`, `info`)

**Files:**
- Create: `src-tauri/tool/src/hold.rs`, `src-tauri/tool/tests/cli.rs`
- Modify: `src-tauri/tool/src/main.rs`, `src-tauri/tool/src/lib.rs`

**Interfaces:**
- Consumes: `paths::*`, `server::*`, `client::HolderClient`.
- Produces: `hold::{HoldRequest, HoldResult, hold, holder_program}`; `HoldRequest { tile, name, cwd, cols, rows, env: Vec<(String, String)>, require_cwd: bool }`; `HoldResult { v, socket, existed, pid, shell_pid, cwd, cwd_fallback }` (Serialize + Deserialize, camelCase); `hold(exe: &Path, dir: &Path, req: &HoldRequest) -> Result<HoldResult, CliError>`; `CliError { message, code }` in `hold`. CLI: `swarmz-tool version | hold <tile> --cwd D --name N [--cols C] [--rows R] [--env K=V]... [--require-cwd] | info <tile> | __holder …`.

- [ ] **Step 1: Write the failing integration tests**

`src-tauri/tool/tests/cli.rs`:

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli 2>&1 | grep -E "test |test result" | head`
Expected: most tests fail (the placeholder `main` only prints the version).

- [ ] **Step 3: Implement `hold.rs`**

Add `pub mod hold;` to `lib.rs`.

```rust
use crate::paths::{clear_stale, ensure_dir, home_dir, live_session, session_paths, Meta};
use crate::proto::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct CliError {
    pub message: String,
    pub code: &'static str,
}

impl CliError {
    pub fn new(code: &'static str, message: impl Into<String>) -> CliError {
        CliError { message: message.into(), code }
    }
}

impl From<String> for CliError {
    fn from(message: String) -> CliError {
        CliError { message, code: "failed" }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HoldRequest {
    pub tile: String,
    pub name: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
    pub require_cwd: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldResult {
    pub v: u32,
    pub socket: String,
    pub existed: bool,
    pub pid: u32,
    pub shell_pid: Option<u32>,
    pub cwd: String,
    pub cwd_fallback: bool,
}

fn result(socket: &Path, meta: Meta, existed: bool) -> HoldResult {
    HoldResult {
        v: PROTOCOL_VERSION,
        socket: socket.to_string_lossy().into_owned(),
        existed,
        pid: meta.pid,
        shell_pid: meta.shell_pid,
        cwd: meta.cwd,
        cwd_fallback: meta.cwd_fallback,
    }
}

/// The shell a holder runs: `$SWARMZ_HOLDER_SHELL` without arguments (tests), else a login
/// `$SHELL`.
pub fn holder_program() -> (String, Vec<String>) {
    if let Ok(p) = std::env::var("SWARMZ_HOLDER_SHELL") {
        if !p.is_empty() {
            return (p, vec![]);
        }
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string()])
}

/// Finds the tile's live holder or starts a detached one, and waits until it is listening.
pub fn hold(exe: &Path, dir: &Path, req: &HoldRequest) -> Result<HoldResult, CliError> {
    let paths = session_paths(dir, &req.tile).map_err(|e| CliError::new("invalid", e))?;
    ensure_dir(dir).map_err(|e| CliError::new("failed", format!("could not create {}: {e}", dir.display())))?;
    if let Some(meta) = live_session(&paths) {
        return Ok(result(&paths.socket, meta, true));
    }
    clear_stale(&paths);
    let (cwd, fallback) = if Path::new(&req.cwd).is_dir() {
        (req.cwd.clone(), false)
    } else if req.require_cwd {
        return Err(CliError::new("cwd_missing", format!("{} is not a directory", req.cwd)));
    } else {
        (home_dir().to_string_lossy().into_owned(), true)
    };
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)
        .map_err(|e| CliError::new("failed", format!("could not open {}: {e}", paths.log.display())))?;
    let log2 = log.try_clone().map_err(|e| CliError::new("failed", e.to_string()))?;

    let mut cmd = Command::new(exe);
    cmd.arg("__holder")
        .arg(&req.tile)
        .arg("--name").arg(&req.name)
        .arg("--cwd").arg(&cwd)
        .arg("--cols").arg(req.cols.to_string())
        .arg("--rows").arg(req.rows.to_string())
        .arg("--dir").arg(dir);
    if fallback {
        cmd.arg("--cwd-fallback");
    }
    for (k, v) in &req.env {
        cmd.arg("--env").arg(format!("{k}={v}"));
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log2));
    // A new session with no controlling terminal: hang-ups aimed at whoever started us (the
    // app, an ssh session) never reach the holder, and it is reparented to launchd once its
    // starter exits.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| CliError::new("failed", format!("could not start the session holder: {e}")))?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(meta) = live_session(&paths) {
            return Ok(result(&paths.socket, meta, false));
        }
        if !crate::paths::pid_alive(pid) || Instant::now() > deadline {
            let log = std::fs::read_to_string(&paths.log).unwrap_or_default();
            let tail: String = log.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(CliError::new("failed", format!("the session holder did not start: {tail}")));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
```

- [ ] **Step 4: Implement `main.rs`**

```rust
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use swarmz_tool::client::HolderClient;
use swarmz_tool::hold::{hold, holder_program, CliError, HoldRequest};
use swarmz_tool::paths::{home_dir, live_session, session_paths, sessions_dir};
use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};
use swarmz_tool::server::{run_holder, HolderConfig, VIEWER_QUEUE_CAP};

const VALUED: &[&str] = &["--cwd", "--name", "--cols", "--rows", "--env", "--dir"];

struct Args {
    positional: Vec<String>,
    opts: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Args {
    fn parse(raw: &[String]) -> Result<Args, CliError> {
        let mut a = Args { positional: vec![], opts: vec![], flags: vec![] };
        let mut i = 0;
        while i < raw.len() {
            let s = &raw[i];
            if VALUED.contains(&s.as_str()) {
                let v = raw.get(i + 1).ok_or_else(|| CliError::new("usage", format!("{s} needs a value")))?;
                a.opts.push((s.clone(), v.clone()));
                i += 2;
            } else if s.starts_with("--") {
                a.flags.push(s.clone());
                i += 1;
            } else {
                a.positional.push(s.clone());
                i += 1;
            }
        }
        Ok(a)
    }

    fn opt(&self, name: &str) -> Option<&str> {
        self.opts.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.opts.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect()
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    fn num(&self, name: &str, default: u16) -> Result<u16, CliError> {
        match self.opt(name) {
            None => Ok(default),
            Some(v) => v.parse().map_err(|_| CliError::new("usage", format!("{name} must be a number"))),
        }
    }

    fn envs(&self) -> Result<Vec<(String, String)>, CliError> {
        self.all("--env")
            .into_iter()
            .map(|kv| {
                kv.split_once('=')
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .ok_or_else(|| CliError::new("usage", format!("--env expects KEY=VALUE, got {kv}")))
            })
            .collect()
    }
}

fn tile_arg(a: &Args) -> Result<String, CliError> {
    a.positional.get(1).cloned().ok_or_else(|| CliError::new("usage", "missing tile id"))
}

fn exe() -> Result<PathBuf, CliError> {
    std::env::current_exe().map_err(|e| CliError::new("failed", format!("cannot locate this program: {e}")))
}

fn run(raw: &[String]) -> Result<serde_json::Value, CliError> {
    let a = Args::parse(raw)?;
    match a.positional.first().map(String::as_str) {
        Some("version") => Ok(json!({ "v": 1, "tool": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION })),
        Some("hold") => {
            let tile = tile_arg(&a)?;
            let req = HoldRequest {
                name: a.opt("--name").unwrap_or(&tile).to_string(),
                cwd: a.opt("--cwd").map(str::to_string).unwrap_or_else(|| home_dir().to_string_lossy().into_owned()),
                cols: a.num("--cols", 80)?,
                rows: a.num("--rows", 24)?,
                env: a.envs()?,
                require_cwd: a.flag("--require-cwd"),
                tile,
            };
            let r = hold(&exe()?, &sessions_dir(), &req)?;
            Ok(serde_json::to_value(r).expect("hold result serialises"))
        }
        Some("info") => {
            let tile = tile_arg(&a)?;
            let paths = session_paths(&sessions_dir(), &tile).map_err(|e| CliError::new("invalid", e))?;
            if live_session(&paths).is_none() {
                return Ok(json!({ "v": 1, "running": false }));
            }
            let hello = Hello { v: PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "tool".into() };
            let client = HolderClient::connect(&paths.socket, &hello, |_, _| {}, |_| {}).map_err(|e| CliError::new("failed", e))?;
            let info = client.info(Duration::from_secs(3)).ok_or_else(|| CliError::new("failed", "the session did not answer"))?;
            Ok(json!({
                "v": 1,
                "running": true,
                "cwd": info.cwd,
                "foregroundBusy": info.foreground_busy,
                "foregroundCommand": info.foreground_command,
            }))
        }
        Some("__holder") => {
            let tile = tile_arg(&a)?;
            let (program, args) = holder_program();
            let name = a.opt("--name").unwrap_or(&tile).to_string();
            let mut env = vec![
                ("TERM".to_string(), "xterm-256color".to_string()),
                ("COLORTERM".to_string(), "truecolor".to_string()),
                ("SWARMZ_TERMINAL_ID".to_string(), tile.clone()),
                ("SWARMZ_TERMINAL_NAME".to_string(), name.clone()),
            ];
            env.extend(a.envs()?);
            let cfg = HolderConfig {
                cwd: a.opt("--cwd").ok_or_else(|| CliError::new("usage", "missing --cwd"))?.to_string(),
                dir: PathBuf::from(a.opt("--dir").ok_or_else(|| CliError::new("usage", "missing --dir"))?),
                cols: a.num("--cols", 80)?,
                rows: a.num("--rows", 24)?,
                cwd_fallback: a.flag("--cwd-fallback"),
                viewer_queue_cap: VIEWER_QUEUE_CAP,
                program,
                args,
                env,
                name,
                tile,
            };
            let code = run_holder(cfg)?;
            std::process::exit(code.unwrap_or(0));
        }
        _ => Err(CliError::new("usage", "usage: swarmz <version|hold|info|attach> …")),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    match run(&raw) {
        Ok(v) => {
            println!("{v}");
        }
        Err(e) => {
            println!("{}", json!({ "v": 1, "error": e.message, "code": e.code }));
            std::process::exit(1);
        }
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --workspace 2>&1 | grep -E "test result|warning|error" | head`
Expected: all pass, no warnings. Check no holder processes were left behind: `pgrep -fl "swarmz-tool __holder"` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tool
git commit -m "feat(core): swarmz tool CLI with hold (detached holders), info and version

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `attach`, the ssh bridge

**Files:**
- Create: `src-tauri/tool/src/attach.rs`
- Modify: `src-tauri/tool/src/main.rs`, `src-tauri/tool/src/lib.rs`, `src-tauri/tool/tests/cli.rs`

**Interfaces:**
- Consumes: `hold::{hold, HoldRequest, CliError}`, `client::HolderClient`.
- Produces: `attach::{ATTACH_MARKER_PREFIX, marker, attach}`; `marker(new: bool) -> String` = `"\x1b]1337;swarmz-attach;new=1\x07"` / `new=0`; CLI `attach <tile> [--cwd D] [--name N] [--env K=V]...` bridges stdin/stdout to the holder and exits with the shell's code when it exits, or 0 when stdin closes.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.rs`:

```rust
fn run_attach(h: &PathBuf, tile: &str) -> (Box<dyn portable_pty::Child + Send + Sync>, std::sync::Arc<std::sync::Mutex<Vec<u8>>>, Box<dyn std::io::Write + Send>) {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut cmd = CommandBuilder::new(EXE);
    cmd.args(["attach", tile, "--cwd", &h.to_string_lossy(), "--name", tile]);
    cmd.env("HOME", h);
    cmd.env("SWARMZ_HOLDER_SHELL", "/bin/sh");
    let child = pair.slave.spawn_command(cmd).unwrap();
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
    let (mut child, out, mut w) = run_attach(&h, "t7");
    assert!(wait_out(&out, "\x1b]1337;swarmz-attach;new=1\x07"), "first attach must say new=1");
    std::io::Write::write_all(&mut w, b"echo bridged-$((2+3))\r").unwrap();
    assert!(wait_out(&out, "bridged-5"));
    // Simulate the ssh connection dropping.
    child.kill().unwrap();
    let _ = child.wait();
    std::thread::sleep(Duration::from_millis(300));
    let (_, info) = tool(&h, &["info", "t7"]);
    assert_eq!(info["running"], true, "the session must survive the bridge going away");
    let (mut child2, out2, mut w2) = run_attach(&h, "t7");
    assert!(wait_out(&out2, "\x1b]1337;swarmz-attach;new=0\x07"), "reattach must say new=0");
    assert!(wait_out(&out2, "bridged-5"), "reattach must replay the history");
    std::io::Write::write_all(&mut w2, b"exit 4\r").unwrap();
    let status = child2.wait().unwrap();
    assert_eq!(status.exit_code(), 4);
}
```

`portable-pty` and `libc` are normal dependencies of the crate, so integration tests can use them directly.

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p swarmz-tool --test cli attach 2>&1 | grep -E "test |panicked" | head -3`
Expected: fails (usage error, no marker).

- [ ] **Step 3: Implement**

`attach.rs` (add `pub mod attach;` to `lib.rs`):

```rust
use crate::client::HolderClient;
use crate::hold::{hold, CliError, HoldRequest};
use crate::proto::{Hello, PROTOCOL_VERSION};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const ATTACH_MARKER_PREFIX: &str = "\x1b]1337;swarmz-attach;new=";

pub fn marker(new: bool) -> String {
    format!("{ATTACH_MARKER_PREFIX}{}\x07", if new { 1 } else { 0 })
}

struct RawMode(Option<libc::termios>);

impl RawMode {
    fn enable() -> RawMode {
        unsafe {
            if libc::isatty(0) == 0 {
                return RawMode(None);
            }
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) != 0 {
                return RawMode(None);
            }
            let original = t;
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(0, libc::TCSANOW, &t);
            RawMode(Some(original))
        }
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if let Some(t) = self.0 {
            unsafe {
                libc::tcsetattr(0, libc::TCSANOW, &t);
            }
        }
    }
}

fn term_size() -> (u16, u16) {
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
            (ws.ws_col, ws.ws_row)
        } else {
            (80, 24)
        }
    }
}

enum Done {
    ShellExited(Option<i32>),
    InputClosed,
}

/// Holds the tile's session (starting it if needed) and bridges this terminal to it. Returns the
/// process exit code: the shell's when it exits, 0 when our input closes (the ssh connection
/// went away), leaving the session running.
pub fn attach(exe: &Path, dir: &Path, mut req: HoldRequest) -> Result<i32, CliError> {
    let (cols, rows) = term_size();
    req.cols = cols;
    req.rows = rows;
    let held = hold(exe, dir, &req)?;
    {
        let mut out = std::io::stdout();
        let _ = out.write_all(marker(!held.existed).as_bytes());
        let _ = out.flush();
    }
    let raw = RawMode::enable();
    let (done_tx, done_rx) = mpsc::channel::<Done>();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let exit_tx = done_tx.clone();
    let hello = Hello { v: PROTOCOL_VERSION, cols, rows, viewer: "window".into() };
    let client = HolderClient::connect(
        Path::new(&held.socket),
        &hello,
        move |bytes, _replay| {
            if let Ok(mut o) = stdout.lock() {
                let _ = o.write_all(&bytes);
                let _ = o.flush();
            }
        },
        move |code| {
            let _ = exit_tx.send(Done::ShellExited(code));
        },
    )
    .map_err(|e| CliError::new("failed", e))?;
    let client = Arc::new(client);

    let input = client.clone();
    let input_done = done_tx.clone();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = input_done.send(Done::InputClosed);
                    break;
                }
                Ok(n) => {
                    if input.write(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let sizer = client.clone();
    std::thread::spawn(move || {
        let mut last = (cols, rows);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = term_size();
            if now != last {
                last = now;
                if sizer.resize(now.0, now.1).is_err() {
                    break;
                }
            }
        }
    });

    let done = done_rx.recv().unwrap_or(Done::InputClosed);
    drop(raw);
    match done {
        Done::ShellExited(code) => Ok(code.unwrap_or(0)),
        Done::InputClosed => {
            client.detach();
            Ok(0)
        }
    }
}
```

In `main.rs`, add the arm before `_ =>` (and `use swarmz_tool::attach::attach;`):

```rust
        Some("attach") => {
            let tile = tile_arg(&a)?;
            let req = HoldRequest {
                name: a.opt("--name").unwrap_or(&tile).to_string(),
                cwd: a.opt("--cwd").map(str::to_string).unwrap_or_else(|| home_dir().to_string_lossy().into_owned()),
                cols: 80,
                rows: 24,
                env: a.envs()?,
                require_cwd: false,
                tile,
            };
            let code = attach(&exe()?, &sessions_dir(), req)?;
            std::process::exit(code);
        }
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --workspace 2>&1 | grep -E "test result|warning|error" | head`
Expected: all pass. `pgrep -fl "swarmz-tool __holder"` prints nothing afterwards.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tool
git commit -m "feat(core): swarmz attach bridges an ssh terminal to a tile's holder and survives drops

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The app runs tiles through holders

**Files:**
- Create: `src-tauri/src/session.rs`, `src-tauri/src/toolbin.rs`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/registry.rs`

**Interfaces:**
- Consumes: `swarmz_tool::{client::HolderClient, hold::HoldResult, proto::{Hello, PROTOCOL_VERSION}}`, `crate::remote::run_with_timeout`.
- Produces: `session::TerminalSession` trait (`write`, `resize`, `terminate`, `foreground_busy`, `cwd`) implemented for `PtySession` and `HolderClient`; `toolbin::{installed_path_in, installed_path, bundled_path, install_from, ensure_installed, hold}` with `hold(tool: &Path, home: Option<&Path>, id: &str, name: &str, cwd: &str, cols: u16, rows: u16) -> Result<HoldResult, String>` (always `--require-cwd`); `TerminalInfo` gains `existed: bool` (serde default false); Tauri event `pty:replay:<id>` (base64) alongside `pty:data:<id>`.

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/toolbin.rs` (tests only first; add `pub mod session; pub mod toolbin;` to `lib.rs`):

```rust
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

    #[test]
    fn hold_starts_a_session_the_app_can_connect_to_and_reports_missing_folders() {
        let tool = built_tool();
        let home = tmp("hold");
        std::env::set_var("SWARMZ_HOLDER_SHELL", "/bin/sh");
        let cwd = home.to_string_lossy().into_owned();
        let r = hold(&tool, Some(&home), "a1", "one", &cwd, 80, 24).unwrap();
        assert!(!r.existed);
        let again = hold(&tool, Some(&home), "a1", "one", "/not/there", 80, 24).unwrap();
        assert!(again.existed, "a live session is found even if its folder is gone");
        let err = hold(&tool, Some(&home), "a2", "two", "/not/there", 80, 24).unwrap_err();
        assert!(err.contains("/not/there is not a directory"), "{err}");
        let hello = swarmz_tool::proto::Hello { v: swarmz_tool::proto::PROTOCOL_VERSION, cols: 80, rows: 24, viewer: "window".into() };
        let client = swarmz_tool::client::HolderClient::connect(std::path::Path::new(&r.socket), &hello, |_, _| {}, |_| {}).unwrap();
        let s: &dyn crate::session::TerminalSession = &client;
        assert_eq!(s.foreground_busy(), Some(false));
        s.terminate();
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}
```

In `registry.rs`'s tests, any assertion that builds `TerminalInfo` literals must include `existed: false` (update them in Step 3).

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --workspace toolbin 2>&1 | grep -E "cannot find|error\[" | head -3`
Expected: missing items.

- [ ] **Step 3: Implement**

`src-tauri/src/session.rs`:

```rust
use std::time::Duration;
use swarmz_tool::client::HolderClient;
use swarmz_tool::pty::PtySession;

/// What the app needs from a running terminal, whether it owns the PTY or views a holder.
pub trait TerminalSession: Send + Sync {
    fn write(&self, bytes: &[u8]) -> Result<(), String>;
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    fn terminate(&self);
    fn foreground_busy(&self) -> Option<bool>;
    fn cwd(&self) -> Option<String>;
}

impl TerminalSession for PtySession {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        PtySession::write(self, bytes)
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        PtySession::resize(self, cols, rows)
    }
    fn terminate(&self) {
        PtySession::terminate(self)
    }
    fn foreground_busy(&self) -> Option<bool> {
        PtySession::foreground_busy(self)
    }
    fn cwd(&self) -> Option<String> {
        PtySession::cwd(self)
    }
}

impl TerminalSession for HolderClient {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        HolderClient::write(self, bytes)
    }
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        HolderClient::resize(self, cols, rows)
    }
    fn terminate(&self) {
        let _ = HolderClient::terminate(self);
    }
    fn foreground_busy(&self) -> Option<bool> {
        self.info(Duration::from_millis(800)).and_then(|i| i.foreground_busy)
    }
    fn cwd(&self) -> Option<String> {
        self.info(Duration::from_secs(2)).and_then(|i| i.cwd)
    }
}
```

Above the tests in `toolbin.rs`:

```rust
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use swarmz_tool::hold::HoldResult;

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
    let tmp = dest.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| format!("could not install {}: {e}", dest.display()))?;
    Ok(true)
}

/// The installed tool, refreshed from the bundled copy when that differs.
pub fn ensure_installed() -> Result<PathBuf, String> {
    let dest = installed_path();
    if let Some(src) = bundled_path() {
        install_from(&src, &dest)?;
    }
    if dest.is_file() {
        Ok(dest)
    } else {
        Err("the swarmz tool is not installed and no bundled copy was found".into())
    }
}

/// Runs `swarmz hold` for a tile (the folder must exist unless the session is already live).
pub fn hold(tool: &Path, home: Option<&Path>, id: &str, name: &str, cwd: &str, cols: u16, rows: u16) -> Result<HoldResult, String> {
    let mut cmd = Command::new(tool);
    cmd.args(["hold", id, "--cwd", cwd, "--name", name, "--cols", &cols.to_string(), "--rows", &rows.to_string(), "--require-cwd"]);
    if let Some(h) = home {
        cmd.env("HOME", h);
    }
    let done = crate::remote::run_with_timeout(cmd, Duration::from_secs(10), "swarmz")?;
    let v: serde_json::Value = serde_json::from_str(done.stdout.trim())
        .map_err(|e| format!("swarmz hold returned something unreadable ({e}): {}", done.stderr.trim()))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    serde_json::from_value(v).map_err(|e| format!("swarmz hold returned an unexpected result: {e}"))
}
```

`registry.rs`: add to `TerminalInfo`

```rust
    #[serde(default)]
    pub existed: bool,
```

and set `existed: false` in `add`'s constructor (line 81) and in any test literals.

`commands.rs`:
- Replace `use crate::pty::{PtySession, SpawnSpec};` with `use crate::session::TerminalSession;` and `use swarmz_tool::client::HolderClient; use swarmz_tool::proto::{Hello, PROTOCOL_VERSION};` (keep `use crate::pty::{PtySession, SpawnSpec};` inside the test module only).
- `AppState.sessions` becomes `Mutex<HashMap<String, (u64, Arc<dyn TerminalSession>)>>`; `take_if_current` takes `&mut HashMap<String, (u64, Arc<dyn TerminalSession>)>`.
- Replace `spawn_for` with:

```rust
/// Connects the tile to its session holder, starting one if needed. Returns whether the session
/// was already running.
fn spawn_for(app: &AppHandle, state: &AppState, info: &TerminalInfo, cols: u16, rows: u16) -> Result<bool, String> {
    let tool = crate::toolbin::ensure_installed()?;
    let held = crate::toolbin::hold(&tool, None, &info.id, &info.name, &info.cwd, cols, rows)?;

    let gen = state.next_gen.fetch_add(1, Ordering::SeqCst);
    let data_app = app.clone();
    let data_topic = format!("pty:data:{}", info.id);
    let replay_topic = format!("pty:replay:{}", info.id);
    let exit_app = app.clone();
    let exit_id = info.id.clone();

    // Same reasoning as before: the exit callback must never observe the map without our entry.
    let mut sessions = state.sessions.lock().unwrap();
    let hello = Hello { v: PROTOCOL_VERSION, cols, rows, viewer: "window".into() };
    let client = HolderClient::connect(
        std::path::Path::new(&held.socket),
        &hello,
        move |bytes, replay| {
            let topic = if replay { &replay_topic } else { &data_topic };
            let _ = data_app.emit(topic, BASE64.encode(&bytes));
        },
        move |code| {
            if let Some(st) = exit_app.try_state::<AppState>() {
                let mine = take_if_current(&mut st.sessions.lock().unwrap(), &exit_id, gen);
                if !mine {
                    return;
                }
                st.registry.lock().unwrap().set_exited(&exit_id, code, None);
            }
            let _ = exit_app.emit(&format!("pty:exit:{exit_id}"), ExitPayload { code });
        },
    )?;
    sessions.insert(info.id.clone(), (gen, Arc::new(client) as Arc<dyn TerminalSession>));
    drop(sessions);
    Ok(held.existed)
}
```

- `create_terminal`: remove the `is_dir` pre-check. After `add`, call `spawn_for`; on `Ok(existed)` return `TerminalInfo { existed, ..info }`; on `Err(e)` where `e.contains("is not a directory")`, remove the id from the registry and return `Err(e)` (the frontend's home fallback depends on this message); other errors keep today's `set_exited` handling.
- `restart_terminal`: `Ok(existed) => Ok(TerminalInfo { existed, ..info })`.
- `close_terminal`: `session.terminate();` instead of `session.kill();`.
- `write_terminal`, `resize_terminal`, `terminal_foreground_busy`, `terminal_cwd`: unchanged apart from the trait object (`terminal_cwd`'s `spawn_blocking` closure calls `session.cwd()` on the `Arc<dyn TerminalSession>`, which is `Send`).
- The test module's `dummy_session()` returns `Arc<dyn TerminalSession>` (`Arc::new(PtySession::spawn(…).unwrap())`), and `session.kill()` becomes `session.terminate()`.

`lib.rs` `setup`: install the tool in the background so a slow disk never delays the window:

```rust
        .setup(|_app| {
            let _ = remote::ensure_ssh_dir();
            std::thread::spawn(|| {
                if let Err(e) = toolbin::ensure_installed() {
                    eprintln!("swarmz: {e}");
                }
            });
            Ok(())
        })
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --workspace 2>&1 | grep -E "test result|warning|error" | head`
Expected: all pass, no warnings; no leftover `__holder` processes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(core): tiles run in session holders; the app views them and survives relaunch

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Frontend: replay stream, reattach without a connect card

**Files:**
- Modify: `src/lib/ipc.ts`, `src/lib/xtermRegistry.ts`, `src/store.ts`
- Test: `src/lib/xtermRegistry.test.ts`, `src/store.test.ts`, and the ipc mocks in `src/components/*.test.tsx`

**Interfaces:**
- Consumes: Tauri event `pty:replay:<id>`, `TerminalInfo.existed`.
- Produces: `ipc.onReplay(id, cb)`; `TerminalInfo.existed?: boolean`; registry entry flag `replaying` that suppresses OSC 52 and the resume-failure scan; store: tiles whose session already existed are not armed for the connect card, and existing ssh tiles are probed for liveness.

- [ ] **Step 1: Write the failing tests**

In every test file's ipc mock add `onReplay: vi.fn(async () => () => {}),` next to `onData`. In `src/lib/xtermRegistry.test.ts`, make the mock capture replay callbacks like data callbacks (a hoisted `replayCallbacks` record), then add:

```ts
describe("replayed output", () => {
  it("is written to the terminal but never copies to the clipboard", async () => {
    useStore.setState({ terminals: { rp: { id: "rp", name: "rp", cwd: "/", exited: null, error: null } }, order: ["rp"], settings: { rp: { ssh: null, claude: null, command: null, extra: {} } } });
    vi.mocked(writeText).mockClear();
    const { term } = attach("rp", document.createElement("div"));
    await prepare("rp");
    const osc52 = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[52];
    const writes = (term as unknown as { writes: Array<{ data: unknown; done?: () => void }> }).writes;
    replayCallbacks.rp(new TextEncoder().encode("old output"));
    expect(writes.length).toBeGreaterThan(0);
    osc52(`c;${btoa("from the past")}`);
    writes[writes.length - 1].done?.();
    osc52(`c;${btoa("live")}`);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("live");
    dispose("rp");
  });
});
```

Extend the fake `Terminal` so `write(data, done?)` records `{data, done}` into `this.writes` (initialise `writes = []`).

In `src/store.test.ts`, add:

```ts
describe("reattaching to running sessions", () => {
  it("does not arm the connect card for a tile whose session was already running", async () => {
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: id === "live" }));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [
        { id: "live", name: "live", cwd: "/tmp/a", ssh: null, claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: true }, command: null },
        { id: "fresh", name: "fresh", cwd: "/tmp/b", ssh: null, claude: { enabled: true, sessionId: "s2", skipPermissions: false, started: true }, command: null },
      ],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().startupPending.live).toBe(false);
    expect(useStore.getState().startupPending.fresh).toBe(true);
  });

  it("marks an already-running ssh tile connected when its connection is live", async () => {
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: true }));
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [{ id: "r1", name: "r1", cwd: "/home/me", ssh: { host: "me@box", cwd: "/p" }, claude: null, command: null }],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    await vi.waitFor(() => expect(useStore.getState().sshConnected.r1).toBe(true));
    expect(useStore.getState().startupPending.r1).toBe(false);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });
});
```

(Restore the default `createTerminal` mock implementation in `beforeEach` if these tests change it: add `vi.mocked(ipc.createTerminal).mockReset().mockImplementation(<the original factory>)` to the file's `beforeEach`, reusing the `info` helper at the top of the mock.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/xtermRegistry.test.ts src/store.test.ts -t "replayed output|reattaching" 2>&1 | grep -E "×|✓" | head`
Expected: all three fail.

- [ ] **Step 3: Implement**

`src/lib/ipc.ts`: `TerminalInfo` gains `existed?: boolean;` and the `ipc` object gains

```ts
  onReplay: (id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
    listen<string>(`pty:replay:${id}`, (e) => cb(base64ToBytes(e.payload))),
```

`src/lib/xtermRegistry.ts`:
- `Entry` gains `replaying: boolean` (initial `false`).
- The OSC 52 handler returns early (still `true`) when `entry.replaying` is set: `if (entry.replaying) return true;` as its first line.
- In `entry.ready`'s `Promise.all`, add a replay listener before `onData`:

```ts
    ipc.onReplay(id, (bytes) => {
      entry.replaying = true;
      term.write(bytes, () => {
        entry.replaying = false;
      });
    }),
```

- In the `onData` listener, skip the resume-failure scan while `entry.replaying` is true (return right after `term.write(bytes)`).

`src/store.ts`:
- `spawnDef` returns `info` including `existed`. In `openDefs`, collect `const existedIds = new Set<string>();` and after each spawn `if (info.existed) existedIds.add(info.id);`. In the bulk pass, change the arming line to
  `if (changed) startupPending[id] = !existedIds.has(id) && startupLine(settings[id] ?? EMPTY_SETTINGS) !== null;`
- After the bulk `set` in `openDefs`, probe existing ssh tiles without typing anything:

```ts
  for (const id of existedIds) {
    const host = useStore.getState().settings[id]?.ssh?.host?.trim();
    if (!host) continue;
    void tileLive(id, host).then((live) => {
      if (live && useStore.getState().terminals[id]) {
        set((st) => ({ sshConnected: { ...st.sshConnected, [id]: true }, startupPending: { ...st.startupPending, [id]: false } }));
      }
    });
  }
```

  (`tileLive` is declared later in the file as a function declaration, so it is hoisted.)
- `restartTerminal`: `startupPending: { ...s.startupPending, [id]: !info.existed && startupLine(s.settings[id] ?? EMPTY_SETTINGS) !== null }`.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(ui): reattached tiles skip the connect card and replay history without re-running clipboard escapes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Remote tool install, remote info, and Tauri commands

**Files:**
- Modify: `src-tauri/src/toolbin.rs`, `src-tauri/src/agents.rs` (make `ssh_command` `pub(crate)`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts` and every test ipc mock

**Interfaces:**
- Consumes: `crate::agents::ssh_command`, `crate::remote::{run_with_timeout, run_with_timeout_input, validate_host}`.
- Produces: `toolbin::{arch_matches, remote_install_command, remote_ready, remote_info}`; Tauri commands `tool_remote_ready(host) -> bool` (installs or updates the remote tool when the architecture matches; true when the remote tool speaks this protocol) and `remote_tile_info(host, id) -> serde_json::Value` (the remote `info` output); `ipc.toolRemoteReady(host)`, `ipc.remoteTileInfo(host, id) -> { running: boolean; cwd?: string | null; foregroundBusy?: boolean | null; foregroundCommand?: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `toolbin.rs` tests:

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --workspace toolbin 2>&1 | grep -E "cannot find" | head -3`

- [ ] **Step 3: Implement**

In `agents.rs`, change `fn ssh_command(host: &str)` to `pub(crate) fn ssh_command(host: &str)`.

Append to `toolbin.rs` (above tests):

```rust
/// Rust's architecture name against `uname -m`'s.
pub fn arch_matches(rust_arch: &str, uname: &str) -> bool {
    let uname = uname.trim();
    match rust_arch {
        "aarch64" => uname == "arm64" || uname == "aarch64",
        other => !uname.is_empty() && other == uname,
    }
}

/// Remote shell command that installs stdin as `~/.swarmz/bin/swarmz` only when exactly `len`
/// bytes arrived.
pub fn remote_install_command(len: usize) -> String {
    format!(
        "mkdir -p ~/.swarmz/bin && cat > ~/.swarmz/bin/swarmz.tmp.$$ && [ \"$(wc -c < ~/.swarmz/bin/swarmz.tmp.$$ | tr -d ' ')\" -eq {len} ] && chmod 755 ~/.swarmz/bin/swarmz.tmp.$$ && mv -f ~/.swarmz/bin/swarmz.tmp.$$ ~/.swarmz/bin/swarmz || {{ rm -f ~/.swarmz/bin/swarmz.tmp.$$; exit 1; }}"
    )
}

fn ssh_run(host: &str, remote: &str, input: Option<&[u8]>, secs: u64) -> Result<crate::remote::Finished, String> {
    let host = crate::remote::validate_host(host)?;
    let mut cmd = crate::agents::ssh_command(&host)?;
    cmd.arg(remote);
    crate::remote::run_with_timeout_input(cmd, Duration::from_secs(secs), "ssh", input)
}

/// Ensures `host` has this app's tool. True when the remote tool speaks our protocol afterwards.
pub fn remote_ready(host: &str) -> Result<bool, String> {
    let local = bundled_path().or_else(|| Some(installed_path()).filter(|p| p.is_file())).ok_or("no local swarmz tool to copy")?;
    let local_bytes = std::fs::read(&local).map_err(|e| e.to_string())?;
    let probe = ssh_run(host, "uname -m; ~/.swarmz/bin/swarmz version 2>/dev/null; cksum < ~/.swarmz/bin/swarmz 2>/dev/null; true", None, 10)?;
    if !probe.status.success() {
        return Err(format!("not reachable: {}", probe.stderr.trim()));
    }
    let mut lines = probe.stdout.lines();
    let uname = lines.next().unwrap_or("");
    if !arch_matches(std::env::consts::ARCH, uname) {
        return Ok(false);
    }
    let local_sum = {
        let mut c = Command::new("cksum");
        c.stdin(std::process::Stdio::piped());
        let out = crate::remote::run_with_timeout_input(c, Duration::from_secs(5), "cksum", Some(&local_bytes))?;
        out.stdout.trim().to_string()
    };
    let remote_sum = probe.stdout.lines().last().unwrap_or("").trim().to_string();
    if remote_sum != local_sum {
        let done = ssh_run(host, &remote_install_command(local_bytes.len()), Some(&local_bytes), 60)?;
        if !done.status.success() {
            return Err(if done.stderr.trim().is_empty() { "could not install the swarmz tool".into() } else { done.stderr.trim().to_string() });
        }
    }
    let check = ssh_run(host, "~/.swarmz/bin/swarmz version", None, 10)?;
    let v: serde_json::Value = serde_json::from_str(check.stdout.trim()).unwrap_or(serde_json::Value::Null);
    Ok(v["protocol"].as_u64() == Some(swarmz_tool::proto::PROTOCOL_VERSION as u64))
}

/// The remote tool's `info` for a tile.
pub fn remote_info(host: &str, id: &str) -> Result<serde_json::Value, String> {
    if !swarmz_tool::paths::valid_tile_id(id) {
        return Err(format!("invalid tile id {id:?}"));
    }
    let done = ssh_run(host, &format!("~/.swarmz/bin/swarmz info {id}"), None, 10)?;
    serde_json::from_str(done.stdout.trim()).map_err(|e| format!("unreadable reply from {host}: {e}"))
}
```

`commands.rs`:

```rust
#[tauri::command]
pub async fn tool_remote_ready(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::toolbin::remote_ready(&host)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remote_tile_info(host: String, id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || crate::toolbin::remote_info(&host, &id)).await.map_err(|e| e.to_string())?
}
```

Register both in `lib.rs`. `src/lib/ipc.ts`:

```ts
export interface RemoteTileInfo {
  running: boolean;
  cwd?: string | null;
  foregroundBusy?: boolean | null;
  foregroundCommand?: string | null;
}
```

and in `ipc`: `toolRemoteReady: (host: string) => invoke<boolean>("tool_remote_ready", { host }),` and `remoteTileInfo: (host: string, id: string) => invoke<RemoteTileInfo>("remote_tile_info", { host, id }),`. Add `toolRemoteReady: vi.fn(async () => false), remoteTileInfo: vi.fn(async () => ({ running: false })),` to every test ipc mock.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --workspace 2>&1 | grep -E "test result|warning|error" | head && cd .. && npm test 2>&1 | tail -3 && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src
git commit -m "feat(core): install the swarmz tool on tailnet machines and read remote tile info

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Remote tiles attach to their home Mac's holder

**Files:**
- Modify: `src/lib/workspace.ts`, `src/store.ts`, `src/lib/xtermRegistry.ts`
- Test: `src/lib/workspace.test.ts`, `src/store.test.ts`, `src/lib/xtermRegistry.test.ts`

**Interfaces:**
- Consumes: `ipc.toolRemoteReady`, `ipc.remoteTileInfo`, the attach marker.
- Produces: `attachLine(host, tileId, cwd, name)` in `workspace.ts`; `startupSteps(s, terminalId?, opts?: { attach?: boolean })`; store state `toolReady: Record<string, boolean>`, actions `remoteAttached(id: string, isNew: boolean): Promise<void>`; `setTerminalCwd` source `"remote"`; xterm OSC 1337 handler; remote folder polling.

- [ ] **Step 1: Write the failing tests**

`src/lib/workspace.test.ts`:

```ts
describe("attach mode", () => {
  it("builds an ssh line that runs the remote swarmz attach with quoted arguments", () => {
    expect(attachLine("me@box", "t-1", "/Volumes/My Disk/proj", "loop'back")).toBe(
      `ssh ${SSH_OPTS} me@box ` + shellQuote(`~/.swarmz/bin/swarmz attach t-1 --cwd ${shellQuote("/Volumes/My Disk/proj")} --name ${shellQuote("loop'back")}`),
    );
    expect(attachLine("me@box", "t-1", null, "n")).toBe(`ssh ${SSH_OPTS} me@box ` + shellQuote(`~/.swarmz/bin/swarmz attach t-1 --name ${shellQuote("n")}`));
  });
  it("uses the attach line as the local step when asked", () => {
    const s = { ssh: { host: "me@box", cwd: "/p" }, claude, command: null };
    const steps = startupSteps(s, "t-1", { attach: true, name: "tile" });
    expect(steps[0]).toEqual({ via: "local", line: attachLine("me@box", "t-1", "/p", "tile") });
    expect(steps[1].via).toBe("remote");
    expect(startupSteps(s, "t-1")[0].line).toBe(sshLine("me@box"));
  });
});
```

(`SSH_OPTS` and `attachLine` join the imports.)

`src/store.test.ts`:

```ts
describe("remote attach", () => {
  const sshTile = async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
    __stopAllPolling();
    return id;
  };

  it("types the attach line when the remote tool is ready", async () => {
    vi.mocked(ipc.writeTerminal).mockClear();
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
    __stopAllPolling();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toContain("~/.swarmz/bin/swarmz attach");
    expect(useStore.getState().toolReady["me@box"]).toBe(true);
    void id;
  });

  it("falls back to the plain ssh line when the remote tool is not ready", async () => {
    vi.mocked(ipc.writeTerminal).mockClear();
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(false);
    await sshTile();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(/^ssh -t .*me@box\r$/);
  });

  it("a new remote session gets the startup step; an existing one is only marked connected", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    const id = await sshTile();
    useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: true } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().remoteAttached(id, true);
    expect(useStore.getState().sshConnected[id]).toBe(true);
    expect(vi.mocked(ipc.writeTerminal).mock.calls.some((c) => String(c[1]).includes("claude --session-id"))).toBe(true);

    const other = await sshTile();
    useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [other]: true } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().remoteAttached(other, false);
    expect(useStore.getState().sshConnected[other]).toBe(true);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("a marker for a tile that is not connecting never types anything", async () => {
    const id = await sshTile();
    useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: false } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().remoteAttached(id, true);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().sshConnected[id]).toBe(true);
  });

  it("in attach mode the poller never types the remote step", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 6 + SSH_SETTLE_MS);
      expect(vi.mocked(ipc.writeTerminal).mock.calls.some((c) => String(c[1]).includes("claude --session-id"))).toBe(false);
    } finally {
      __stopAllPolling();
      vi.useRealTimers();
    }
  });

  it("setTerminalCwd accepts remote folder reports for connected ssh tiles only", async () => {
    const id = await sshTile();
    await useStore.getState().setTerminalCwd(id, "/p/deeper", "remote");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p");
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().setTerminalCwd(id, "/p/deeper", "remote");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper");
  });
});
```

Add `toolReady: {}` to the store test `beforeEach` state reset, and to its mock resets: `vi.mocked(ipc.toolRemoteReady).mockReset().mockResolvedValue(false);` and `vi.mocked(ipc.remoteTileInfo).mockReset().mockResolvedValue({ running: false });`.

`src/lib/xtermRegistry.test.ts`:

```ts
describe("attach marker and remote folders", () => {
  const originals = { remoteAttached: useStore.getState().remoteAttached, setTerminalCwd: useStore.getState().setTerminalCwd };
  beforeEach(() => {
    useStore.setState({
      terminals: { ra: { id: "ra", name: "ra", cwd: "/home/me", exited: null, error: null } },
      order: ["ra"],
      settings: { ra: { ssh: { host: "me@box", cwd: "/p" }, claude: null, command: null, extra: {} } },
      sshConnected: { ra: true },
      toolReady: { "me@box": true },
    });
  });
  afterEach(() => {
    dispose("ra");
    useStore.setState(originals);
  });

  it("passes the marker to the store and ignores it during replay", async () => {
    const remoteAttached = vi.fn(async () => {});
    useStore.setState({ remoteAttached });
    const { term } = attach("ra", document.createElement("div"));
    await prepare("ra");
    const osc = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[1337];
    expect(osc("swarmz-attach;new=1")).toBe(true);
    expect(remoteAttached).toHaveBeenCalledWith("ra", true);
    replayCallbacks.ra(new TextEncoder().encode("x"));
    osc("swarmz-attach;new=1");
    expect(remoteAttached).toHaveBeenCalledTimes(1);
    expect(osc("something-else")).toBe(false);
  });

  it("polls the remote tool for a connected ssh tile's folder", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p/sub" });
      const setTerminalCwd = vi.fn(async () => {});
      useStore.setState({ setTerminalCwd });
      attach("ra", document.createElement("div"));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.remoteTileInfo).toHaveBeenCalledWith("me@box", "ra");
      expect(setTerminalCwd).toHaveBeenCalledWith("ra", "/p/sub", "remote");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/workspace.test.ts src/store.test.ts src/lib/xtermRegistry.test.ts -t "attach mode|remote attach|attach marker" 2>&1 | grep -E "×|✓" | head -12`
Expected: failures on the missing functions and state.

- [ ] **Step 3: Implement**

`src/lib/workspace.ts`:

```ts
const REMOTE_TOOL = "~/.swarmz/bin/swarmz";

/** The ssh line for a tile that attaches to its session holder on `host`. The remote command is
 * one word for the local shell (quoted once) and is parsed again by the remote shell (arguments
 * quoted again); the leading `~` is left for the remote shell to expand. */
export function attachLine(host: string, tileId: string, cwd: string | null | undefined, name: string): string {
  const parts = [REMOTE_TOOL, "attach", tileId];
  if (cwd) parts.push("--cwd", shellQuote(cwd));
  parts.push("--name", shellQuote(name));
  return `ssh ${SSH_OPTS} ${host} ${shellQuote(parts.join(" "))}`;
}
```

`startupSteps(s, terminalId?, opts: { attach?: boolean; name?: string } = {})`: inside the `if (host)` branch, the first step is
`{ via: "local", line: opts.attach && terminalId ? attachLine(host, terminalId, s.ssh?.cwd, opts.name ?? terminalId) : sshLine(host) }`; everything else unchanged. `startupLine` passes `opts` through.

`src/store.ts`:
- State `toolReady: Record<string, boolean>` (initial `{}`), actions `remoteAttached(id: string, isNew: boolean): Promise<void>`.
- A helper `attachModeFor(id)`: `const host = settings[id]?.ssh?.host?.trim(); return !!host && useStore.getState().toolReady[host] === true;`.
- `runStartup`: before computing `steps`, for ssh tiles whose host has no `toolReady` entry yet, `await ipc.toolRemoteReady(host).then((ok) => set((st) => ({ toolReady: { ...st.toolReady, [host]: ok } }))).catch(() => set((st) => ({ toolReady: { ...st.toolReady, [host]: false } })))`. Then `const attach = attachModeFor(id)` and `startupSteps(settings, id, { attach, name: s.terminals[id]?.name })`. In the early "already live" branch, when `attach` is true only mark the tile connected (no `runRemoteStep`). Pass `attach` to `startPolling(id, host, attach)`.
- `startPolling(id, host, attach = false)`: store `attach` on the poller entry; in the success path (where it sets `sshConnected` and calls `runRemoteStep`), when `entry.attach` is true, return right after `stopPolling(id)` without changing state (the marker drives the connection); timeout and exit handling are unchanged.
- `runRemoteStep` computes the remote step with `startupSteps(settings, id, { attach: attachModeFor(id), name })` (the remote step is identical in both modes).
- `remoteAttached(id, isNew)`:

```ts
  async remoteAttached(id, isNew) {
    const s = useStore.getState();
    if (!s.terminals[id]) return;
    const wasConnecting = s.sshConnecting[id] === true;
    stopPolling(id);
    set((st) => ({
      sshConnected: { ...st.sshConnected, [id]: true },
      sshConnecting: omit(st.sshConnecting, id),
      startupPending: { ...st.startupPending, [id]: false },
      startupNotes: omit(st.startupNotes, id),
    }));
    if (isNew && wasConnecting) {
      await new Promise((r) => setTimeout(r, SSH_SETTLE_MS));
      await useStore.getState().runRemoteStep(id);
    }
  },
```

- `ensureAgentWatchers`: after a successful `agentsInstallRemote(host)`, also `ipc.toolRemoteReady(host)` and record `toolReady[host]` (errors record `false`).
- `setTerminalCwd`: for ssh or foreign tiles, accept `source === "remote"` only when `sshConnected[id] === true` (same rule as `osc7`); the source union becomes `"poll" | "osc7" | "hook" | "remote"`.

`src/lib/xtermRegistry.ts`:
- Register an OSC 1337 handler:

```ts
  term.parser.registerOscHandler(1337, (data) => {
    const m = /^swarmz-attach;new=([01])$/.exec(data);
    if (!m) return false;
    if (!entry.replaying) void useStore.getState().remoteAttached(id, m[1] === "1");
    return true;
  });
```

- Folder polling for remote tiles: in the interval tick (and the Enter poll), when the tile has `settings.ssh.host`, `sshConnected[id]` and `toolReady[host]`, call `ipc.remoteTileInfo(host, id)`; if the reply has `running && cwd`, call `setTerminalCwd(id, cwd, "remote")`. Local tiles keep today's path. Errors are ignored.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass. Existing ssh startup tests that assert the plain `ssh -t` line still pass because `toolRemoteReady` resolves `false` by default in the mocks.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(ui): remote tiles attach to their home Mac's session and follow its folder

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Build, bundle, docs

**Files:**
- Modify: `package.json`, `src-tauri/tauri.conf.json`, `CLAUDE.md`, `README.md`, `docs/superpowers/specs/2026-09-16-swarmz-phone-design.md` (status line)

- [ ] **Step 1: Scripts and bundle**

`package.json` scripts:

```json
    "build:tool": "cargo build --release --manifest-path src-tauri/Cargo.toml -p swarmz-tool",
    "build:tool:debug": "cargo build --manifest-path src-tauri/Cargo.toml -p swarmz-tool",
```

`src-tauri/tauri.conf.json`:
- `build.beforeDevCommand`: `"npm run build:tool:debug && npm run dev"`
- `build.beforeBuildCommand`: `"npm run build:tool && npm run build"`
- `bundle.macOS`: `{ "files": { "MacOS/swarmz-tool": "target/release/swarmz-tool" } }` (merge with any existing `macOS` keys).

- [ ] **Step 2: Verify the config parses and the tool builds**

Run: `npm run build:tool 2>&1 | tail -2 && python3 -c "import json;d=json.load(open('src-tauri/tauri.conf.json'));print(d['bundle']['macOS']['files'])"`
Expected: the release tool builds; the files map prints. Do not run `tauri build`; the controller builds the app.

- [ ] **Step 3: Docs**

`CLAUDE.md`: in "Commands", change the Rust test line to `cd src-tauri && cargo test --workspace   # Rust unit tests (app + swarmz-tool)` and add `npm run build:tool:debug   # build the session holder / swarmz tool`. Add a subsection under Architecture:

```markdown
### Session holders

Every tile's shell runs in a detached holder process (`src-tauri/tool`, binary `swarmz-tool`, installed as `~/.swarmz/bin/swarmz`). `swarmz hold <tile>` starts or finds it; the app connects to `~/.swarmz/sessions/<tile>.sock` as a viewer (`HolderClient`), so quitting or relaunching swarmz leaves shells and agents running and reattaching replays recent output (emitted on `pty:replay:<id>`, during which clipboard and attach escapes are ignored). A tile whose home is another Mac types `ssh … ~/.swarmz/bin/swarmz attach <tile>`; the attach marker (`OSC 1337 swarmz-attach;new=`) tells the app whether to type the startup step. The app installs the tool locally at startup and on tailnet machines on first connect (`tool_remote_ready`).
```

`README.md` "Development": use `cargo test --workspace` and mention `npm run build:tool:debug` before `npm run tauri dev` (the dev command also does it).

Spec status line: `Status: approved design; sub-project 1 (session holder) implemented`.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && (cd src-tauri && cargo test --workspace)`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add package.json src-tauri/tauri.conf.json CLAUDE.md README.md docs/superpowers/specs/2026-09-16-swarmz-phone-design.md
git commit -m "build: bundle the swarmz tool with the app; document session holders

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Acceptance (controller, with the user, on the release build)**

1. Build and install the app; open a local tile, run `sleep 1000` in it, start a Claude session in another.
2. Quit swarmz with Cmd+Q: `pgrep -fl "swarmz-tool __holder"` still lists both holders; the `sleep` and `claude` processes are alive.
3. Relaunch: both tiles reappear without a connect card, show their earlier output, and the Claude tile's dot is right.
4. Open a remote tile to the other Mac: the connect line is `ssh … swarmz attach …`; Claude starts once.
5. Turn Wi-Fi off for 30 s and back on (or kill the tile's ssh): reconnecting shows the same Claude conversation, still running, and no second Claude is started.
6. `cd` somewhere in the remote tile's shell and wait 5 s: the sidebar shows the new folder.
7. Close a tile: its holder exits (`pgrep` no longer lists it).
