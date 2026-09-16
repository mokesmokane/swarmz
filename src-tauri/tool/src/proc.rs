//! Runs a child process with a deadline, draining its output on threads so a large output can
//! never block it.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Finished {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_with_timeout_input(mut cmd: Command, timeout: Duration, program: &str, input: Option<&[u8]>) -> Result<Finished, String> {
    let mut child = cmd
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if let Some(bytes) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let bytes = bytes.to_vec();
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(&bytes);
            });
        }
    }
    let start = Instant::now();

    // Drain stdout/stderr concurrently on their own threads so a listing
    // larger than the OS pipe buffer can't block the child on write while
    // we wait for it to exit (which would otherwise look like a timeout).
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut o) = stdout_pipe {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = stderr_pipe {
            let _ = e.read_to_string(&mut s);
        }
        s
    });

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_handle.join().unwrap_or_default();
                let stderr = stderr_handle.join().unwrap_or_default();
                return Ok(Finished { status, stdout, stderr });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // The pipes are closed now, so the reader threads will
                    // see EOF and finish; join them to avoid leaking.
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err(format!("{program} timed out"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("{program} failed: {e}")),
        }
    }
}

pub fn run_with_timeout(cmd: Command, timeout: Duration, program: &str) -> Result<Finished, String> {
    run_with_timeout_input(cmd, timeout, program, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_with_timeout_drains_output_larger_than_pipe_buffer() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("head -c 300000 /dev/zero | tr '\\0' 'a'; echo; echo done");
        let started = Instant::now();
        let done = run_with_timeout(cmd, Duration::from_secs(10), "sh").unwrap();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(done.status.success());
        assert!(done.stdout.len() > 200_000);
    }

    #[test]
    fn run_with_timeout_kills_slow_command_and_reports_timeout() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let started = Instant::now();
        let result = run_with_timeout(cmd, Duration::from_secs(1), "sleep");
        assert!(started.elapsed() < Duration::from_secs(2));
        let err = result.unwrap_err();
        assert!(err.contains("sleep timed out"), "unexpected error: {err}");
    }
}
