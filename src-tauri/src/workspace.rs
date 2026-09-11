use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SshConfig {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaudeConfig {
    pub enabled: bool,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "skipPermissions")]
    pub skip_permissions: bool,
    pub started: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalDef {
    pub id: String,
    pub name: String,
    pub cwd: String,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    #[serde(default)]
    pub claude: Option<ClaudeConfig>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Workspace {
    pub version: u32,
    pub terminals: Vec<TerminalDef>,
    #[serde(default)]
    pub layout: Value,
}

pub fn default_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".swarmz").join("workspace.json")
}

pub fn load_from(path: &Path) -> Result<Option<Workspace>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    match serde_json::from_str::<Workspace>(&text) {
        Ok(ws) => Ok(Some(ws)),
        Err(parse_err) => {
            let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let broken = path.with_file_name(format!("workspace.json.broken-{secs}"));
            fs::rename(path, &broken).map_err(|e| format!("workspace file was invalid ({parse_err}) and could not be moved: {e}"))?;
            Err(format!("workspace file was invalid ({parse_err}) and was moved to {}", broken.display()))
        }
    }
}

pub fn save_to(path: &Path, ws: &Workspace) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "workspace path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    let text = serde_json::to_string_pretty(ws).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("swarmz-ws-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        dir.join("workspace.json")
    }

    fn sample() -> Workspace {
        Workspace {
            version: 1,
            terminals: vec![TerminalDef {
                id: "t1".into(),
                name: "api".into(),
                cwd: "/tmp".into(),
                ssh: Some(SshConfig { host: "me@host".into(), cwd: Some("/remote".into()) }),
                claude: Some(ClaudeConfig {
                    enabled: true,
                    session_id: "s1".into(),
                    skip_permissions: true,
                    started: false,
                }),
                command: None,
                extra: serde_json::Map::new(),
            }],
            layout: serde_json::json!({ "kind": "group", "id": "g1", "tabs": ["t1"], "active": "t1" }),
        }
    }

    #[test]
    fn missing_file_loads_as_none() {
        let path = temp_path("missing");
        assert_eq!(load_from(&path).unwrap(), None);
    }

    #[test]
    fn round_trips_and_leaves_no_tmp_file() {
        let path = temp_path("roundtrip");
        save_to(&path, &sample()).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        let loaded = load_from(&path).unwrap().unwrap();
        assert_eq!(loaded, sample());
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\n  \"terminals\""), "file should be pretty-printed");
        assert!(text.contains("\"sessionId\""));
        assert!(text.contains("\"skipPermissions\""));
    }

    #[test]
    fn unknown_terminal_fields_round_trip() {
        let path = temp_path("extra");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"version":1,"terminals":[{"id":"t1","name":"a","cwd":"/tmp","note":"keep me"}],"layout":null}"#,
        )
        .unwrap();
        let ws = load_from(&path).unwrap().unwrap();
        assert_eq!(ws.terminals[0].extra.get("note").unwrap(), "keep me");
        assert_eq!(ws.terminals[0].ssh, None);
        assert_eq!(ws.layout, serde_json::Value::Null);
        save_to(&path, &ws).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("keep me"));
    }

    #[test]
    fn malformed_file_is_quarantined_and_reported() {
        let path = temp_path("broken");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        let err = load_from(&path).unwrap_err();
        assert!(err.contains("workspace.json.broken-"), "got: {err}");
        assert!(!path.exists());
        let quarantined = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("workspace.json.broken-"));
        assert!(quarantined);
    }
}
