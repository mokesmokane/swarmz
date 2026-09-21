//! Files the phone sends to a tile's Mac (phone attachments spec §3): written into
//! `~/.swarmz/paste`, the folder the desktop's Ctrl+V uses, with the same size-checked, atomic
//! write, and swept with `prune`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The largest upload (spec §3.1).
pub const MAX_UPLOAD: u64 = 25 * 1024 * 1024;
/// How old a paste file must be before `prune` removes it (spec §3.2).
pub const PASTE_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
const NAME_MAX: usize = 64;

pub fn paste_dir(home: &Path) -> PathBuf {
    home.join(".swarmz").join("paste")
}

/// The display name made safe for a file name: `[A-Za-z0-9._-]` kept, anything else `_`, no
/// leading dots, at most `NAME_MAX` characters keeping the extension, `file` when nothing is
/// left.
pub fn safe_name(name: &str) -> String {
    let mapped: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    let trimmed = mapped.trim_start_matches('.').to_string();
    let base = if trimmed.is_empty() { "file".to_string() } else { trimmed };
    if base.len() <= NAME_MAX {
        return base;
    }
    // Keep a short extension; cut the stem.
    match base.rfind('.') {
        Some(i) if i > 0 && base.len() - i <= 8 => {
            let ext = &base[i..];
            let stem = &base[..i];
            let keep = NAME_MAX - ext.len();
            format!("{}{ext}", &stem[..keep.min(stem.len())])
        }
        _ => base[..NAME_MAX].to_string(),
    }
}

/// The stored name: `paste-<ms>-<name>`, beside the desktop's `paste-<ms>.png`.
pub fn stored_name(now_ms: u128, name: &str) -> String {
    format!("paste-{now_ms}-{}", safe_name(name))
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Reads exactly `size` bytes from `input` into a new file under `paste_dir(home)`, and returns
/// its absolute path. Errors are `(code, message)`: `too_large`, `short` (fewer bytes arrived;
/// nothing is left behind) or `failed`.
pub fn write_upload(home: &Path, name: &str, size: u64, input: &mut dyn Read) -> Result<(PathBuf, u64), (&'static str, String)> {
    if size > MAX_UPLOAD {
        return Err(("too_large", format!("{size} bytes is over the {MAX_UPLOAD} byte limit")));
    }
    let dir = paste_dir(home);
    crate::paths::ensure_dir(&dir).map_err(|e| ("failed", format!("could not create {}: {e}", dir.display())))?;
    // A name that is free now; two uploads in the same millisecond take the next one.
    let mut ms = now_ms();
    let (path, file) = loop {
        let path = dir.join(stored_name(ms, name));
        match open_new(&path) {
            Ok(f) => break (path, f),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => ms += 1,
            Err(e) => return Err(("failed", format!("could not create {}: {e}", path.display()))),
        }
    };
    // The reserved name stays as an empty file while the bytes go to a temp file beside it, so a
    // short upload never leaves anything to open: the temp file replaces it only at full size.
    drop(file);
    let tmp = dir.join(format!("{}.tmp.{}", path.file_name().unwrap().to_string_lossy(), std::process::id()));
    let fail = |code: &'static str, msg: String| {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&path);
        (code, msg)
    };
    let mut out = open_new(&tmp).map_err(|e| fail("failed", format!("could not create {}: {e}", tmp.display())))?;
    let copied = match std::io::copy(&mut input.take(size), &mut out) {
        Ok(n) => n,
        Err(e) => return Err(fail("failed", format!("write failed: {e}"))),
    };
    let flushed = out.flush();
    drop(out);
    if flushed.is_err() || copied != size {
        return Err(fail("short", format!("{copied} of {size} bytes arrived")));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        return Err(fail("failed", format!("could not move into place: {e}")));
    }
    Ok((path, copied))
}

fn open_new(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// Removes paste files older than `older_than` (never directories, never a temp file being
/// written right now, which is younger). Returns how many.
pub fn sweep_paste(home: &Path, older_than: Duration) -> usize {
    let dir = paste_dir(home);
    let Ok(entries) = std::fs::read_dir(&dir) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        let old = meta.modified().ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age >= older_than);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("szc-{}-upload-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    #[test]
    fn names_are_made_safe_and_kept_short() {
        assert_eq!(safe_name("IMG 2026.jpg"), "IMG_2026.jpg");
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name("...."), "file");
        assert_eq!(safe_name(""), "file");
        assert_eq!(safe_name("résumé.pdf"), "r_sum_.pdf");
        let long = format!("{}.jpeg", "a".repeat(200));
        let s = safe_name(&long);
        assert_eq!(s.len(), NAME_MAX);
        assert!(s.ends_with(".jpeg"));
        assert_eq!(safe_name(&"b".repeat(100)).len(), NAME_MAX);
        assert_eq!(stored_name(17, "a b.png"), "paste-17-a_b.png");
    }

    #[test]
    fn an_upload_lands_at_full_size_with_a_private_mode() {
        let h = home("ok");
        let payload = b"hello, phone".to_vec();
        let (path, n) = write_upload(&h, "note.txt", payload.len() as u64, &mut &payload[..]).unwrap();
        assert_eq!(n, payload.len() as u64);
        assert!(path.starts_with(paste_dir(&h)));
        assert!(path.file_name().unwrap().to_string_lossy().ends_with("-note.txt"));
        assert_eq!(std::fs::read(&path).unwrap(), payload);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // Extra bytes after `size` are ignored; a second upload gets its own name.
        let more = b"12345".to_vec();
        let (p2, n2) = write_upload(&h, "note.txt", 3, &mut &more[..]).unwrap();
        assert_eq!((n2, std::fs::read(&p2).unwrap()), (3, b"123".to_vec()));
        assert_ne!(p2, path);
        assert_eq!(std::fs::read_dir(paste_dir(&h)).unwrap().count(), 2, "no temp files left");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn a_short_upload_leaves_nothing_and_a_large_one_is_refused_unread() {
        let h = home("short");
        let payload = b"abc".to_vec();
        let err = write_upload(&h, "x.bin", 10, &mut &payload[..]).unwrap_err();
        assert_eq!(err.0, "short");
        assert_eq!(std::fs::read_dir(paste_dir(&h)).map(|d| d.count()).unwrap_or(0), 0);
        struct Never;
        impl Read for Never {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("read despite the size being over the limit")
            }
        }
        let err = write_upload(&h, "x.bin", MAX_UPLOAD + 1, &mut Never).unwrap_err();
        assert_eq!(err.0, "too_large");
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_sweep_removes_only_old_files() {
        let h = home("sweep");
        let dir = paste_dir(&h);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("paste-1-old.png"), b"x").unwrap();
        std::fs::write(dir.join("paste-2-new.png"), b"y").unwrap();
        std::fs::create_dir_all(dir.join("paste-3-dir")).unwrap();
        let old = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        std::fs::File::options().write(true).open(dir.join("paste-1-old.png")).unwrap().set_modified(old).unwrap();
        assert_eq!(sweep_paste(&h, PASTE_AGE), 1);
        assert!(!dir.join("paste-1-old.png").exists());
        assert!(dir.join("paste-2-new.png").exists());
        assert!(dir.join("paste-3-dir").exists());
        assert_eq!(sweep_paste(&h, PASTE_AGE), 0);
        assert_eq!(sweep_paste(&home("none"), PASTE_AGE), 0);
        let _ = std::fs::remove_dir_all(&h);
    }
}
