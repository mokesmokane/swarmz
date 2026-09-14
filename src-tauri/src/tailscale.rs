use crate::remote::run_with_timeout;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Machine {
    pub name: String,
    #[serde(rename = "hostName")]
    pub host_name: String,
    pub ip: Option<String>,
    pub os: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TailscaleStatus {
    pub running: bool,
    pub message: Option<String>,
    pub user: String,
    #[serde(rename = "self")]
    pub self_machine: Option<Machine>,
    pub peers: Vec<Machine>,
}

#[derive(Deserialize)]
struct RawNode {
    #[serde(rename = "HostName", default)]
    host_name: String,
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "OS", default)]
    os: String,
    #[serde(rename = "Online", default)]
    online: bool,
    #[serde(rename = "TailscaleIPs", default)]
    ips: Vec<String>,
}

#[derive(Deserialize)]
struct RawStatus {
    #[serde(rename = "BackendState", default)]
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: Option<RawNode>,
    #[serde(rename = "Peer", default)]
    peers: HashMap<String, RawNode>,
}

pub fn short_name(dns: &str) -> String {
    dns.split('.').next().unwrap_or("").to_string()
}

fn to_machine(n: &RawNode) -> Machine {
    Machine {
        name: short_name(&n.dns_name),
        host_name: n.host_name.clone(),
        ip: n.ips.iter().find(|ip| ip.contains('.')).cloned().or_else(|| n.ips.first().cloned()),
        os: n.os.clone(),
        online: n.online,
    }
}

fn not_running(message: String, user: &str, self_machine: Option<Machine>) -> TailscaleStatus {
    TailscaleStatus { running: false, message: Some(message), user: user.to_string(), self_machine, peers: vec![] }
}

pub fn parse_status(json: &str, user: &str) -> Result<TailscaleStatus, String> {
    let raw: RawStatus = serde_json::from_str(json).map_err(|e| format!("could not parse tailscale status: {e}"))?;
    let self_machine = raw.self_node.as_ref().map(to_machine);
    if raw.backend_state != "Running" {
        let state = if raw.backend_state.is_empty() { "not running".to_string() } else { raw.backend_state.clone() };
        return Ok(not_running(format!("Tailscale is {state}"), user, self_machine));
    }
    let mut peers: Vec<Machine> = raw.peers.values().map(to_machine).filter(|m| !m.name.is_empty()).collect();
    peers.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.cmp(&b.name)));
    Ok(TailscaleStatus { running: true, message: None, user: user.to_string(), self_machine, peers })
}

const CANDIDATES: [&str; 3] = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

pub fn find_cli() -> Option<PathBuf> {
    CANDIDATES.iter().map(Path::new).find(|p| p.exists()).map(|p| p.to_path_buf())
}

pub fn status() -> Result<TailscaleStatus, String> {
    let user = std::env::var("USER").unwrap_or_default();
    let Some(cli) = find_cli() else {
        return Ok(not_running("Tailscale is not installed".into(), &user, None));
    };
    let mut cmd = Command::new(cli);
    cmd.arg("status").arg("--json");
    let done = run_with_timeout(cmd, Duration::from_secs(5), "tailscale")?;
    if done.stdout.trim().is_empty() {
        let msg = done.stderr.trim();
        return Ok(not_running(if msg.is_empty() { "Tailscale did not respond".into() } else { msg.to_string() }, &user, None));
    }
    parse_status(&done.stdout, &user)
}

pub fn open_app() -> Result<(), String> {
    let status = Command::new("open").arg("-a").arg("Tailscale").status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("could not open Tailscale".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "BackendState": "Running",
      "Self": { "HostName": "Martin’s Mac mini (2)", "DNSName": "martins-mac-mini-2.tail9f50bb.ts.net.", "OS": "macOS", "Online": true, "TailscaleIPs": ["100.111.1.82", "fd7a::1"] },
      "Peer": {
        "k1": { "HostName": "Martin’s Mac mini", "DNSName": "martins-mac-mini.tail9f50bb.ts.net.", "OS": "macOS", "Online": true, "TailscaleIPs": ["fd7a::2", "100.117.82.118"] },
        "k2": { "HostName": "home-mini", "DNSName": "home-mini.tail9f50bb.ts.net.", "OS": "macOS", "Online": false, "TailscaleIPs": [] },
        "k3": { "HostName": "aaa", "DNSName": "aaa.tail9f50bb.ts.net.", "OS": "linux", "Online": true, "TailscaleIPs": ["100.1.1.1"] }
      }
    }"#;

    #[test]
    fn parses_peers_online_first_then_by_name_and_prefers_ipv4() {
        let st = parse_status(SAMPLE, "mokes").unwrap();
        assert!(st.running);
        assert_eq!(st.user, "mokes");
        assert_eq!(st.self_machine.as_ref().unwrap().name, "martins-mac-mini-2");
        let names: Vec<&str> = st.peers.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["aaa", "martins-mac-mini", "home-mini"]);
        let mini = &st.peers[1];
        assert_eq!(mini.ip.as_deref(), Some("100.117.82.118"));
        assert_eq!(mini.host_name, "Martin’s Mac mini");
        assert!(mini.online);
        assert_eq!(st.peers[2].ip, None);
        assert!(!st.peers[2].online);
    }

    #[test]
    fn not_running_backend_reports_running_false_with_message() {
        let st = parse_status(r#"{"BackendState":"NeedsLogin","Peer":{}}"#, "mokes").unwrap();
        assert!(!st.running);
        assert!(st.message.as_deref().unwrap().contains("NeedsLogin"));
        assert!(st.peers.is_empty());
    }

    #[test]
    fn malformed_json_is_an_error() {
        assert!(parse_status("{ nope", "mokes").is_err());
    }

    #[test]
    fn short_name_strips_domain_and_trailing_dot() {
        assert_eq!(short_name("home-mini.tail9f50bb.ts.net."), "home-mini");
        assert_eq!(short_name(""), "");
    }
}
