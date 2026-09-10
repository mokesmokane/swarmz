use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TerminalInfo {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub exited: Option<i32>,
    pub error: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum RegistryError {
    DuplicateName(String),
    NotFound(String),
    EmptyName,
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::DuplicateName(n) => write!(f, "a terminal named \"{n}\" already exists"),
            RegistryError::NotFound(id) => write!(f, "no terminal with id {id}"),
            RegistryError::EmptyName => write!(f, "name cannot be empty"),
        }
    }
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

    pub fn add(&mut self, id: String, requested_name: Option<String>, cwd: String) -> TerminalInfo {
        let base = requested_name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| basename(&cwd));
        let name = self.unique_name(&base);
        let info = TerminalInfo { id, name, cwd, exited: None, error: None };
        self.entries.push(info.clone());
        info
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<TerminalInfo, RegistryError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(RegistryError::EmptyName);
        }
        if self.entries.iter().any(|t| t.id != id && t.name == name) {
            return Err(RegistryError::DuplicateName(name.to_string()));
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| RegistryError::NotFound(id.to_string()))?;
        entry.name = name.to_string();
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
    fn default_name_is_cwd_basename_and_suffixes_on_collision() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), None, "/Users/me/projects/swarmz".into());
        let b = r.add("2".into(), None, "/Users/me/projects/swarmz".into());
        let c = r.add("3".into(), None, "/Users/me/projects/swarmz".into());
        assert_eq!(a.name, "swarmz");
        assert_eq!(b.name, "swarmz-2");
        assert_eq!(c.name, "swarmz-3");
    }

    #[test]
    fn requested_name_is_used_and_suffixed_on_collision() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), Some("api".into()), "/tmp".into());
        let b = r.add("2".into(), Some("api".into()), "/tmp".into());
        assert_eq!(a.name, "api");
        assert_eq!(b.name, "api-2");
    }

    #[test]
    fn blank_or_root_cwd_falls_back_to_shell() {
        let mut r = TerminalRegistry::new();
        let a = r.add("1".into(), Some("   ".into()), "/".into());
        assert_eq!(a.name, "shell");
    }

    #[test]
    fn rename_rejects_duplicates_and_empty() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into());
        r.add("2".into(), Some("b".into()), "/tmp".into());
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
    fn exited_and_remove() {
        let mut r = TerminalRegistry::new();
        r.add("1".into(), Some("a".into()), "/tmp".into());
        r.set_exited("1", Some(3), None);
        assert_eq!(r.get("1").unwrap().exited, Some(3));
        r.clear_exited("1");
        assert_eq!(r.get("1").unwrap().exited, None);
        assert!(r.remove("1").is_some());
        assert!(r.get("1").is_none());
        assert_eq!(r.list().len(), 0);
        let again = r.add("2".into(), Some("a".into()), "/tmp".into());
        assert_eq!(again.name, "a");
    }
}
