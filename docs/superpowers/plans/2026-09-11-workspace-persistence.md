# swarmz Workspace Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On launch, swarmz restores the saved terminals and layout from a hand-editable `~/.swarmz/workspace.json`; each terminal can carry an SSH and/or Claude startup line (with per-terminal session resume and an optional skip-permissions flag) that the user runs with one click.

**Architecture:** The Rust core gains a `workspace` module that loads and atomically saves the file, plus a duplicate-id guard in the registry. The frontend gains a pure `workspace.ts` (types, `startupLine`, `reconcileLayout`, `toWorkspace`), store actions for load/reload/settings/startup, a debounced save subscription, a per-row settings panel in the sidebar, and a startup bar in the terminal pane.

**Tech Stack:** unchanged (Tauri 2, Rust, serde/serde_json, React 19, zustand 5, vitest 4). Uses `@tauri-apps/api/path` `homeDir()` and `@tauri-apps/plugin-dialog` `confirm()` which the existing `core:default` and `dialog:default` capabilities already permit.

**Spec:** `docs/superpowers/specs/2026-09-11-workspace-persistence-design.md`

## Global Constraints

- File path: `$HOME/.swarmz/workspace.json`, pretty-printed; writes go to `workspace.json.tmp` then rename. Malformed file is renamed to `workspace.json.broken-<unix-seconds>` and reported.
- Schema: `{ version: 1, terminals: TerminalDef[], layout: Layout | null }`; `TerminalDef = { id, name, cwd, ssh?: { host, cwd? } | null, claude?: { enabled, sessionId, skipPermissions, started } | null, command?: string | null }`. Unknown fields on a terminal def round-trip.
- Startup line rules (spec section 3): `command` wins when non-empty; ssh only → `ssh -t <host>`; claude only → `claude [--dangerously-skip-permissions] (--session-id X | --resume X)` with `--resume` once `started`; both → `ssh -t <host> '<cd <ssh.cwd> && >claude …'` with single-quote shell quoting.
- Startup commands never run automatically; a tile shows a startup bar until the user clicks Run or Skip.
- Saved terminal ids are reused on restore; the registry rejects a duplicate id.
- No import cycle: `store.ts` imports `lib/ipc`, `lib/layout`, `lib/workspace` only; `xtermRegistry` imports the store.
- Commit after every task with a conventional-commit message ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014xUXNbx7voeP3tRbbRR67s
  ```
- Never commit `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`, `.superpowers`.

---

## File structure

```
src-tauri/src/workspace.rs          load_from/save_to + serde types (tested)
src-tauri/src/registry.rs           add() returns Result; DuplicateId
src-tauri/src/commands.rs           load_workspace/save_workspace commands; create_terminal maps add() error
src-tauri/src/lib.rs                register the two commands, `pub mod workspace;`
src/lib/workspace.ts                types, shellQuote, claudeLine, startupLine, reconcileLayout, toWorkspace
src/lib/workspace.test.ts
src/lib/ipc.ts                      loadWorkspace/saveWorkspace wrappers
src/store.ts                        settings, startupPending, startupNotes, persistError, persistenceReady; actions; save subscription
src/store.test.ts                   new tests; mock gains loadWorkspace/saveWorkspace and @tauri-apps/api/path
src/components/TerminalSettings.tsx inline settings panel used by Sidebar rows
src/components/Sidebar.tsx          gear button + panel, Reload workspace, persist error line
src/components/TerminalPane.tsx     startup bar
src/App.tsx                         call loadWorkspace on mount
```

---

### Task 1: Rust workspace module, registry duplicate-id guard, commands

**Files:**
- Create: `src-tauri/src/workspace.rs`
- Modify: `src-tauri/src/registry.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: existing `TerminalRegistry`, `AppState`.
- Produces: Tauri commands `load_workspace() -> Result<Option<Workspace>, String>` and `save_workspace(workspace: Workspace) -> Result<(), String>` (JS arg name `workspace`). `RegistryError::DuplicateId(String)`; `TerminalRegistry::add` now returns `Result<TerminalInfo, RegistryError>`.

- [ ] **Step 1: Write the failing workspace tests**

Create `src-tauri/src/workspace.rs` with only the test module:

```rust
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
```

Add `pub mod workspace;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run to verify failure**

```bash
cd src-tauri && cargo test workspace
```
Expected: compile error, `Workspace` not found.

- [ ] **Step 3: Implement the module**

Prepend to `src-tauri/src/workspace.rs`:

```rust
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
```

- [ ] **Step 4: Run workspace tests**

```bash
cd src-tauri && cargo test workspace
```
Expected: 4 passed.

- [ ] **Step 5: Registry duplicate-id guard (test first)**

In `src-tauri/src/registry.rs` add to the test module:

```rust
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
```

Then change the enum, Display, and `add`:

```rust
#[derive(Debug, PartialEq)]
pub enum RegistryError {
    DuplicateName(String),
    DuplicateId(String),
    NotFound(String),
    EmptyName,
    InvalidName(String),
}
```
Add to Display: `RegistryError::DuplicateId(id) => write!(f, "a terminal with id {id} already exists"),`.

```rust
    pub fn add(&mut self, id: String, requested_name: Option<String>, cwd: String) -> Result<TerminalInfo, RegistryError> {
        if self.entries.iter().any(|t| t.id == id) {
            return Err(RegistryError::DuplicateId(id));
        }
        let base = requested_name
            .and_then(|n| validate_name(&n).ok())
            .unwrap_or_else(|| basename(&cwd));
        let name = self.unique_name(&base);
        let info = TerminalInfo { id, name, cwd, exited: None, error: None };
        self.entries.push(info.clone());
        Ok(info)
    }
```

Update every existing `r.add(...)` call in the registry tests to `r.add(...).unwrap()` (the two "falls back" assertions compare `.unwrap().name`). Run `cargo test registry` and fix any remaining compile errors in tests only.

- [ ] **Step 6: Commands and wiring**

In `src-tauri/src/commands.rs`:
- Add `use crate::workspace::{self, Workspace};`.
- In `create_terminal`, replace `let info = state.registry.lock().unwrap().add(id, name, cwd);` with:
  ```rust
  let info = state.registry.lock().unwrap().add(id, name, cwd).map_err(|e| e.to_string())?;
  ```
- Append:
  ```rust
  #[tauri::command]
  pub fn load_workspace() -> Result<Option<Workspace>, String> {
      workspace::load_from(&workspace::default_path())
  }

  #[tauri::command]
  pub fn save_workspace(workspace: Workspace) -> Result<(), String> {
      workspace::save_to(&workspace::default_path(), &workspace)
  }
  ```
  The command parameter is named `workspace` (that is the JS-facing arg name) and would shadow the `workspace` module inside the function body, so import the module under an alias: replace the `use crate::workspace::{self, Workspace};` line with `use crate::workspace::Workspace; use crate::workspace as ws_file;` and write the two bodies as `ws_file::load_from(&ws_file::default_path())` and `ws_file::save_to(&ws_file::default_path(), &workspace)`.

In `src-tauri/src/lib.rs` add `pub mod workspace;` and register `commands::load_workspace, commands::save_workspace,` in `generate_handler!`.

- [ ] **Step 7: Full Rust verification**

```bash
cd src-tauri && cargo test
```
Expected: 18 passed (13 + 4 workspace + 1 registry), no warnings in the swarmz crate.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src
git commit -m "feat(core): workspace file load/save; reject duplicate terminal ids"
```

---

### Task 2: Frontend workspace types, startup line, layout reconciliation, ipc wrappers

**Files:**
- Create: `src/lib/workspace.ts`, `src/lib/workspace.test.ts`
- Modify: `src/lib/ipc.ts`

**Interfaces:**
- Consumes: `layout.ts` (`Layout`, `allGroups`, `addTab`, `removeTerminal`).
- Produces (imported by Task 3 and 4):
  ```ts
  export interface SshConfig { host: string; cwd?: string | null }
  export interface ClaudeConfig { enabled: boolean; sessionId: string; skipPermissions: boolean; started: boolean }
  export interface TerminalSettings { ssh: SshConfig | null; claude: ClaudeConfig | null; command: string | null }
  export interface TerminalDef extends TerminalSettings { id: string; name: string; cwd: string }
  export interface Workspace { version: 1; terminals: TerminalDef[]; layout: Layout }
  export const EMPTY_SETTINGS: TerminalSettings;
  export function shellQuote(s: string): string;
  export function claudeLine(c: ClaudeConfig): string;
  export function startupLine(s: TerminalSettings): string | null;
  export function startupUsesClaude(s: TerminalSettings): boolean;   // true when the line came from the claude branch (not `command`)
  export function reconcileLayout(layout: Layout, ids: string[]): Layout;
  export function toWorkspace(input: { order: string[]; terminals: Record<string, { id: string; name: string; cwd: string }>; settings: Record<string, TerminalSettings>; layout: Layout }): Workspace;
  export function validateHost(host: string): string | null;         // error message or null
  // ipc
  ipc.loadWorkspace(): Promise<Workspace | null>
  ipc.saveWorkspace(workspace: Workspace): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addTab, splitWith, type GroupNode, type SplitNode } from "./layout";
import {
  EMPTY_SETTINGS,
  claudeLine,
  reconcileLayout,
  shellQuote,
  startupLine,
  startupUsesClaude,
  toWorkspace,
  validateHost,
  type ClaudeConfig,
} from "./workspace";

const claude: ClaudeConfig = { enabled: true, sessionId: "11111111-2222-3333-4444-555555555555", skipPermissions: false, started: false };

describe("shellQuote", () => {
  it("wraps in single quotes and escapes embedded single quotes", () => {
    expect(shellQuote("/proj")).toBe("'/proj'");
    expect(shellQuote("/a'b")).toBe("'/a'\\''b'");
  });
});

describe("claudeLine", () => {
  it("uses --session-id before the first run and --resume after", () => {
    expect(claudeLine(claude)).toBe(`claude --session-id ${claude.sessionId}`);
    expect(claudeLine({ ...claude, started: true })).toBe(`claude --resume ${claude.sessionId}`);
  });

  it("adds the skip-permissions flag before the session flag", () => {
    expect(claudeLine({ ...claude, skipPermissions: true })).toBe(
      `claude --dangerously-skip-permissions --session-id ${claude.sessionId}`,
    );
  });
});

describe("startupLine", () => {
  it("is null with no settings", () => {
    expect(startupLine(EMPTY_SETTINGS)).toBeNull();
    expect(startupLine({ ssh: null, claude: { ...claude, enabled: false }, command: null })).toBeNull();
  });

  it("ssh only", () => {
    expect(startupLine({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toBe("ssh -t me@host");
  });

  it("claude only", () => {
    expect(startupLine({ ...EMPTY_SETTINGS, claude })).toBe(`claude --session-id ${claude.sessionId}`);
  });

  it("ssh and claude with a remote cwd", () => {
    const line = startupLine({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null });
    expect(line).toBe(`ssh -t me@host ${shellQuote(`cd ${shellQuote("/proj")} && claude --session-id ${claude.sessionId}`)}`);
  });

  it("ssh and claude without a remote cwd", () => {
    const line = startupLine({ ssh: { host: "me@host" }, claude, command: null });
    expect(line).toBe(`ssh -t me@host ${shellQuote(`claude --session-id ${claude.sessionId}`)}`);
  });

  it("free-form command wins and is trimmed", () => {
    expect(startupLine({ ssh: { host: "me@host" }, claude, command: "  npm run dev  " })).toBe("npm run dev");
    expect(startupLine({ ...EMPTY_SETTINGS, command: "   " })).toBeNull();
  });
});

describe("startupUsesClaude", () => {
  it("is true only when the claude branch produced the line", () => {
    expect(startupUsesClaude({ ...EMPTY_SETTINGS, claude })).toBe(true);
    expect(startupUsesClaude({ ssh: { host: "h" }, claude, command: null })).toBe(true);
    expect(startupUsesClaude({ ssh: { host: "h" }, claude, command: "ls" })).toBe(false);
    expect(startupUsesClaude({ ...EMPTY_SETTINGS, ssh: { host: "h" } })).toBe(false);
  });
});

describe("validateHost", () => {
  it("rejects whitespace, quotes and empty", () => {
    expect(validateHost("me@host")).toBeNull();
    expect(validateHost("host.local")).toBeNull();
    expect(validateHost("")).not.toBeNull();
    expect(validateHost("me@host x")).not.toBeNull();
    expect(validateHost("me@'host'")).not.toBeNull();
  });
});

describe("reconcileLayout", () => {
  it("drops unknown ids, adds missing ids to the first group, and collapses", () => {
    let l = addTab(null, "a", null);
    l = addTab(l, "b", null);
    const g1 = (l as GroupNode).id;
    l = splitWith(l, g1, "b", "right", "g2");
    const out = reconcileLayout(l, ["a", "c"]);
    expect(out?.kind).toBe("group");
    expect((out as GroupNode).tabs).toEqual(["a", "c"]);
  });

  it("returns null when there are no ids and builds a root when the layout is null", () => {
    expect(reconcileLayout(addTab(null, "a", null), [])).toBeNull();
    const out = reconcileLayout(null, ["x", "y"]);
    expect((out as GroupNode).tabs).toEqual(["x", "y"]);
  });

  it("keeps a valid layout untouched", () => {
    let l = addTab(null, "a", null);
    l = addTab(l, "b", null);
    l = splitWith(l, (l as GroupNode).id, "b", "bottom", "g2");
    const out = reconcileLayout(l, ["a", "b"]);
    expect((out as SplitNode).children.length).toBe(2);
  });
});

describe("toWorkspace", () => {
  it("emits terminals in order with their settings", () => {
    const ws = toWorkspace({
      order: ["b", "a"],
      terminals: {
        a: { id: "a", name: "A", cwd: "/a" },
        b: { id: "b", name: "B", cwd: "/b" },
      },
      settings: { a: { ...EMPTY_SETTINGS, ssh: { host: "h" } } },
      layout: null,
    });
    expect(ws.version).toBe(1);
    expect(ws.terminals.map((t) => t.id)).toEqual(["b", "a"]);
    expect(ws.terminals[1].ssh).toEqual({ host: "h" });
    expect(ws.terminals[0].ssh).toBeNull();
    expect(ws.terminals[0].claude).toBeNull();
    expect(ws.terminals[0].command).toBeNull();
    expect(ws.layout).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test
```
Expected: cannot resolve `./workspace`.

- [ ] **Step 3: Implement `src/lib/workspace.ts`**

```ts
import { addTab, allGroups, removeTerminal, type Layout } from "./layout";

export interface SshConfig {
  host: string;
  cwd?: string | null;
}

export interface ClaudeConfig {
  enabled: boolean;
  sessionId: string;
  skipPermissions: boolean;
  started: boolean;
}

export interface TerminalSettings {
  ssh: SshConfig | null;
  claude: ClaudeConfig | null;
  command: string | null;
}

export interface TerminalDef extends TerminalSettings {
  id: string;
  name: string;
  cwd: string;
}

export interface Workspace {
  version: 1;
  terminals: TerminalDef[];
  layout: Layout;
}

export const EMPTY_SETTINGS: TerminalSettings = { ssh: null, claude: null, command: null };

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function claudeLine(c: ClaudeConfig): string {
  const parts = ["claude"];
  if (c.skipPermissions) parts.push("--dangerously-skip-permissions");
  parts.push(c.started ? "--resume" : "--session-id", c.sessionId);
  return parts.join(" ");
}

function trimmedCommand(s: TerminalSettings): string | null {
  const c = s.command?.trim();
  return c ? c : null;
}

export function startupUsesClaude(s: TerminalSettings): boolean {
  return trimmedCommand(s) === null && !!s.claude?.enabled;
}

export function startupLine(s: TerminalSettings): string | null {
  const command = trimmedCommand(s);
  if (command) return command;
  const claude = s.claude?.enabled ? claudeLine(s.claude) : null;
  const host = s.ssh?.host?.trim();
  if (host) {
    if (!claude) return `ssh -t ${host}`;
    const cd = s.ssh?.cwd ? `cd ${shellQuote(s.ssh.cwd)} && ` : "";
    return `ssh -t ${host} ${shellQuote(cd + claude)}`;
  }
  return claude;
}

export function validateHost(host: string): string | null {
  const h = host.trim();
  if (!h) return "host cannot be empty";
  if (/[\s'"`\\$]/.test(h)) return "host cannot contain spaces, quotes, backslashes or $";
  return null;
}

export function reconcileLayout(layout: Layout, ids: string[]): Layout {
  const wanted = new Set(ids);
  let out: Layout = layout;
  for (const present of allGroups(out).flatMap((g) => g.tabs)) {
    if (!wanted.has(present)) out = removeTerminal(out, present);
  }
  const placed = new Set(allGroups(out).flatMap((g) => g.tabs));
  for (const id of ids) {
    if (!placed.has(id)) out = addTab(out, id, null);
  }
  return out;
}

export function toWorkspace(input: {
  order: string[];
  terminals: Record<string, { id: string; name: string; cwd: string }>;
  settings: Record<string, TerminalSettings>;
  layout: Layout;
}): Workspace {
  const terminals: TerminalDef[] = input.order
    .filter((id) => input.terminals[id])
    .map((id) => {
      const t = input.terminals[id];
      const s = input.settings[id] ?? EMPTY_SETTINGS;
      return { id: t.id, name: t.name, cwd: t.cwd, ssh: s.ssh, claude: s.claude, command: s.command };
    });
  return { version: 1, terminals, layout: input.layout };
}
```

Note on `addTab(out, id, null)` when `out` is null: `addTab` creates the root group; subsequent ids go to the first group. That satisfies the "builds a root" test. `reconcileLayout(layout, [])` removes every terminal, and `removeTerminal` normalises to `null`.

- [ ] **Step 4: ipc wrappers**

In `src/lib/ipc.ts` add at the top `import type { Workspace } from "./workspace";` and inside `ipc`:

```ts
  loadWorkspace: () => invoke<Workspace | null>("load_workspace"),
  saveWorkspace: (workspace: Workspace) => invoke<void>("save_workspace", { workspace }),
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 34 + 15 = 49 passing, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspace.ts src/lib/workspace.test.ts src/lib/ipc.ts
git commit -m "feat(ui): workspace types, startup line composer, layout reconciliation"
```

---

### Task 3: Store persistence, restore, settings, and startup actions

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: Task 2 exports; `ipc.loadWorkspace/saveWorkspace/writeTerminal`; `homeDir` from `@tauri-apps/api/path`; `confirm` from `@tauri-apps/plugin-dialog`.
- Produces (used by Task 4):
  ```ts
  // new state
  settings: Record<string, TerminalSettings>;
  startupPending: Record<string, boolean>;
  startupNotes: Record<string, string>;
  persistError: string | null;
  persistenceReady: boolean;
  // new actions
  loadWorkspace(): Promise<void>;
  reloadWorkspace(): Promise<void>;
  updateSettings(id: string, patch: Partial<TerminalSettings>): void;
  runStartup(id: string): Promise<void>;
  skipStartup(id: string): void;
  dismissPersistError(): void;
  // module export for tests
  export const SAVE_DEBOUNCE_MS = 500;
  ```

- [ ] **Step 1: Extend the test mocks and add failing tests**

In `src/store.test.ts`, extend the `vi.mock("./lib/ipc", ...)` factory's `ipc` object with:

```ts
      loadWorkspace: vi.fn(async () => null),
      saveWorkspace: vi.fn(async () => {}),
```

Add two more mocks directly after it:

```ts
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
```

Extend the imports: `import { beforeSpawn, SAVE_DEBOUNCE_MS, useStore } from "./store";`, `import { ipc } from "./lib/ipc";` (add if not present), `import { EMPTY_SETTINGS, type Workspace } from "./lib/workspace";`, and `vi` already imported.

Extend the `beforeEach` `setState` with `settings: {}, startupPending: {}, startupNotes: {}, persistError: null, persistenceReady: true,` and add `vi.mocked(ipc.saveWorkspace).mockClear(); vi.mocked(ipc.loadWorkspace).mockResolvedValue(null); vi.mocked(ipc.createTerminal).mockClear();`.

Append these test blocks:

```ts
describe("persistence", () => {
  it("saves the workspace, debounced, after a change", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createTerminal("/tmp/a");
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ipc.saveWorkspace).toHaveBeenCalledTimes(1);
      const ws = vi.mocked(ipc.saveWorkspace).mock.calls[0][0] as Workspace;
      expect(ws.terminals.map((t) => t.id)).toEqual([id]);
      expect(ws.terminals[0].ssh).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not save before persistenceReady", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ persistenceReady: false });
      await useStore.getState().createTerminal("/tmp/a");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a save failure as persistError", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.saveWorkspace).mockRejectedValueOnce("disk full");
      await useStore.getState().createTerminal("/tmp/a");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      expect(useStore.getState().persistError).toContain("disk full");
      useStore.getState().dismissPersistError();
      expect(useStore.getState().persistError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadWorkspace", () => {
  const ws: Workspace = {
    version: 1,
    terminals: [
      { id: "t1", name: "one", cwd: "/tmp/one", ssh: null, claude: null, command: null },
      {
        id: "t2",
        name: "two",
        cwd: "/tmp/two",
        ssh: { host: "me@host", cwd: "/remote" },
        claude: { enabled: true, sessionId: "s2", skipPermissions: true, started: true },
        command: null,
      },
    ],
    layout: { kind: "split", id: "s", dir: "row", sizes: [50, 50], children: [
      { kind: "group", id: "g1", tabs: ["t1"], active: "t1" },
      { kind: "group", id: "g2", tabs: ["t2", "ghost"], active: "t2" },
    ] },
  };

  it("restores terminals with saved ids, settings, layout, and pending flags", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce(ws);
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.order).toEqual(["t1", "t2"]);
    expect(vi.mocked(ipc.createTerminal).mock.calls.map((c) => [c[0], c[1], c[4]])).toEqual([
      ["t1", "/tmp/one", "one"],
      ["t2", "/tmp/two", "two"],
    ]);
    expect(s.settings.t2.claude?.sessionId).toBe("s2");
    expect(s.startupPending).toEqual({ t1: false, t2: true });
    expect(s.layout?.kind).toBe("split");
    expect(findGroup(s.layout, "g2")?.tabs).toEqual(["t2"]);
    expect(s.persistenceReady).toBe(true);
    expect(s.focusedTerminalId).toBe("t1");
  });

  it("falls back to the home directory when a saved cwd is rejected", async () => {
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: "t1", name: "gone", cwd: "/no/such", ssh: null, claude: null, command: null }],
      layout: null,
    });
    vi.mocked(ipc.createTerminal).mockImplementationOnce(async () => {
      throw "/no/such is not a directory";
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.terminals.t1.cwd).toBe("/home/me");
    expect(s.startupNotes.t1).toContain("/no/such");
  });

  it("surfaces a load error and still becomes ready", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockRejectedValueOnce("workspace file was invalid and was moved to x");
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().persistError).toContain("moved to x");
    expect(useStore.getState().persistenceReady).toBe(true);
  });
});

describe("settings and startup", () => {
  it("updateSettings generates a session id when claude is enabled and marks pending", () => {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: EMPTY_SETTINGS },
      startupPending: { a: false },
    });
    useStore.getState().updateSettings("a", { claude: { enabled: true, sessionId: "", skipPermissions: false, started: false } });
    const s = useStore.getState();
    expect(s.settings.a.claude?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.startupPending.a).toBe(true);
    useStore.getState().updateSettings("a", { claude: null });
    expect(useStore.getState().startupPending.a).toBe(false);
  });

  it("runStartup writes the line, marks claude started, and clears pending", async () => {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: { ssh: null, claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false }, command: null } },
      startupPending: { a: true },
    });
    await useStore.getState().runStartup("a");
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", "claude --session-id sid\r");
    const s = useStore.getState();
    expect(s.settings.a.claude?.started).toBe(true);
    expect(s.startupPending.a).toBe(false);
    useStore.getState().skipStartup("a");
    expect(useStore.getState().startupPending.a).toBe(false);
  });

  it("restartTerminal re-marks pending when a startup line exists", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { ssh: { host: "h" } });
    useStore.getState().skipStartup(id);
    useStore.getState().markExited(id, 0);
    await useStore.getState().restartTerminal(id);
    expect(useStore.getState().startupPending[id]).toBe(true);
  });

  it("closeTerminal drops settings and pending entries", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { ssh: { host: "h" } });
    await useStore.getState().closeTerminal(id);
    expect(useStore.getState().settings[id]).toBeUndefined();
    expect(useStore.getState().startupPending[id]).toBeUndefined();
  });
});

describe("reloadWorkspace", () => {
  it("opens defs missing from the app and closes terminals missing from the file", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: "n1", name: "new", cwd: "/tmp/n", ssh: null, claude: null, command: null }],
      layout: null,
    });
    await useStore.getState().reloadWorkspace();
    const s = useStore.getState();
    expect(s.order).toEqual(["n1"]);
    expect(s.terminals[a]).toBeUndefined();
    expect(ipc.closeTerminal).toHaveBeenCalledWith(a);
  });
});
```

Add `findGroup` to the existing `./lib/layout` import in the test file if missing.

- [ ] **Step 2: Run to verify failure**

```bash
npm test
```
Expected: new tests fail (`SAVE_DEBOUNCE_MS` undefined, actions missing).

- [ ] **Step 3: Implement the store changes**

In `src/store.ts`:

Imports: add
```ts
import { homeDir } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  EMPTY_SETTINGS,
  reconcileLayout,
  startupLine,
  startupUsesClaude,
  toWorkspace,
  type TerminalSettings,
  type TerminalDef,
} from "./lib/workspace";
```
and `export const SAVE_DEBOUNCE_MS = 500;` after `DEFAULT_ROWS`.

State interface additions:
```ts
  settings: Record<string, TerminalSettings>;
  startupPending: Record<string, boolean>;
  startupNotes: Record<string, string>;
  persistError: string | null;
  persistenceReady: boolean;

  loadWorkspace(): Promise<void>;
  reloadWorkspace(): Promise<void>;
  updateSettings(id: string, patch: Partial<TerminalSettings>): void;
  runStartup(id: string): Promise<void>;
  skipStartup(id: string): void;
  dismissPersistError(): void;
```
Initial values: `settings: {}, startupPending: {}, startupNotes: {}, persistError: null, persistenceReady: false,`.

Helper above `useStore` (module scope):
```ts
function omit<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const out = { ...rec };
  delete out[id];
  return out;
}

async function spawnDef(def: TerminalDef): Promise<{ info: TerminalInfo; note: string | null }> {
  await beforeSpawn.hook(def.id);
  const dims = beforeSpawn.size(def.id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  try {
    return { info: await ipc.createTerminal(def.id, def.cwd, dims.cols, dims.rows, def.name), note: null };
  } catch (e) {
    const msg = typeof e === "string" ? e : String(e);
    if (!msg.includes("is not a directory")) throw e;
    const home = await homeDir();
    const info = await ipc.createTerminal(def.id, home, dims.cols, dims.rows, def.name);
    return { info, note: `${def.cwd} no longer exists; opened in ${home}` };
  }
}
```

`createTerminal`: in the `set`, add `settings: { ...s.settings, [info.id]: EMPTY_SETTINGS }, startupPending: { ...s.startupPending, [info.id]: false },`.

`closeTerminal`: in the `set`, add `settings: omit(s.settings, id), startupPending: omit(s.startupPending, id), startupNotes: omit(s.startupNotes, id),`.

`restartTerminal`: change the `set` to
```ts
    set((s) => ({
      terminals: { ...s.terminals, [id]: info },
      startupPending: { ...s.startupPending, [id]: startupLine(s.settings[id] ?? EMPTY_SETTINGS) !== null },
    }));
```

New actions (inside the `create` object):
```ts
  async loadWorkspace() {
    let ws: Awaited<ReturnType<typeof ipc.loadWorkspace>> = null;
    try {
      ws = await ipc.loadWorkspace();
    } catch (e) {
      set({ persistError: typeof e === "string" ? e : String(e), persistenceReady: true });
      return;
    }
    if (!ws) {
      set({ persistenceReady: true });
      return;
    }
    await openDefs(ws.terminals, ws.layout, set);
    set({ persistenceReady: true });
  },

  async reloadWorkspace() {
    let ws: Awaited<ReturnType<typeof ipc.loadWorkspace>> = null;
    try {
      ws = await ipc.loadWorkspace();
    } catch (e) {
      set({ persistError: typeof e === "string" ? e : String(e) });
      return;
    }
    if (!ws) {
      set({ persistError: "no workspace file found" });
      return;
    }
    const wanted = new Set(ws.terminals.map((t) => t.id));
    const toClose = useStore.getState().order.filter((id) => !wanted.has(id));
    if (toClose.length > 0) {
      const ok = await confirm(`Close ${toClose.length} terminal(s) that are not in workspace.json?`, { title: "Reload workspace" });
      if (!ok) return;
      for (const id of toClose) await useStore.getState().closeTerminal(id);
    }
    const open = new Set(useStore.getState().order);
    await openDefs(ws.terminals.filter((d) => !open.has(d.id)), ws.layout, set, ws.terminals);
  },

  updateSettings(id, patch) {
    set((s) => {
      const current = s.settings[id] ?? EMPTY_SETTINGS;
      const next: TerminalSettings = { ...current, ...patch };
      if (next.claude?.enabled && !next.claude.sessionId) {
        next.claude = { ...next.claude, sessionId: crypto.randomUUID() };
      }
      return {
        settings: { ...s.settings, [id]: next },
        startupPending: { ...s.startupPending, [id]: startupLine(next) !== null },
      };
    });
  },

  async runStartup(id) {
    const s = useStore.getState();
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    const line = startupLine(settings);
    if (!line) return;
    await ipc.writeTerminal(id, line + "\r");
    set((st) => {
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return {
        settings: { ...st.settings, [id]: { ...cur, claude } },
        startupPending: { ...st.startupPending, [id]: false },
      };
    });
  },

  skipStartup(id) {
    set((s) => ({ startupPending: { ...s.startupPending, [id]: false } }));
  },

  dismissPersistError() {
    set({ persistError: null });
  },
```

Module-scope `openDefs` (placed above `useStore`, after `spawnDef`); it opens the given defs sequentially, then applies settings, pending flags, notes, layout reconciliation and focus:
```ts
type SetState = (partial: Partial<WorkbenchState> | ((s: WorkbenchState) => Partial<WorkbenchState>)) => void;

async function openDefs(defs: TerminalDef[], savedLayout: Layout, set: SetState, allDefs: TerminalDef[] = defs) {
  for (const def of defs) {
    try {
      const { info, note } = await spawnDef(def);
      set((s) => ({
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        settings: { ...s.settings, [info.id]: { ssh: def.ssh ?? null, claude: def.claude ?? null, command: def.command ?? null } },
        startupNotes: note ? { ...s.startupNotes, [info.id]: note } : s.startupNotes,
        lastCwd: info.cwd,
      }));
    } catch (e) {
      set({ persistError: `could not open "${def.name}": ${typeof e === "string" ? e : String(e)}` });
    }
  }
  set((s) => {
    const settings = { ...s.settings };
    for (const def of allDefs) {
      if (s.terminals[def.id]) settings[def.id] = { ssh: def.ssh ?? null, claude: def.claude ?? null, command: def.command ?? null };
    }
    const layout = reconcileLayout(savedLayout, s.order);
    const startupPending: Record<string, boolean> = {};
    for (const id of s.order) startupPending[id] = startupLine(settings[id] ?? EMPTY_SETTINGS) !== null;
    const first = allGroups(layout)[0]?.active ?? null;
    return { settings, layout, startupPending, ...focusFor(layout, first) };
  });
}
```

Debounced save subscription at the bottom of `src/store.ts` (after `useStore` is created):
```ts
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const s = useStore.getState();
    ipc.saveWorkspace(toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout })).catch((e) => {
      useStore.setState({ persistError: `could not save workspace: ${typeof e === "string" ? e : String(e)}` });
    });
  }, SAVE_DEBOUNCE_MS);
}

useStore.subscribe((s, prev) => {
  if (!s.persistenceReady) return;
  if (s.terminals !== prev.terminals || s.order !== prev.order || s.layout !== prev.layout || s.settings !== prev.settings) {
    scheduleSave();
  }
});
```

`toWorkspace`'s `terminals` parameter accepts `Record<string, TerminalInfo>` structurally (it only reads id, name, cwd).

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: 49 + 11 = 60 passing, tsc clean. If the "restores terminals" test's focus assertion fails because `reconcileLayout` returns the split with `g1` first, check `focusFor(layout, first)` picks `allGroups(layout)[0].active` which is `t1`.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): workspace load/save, settings, startup actions in the store"
```

---

### Task 4: Settings panel, startup bar, reload button, load on mount, smoke

**Files:**
- Create: `src/components/TerminalSettings.tsx`
- Modify: `src/components/Sidebar.tsx`, `src/components/TerminalPane.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: store fields and actions from Task 3; `startupLine`, `validateHost`, `EMPTY_SETTINGS` from Task 2.
- Produces: the complete feature. Deviation from spec 5.3, ruled by the controller: the directory field in the settings panel is read-only (a live PTY cannot change cwd; close and create a new terminal instead).

- [ ] **Step 1: `TerminalSettings.tsx`**

```tsx
import { useState } from "react";
import { useStore } from "../store";
import { EMPTY_SETTINGS, startupLine, validateHost, type TerminalSettings as Settings } from "../lib/workspace";

export function TerminalSettings({ id, onClose }: { id: string; onClose: () => void }) {
  const info = useStore((s) => s.terminals[id]);
  const current = useStore((s) => s.settings[id] ?? EMPTY_SETTINGS);
  const updateSettings = useStore((s) => s.updateSettings);
  const renameTerminal = useStore((s) => s.renameTerminal);

  const [name, setName] = useState(info?.name ?? "");
  const [host, setHost] = useState(current.ssh?.host ?? "");
  const [remoteCwd, setRemoteCwd] = useState(current.ssh?.cwd ?? "");
  const [claudeOn, setClaudeOn] = useState(current.claude?.enabled ?? false);
  const [skip, setSkip] = useState(current.claude?.skipPermissions ?? false);
  const [command, setCommand] = useState(current.command ?? "");
  const [error, setError] = useState<string | null>(null);

  if (!info) return null;

  const draft: Settings = {
    ssh: host.trim() ? { host: host.trim(), cwd: remoteCwd.trim() || null } : null,
    claude: claudeOn
      ? { enabled: true, sessionId: current.claude?.sessionId ?? "", skipPermissions: skip, started: current.claude?.started ?? false }
      : current.claude
        ? { ...current.claude, enabled: false }
        : null,
    command: command.trim() || null,
  };
  const preview = startupLine({ ...draft, claude: draft.claude ? { ...draft.claude, sessionId: draft.claude.sessionId || "<new>" } : null });

  const save = async () => {
    if (host.trim()) {
      const hostErr = validateHost(host);
      if (hostErr) {
        setError(hostErr);
        return;
      }
    }
    if (name.trim() !== info.name) {
      const renameErr = await renameTerminal(id, name);
      if (renameErr) {
        setError(renameErr);
        return;
      }
    }
    updateSettings(id, draft);
    setError(null);
    onClose();
  };

  const field = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-blue-500";
  const label = "mt-2 block text-[10px] uppercase tracking-wide text-neutral-500";

  return (
    <div className="mx-1 mb-1 rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs" onClick={(e) => e.stopPropagation()}>
      <label className={label}>Name</label>
      <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      <label className={label}>Directory</label>
      <div className="truncate rounded border border-neutral-800 px-1.5 py-0.5 text-neutral-400" title="Close and create a new terminal to change the directory">
        {info.cwd}
      </div>
      <label className={label}>SSH host (optional)</label>
      <input className={field} placeholder="user@host" value={host} onChange={(e) => setHost(e.target.value)} />
      <label className={label}>Remote directory (optional)</label>
      <input className={field} placeholder="/path/on/remote" value={remoteCwd} onChange={(e) => setRemoteCwd(e.target.value)} disabled={!host.trim()} />
      <label className="mt-2 flex items-center gap-2 text-neutral-300">
        <input type="checkbox" checked={claudeOn} onChange={(e) => setClaudeOn(e.target.checked)} />
        Run Claude
      </label>
      <label className="mt-1 flex items-center gap-2 text-neutral-300">
        <input type="checkbox" checked={skip} disabled={!claudeOn} onChange={(e) => setSkip(e.target.checked)} />
        Skip permissions <span className="text-red-400">(dangerous)</span>
      </label>
      <label className={label}>Startup command (overrides the above)</label>
      <input className={field} placeholder="e.g. npm run dev" value={command} onChange={(e) => setCommand(e.target.value)} />
      <div className="mt-2 truncate font-mono text-[10px] text-neutral-500" title={preview ?? ""}>
        {preview ? `Runs: ${preview}` : "No startup command"}
      </div>
      {error && <div className="mt-1 text-red-400">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Sidebar changes**

In `src/components/Sidebar.tsx`:
- Import `TerminalSettings` from `./TerminalSettings`.
- In `Row`, add `const [settingsOpen, setSettingsOpen] = useState(false);` and, next to the close button (before it), a gear button:
  ```tsx
      <button
        className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          setSettingsOpen((v) => !v);
        }}
        title="Terminal settings"
      >
        ⚙
      </button>
  ```
  Wrap the row's returned element: return a fragment `<>{row}{settingsOpen && <TerminalSettings id={id} onClose={() => setSettingsOpen(false)} />}</>` where `row` is the existing `<div …>` element.
- In `Sidebar`, read `const reloadWorkspace = useStore((s) => s.reloadWorkspace); const persistError = useStore((s) => s.persistError); const dismiss = useStore((s) => s.dismissPersistError);`. In the header, before the `+` button, add:
  ```tsx
        <button
          className="rounded px-1.5 text-sm leading-none text-neutral-400 hover:bg-neutral-800"
          onClick={() => void reloadWorkspace()}
          title="Reload ~/.swarmz/workspace.json"
        >
          ↻
        </button>
  ```
  and after the existing `{error && …}` line add:
  ```tsx
      {persistError && (
        <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
          <span className="flex-1">{persistError}</span>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={dismiss} title="Dismiss">×</button>
        </div>
      )}
  ```

- [ ] **Step 3: Startup bar in `TerminalPane.tsx`**

Add imports: `import { EMPTY_SETTINGS, startupLine } from "../lib/workspace";`. Read from the store:
```tsx
  const pending = useStore((s) => s.startupPending[id] === true);
  const settings = useStore((s) => s.settings[id] ?? EMPTY_SETTINGS);
  const note = useStore((s) => s.startupNotes[id]);
  const runStartup = useStore((s) => s.runStartup);
  const skipStartup = useStore((s) => s.skipStartup);
  const line = startupLine(settings);
```
Render, inside the outer `div` before the terminal container div (so it overlays the top):
```tsx
      {pending && line && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-300">
          <span className="min-w-0 flex-1 truncate font-mono" title={line}>{line}</span>
          {note && <span className="truncate text-amber-300" title={note}>{note}</span>}
          <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void runStartup(id)}>Run</button>
          <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={() => skipStartup(id)}>Skip</button>
        </div>
      )}
```
Also change the terminal container to leave room when the bar shows: `className={`absolute inset-0 p-1 ${pending && line ? "pt-9" : ""}`}`.

- [ ] **Step 4: Load on mount in `App.tsx`**

Inside the existing `useEffect` (or a second one), add `void useStore.getState().loadWorkspace();` once on mount:
```tsx
  useEffect(() => {
    void useStore.getState().loadWorkspace();
  }, []);
```
Guard against React StrictMode's double invoke: in the store's `loadWorkspace`, return early if `useStore.getState().persistenceReady` is already true OR a module-level `let loading = false` flag is set; set it at the start. Add to the top of `loadWorkspace`:
```ts
    if (loadStarted) return;
    loadStarted = true;
```
with `let loadStarted = false;` at module scope in `store.ts`, and reset it in the test `beforeEach` via an exported `__resetLoadGuard()` helper: `export function __resetLoadGuard() { loadStarted = false; }`. Call it in `beforeEach`.

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run build && (cd src-tauri && cargo test)
```
Expected: 60 vitest, 18 cargo, tsc clean, build OK.

- [ ] **Step 6: Manual smoke (user)**

```
npm run tauri dev
```
1. Open two terminals, split them. Quit the app. `cat ~/.swarmz/workspace.json` shows both with the layout.
2. Relaunch: both tiles return in the same layout, no startup bars.
3. Gear on one row: set SSH host to your other Mac, enable Run Claude with Skip permissions, Save. A startup bar appears in that tile showing `ssh -t … 'claude --dangerously-skip-permissions --session-id …'`. Click Run; the ssh prompt appears.
4. Quit, relaunch: the bar shows `--resume` for that session. Click Skip; the bar hides.
5. Quit, edit the file by hand to rename a terminal, relaunch: the new name shows.
6. Break the file (delete a brace), relaunch: app starts empty with the amber notice; a `workspace.json.broken-…` file exists.

- [ ] **Step 7: Commit**

```bash
git add src/components/TerminalSettings.tsx src/components/Sidebar.tsx src/components/TerminalPane.tsx src/App.tsx src/store.ts src/store.test.ts
git commit -m "feat(ui): settings panel, startup bar, reload workspace, load on launch"
```

---

## Self-review notes

- Spec 5.3 directory field: read-only in the panel (ruled deviation; a live shell cannot change cwd).
- Spec 6 "duplicate id on restore": `spawnDef` throws on the core's DuplicateId error and `openDefs` records it as `persistError` while continuing with the other defs.
- Stage 2 will extend `claudeLine` in `workspace.ts` with the MCP flags; nothing else changes.
