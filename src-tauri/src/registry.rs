use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub exited: Option<i32>,
    pub error: Option<String>,
    /// Whether the tile's session was already running when the app connected to it.
    #[serde(default)]
    pub existed: bool,
    /// When the tile's session holder started (UTC, RFC 3339); None until it is connected.
    #[serde(default, rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum RegistryError {
    DuplicateName(String),
    DuplicateId(String),
    NotFound(String),
    EmptyName,
    InvalidName(String),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::DuplicateName(n) => write!(f, "a terminal named \"{n}\" already exists"),
            RegistryError::DuplicateId(id) => write!(f, "a terminal with id {id} already exists"),
            RegistryError::NotFound(id) => write!(f, "no terminal with id {id}"),
            RegistryError::EmptyName => write!(f, "name cannot be empty"),
            RegistryError::InvalidName(n) => {
                write!(f, "name \"{n}\" contains unsupported characters or is too long")
            }
        }
    }
}

const MAX_NAME_LEN: usize = 64;
const UNSUPPORTED_NAME_CHARS: [char; 5] = ['"', '\'', '`', '\\', '$'];

/// Trims `name` and rejects it if empty, too long, or containing characters
/// that could cause trouble if the name is ever interpolated into a shell
/// command or file path (quotes, backslash, `$`, or any control character).
fn validate_name(name: &str) -> Result<String, RegistryError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(RegistryError::EmptyName);
    }
    if trimmed.chars().count() > MAX_NAME_LEN
        || trimmed.chars().any(|c| UNSUPPORTED_NAME_CHARS.contains(&c) || c.is_control())
    {
        return Err(RegistryError::InvalidName(trimmed.to_string()));
    }
    Ok(trimmed.to_string())
}

#[derive(Debug, Default)]
pub struct TerminalRegistry {
    entries: Vec<TerminalInfo>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        self.entries.clone()
    }

    pub fn get(&self, id: &str) -> Option<&TerminalInfo> {
        self.entries.iter().find(|t| t.id == id)
    }

    pub fn add(&mut self, id: String, requested_name: Option<String>, cwd: String) -> Result<TerminalInfo, RegistryError> {
        if self.entries.iter().any(|t| t.id == id) {
            return Err(RegistryError::DuplicateId(id));
        }
        let base = requested_name
            .and_then(|n| validate_name(&n).ok())
            .unwrap_or_else(|| basename(&cwd));
        let name = self.unique_name(&base);
        let info = TerminalInfo { id, name, cwd, exited: None, error: None, existed: false, started_at: None };
        self.entries.push(info.clone());
        Ok(info)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<TerminalInfo, RegistryError> {
        let name = validate_name(name)?;
        if self.entries.iter().any(|t| t.id != id && t.name == name) {
            return Err(RegistryError::DuplicateName(name));
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| RegistryError::NotFound(id.to_string()))?;
        entry.name = name;
        Ok(entry.clone())
    }

    pub fn set_cwd(&mut self, id: &str, cwd: &str) -> Result<TerminalInfo, RegistryError> {
        let entry = self
            .entries
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| RegistryError::NotFound(id.to_string()))?;
        entry.cwd = cwd.to_string();
        Ok(entry.clone())
    }

    pub fn set_exited(&mut self, id: &str, code: Option<i32>, error: Option<String>) {
        if let Some(entry) = self.entries.iter_mut().find(|t| t.id == id) {
            entry.exited = Some(code.unwrap_or(-1));
            entry.error = error;
        }
    }

    pub fn clear_exited(&mut self, id: &str) {
        if let Some(entry) = self.entries.iter_mut().find(|t| t.id == id) {
            entry.exited = None;
            entry.error = None;
        }
    }

    pub fn remove(&mut self, id: &str) -> Option<TerminalInfo> {
        let idx = self.entries.iter().position(|t| t.id == id)?;
        Some(self.entries.remove(idx))
    }

    fn unique_name(&self, base: &str) -> String {
        let taken = |n: &str| self.entries.iter().any(|t| t.name == n);
        if !taken(base) {
            return base.to_string();
        }
        let mut i = 2;
        loop {
            let candidate = format!("{base}-{i}");
            if !taken(&candidate) {
                return candidate;
            }
            i += 1;
        }
    }
}

fn basename(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "shell".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn started_at_is_sent_as_camel_case_only_when_known() {
        let mut reg = TerminalRegistry::new();
        let info = reg.add("a".into(), None, "/tmp".into()).unwrap();
        assert!(serde_json::to_value(&info).unwrap().get("startedAt").is_none());
        let joined = TerminalInfo { existed: true, started_at: Some("2026-09-16T10:00:00Z".into()), ..info };
        let v = serde_json::to_value(&joined).unwrap();
        assert_eq!(v["startedAt"], "2026-09-16T10:00:00Z");
        assert_eq!(v["existed"], true);
    }

    #[test]
    fn default_name_is_cwd_basename_and_suffixes_on_collision() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), None, "/Users/me/projects/swarmz".into()).unwrap();
        let b = r.add("2".into(), None, "/Users/me/projects/swarmz".into()).unwrap();
        let c = r.add("3".into(), None, "/Users/me/projects/swarmz".into()).unwrap();
        assert_eq!(a.name, "swarmz");
        assert_eq!(b.name, "swarmz-2");
        assert_eq!(c.name, "swarmz-3");
    }

    #[test]
    fn requested_name_is_used_and_suffixed_on_collision() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), Some("api".into()), "/tmp".into()).unwrap();
        let b = r.add("2".into(), Some("api".into()), "/tmp".into()).unwrap();
        assert_eq!(a.name, "api");
        assert_eq!(b.name, "api-2");
    }

    #[test]
    fn blank_or_root_cwd_falls_back_to_shell() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), Some("   ".into()), "/".into()).unwrap();
        assert_eq!(a.name, "shell");
    }

    #[test]
    fn rename_rejects_duplicates_and_empty() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into()).unwrap();
        r.add("2".into(), Some("b".into()), "/tmp".into()).unwrap();
        assert_eq!(r.rename("2", "a"), Err(RegistryError::DuplicateName("a".into())));
        assert_eq!(r.rename("2", "  "), Err(RegistryError::EmptyName));
        assert_eq!(r.rename("9", "z"), Err(RegistryError::NotFound("9".into())));
        let ok = r.rename("2", "b").unwrap();
        assert_eq!(ok.name, "b");
        let ok = r.rename("2", " c ").unwrap();
        assert_eq!(ok.name, "c");
        assert_eq!(r.get("2").unwrap().name, "c");
    }

    #[test]
    fn rename_rejects_unsupported_characters() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into()).unwrap();
        assert_eq!(r.rename("1", "a\"b"), Err(RegistryError::InvalidName("a\"b".into())));
        assert_eq!(r.get("1").unwrap().name, "a");
    }

    #[test]
    fn rename_rejects_names_over_max_length() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into()).unwrap();
        let too_long = "x".repeat(65);
        assert_eq!(r.rename("1", &too_long), Err(RegistryError::InvalidName(too_long)));
        assert_eq!(r.get("1").unwrap().name, "a");
    }

    #[test]
    fn rename_accepts_ordinary_names() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into()).unwrap();
        let ok = r.rename("1", "ok-name_2").unwrap();
        assert_eq!(ok.name, "ok-name_2");
    }

    #[test]
    fn add_falls_back_to_basename_when_requested_name_is_invalid() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), Some("bad`name".into()), "/Users/me/projects/swarmz".into()).unwrap();
        assert_eq!(a.name, "swarmz");
    }

    #[test]
    fn add_rejects_duplicate_id() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into()).unwrap();
        assert_eq!(
            r.add("1".into(), Some("b".into()), "/tmp".into()),
            Err(RegistryError::DuplicateId("1".into()))
        );
        assert_eq!(r.list().len(), 1);
    }

    #[test]
    fn set_cwd_updates_the_entry_and_rejects_unknown_ids() {
        let mut reg = TerminalRegistry::new();
        reg.add("a".into(), None, "/one".into()).unwrap();
        let info = reg.set_cwd("a", "/two").unwrap();
        assert_eq!(info.cwd, "/two");
        assert_eq!(reg.get("a").unwrap().cwd, "/two");
        assert_eq!(reg.set_cwd("nope", "/x"), Err(RegistryError::NotFound("nope".into())));
    }

    #[test]
    fn exited_and_remove() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into()).unwrap();
        r.set_exited("1", Some(3), None);
        assert_eq!(r.get("1").unwrap().exited, Some(3));
        r.clear_exited("1");
        assert_eq!(r.get("1").unwrap().exited, None);
        assert!(r.remove("1").is_some());
        assert!(r.get("1").is_none());
        assert_eq!(r.list().len(), 0);
        let again = r.add("2".into(), Some("a".into()), "/tmp".into()).unwrap();
        assert_eq!(again.name, "a");
    }
}
