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
