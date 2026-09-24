//! Reading a file a tile talks about (file viewing spec §3): from this disk for a local tile,
//! over the shared ssh master for an ssh tile. Text comes back as text, an image as base64, and
//! anything else as a size and a note; nothing over `VIEW_MAX` is fetched whole.

use crate::remote::{sh_quote, validate_host};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The most of a file the viewer shows.
pub const VIEW_MAX: u64 = 2 * 1024 * 1024;
/// How much of a file decides whether it is text.
const SNIFF: usize = 8 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    /// `text`, `image` or `binary`.
    pub kind: String,
    pub path: String,
    pub size: u64,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

/// The image type a path's extension names, when it is one the viewer shows inline.
pub fn image_mime(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Text is UTF-8 without a NUL in its first `SNIFF` bytes; a cut in the middle of a character at
/// the sniff boundary is forgiven.
pub fn looks_like_text(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(SNIFF)];
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.valid_up_to() + 4 >= head.len() && e.error_len().is_none(),
    }
}

/// `~` and `~/…` against `home`; anything else as given.
pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// A view of the bytes of `path` (as the user named it), classified by extension and content.
pub fn view_of(path: &str, size: u64, bytes: Vec<u8>) -> FileView {
    let truncated = size > bytes.len() as u64;
    if let Some(mime) = image_mime(path) {
        return FileView { kind: "image".into(), path: path.into(), size, truncated, text: None, base64: Some(BASE64.encode(&bytes)), mime: Some(mime.into()) };
    }
    if looks_like_text(&bytes) {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return FileView { kind: "text".into(), path: path.into(), size, truncated, text: Some(text), base64: None, mime: None };
    }
    FileView { kind: "binary".into(), path: path.into(), size, truncated, text: None, base64: None, mime: None }
}

/// Reads `path` on this Mac: a regular file only, at most `VIEW_MAX` bytes of it.
pub fn read_local(path: &str, home: &Path) -> Result<FileView, String> {
    use std::io::Read;
    let full = expand_home(path, home);
    let meta = std::fs::metadata(&full).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "not found".to_string(),
        _ => e.to_string(),
    })?;
    if meta.is_dir() {
        return Err("a folder, not a file".into());
    }
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    let mut f = std::fs::File::open(&full).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.by_ref().take(VIEW_MAX).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(view_of(path, meta.len(), bytes))
}

/// The remote side of a read: one line saying what `path` is, then its size, then up to
/// `VIEW_MAX` bytes base64-encoded (a text stream survives ssh unchanged, bytes do not). `~` is
/// the remote home, so it is left for the remote shell rather than quoted away.
pub fn remote_read_command(path: &str) -> String {
    let target = match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", sh_quote(rest)),
        None if path == "~" => "\"$HOME\"".to_string(),
        None => sh_quote(path),
    };
    format!(
        "p={target}; if [ -d \"$p\" ]; then echo DIR; elif [ -f \"$p\" ]; then echo FILE; wc -c < \"$p\" | tr -d ' '; head -c {VIEW_MAX} \"$p\" | base64; elif [ -e \"$p\" ]; then echo OTHER; else echo NONE; fi"
    )
}

/// What the remote command printed, as a view.
pub fn parse_remote(path: &str, stdout: &str) -> Result<FileView, String> {
    let mut lines = stdout.lines();
    match lines.next().map(str::trim) {
        Some("FILE") => {}
        Some("DIR") => return Err("a folder, not a file".into()),
        Some("OTHER") => return Err("not a regular file".into()),
        Some("NONE") | None => return Err("not found".into()),
        Some(other) => return Err(format!("unexpected reply: {other}")),
    }
    let size: u64 = lines.next().unwrap_or("").trim().parse().map_err(|_| "unreadable size".to_string())?;
    let encoded: String = lines.map(str::trim).collect();
    let bytes = BASE64.decode(encoded.as_bytes()).map_err(|e| format!("unreadable content: {e}"))?;
    Ok(view_of(path, size, bytes))
}

/// Reads `path` on `host` over the shared ssh master.
pub fn read_remote(host: &str, path: &str) -> Result<FileView, String> {
    let host = validate_host(host)?;
    let mut cmd = crate::agents::ssh_command(&host)?;
    cmd.arg(remote_read_command(path));
    let done = crate::remote::run_with_timeout(cmd, Duration::from_secs(30), "ssh")?;
    if !done.status.success() {
        if done.status.code() == Some(255) {
            return Err("not connected: connect in the terminal first".into());
        }
        let msg = done.stderr.trim();
        return Err(if msg.is_empty() { format!("remote read failed (exit {:?})", done.status.code()) } else { msg.to_string() });
    }
    parse_remote(path, &done.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("szb-{}-files-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn text_images_and_binaries_are_told_apart() {
        assert!(looks_like_text(b"hello\nworld"));
        assert!(looks_like_text("héllo".as_bytes()));
        assert!(!looks_like_text(b"\x89PNG\0\0"));
        assert!(looks_like_text(b""));
        assert_eq!(image_mime("shot.PNG"), Some("image/png"));
        assert_eq!(image_mime("a/b.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime("notes.md"), None);
        let v = view_of("x.png", 3, vec![1, 2, 3]);
        assert_eq!((v.kind.as_str(), v.base64.as_deref(), v.mime.as_deref()), ("image", Some("AQID"), Some("image/png")));
        let v = view_of("x.bin", 10, vec![0, 1, 2]);
        assert_eq!((v.kind.as_str(), v.truncated), ("binary", true));
        let v = view_of("x.txt", 2, b"hi".to_vec());
        assert_eq!((v.kind.as_str(), v.text.as_deref(), v.truncated), ("text", Some("hi"), false));
    }

    #[test]
    fn a_local_read_expands_home_caps_and_refuses_folders() {
        let home = tmp("home");
        std::fs::write(home.join("note.txt"), "line 1\nline 2\n").unwrap();
        let v = read_local("~/note.txt", &home).unwrap();
        assert_eq!((v.kind.as_str(), v.size, v.text.as_deref()), ("text", 14, Some("line 1\nline 2\n")));
        assert_eq!(v.path, "~/note.txt");
        assert_eq!(read_local("~/nope.txt", &home).unwrap_err(), "not found");
        assert_eq!(read_local(home.to_str().unwrap(), &home).unwrap_err(), "a folder, not a file");
        assert_eq!(expand_home("~", &home), home);
        assert_eq!(expand_home("/etc/hosts", &home), PathBuf::from("/etc/hosts"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_remote_command_quotes_the_path_and_keeps_home_for_the_remote_shell() {
        let c = remote_read_command("/tmp/it's here.txt");
        assert!(c.starts_with("p='/tmp/it'\\''s here.txt'; if [ -d \"$p\" ]"), "{c}");
        assert!(c.contains(&format!("head -c {VIEW_MAX}")));
        let c = remote_read_command("~/Projects/x.rs");
        assert!(c.starts_with("p=\"$HOME\"/'Projects/x.rs';"), "{c}");
        assert!(remote_read_command("~").starts_with("p=\"$HOME\";"));
    }

    #[test]
    fn the_remote_reply_is_parsed() {
        let v = parse_remote("~/a.txt", "FILE\n7\naGVsbG8K\n").unwrap();
        assert_eq!((v.kind.as_str(), v.size, v.text.as_deref(), v.truncated), ("text", 7, Some("hello\n"), true));
        assert_eq!(parse_remote("x", "DIR\n").unwrap_err(), "a folder, not a file");
        assert_eq!(parse_remote("x", "NONE\n").unwrap_err(), "not found");
        assert_eq!(parse_remote("x", "").unwrap_err(), "not found");
        assert!(parse_remote("x", "FILE\nabc\n").is_err());
    }
}
