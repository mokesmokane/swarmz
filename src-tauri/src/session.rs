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
    /// Whether the program in front has bracketed paste on, as the holder's screen model saw it.
    fn bracketed_paste(&self) -> Option<bool> {
        None
    }
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
    // `info()` serialises concurrent callers itself, so the app's foreground probe and folder
    // poll can run on different threads without swapping replies.
    fn foreground_busy(&self) -> Option<bool> {
        self.info(Duration::from_millis(800)).and_then(|i| i.foreground_busy)
    }
    fn cwd(&self) -> Option<String> {
        self.info(Duration::from_secs(2)).and_then(|i| i.cwd)
    }
    fn bracketed_paste(&self) -> Option<bool> {
        self.info(Duration::from_millis(800)).and_then(|i| i.bracketed_paste)
    }
}
