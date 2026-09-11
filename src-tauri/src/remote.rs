use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CONTROL_PATH: &str = "~/.swarmz/ssh/%C";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RemoteListing {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<String>,
}

pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn validate_host(host: &str) -> Result<String, String> {
    let h = host.trim();
    if h.is_empty() {
        return Err("host cannot be empty".into());
    }
    let mut chars = h.chars();
    let first_ok = chars.next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
    let rest_ok = h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | ':' | '-'));
    if !first_ok || !rest_ok || h.len() > 253 {
        return Err("host may only contain letters, digits, . _ @ : - and cannot start with -".into());
    }
    Ok(h.to_string())
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
}

pub fn ensure_ssh_dir_in(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join(".swarmz").join("ssh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not set permissions on {}: {e}", dir.display()))?;
    }
    Ok(dir)
}

pub fn ensure_ssh_dir() -> Result<PathBuf, String> {
    ensure_ssh_dir_in(&home_dir())
}

pub fn list_command(path: Option<&str>) -> String {
    let cd = match path {
        Some(p) => format!("cd -- {}", sh_quote(p)),
        None => "cd".to_string(),
    };
    format!("{cd} && pwd && {{ ls -1Ap -- . | grep '/$' || true; }}")
}

pub fn parse_listing(stdout: &str) -> Result<RemoteListing, String> {
    let mut lines = stdout.lines().map(|l| l.trim_end_matches('\r'));
    let path = lines.next().filter(|l| !l.is_empty()).ok_or_else(|| "empty listing".to_string())?.to_string();
    let mut visible: Vec<String> = Vec::new();
    let mut hidden: Vec<String> = Vec::new();
    for line in lines {
        let name = line.trim_end_matches('/');
        if name.is_empty() {
            continue;
        }
        if name.starts_with('.') {
            hidden.push(name.to_string());
        } else {
            visible.push(name.to_string());
        }
    }
    visible.sort();
    hidden.sort();
    visible.extend(hidden);
    let parent = if path == "/" {
        None
    } else {
        match path.rfind('/') {
            Some(0) => Some("/".to_string()),
            Some(i) => Some(path[..i].to_string()),
            None => None,
        }
    };
    Ok(RemoteListing { path, parent, dirs: visible })
}

struct Finished {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Finished, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run ssh: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut stdout);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut stderr);
                }
                return Ok(Finished { status, stdout, stderr });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ssh timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("ssh failed: {e}")),
        }
    }
}

fn base_command() -> Result<Command, String> {
    ensure_ssh_dir()?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg(format!("ControlPath={CONTROL_PATH}"));
    Ok(cmd)
}

pub fn check(host: &str) -> Result<bool, String> {
    let host = validate_host(host)?;
    let mut cmd = base_command()?;
    cmd.arg("-O").arg("check").arg(&host);
    let done = run_with_timeout(cmd, Duration::from_secs(5))?;
    Ok(done.status.success())
}

pub fn list_dir(host: &str, path: Option<&str>) -> Result<RemoteListing, String> {
    let host = validate_host(host)?;
    let mut cmd = base_command()?;
    cmd.arg("-o").arg("ControlMaster=no").arg("-o").arg("BatchMode=yes").arg(&host).arg(list_command(path));
    let done = run_with_timeout(cmd, Duration::from_secs(10))?;
    if !done.status.success() {
        let code = done.status.code().unwrap_or(-1);
        if code == 255 {
            return Err("not connected: connect in the terminal first".into());
        }
        let msg = done.stderr.trim();
        return Err(if msg.is_empty() { format!("remote command failed (exit {code})") } else { msg.to_string() });
    }
    parse_listing(&done.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_quote_wraps_and_escapes() {
        assert_eq!(sh_quote("/proj"), "'/proj'");
        assert_eq!(sh_quote("/a'b"), "'/a'\\''b'");
    }

    #[test]
    fn validate_host_allowlist() {
        assert!(validate_host("me@host.local").is_ok());
        assert!(validate_host("10.0.0.5").is_ok());
        assert!(validate_host("").is_err());
        assert!(validate_host("-oProxyCommand=x").is_err());
        assert!(validate_host("h; ls").is_err());
        assert!(validate_host("a|b").is_err());
    }

    #[test]
    fn parse_listing_orders_dirs_and_computes_parent() {
        let out = "/Users/me/projects\nzeta/\n.hidden/\nalpha/\n.git/\n";
        let l = parse_listing(out).unwrap();
        assert_eq!(l.path, "/Users/me/projects");
        assert_eq!(l.parent.as_deref(), Some("/Users/me"));
        assert_eq!(l.dirs, vec!["alpha", "zeta", ".git", ".hidden"]);
    }

    #[test]
    fn parse_listing_root_has_no_parent_and_top_level_parent_is_root() {
        assert_eq!(parse_listing("/\nbin/\n").unwrap().parent, None);
        assert_eq!(parse_listing("/Users\nme/\n").unwrap().parent.as_deref(), Some("/"));
    }

    #[test]
    fn parse_listing_rejects_empty_output() {
        assert!(parse_listing("").is_err());
    }

    #[test]
    fn remote_list_command_quotes_path() {
        assert_eq!(list_command(None), "cd && pwd && { ls -1Ap -- . | grep '/$' || true; }");
        assert_eq!(
            list_command(Some("/a'b")),
            "cd -- '/a'\\''b' && pwd && { ls -1Ap -- . | grep '/$' || true; }"
        );
    }

    #[test]
    fn ssh_dir_is_created_private() {
        let home = std::env::temp_dir().join(format!("swarmz-remote-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = ensure_ssh_dir_in(&home).unwrap();
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
