use crate::remote::{run_with_timeout_input, validate_host, CONTROL_PATH};
use std::process::Command;
use std::time::Duration;

/// PNG bytes for a `width`x`height` RGBA buffer, as the clipboard hands it over.
pub fn png_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| format!("clipboard image is {width}x{height} but carries {} bytes", rgba.len()))?;
    let mut buf = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| format!("could not encode the clipboard image as PNG: {e}"))?;
    Ok(buf)
}

/// The file name a paste lands under on the remote; `now_ms` keeps two pastes apart. Only
/// digits go into it, so it is always safe to interpolate into the shell command below.
pub fn paste_name(now_ms: u128) -> String {
    format!("paste-{now_ms}.png")
}

/// Writes `len` bytes of stdin to `~/.swarmz/paste/<name>` on the remote and prints the
/// absolute path it landed at. Like the other remote writes, `cat` cannot tell a pipe that
/// closed because we timed out from one that ended because the payload was complete — both
/// are a clean EOF and exit 0 — so the temp file's size is checked before it is moved into
/// place, and a short write leaves nothing for Claude to open.
pub fn remote_paste_command(name: &str, len: usize) -> String {
    let tmp = format!("~/.swarmz/paste/{name}.tmp.$$");
    format!(
        "mkdir -p ~/.swarmz/paste && cat > {tmp} && [ \"$(wc -c < {tmp} | tr -d ' ')\" -eq {len} ] \
&& mv -f {tmp} ~/.swarmz/paste/{name} && cd ~ && printf '%s/.swarmz/paste/{name}' \"$PWD\" \
|| {{ rm -f {tmp}; exit 1; }}"
    )
}

/// True for a path the remote can be trusted to have printed: absolute and free of control
/// characters, which could otherwise smuggle terminal escapes into the tile we type it into.
pub fn usable_path(s: &str) -> bool {
    s.starts_with('/') && !crate::remote::has_control_chars(s)
}

/// Pushes `png` to `host` over the shared ssh socket, returning the absolute remote path.
pub fn push_png(host: &str, png: &[u8]) -> Result<String, String> {
    let host = validate_host(host)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let name = paste_name(now_ms);
    let mut cmd = ssh_command(&host)?;
    cmd.arg(remote_paste_command(&name, png.len()));
    let done = run_with_timeout_input(cmd, Duration::from_secs(20), "ssh", Some(png))?;
    if !done.status.success() {
        return Err(if done.status.code() == Some(255) {
            format!("not reachable: {}", done.stderr.trim())
        } else if done.stderr.trim().is_empty() {
            format!("remote paste write failed (exit {:?})", done.status.code())
        } else {
            done.stderr.trim().to_string()
        });
    }
    // Login-shell banners and the like share this stdout, so never type it into a tile unchecked.
    let path = done.stdout.trim();
    if !usable_path(path) {
        return Err("remote returned an unusable path".into());
    }
    Ok(path.to_string())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];

    #[test]
    fn png_from_rgba_round_trips_the_pixels() {
        let mut rgba = Vec::new();
        rgba.extend_from_slice(&RED);
        rgba.extend_from_slice(&BLUE);
        let png = png_from_rgba(2, 1, &rgba).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

        let decoded = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (2, 1));
        assert_eq!(decoded.get_pixel(0, 0).0, RED);
        assert_eq!(decoded.get_pixel(1, 0).0, BLUE);
    }

    #[test]
    fn png_from_rgba_rejects_a_buffer_that_does_not_match_the_size() {
        let err = png_from_rgba(2, 1, &RED).unwrap_err();
        assert!(err.contains("2x1"), "{err}");
    }

    #[test]
    fn paste_name_is_stamped_with_the_millisecond() {
        assert_eq!(paste_name(1700000000000), "paste-1700000000000.png");
    }

    #[test]
    fn usable_path_takes_only_an_absolute_path_free_of_control_characters() {
        assert!(usable_path("/Users/me/.swarmz/paste/x.png"));
        assert!(!usable_path("rel/x.png"));
        // A login-shell banner or a hostile path could otherwise type escapes into the tile.
        assert!(!usable_path("/a\x1b[31mb"));
        assert!(!usable_path(""));
    }

    #[test]
    fn remote_paste_command_writes_atomically_and_prints_the_path() {
        let cmd = remote_paste_command("paste-7.png", 42);
        assert!(cmd.contains("mkdir -p ~/.swarmz/paste"), "{cmd}");
        assert!(cmd.contains("-eq 42"), "{cmd}");
        assert!(cmd.contains("mv -f"), "{cmd}");
        assert!(cmd.contains("printf '%s/.swarmz/paste/paste-7.png' \"$PWD\""), "{cmd}");
    }

    /// Runs the paste command locally with `HOME` pointed at a temp dir, the way the remote
    /// shell runs it, and feeds it `payload` on stdin.
    fn run_paste(command: &str, home: &std::path::Path, payload: &[u8]) -> (bool, String) {
        use std::io::Write;
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .env("HOME", home)
            .current_dir(home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(payload).unwrap();
        let out = child.wait_with_output().unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string())
    }

    #[test]
    fn a_short_payload_leaves_nothing_behind() {
        let home = std::env::temp_dir().join(format!("swarmz-paste-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();

        let png = png_from_rgba(1, 1, &RED).unwrap();
        let name = paste_name(1700000000000);
        let target = home.join(".swarmz/paste").join(&name);

        let (ok, stdout) = run_paste(&remote_paste_command(&name, png.len()), &home, &png);
        assert!(ok);
        assert_eq!(std::fs::read(&target).unwrap(), png);
        assert_eq!(stdout, format!("{}/.swarmz/paste/{name}", home.display()));

        // A timeout closes the pipe cleanly, so `cat` still exits 0 with half a PNG: the length
        // check is what stops Claude being handed a truncated image.
        let short = paste_name(1700000000001);
        let (ok, stdout) = run_paste(&remote_paste_command(&short, png.len()), &home, &png[..4]);
        assert!(!ok);
        assert_eq!(stdout, "");
        assert!(!home.join(".swarmz/paste").join(&short).exists());
        assert_eq!(std::fs::read_dir(home.join(".swarmz/paste")).unwrap().count(), 1);

        std::fs::remove_dir_all(&home).unwrap();
    }
}
