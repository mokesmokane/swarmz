use crate::remote::{run_with_timeout, run_with_timeout_input, validate_host, CONTROL_PATH};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

pub const PULL_COMMAND: &str = "cat ~/.swarmz/workspace.json";
pub const PUSH_COMMAND: &str =
    "mkdir -p ~/.swarmz && cat > ~/.swarmz/workspace.json.sync.$$ && mv -f ~/.swarmz/workspace.json.sync.$$ ~/.swarmz/workspace.json";

fn ssh_command(host: &str) -> Result<Command, String> {
    crate::remote::ensure_ssh_dir()?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg(format!("ControlPath={CONTROL_PATH}"))
        .arg("-o").arg("ControlMaster=auto")
        .arg("-o").arg("ControlPersist=10m")
        .arg("-o").arg("BatchMode=yes")
        .arg("-o").arg("ConnectTimeout=5")
        .arg(host);
    Ok(cmd)
}

/// Runs `remote` on `host` with the sync's ssh options (a shared master when there is one,
/// `BatchMode`, never a prompt), within `secs`.
pub fn run_remote(host: &str, remote: &str, secs: u64) -> Result<crate::remote::Finished, String> {
    let host = validate_host(host)?;
    let mut cmd = ssh_command(&host)?;
    cmd.arg(remote);
    run_with_timeout(cmd, Duration::from_secs(secs), "ssh")
}

pub fn classify_pull(code: Option<i32>, stdout: &str, stderr: &str) -> Result<Option<String>, String> {
    match code {
        Some(0) => Ok(Some(stdout.to_string())),
        Some(255) => Err(format!("not reachable: {}", stderr.trim())),
        _ if stderr.contains("No such file") => Ok(None),
        Some(c) => Err(if stderr.trim().is_empty() { format!("remote read failed (exit {c})") } else { stderr.trim().to_string() }),
        None => Err("ssh was terminated".into()),
    }
}

pub fn pull(host: &str) -> Result<Option<String>, String> {
    let host = validate_host(host)?;
    let mut cmd = ssh_command(&host)?;
    cmd.arg(PULL_COMMAND);
    let done = run_with_timeout(cmd, Duration::from_secs(10), "ssh")?;
    classify_pull(done.status.code(), &done.stdout, &done.stderr)
}

pub fn push(host: &str, contents: &str) -> Result<(), String> {
    let host = validate_host(host)?;
    let mut cmd = ssh_command(&host)?;
    cmd.arg(PUSH_COMMAND);
    let done = run_with_timeout_input(cmd, Duration::from_secs(10), "ssh", Some(contents.as_bytes()))?;
    if done.status.success() {
        Ok(())
    } else if done.status.code() == Some(255) {
        Err(format!("not reachable: {}", done.stderr.trim()))
    } else {
        Err(if done.stderr.trim().is_empty() { "remote write failed".into() } else { done.stderr.trim().to_string() })
    }
}

pub fn stat_mtime_ms(path: &Path) -> Result<Option<u64>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta.modified().map_err(|e| e.to_string())?;
            let ms = modified.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
            Ok(Some(ms))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn stat_local() -> Result<Option<u64>, String> {
    stat_mtime_ms(&crate::workspace::default_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_strings_are_exact() {
        assert_eq!(PULL_COMMAND, "cat ~/.swarmz/workspace.json");
        assert_eq!(
            PUSH_COMMAND,
            "mkdir -p ~/.swarmz && cat > ~/.swarmz/workspace.json.sync.$$ && mv -f ~/.swarmz/workspace.json.sync.$$ ~/.swarmz/workspace.json"
        );
    }

    #[test]
    fn classify_pull_maps_missing_file_to_none() {
        assert_eq!(classify_pull(Some(0), "{}", "").unwrap(), Some("{}".to_string()));
        assert_eq!(classify_pull(Some(1), "", "cat: /Users/x/.swarmz/workspace.json: No such file or directory").unwrap(), None);
        assert!(classify_pull(Some(255), "", "ssh: connect to host x port 22: Connection refused").unwrap_err().contains("not reachable"));
        assert!(classify_pull(Some(1), "", "Permission denied").is_err());
    }

    #[test]
    fn stdin_payload_reaches_the_child() {
        let path = std::env::temp_dir().join(format!("swarmz-sync-test-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(format!("cat > {}", path.display()));
        let done = crate::remote::run_with_timeout_input(cmd, std::time::Duration::from_secs(5), "sh", Some(b"hello sync")).unwrap();
        assert!(done.status.success());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello sync");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stat_of_missing_file_is_none_and_existing_file_has_mtime() {
        let dir = std::env::temp_dir().join(format!("swarmz-stat-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("workspace.json");
        assert_eq!(stat_mtime_ms(&file).unwrap(), None);
        std::fs::write(&file, "{}").unwrap();
        assert!(stat_mtime_ms(&file).unwrap().unwrap() > 1_600_000_000_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
