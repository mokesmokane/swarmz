//! `swarmz stats` (activity bar and machines spec §4): this Mac's CPU, memory, disk, uptime and
//! Claude sessions, for the desktop's Machines view. The parsers are pure, over the outputs of
//! `ps`, `sysctl` and `vm_stat`, so fixtures test them.

use crate::agent::Status;
use crate::tiles::TileRow;
use serde_json::{json, Value};
use std::process::Command;

/// Sum of every process's `%cpu` (`ps -A -o %cpu`), where 100 is one core.
pub fn parse_ps_cpu(out: &str) -> f64 {
    out.lines().filter_map(|l| l.trim().parse::<f64>().ok()).sum()
}

/// `sysctl -n vm.loadavg hw.ncpu hw.memsize kern.boottime`: (load1, cores, memory bytes, boot
/// time in seconds since the epoch).
pub fn parse_sysctl(out: &str) -> (Option<f64>, Option<u32>, Option<u64>, Option<u64>) {
    let lines: Vec<&str> = out.lines().map(str::trim).collect();
    let load1 = lines.first().and_then(|l| l.trim_start_matches('{').split_whitespace().next()).and_then(|v| v.parse().ok());
    let cores = lines.get(1).and_then(|l| l.parse().ok());
    let mem = lines.get(2).and_then(|l| l.parse().ok());
    let boot = lines.get(3).and_then(|l| l.split("sec =").nth(1)).and_then(|r| r.split(',').next()).and_then(|v| v.trim().parse().ok());
    (load1, cores, mem, boot)
}

/// Used memory from `vm_stat`, as Activity Monitor counts it: app memory (active), wired, and
/// what the compressor occupies.
pub fn parse_vm_stat(out: &str) -> Option<u64> {
    let page: u64 = out.lines().next()?.split("page size of").nth(1)?.split_whitespace().next()?.parse().ok()?;
    let pages = |key: &str| -> u64 {
        out.lines()
            .find(|l| l.trim_start().starts_with(key))
            .and_then(|l| l.rsplit(':').next())
            .and_then(|v| v.trim().trim_end_matches('.').parse().ok())
            .unwrap_or(0)
    };
    Some((pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page)
}

/// Claude sessions by state, from this Mac's tile rows.
pub fn claude_counts(rows: &[TileRow]) -> Value {
    let (mut working, mut needs, mut idle, mut stopped) = (0, 0, 0, 0);
    for r in rows.iter().filter(|r| r.kind == "claude") {
        if !r.running {
            stopped += 1;
        } else if r.status == Status::Blocked || r.needs.is_some() {
            needs += 1;
        } else if r.status == Status::Working {
            working += 1;
        } else {
            idle += 1;
        }
    }
    json!({"working": working, "needsYou": needs, "idle": idle, "stopped": stopped})
}

fn run(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// Free and total bytes of the volume holding `/`.
fn disk() -> Option<(u64, u64)> {
    let path = std::ffi::CString::new("/").ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let block = s.f_bsize as u64;
    Some((s.f_bavail as u64 * block, s.f_blocks as u64 * block))
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// The whole reply, from the numbers already gathered (pure, for the test).
#[allow(clippy::too_many_arguments)]
pub fn reply(cpu_sum: f64, load1: Option<f64>, cores: Option<u32>, mem_total: Option<u64>, mem_used: Option<u64>, disk: Option<(u64, u64)>, uptime: Option<u64>, claude: Value, app: Option<String>, build: u64) -> Value {
    let cores_n = cores.unwrap_or(1).max(1);
    let percent = |part: u64, whole: u64| if whole == 0 { None } else { Some(round1(part as f64 * 100.0 / whole as f64)) };
    json!({
        "v": 1,
        "cpu": {"percent": round1((cpu_sum / cores_n as f64).min(100.0)), "load1": load1, "cores": cores},
        "memory": {"usedPercent": mem_used.zip(mem_total).and_then(|(u, t)| percent(u, t)), "totalBytes": mem_total},
        "disk": {"freePercent": disk.and_then(|(f, t)| percent(f, t)), "freeBytes": disk.map(|(f, _)| f)},
        "uptimeSeconds": uptime,
        "claude": claude,
        "app": app,
        "tool": env!("CARGO_PKG_VERSION"),
        "build": build,
    })
}

/// This Mac's numbers now.
pub fn gather(rows: &[TileRow], build: u64) -> Value {
    let cpu_sum = parse_ps_cpu(&run("/bin/ps", &["-A", "-o", "%cpu"]));
    let (load1, cores, mem_total, boot) = parse_sysctl(&run("/usr/sbin/sysctl", &["-n", "vm.loadavg", "hw.ncpu", "hw.memsize", "kern.boottime"]));
    let mem_used = parse_vm_stat(&run("/usr/bin/vm_stat", &[]));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let uptime = boot.map(|b| now.saturating_sub(b));
    let app = Some(run("/usr/bin/plutil", &["-extract", "CFBundleShortVersionString", "raw", "/Applications/swarmz.app/Contents/Info.plist"]).trim().to_string()).filter(|v| !v.is_empty());
    reply(cpu_sum, load1, cores, mem_total, mem_used, disk(), uptime, claude_counts(rows), app, build)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VM_STAT: &str = "Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3680.
Pages active:                            100000.
Pages inactive:                          109542.
Pages wired down:                         50000.
Pages stored in compressor:              684458.
Pages occupied by compressor:             50000.
";

    #[test]
    fn the_outputs_are_parsed() {
        assert_eq!(parse_ps_cpu(" %CPU\n  0.7\n 12.5\n  bad\n 100.0\n"), 113.2);
        let (l, c, m, b) = parse_sysctl("{ 3.25 2.69 2.44 }\n8\n8589934592\n{ sec = 1789979322, usec = 272938 } Mon Sep 21 09:28:42 2026\n");
        assert_eq!((l, c, m, b), (Some(3.25), Some(8), Some(8589934592), Some(1789979322)));
        assert_eq!(parse_sysctl(""), (None, None, None, None));
        assert_eq!(parse_vm_stat(VM_STAT), Some(200000 * 16384));
        assert_eq!(parse_vm_stat("nonsense"), None);
    }

    #[test]
    fn claude_sessions_are_counted_by_state() {
        let row = |kind: &str, running: bool, status: Status, needs: bool| TileRow {
            kind: kind.into(),
            running,
            status,
            needs: needs.then_some(crate::agent::Needs::Question),
            ..Default::default()
        };
        let rows = vec![
            row("claude", true, Status::Working, false),
            row("claude", true, Status::Blocked, true),
            row("claude", true, Status::Idle, false),
            row("claude", false, Status::Offline, false),
            row("shell", true, Status::Idle, false),
        ];
        assert_eq!(claude_counts(&rows), json!({"working": 1, "needsYou": 1, "idle": 1, "stopped": 1}));
    }

    #[test]
    fn the_reply_divides_cpu_by_cores_and_works_out_percentages() {
        let v = reply(400.0, Some(3.2), Some(8), Some(1000), Some(250), Some((50, 200)), Some(3600), json!({}), Some("0.8.0".into()), 7);
        assert_eq!(v["cpu"]["percent"], 50.0);
        assert_eq!(v["memory"]["usedPercent"], 25.0);
        assert_eq!(v["disk"]["freePercent"], 25.0);
        assert_eq!((v["uptimeSeconds"].as_u64(), v["app"].as_str(), v["build"].as_u64()), (Some(3600), Some("0.8.0"), Some(7)));
        let busy = reply(2000.0, None, Some(8), None, None, None, None, json!({}), None, 0);
        assert_eq!(busy["cpu"]["percent"], 100.0, "capped");
        assert!(busy["memory"]["usedPercent"].is_null());
    }
}
