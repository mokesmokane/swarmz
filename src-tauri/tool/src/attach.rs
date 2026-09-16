use crate::client::HolderClient;
use crate::hold::{hold, CliError, HoldRequest};
use crate::proto::{Hello, PROTOCOL_VERSION};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const ATTACH_MARKER_PREFIX: &str = "\x1b]1337;swarmz-attach;new=";

/// Written right after the replay (under the same stdout lock and flush), so a viewer knows
/// exactly where replayed history ends and live output begins. The holder always sends one replay,
/// even an empty one, so every attach writes this once, before any live byte.
pub const REPLAY_END_MARKER: &str = "\x1b]1337;swarmz-replay-end\x07";

/// The attach marker: `new=` says whether the session was just started, and `end=1` promises
/// that `REPLAY_END_MARKER` follows the replay, so a viewer can rely on it instead of guessing.
/// Viewers ignore fields they do not know.
pub fn marker(new: bool) -> String {
    format!("{ATTACH_MARKER_PREFIX}{};end=1\x07", if new { 1 } else { 0 })
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

/// Queries fd 1 (stdout), not fd 0: under `ssh -t` (how this CLI is actually invoked) stdin and
/// stdout are the same pty, but a plain redirect could leave only one of them attached to it, and
/// stdout is the one whose size actually matters for wrapping the shell's own output.
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
    OutputClosed,
}

/// Refuses to attach a tile from inside that tile's own session (`SWARMZ_TERMINAL_ID` is set in
/// every holder's shell): the bridge would feed the session its own output forever.
pub fn refuse_self_attach(tile: &str, own_tile: Option<&str>) -> Result<(), CliError> {
    if own_tile == Some(tile) {
        return Err(CliError::new("self", format!("already inside tile {tile}'s session; not attaching it to itself")));
    }
    Ok(())
}

/// Holds the tile's session (starting it if needed) and bridges this terminal to it. Returns the
/// process exit code: the shell's when it exits (or 1 when it exited without reporting a code, as
/// for a signal-killed shell or a connection that broke unexpectedly), 0 when our input or output
/// closes (the ssh connection went away), leaving the session running.
pub fn attach(exe: &Path, dir: &Path, mut req: HoldRequest) -> Result<i32, CliError> {
    refuse_self_attach(&req.tile, std::env::var("SWARMZ_TERMINAL_ID").ok().as_deref())?;
    let (cols, rows) = term_size();
    req.cols = cols;
    req.rows = rows;
    let held = hold(exe, dir, &req)?;
    let attach_marker = marker(!held.existed);
    let raw = RawMode::enable();
    let (done_tx, done_rx) = mpsc::channel::<Done>();
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let exit_tx = done_tx.clone();
    let output_done = done_tx.clone();
    let hello = Hello { v: PROTOCOL_VERSION, cols, rows, viewer: "window".into() };
    let client = HolderClient::connect(
        Path::new(&held.socket),
        &hello,
        move |bytes, replay| {
            let Ok(mut o) = stdout.lock() else { return };
            // A write or flush failure (e.g. EPIPE, the other end of the ssh pipe has gone away)
            // ends the bridge exactly like stdin closing: detach and leave the session running,
            // rather than surfacing it as the shell having exited.
            // The replay is written once, before any live byte, framed by the two markers under
            // one lock. The attach marker is only written once the session has answered, so a
            // failed connect prints nothing but its JSON error.
            let ok = if replay {
                o.write_all(attach_marker.as_bytes()).is_ok()
                    && o.write_all(&bytes).is_ok()
                    && o.write_all(REPLAY_END_MARKER.as_bytes()).is_ok()
            } else {
                o.write_all(&bytes).is_ok()
            };
            if !ok || o.flush().is_err() {
                let _ = output_done.send(Done::OutputClosed);
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
        // `None` covers both a shell that exited without a reportable code (killed by a signal)
        // and a connection that broke before the holder ever reported an exit at all (see
        // `HolderClient`'s fallback `on_exit(None)` when its reader loop ends unexpectedly): both
        // are failures, never success.
        Done::ShellExited(code) => Ok(code.unwrap_or(1)),
        Done::InputClosed | Done::OutputClosed => {
            client.detach();
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_announces_the_end_marker() {
        assert_eq!(marker(true), "\x1b]1337;swarmz-attach;new=1;end=1\x07");
        assert_eq!(marker(false), "\x1b]1337;swarmz-attach;new=0;end=1\x07");
        assert!(marker(false).starts_with(ATTACH_MARKER_PREFIX));
    }

    #[test]
    fn attaching_the_tile_you_are_in_is_refused() {
        assert_eq!(refuse_self_attach("t1", Some("t1")).unwrap_err().code, "self");
        assert!(refuse_self_attach("t1", Some("t2")).is_ok());
        assert!(refuse_self_attach("t1", None).is_ok());
    }
}
