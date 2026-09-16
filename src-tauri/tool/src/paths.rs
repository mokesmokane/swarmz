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

/// Removes the socket and metadata of a session that is not live. A socket that is still being
/// listened on is left alone even when the metadata looks stale (missing, corrupt, or naming a
/// dead pid): unlinking a live socket would let a second holder bind the path out from under
/// whatever is already serving it. The log is kept either way.
pub fn clear_stale(paths: &SessionPaths) {
    if live_session(paths).is_none() {
        if !socket_live(&paths.socket) {
            let _ = std::fs::remove_file(&paths.socket);
        }
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
    fn clear_stale_never_unlinks_a_socket_still_being_listened_on() {
        let d = tmp("live-no-meta");
        ensure_dir(&d).unwrap();
        let p = session_paths(&d, "t1").unwrap();
        // A live listener with no metadata at all (missing, not just stale): exactly what a
        // second concurrent `hold` could see mid-startup, before the first one has written
        // `Meta` yet. `live_session` is correctly None (no metadata to report), but the socket
        // itself must survive `clear_stale` so nothing else can bind over it.
        let _l = std::os::unix::net::UnixListener::bind(&p.socket).unwrap();
        assert!(live_session(&p).is_none());
        clear_stale(&p);
        assert!(socket_live(&p.socket), "clear_stale must not unlink a socket that is still live");
        assert!(read_meta(&p.meta).is_none());
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
