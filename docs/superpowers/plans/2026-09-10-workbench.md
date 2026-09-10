# swarmz Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app with a sidebar of terminals on the left and a split tree of tab groups on the right, each tab a real PTY rendered with xterm.js.

**Architecture:** The Rust core owns the terminal registry (ids, names, cwds, exit state) and the PTY sessions, exposing Tauri commands and streaming output as events. The React frontend keeps a pure layout reducer (split tree of tab groups) in a zustand store, keeps one xterm.js instance per terminal in a module-level registry so it survives re-docking, and renders the tree with react-resizable-panels. Drag and drop uses native HTML5 drag events.

**Tech Stack:** Tauri 2.11, Rust 1.86, portable-pty 0.9, React 19, TypeScript 6, Vite 8, Tailwind 4, zustand 5, @xterm/xterm 6, @xterm/addon-fit 0.11, react-resizable-panels 4, vitest 4, @tauri-apps/plugin-dialog 2.

**Spec:** `docs/superpowers/specs/2026-09-10-swarmz-design.md` (sections 2, 3, 4, 8, 9 and stage 1 of section 10).

## Global Constraints

- macOS first. Shell is `$SHELL` (fallback `/bin/zsh`) launched with `-l`.
- Child env always contains `SWARMZ_TERMINAL_ID`, `SWARMZ_TERMINAL_NAME`, `TERM=xterm-256color`, `COLORTERM=truecolor`.
- Terminal names are unique; default is the cwd basename, then `-2`, `-3` on collision.
- A terminal lives in exactly one tab group at a time.
- One xterm.js instance per terminal, created once, never recreated on re-tab or re-dock.
- Events: `pty:data:<id>` carries a base64 string; `pty:exit:<id>` carries `{ code: number | null }`.
- Split sizes are percentages that sum to 100.
- Frontend generates terminal ids (`crypto.randomUUID()`) and registers event listeners before asking the core to spawn, so no output is lost.
- Commit after every task with a conventional-commit message. Do not commit `node_modules`, `dist`, `src-tauri/target`, or `src-tauri/gen`.

---

## File structure

```
swarmz/
  package.json                 deps + scripts (dev, build, test, tauri)
  vite.config.ts               Vite + React + Tailwind + vitest config
  index.html                   root div
  src/
    main.tsx                   React entry
    App.tsx                    Sidebar | Workbench shell
    index.css                  Tailwind + xterm css + base styles
    lib/
      layout.ts                pure split-tree reducer (no React, no Tauri)
      layout.test.ts           reducer tests
      ipc.ts                   typed wrappers over invoke/listen
      xtermRegistry.ts         one xterm instance per terminal id
    store.ts                   zustand store: terminals, layout, focus, drag
    store.test.ts              store tests with mocked ipc
    components/
      Sidebar.tsx              terminal list, new/rename/close, drag source
      Workbench.tsx            recursive split renderer + empty state
      TabGroup.tsx             tab bar, drop zones, active pane
      TerminalPane.tsx         mounts xterm, fit on resize, exit banner
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    src/
      main.rs                  calls swarmz_lib::run()
      lib.rs                   builder: plugins, state, command handler
      registry.rs              TerminalRegistry (pure, tested)
      pty.rs                   PtySession (portable-pty, tested)
      commands.rs              Tauri commands + AppState + event emission
```

---

### Task 1: Scaffold the Tauri app and install dependencies

**Files:**
- Create: everything from the `create-tauri-app` react-ts template
- Modify: `package.json`, `vite.config.ts`, `src/index.css`, `src/App.tsx`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `.gitignore`

**Interfaces:**
- Produces: a building app skeleton with all dependencies installed; `npm test` runs vitest; `cargo check` passes in `src-tauri`.

- [ ] **Step 1: Scaffold into the existing directory**

From the parent directory so the scaffolder targets `swarmz` (the `--force` flag allows the non-empty directory that already holds `docs/` and `.git/`):

```bash
cd /Volumes/ExternalSSD/projects
npx --yes create-tauri-app@latest swarmz -t react-ts -m npm -y --identifier dev.swarmz.app --force
cd swarmz
git status --short | head
```

Expected: new files `package.json`, `src/`, `src-tauri/`, `index.html`, `vite.config.ts`, `tsconfig.json`, `.gitignore`. `docs/` untouched.

- [ ] **Step 2: Replace `package.json`**

```json
{
  "name": "swarmz",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/xterm": "^6.0.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-resizable-panels": "^4.12.4",
    "zustand": "^5.0.15"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@tauri-apps/cli": "^2",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^6.0.2",
    "tailwindcss": "^4.1.0",
    "typescript": "~6.0.3",
    "vite": "^8.0.16",
    "vitest": "^4.0.0"
  }
}
```

Then:

```bash
npm install
```

- [ ] **Step 3: Replace `vite.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
```

- [ ] **Step 4: Replace styles and the App shell**

Delete `src/App.css` and `src/assets/react.svg`, `public/tauri.svg`, `public/vite.svg`.

`src/index.css`:

```css
@import "tailwindcss";
@import "@xterm/xterm/css/xterm.css";

html, body, #root {
  height: 100%;
  margin: 0;
  background: #0f1115;
  color: #d4d4d8;
  font-family: ui-sans-serif, system-ui, sans-serif;
  overflow: hidden;
}

.xterm { height: 100%; }
```

`src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`src/App.tsx` (placeholder, replaced in Task 9):

```tsx
export default function App() {
  return <div className="h-full flex items-center justify-center text-neutral-500">swarmz</div>;
}
```

- [ ] **Step 5: Rust manifest, config, capabilities, entry**

`src-tauri/Cargo.toml`:

```toml
[package]
name = "swarmz"
version = "0.1.0"
description = "Tiled terminal workbench for Claude Code agents"
authors = ["Martin O'Kane"]
edition = "2021"

[lib]
name = "swarmz_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
portable-pty = "0.9"
uuid = { version = "1", features = ["v4"] }
base64 = "0.22"

[profile.release]
codegen-units = 1
lto = true
opt-level = 3
panic = "abort"
strip = true
```

`src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "swarmz",
  "version": "0.1.0",
  "identifier": "dev.swarmz.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "swarmz",
        "width": 1400,
        "height": 900,
        "minWidth": 900,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

`src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "dialog:default"
  ]
}
```

`src-tauri/src/main.rs`:

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    swarmz_lib::run()
}
```

`src-tauri/src/lib.rs` (placeholder, extended in Task 4):

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 6: Verify everything builds**

```bash
npm run typecheck && npm run build
cd src-tauri && cargo check && cd ..
```

Expected: tsc clean, vite build writes `dist/`, cargo check finishes (first run downloads and compiles Tauri, several minutes).

- [ ] **Step 7: Confirm `.gitignore` and commit**

Ensure `.gitignore` contains `node_modules`, `dist`, and `src-tauri/.gitignore` contains `/target/` and `/gen/schemas` (the template provides these). Then:

```bash
git add -A
git commit -m "chore: scaffold Tauri + React workbench skeleton"
```

---

### Task 2: Terminal registry (Rust, pure)

**Files:**
- Create: `src-tauri/src/registry.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod registry;`)

**Interfaces:**
- Produces:
  ```rust
  pub struct TerminalInfo { pub id: String, pub name: String, pub cwd: String, pub exited: Option<i32>, pub error: Option<String> }
  pub enum RegistryError { DuplicateName(String), NotFound(String), EmptyName }
  impl TerminalRegistry {
      pub fn new() -> Self;
      pub fn list(&self) -> Vec<TerminalInfo>;
      pub fn get(&self, id: &str) -> Option<&TerminalInfo>;
      pub fn add(&mut self, id: String, requested_name: Option<String>, cwd: String) -> TerminalInfo;
      pub fn rename(&mut self, id: &str, name: &str) -> Result<TerminalInfo, RegistryError>;
      pub fn set_exited(&mut self, id: &str, code: Option<i32>, error: Option<String>);
      pub fn clear_exited(&mut self, id: &str);
      pub fn remove(&mut self, id: &str) -> Option<TerminalInfo>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/registry.rs` with only the test module for now:

```rust
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
```

Add `pub mod registry;` at the top of `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test registry
```

Expected: compile error, `TerminalRegistry` not found.

- [ ] **Step 3: Implement the registry**

Prepend to `src-tauri/src/registry.rs`:

```rust
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test registry
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/registry.rs src-tauri/src/lib.rs
git commit -m "feat(core): terminal registry with unique naming"
```

---

### Task 3: PTY session (Rust)

**Files:**
- Create: `src-tauri/src/pty.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod pty;`)

**Interfaces:**
- Produces:
  ```rust
  pub struct SpawnSpec { pub program: String, pub args: Vec<String>, pub cwd: String, pub env: Vec<(String, String)>, pub cols: u16, pub rows: u16 }
  impl PtySession {
      pub fn spawn(spec: SpawnSpec, on_data: impl Fn(Vec<u8>) + Send + 'static, on_exit: impl FnOnce(Option<i32>) + Send + 'static) -> Result<PtySession, String>;
      pub fn write(&self, bytes: &[u8]) -> Result<(), String>;
      pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
      pub fn kill(&self);
  }
  ```
  `PtySession` is `Send + Sync` (all handles behind mutexes). `on_data` is called from a reader thread, `on_exit` from a waiter thread, exactly once.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/pty.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn spec(program: &str, args: &[&str]) -> SpawnSpec {
        SpawnSpec {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: "/".into(),
            env: vec![("TERM".into(), "xterm-256color".into())],
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn captures_output_and_exit_code() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<i32>>();
        let session = PtySession::spawn(
            spec("/bin/sh", &["-c", "echo hello; exit 3"]),
            move |d| { let _ = tx.send(d); },
            move |c| { let _ = etx.send(c); },
        )
        .unwrap();
        let code = erx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(3));
        // rx.iter() ends when the reader thread drops tx.
        let out: Vec<u8> = rx.iter().flatten().collect();
        assert!(String::from_utf8_lossy(&out).contains("hello"));
        drop(session);
    }

    #[test]
    fn write_echoes_through_cat_and_kill_ends_it() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (etx, erx) = mpsc::channel::<Option<i32>>();
        let session = PtySession::spawn(
            spec("/bin/cat", &[]),
            move |d| { let _ = tx.send(d); },
            move |c| { let _ = etx.send(c); },
        )
        .unwrap();
        session.write(b"abc\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::new();
        while Instant::now() < deadline && !String::from_utf8_lossy(&out).contains("abc") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                out.extend(chunk);
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("abc"));
        session.resize(100, 30).unwrap();
        session.kill();
        assert!(erx.recv_timeout(Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn spawn_failure_is_an_error() {
        let result = PtySession::spawn(spec("/nonexistent/binary", &[]), |_| {}, |_| {});
        assert!(result.is_err());
    }
}
```

Add `pub mod pty;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test pty
```

Expected: compile error, `PtySession` not found.

- [ ] **Step 3: Implement the session**

Prepend to `src-tauri/src/pty.rs`:

```rust
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;

pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl PtySession {
    pub fn spawn(
        spec: SpawnSpec,
        on_data: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<PtySession, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn {} failed: {e}", spec.program))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer failed: {e}"))?;
        let killer = child.clone_killer();

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_data(buf[..n].to_vec()),
                }
            }
        });

        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            on_exit(code);
        });

        Ok(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        })
    }

    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|_| "writer poisoned".to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let m = self.master.lock().map_err(|_| "master poisoned".to_string())?;
        m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self) {
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test pty
```

Expected: 3 passed. If `spawn_failure_is_an_error` fails because portable-pty reports the exec failure through the child exit instead of `spawn_command`, change that test to assert that `on_exit` fires with a non-zero code within 5 seconds, and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs src-tauri/src/lib.rs
git commit -m "feat(core): PTY session over portable-pty"
```

---

### Task 4: Tauri commands, state, and events

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `registry::{TerminalRegistry, TerminalInfo}`, `pty::{PtySession, SpawnSpec}`.
- Produces Tauri commands (JS names in camelCase args):
  - `create_terminal(id: String, cwd: String, cols: u16, rows: u16, name: Option<String>) -> Result<TerminalInfo, String>`
  - `list_terminals() -> Vec<TerminalInfo>`
  - `write_terminal(id: String, data: String) -> Result<(), String>`
  - `resize_terminal(id: String, cols: u16, rows: u16) -> Result<(), String>`
  - `rename_terminal(id: String, name: String) -> Result<TerminalInfo, String>`
  - `close_terminal(id: String) -> Result<(), String>`
  - `restart_terminal(id: String, cols: u16, rows: u16) -> Result<TerminalInfo, String>`
- Events: `pty:data:<id>` payload base64 `String`; `pty:exit:<id>` payload `{ "code": number | null }`.

- [ ] **Step 1: Write `commands.rs`**

```rust
use crate::pty::{PtySession, SpawnSpec};
use crate::registry::{TerminalInfo, TerminalRegistry};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    pub registry: Mutex<TerminalRegistry>,
    pub sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    code: Option<i32>,
}

fn spawn_for(app: &AppHandle, state: &AppState, info: &TerminalInfo, cols: u16, rows: u16) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let spec = SpawnSpec {
        program: shell,
        args: vec!["-l".to_string()],
        cwd: info.cwd.clone(),
        env: vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("SWARMZ_TERMINAL_ID".into(), info.id.clone()),
            ("SWARMZ_TERMINAL_NAME".into(), info.name.clone()),
        ],
        cols,
        rows,
    };

    let data_app = app.clone();
    let data_topic = format!("pty:data:{}", info.id);
    let exit_app = app.clone();
    let exit_id = info.id.clone();

    let session = PtySession::spawn(
        spec,
        move |bytes| {
            let _ = data_app.emit(&data_topic, BASE64.encode(&bytes));
        },
        move |code| {
            if let Some(st) = exit_app.try_state::<AppState>() {
                st.registry.lock().unwrap().set_exited(&exit_id, code, None);
                st.sessions.lock().unwrap().remove(&exit_id);
            }
            let _ = exit_app.emit(&format!("pty:exit:{exit_id}"), ExitPayload { code });
        },
    )?;

    state.sessions.lock().unwrap().insert(info.id.clone(), Arc::new(session));
    Ok(())
}

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    name: Option<String>,
) -> Result<TerminalInfo, String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let info = state.registry.lock().unwrap().add(id, name, cwd);
    match spawn_for(&app, &state, &info, cols, rows) {
        Ok(()) => Ok(info),
        Err(e) => {
            let mut reg = state.registry.lock().unwrap();
            reg.set_exited(&info.id, Some(-1), Some(e));
            Ok(reg.get(&info.id).cloned().unwrap_or(info))
        }
    }
}

#[tauri::command]
pub fn list_terminals(state: State<'_, AppState>) -> Vec<TerminalInfo> {
    state.registry.lock().unwrap().list()
}

#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("terminal {id} is not running"))?;
    session.write(data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().get(&id).cloned();
    match session {
        Some(s) => s.resize(cols, rows),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn rename_terminal(state: State<'_, AppState>, id: String, name: String) -> Result<TerminalInfo, String> {
    state.registry.lock().unwrap().rename(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().remove(&id) {
        session.kill();
    }
    state.registry.lock().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
pub fn restart_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let info = {
        let mut reg = state.registry.lock().unwrap();
        let current = reg.get(&id).cloned().ok_or_else(|| format!("no terminal with id {id}"))?;
        if current.exited.is_none() {
            return Err("terminal is still running".to_string());
        }
        reg.clear_exited(&id);
        reg.get(&id).cloned().unwrap()
    };
    match spawn_for(&app, &state, &info, cols, rows) {
        Ok(()) => Ok(info),
        Err(e) => {
            let mut reg = state.registry.lock().unwrap();
            reg.set_exited(&id, Some(-1), Some(e));
            Ok(reg.get(&id).cloned().unwrap())
        }
    }
}
```

- [ ] **Step 2: Wire into `lib.rs`**

Replace `src-tauri/src/lib.rs` with:

```rust
pub mod commands;
pub mod pty;
pub mod registry;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::list_terminals,
            commands::write_terminal,
            commands::resize_terminal,
            commands::rename_terminal,
            commands::close_terminal,
            commands::restart_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify it compiles and existing tests still pass**

```bash
cd src-tauri && cargo test
```

Expected: 8 passed, no warnings about unused imports (remove `Manager` from the `use` line if the compiler says it is unused; it is needed for `try_state`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(core): terminal commands and PTY events"
```

---

### Task 5: Layout reducer (pure TypeScript)

**Files:**
- Create: `src/lib/layout.ts`, `src/lib/layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TerminalId = string;
  export type SplitDir = "row" | "col";
  export type Side = "left" | "right" | "top" | "bottom";
  export interface GroupNode { kind: "group"; id: string; tabs: TerminalId[]; active: TerminalId }
  export interface SplitNode { kind: "split"; id: string; dir: SplitDir; children: LayoutNode[]; sizes: number[] }
  export type LayoutNode = GroupNode | SplitNode;
  export type Layout = LayoutNode | null;
  export function newNodeId(prefix?: string): string;
  export function findGroup(layout: Layout, groupId: string): GroupNode | null;
  export function findGroupOf(layout: Layout, termId: TerminalId): GroupNode | null;
  export function allGroups(layout: Layout): GroupNode[];
  export function addTab(layout: Layout, termId: TerminalId, groupId: string | null): Layout;
  export function setActive(layout: Layout, groupId: string, termId: TerminalId): Layout;
  export function removeTerminal(layout: Layout, termId: TerminalId): Layout;
  export function moveToGroup(layout: Layout, termId: TerminalId, groupId: string): Layout;
  export function splitWith(layout: Layout, targetGroupId: string, termId: TerminalId, side: Side, newGroupId?: string): Layout;
  export function resizeSplit(layout: Layout, splitId: string, sizes: number[]): Layout;
  ```
  All functions are pure and return new trees. `sizes` always sum to 100.

- [ ] **Step 1: Write the failing tests**

`src/lib/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addTab,
  allGroups,
  findGroup,
  findGroupOf,
  moveToGroup,
  removeTerminal,
  resizeSplit,
  setActive,
  splitWith,
  type GroupNode,
  type Layout,
  type SplitNode,
} from "./layout";

function group(layout: Layout, termId: string): GroupNode {
  const g = findGroupOf(layout, termId);
  if (!g) throw new Error(`no group holds ${termId}`);
  return g;
}

describe("addTab", () => {
  it("creates a root group when the layout is empty", () => {
    const l = addTab(null, "t1", null);
    expect(l?.kind).toBe("group");
    expect((l as GroupNode).tabs).toEqual(["t1"]);
    expect((l as GroupNode).active).toBe("t1");
  });

  it("appends to the named group and activates the new tab", () => {
    let l = addTab(null, "t1", null);
    const gid = (l as GroupNode).id;
    l = addTab(l, "t2", gid);
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect((l as GroupNode).active).toBe("t2");
  });

  it("falls back to the first group when groupId is unknown", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", "nope");
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
  });

  it("only activates when the terminal is already placed", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t1", null);
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect((l as GroupNode).active).toBe("t1");
  });
});

describe("splitWith", () => {
  it("splits a group to the right into a row split with two halves", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g-new");
    const s = l as SplitNode;
    expect(s.kind).toBe("split");
    expect(s.dir).toBe("row");
    expect(s.sizes).toEqual([50, 50]);
    expect((s.children[0] as GroupNode).id).toBe(gid);
    expect((s.children[0] as GroupNode).tabs).toEqual(["t1"]);
    expect((s.children[1] as GroupNode).id).toBe("g-new");
    expect((s.children[1] as GroupNode).tabs).toEqual(["t2"]);
  });

  it("puts the new group first for left and top", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "top", "g-new");
    const s = l as SplitNode;
    expect(s.dir).toBe("col");
    expect((s.children[0] as GroupNode).id).toBe("g-new");
  });

  it("inserts as a sibling when the parent split already has that direction", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = splitWith(l, "g2", "t3", "right", "g3");
    const s = l as SplitNode;
    expect(s.children.map((c) => (c as GroupNode).id)).toEqual([gid, "g2", "g3"]);
    expect(s.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(s.sizes).toEqual([50, 25, 25]);
  });

  it("nests when the direction differs", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = splitWith(l, "g2", "t3", "bottom", "g3");
    const root = l as SplitNode;
    expect(root.dir).toBe("row");
    const inner = root.children[1] as SplitNode;
    expect(inner.kind).toBe("split");
    expect(inner.dir).toBe("col");
    expect(inner.children.map((c) => (c as GroupNode).id)).toEqual(["g2", "g3"]);
  });

  it("is a no-op when splitting a single-tab group with its own tab", () => {
    const l = addTab(null, "t1", null);
    const gid = (l as GroupNode).id;
    expect(splitWith(l, gid, "t1", "right", "g-new")).toBe(l);
  });

  it("moves a terminal out of another group, collapsing it if empty", () => {
    let l = addTab(null, "t1", null);
    const g1 = (l as GroupNode).id;
    l = splitWith(l, g1, "t1", "right", "g2"); // no-op
    l = addTab(l, "t2", g1);
    l = splitWith(l, g1, "t2", "right", "g2");
    l = splitWith(l, g1, "t2", "bottom", "g3"); // take t2 out of g2 (now empty) and split g1 vertically
    const root = l as SplitNode;
    expect(root.dir).toBe("col");
    expect(allGroups(l).map((g) => g.id)).toEqual([g1, "g3"]);
    expect(findGroup(l, "g2")).toBeNull();
  });
});

describe("removeTerminal", () => {
  it("removes a tab and picks a neighbour as active", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    l = setActive(l, (l as GroupNode).id, "t2");
    l = removeTerminal(l, "t2");
    expect((l as GroupNode).tabs).toEqual(["t1", "t3"]);
    expect((l as GroupNode).active).toBe("t3");
  });

  it("collapses an empty group and flattens a single-child split", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = removeTerminal(l, "t2");
    expect(l?.kind).toBe("group");
    expect((l as GroupNode).id).toBe(gid);
    expect((l as GroupNode).tabs).toEqual(["t1"]);
  });

  it("returns null when the last terminal is removed", () => {
    const l = addTab(null, "t1", null);
    expect(removeTerminal(l, "t1")).toBeNull();
  });

  it("renormalises sibling sizes after a collapse", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = splitWith(l, "g2", "t3", "right", "g3"); // sizes 50/25/25
    l = removeTerminal(l, "t3");
    const s = l as SplitNode;
    expect(s.children.length).toBe(2);
    expect(s.sizes[0]).toBeCloseTo(66.667, 2);
    expect(s.sizes[1]).toBeCloseTo(33.333, 2);
  });
});

describe("moveToGroup", () => {
  it("moves a tab between groups and activates it", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t3", "right", "g2");
    l = moveToGroup(l, "t2", "g2");
    expect(group(l, "t2").id).toBe("g2");
    expect(findGroup(l, "g2")?.tabs).toEqual(["t3", "t2"]);
    expect(findGroup(l, "g2")?.active).toBe("t2");
    expect(findGroup(l, gid)?.tabs).toEqual(["t1"]);
  });

  it("just activates when moving within the same group", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = moveToGroup(l, "t1", gid);
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect((l as GroupNode).active).toBe("t1");
  });

  it("ignores an unknown target group", () => {
    const l = addTab(null, "t1", null);
    expect(moveToGroup(l, "t1", "nope")).toBe(l);
  });
});

describe("resizeSplit", () => {
  it("replaces sizes and normalises them to 100", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    const sid = (l as SplitNode).id;
    l = resizeSplit(l, sid, [30, 90]);
    expect((l as SplitNode).sizes).toEqual([25, 75]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: fails to resolve `./layout`.

- [ ] **Step 3: Implement the reducer**

`src/lib/layout.ts`:

```ts
export type TerminalId = string;
export type SplitDir = "row" | "col";
export type Side = "left" | "right" | "top" | "bottom";

export interface GroupNode {
  kind: "group";
  id: string;
  tabs: TerminalId[];
  active: TerminalId;
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: SplitDir;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = GroupNode | SplitNode;
export type Layout = LayoutNode | null;

let counter = 0;
export function newNodeId(prefix = "n"): string {
  counter += 1;
  return `${prefix}${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function findGroup(layout: Layout, groupId: string): GroupNode | null {
  return allGroups(layout).find((g) => g.id === groupId) ?? null;
}

export function findGroupOf(layout: Layout, termId: TerminalId): GroupNode | null {
  return allGroups(layout).find((g) => g.tabs.includes(termId)) ?? null;
}

export function allGroups(layout: Layout): GroupNode[] {
  if (!layout) return [];
  if (layout.kind === "group") return [layout];
  return layout.children.flatMap((c) => allGroups(c));
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((s) => (s / total) * 100);
}

function normalize(node: LayoutNode): LayoutNode | null {
  if (node.kind === "group") return node.tabs.length === 0 ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const n = normalize(child);
    if (n) {
      kept.push(n);
      sizes.push(node.sizes[i] ?? 0);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept, sizes: normalizeSizes(sizes) };
}

function updateGroup(node: LayoutNode, groupId: string, f: (g: GroupNode) => GroupNode): LayoutNode {
  if (node.kind === "group") return node.id === groupId ? f(node) : node;
  return { ...node, children: node.children.map((c) => updateGroup(c, groupId, f)) };
}

export function addTab(layout: Layout, termId: TerminalId, groupId: string | null): Layout {
  if (!layout) return { kind: "group", id: newNodeId("g"), tabs: [termId], active: termId };
  const existing = findGroupOf(layout, termId);
  if (existing) return setActive(layout, existing.id, termId);
  const target = (groupId && findGroup(layout, groupId)) || allGroups(layout)[0];
  return updateGroup(layout, target.id, (g) => ({ ...g, tabs: [...g.tabs, termId], active: termId }));
}

export function setActive(layout: Layout, groupId: string, termId: TerminalId): Layout {
  if (!layout) return layout;
  return updateGroup(layout, groupId, (g) => (g.tabs.includes(termId) ? { ...g, active: termId } : g));
}

export function removeTerminal(layout: Layout, termId: TerminalId): Layout {
  if (!layout) return null;
  const strip = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      const idx = node.tabs.indexOf(termId);
      if (idx === -1) return node;
      const tabs = node.tabs.filter((t) => t !== termId);
      const active = node.active === termId ? (tabs[Math.min(idx, tabs.length - 1)] ?? "") : node.active;
      return { ...node, tabs, active };
    }
    return { ...node, children: node.children.map(strip) };
  };
  return normalize(strip(layout));
}

export function moveToGroup(layout: Layout, termId: TerminalId, groupId: string): Layout {
  const target = findGroup(layout, groupId);
  if (!layout || !target) return layout;
  const current = findGroupOf(layout, termId);
  if (current?.id === groupId) return setActive(layout, groupId, termId);
  const without = removeTerminal(layout, termId);
  return addTab(without, termId, groupId);
}

function insertBeside(node: LayoutNode, targetId: string, fresh: GroupNode, dir: SplitDir, before: boolean): LayoutNode {
  if (node.kind === "group") {
    if (node.id !== targetId) return node;
    const children = before ? [fresh, node] : [node, fresh];
    return { kind: "split", id: newNodeId("s"), dir, children, sizes: [50, 50] };
  }
  const idx = node.children.findIndex((c) => c.kind === "group" && c.id === targetId);
  if (idx !== -1 && node.dir === dir) {
    const children = [...node.children];
    const sizes = [...node.sizes];
    const half = sizes[idx] / 2;
    sizes[idx] = half;
    const insertAt = before ? idx : idx + 1;
    children.splice(insertAt, 0, fresh);
    sizes.splice(insertAt, 0, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, targetId, fresh, dir, before)) };
}

export function splitWith(
  layout: Layout,
  targetGroupId: string,
  termId: TerminalId,
  side: Side,
  newGroupId: string = newNodeId("g"),
): Layout {
  if (!layout) return addTab(layout, termId, null);
  const target = findGroup(layout, targetGroupId);
  if (!target) return layout;
  if (target.tabs.length === 1 && target.tabs[0] === termId) return layout;
  const without = removeTerminal(layout, termId);
  if (!without) return addTab(null, termId, null);
  const fresh: GroupNode = { kind: "group", id: newGroupId, tabs: [termId], active: termId };
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  return insertBeside(without, targetGroupId, fresh, dir, before);
}

export function resizeSplit(layout: Layout, splitId: string, sizes: number[]): Layout {
  if (!layout) return layout;
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, sizes: normalizeSizes(sizes) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(layout);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: 17 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/layout.ts src/lib/layout.test.ts
git commit -m "feat(ui): split-tree layout reducer"
```

---

### Task 6: IPC wrappers and zustand store

**Files:**
- Create: `src/lib/ipc.ts`, `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: Tauri commands from Task 4, reducer from Task 5.
- Produces:
  ```ts
  // ipc.ts
  export interface TerminalInfo { id: string; name: string; cwd: string; exited: number | null; error: string | null }
  export const ipc: {
    createTerminal(id: string, cwd: string, cols: number, rows: number, name?: string): Promise<TerminalInfo>;
    listTerminals(): Promise<TerminalInfo[]>;
    writeTerminal(id: string, data: string): Promise<void>;
    resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
    renameTerminal(id: string, name: string): Promise<TerminalInfo>;
    closeTerminal(id: string): Promise<void>;
    restartTerminal(id: string, cols: number, rows: number): Promise<TerminalInfo>;
    onData(id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn>;
    onExit(id: string, cb: (code: number | null) => void): Promise<UnlistenFn>;
  };
  // store.ts
  export interface WorkbenchState {
    terminals: Record<string, TerminalInfo>;
    order: string[];
    layout: Layout;
    focusedGroupId: string | null;
    focusedTerminalId: string | null;
    draggingTerminalId: string | null;
    lastCwd: string | null;
    createTerminal(cwd: string): Promise<string>;
    closeTerminal(id: string): Promise<void>;
    restartTerminal(id: string): Promise<void>;
    renameTerminal(id: string, name: string): Promise<string | null>; // returns error message or null
    markExited(id: string, code: number | null): void;
    focusTerminal(id: string): void;
    focusGroup(groupId: string): void;
    moveTerminal(id: string, groupId: string): void;
    splitTerminal(id: string, targetGroupId: string, side: Side): void;
    resizeSplit(splitId: string, sizes: number[]): void;
    setDragging(id: string | null): void;
  }
  export const useStore: UseBoundStore<StoreApi<WorkbenchState>>;
  export const beforeSpawn: { hook: (id: string) => Promise<void> };
  ```
  `beforeSpawn.hook` is called with the new id before `ipc.createTerminal`; Task 7 sets it to register xterm listeners. Default is a no-op.

- [ ] **Step 1: Write `ipc.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  exited: number | null;
  error: string | null;
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const ipc = {
  createTerminal: (id: string, cwd: string, cols: number, rows: number, name?: string) =>
    invoke<TerminalInfo>("create_terminal", { id, cwd, cols, rows, name: name ?? null }),
  listTerminals: () => invoke<TerminalInfo[]>("list_terminals"),
  writeTerminal: (id: string, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", { id, cols, rows }),
  renameTerminal: (id: string, name: string) => invoke<TerminalInfo>("rename_terminal", { id, name }),
  closeTerminal: (id: string) => invoke<void>("close_terminal", { id }),
  restartTerminal: (id: string, cols: number, rows: number) =>
    invoke<TerminalInfo>("restart_terminal", { id, cols, rows }),
  onData: (id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
    listen<string>(`pty:data:${id}`, (e) => cb(base64ToBytes(e.payload))),
  onExit: (id: string, cb: (code: number | null) => void): Promise<UnlistenFn> =>
    listen<{ code: number | null }>(`pty:exit:${id}`, (e) => cb(e.payload.code)),
};
```

- [ ] **Step 2: Write the failing store tests**

`src/store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo } from "./lib/ipc";

vi.mock("./lib/ipc", () => {
  const info = (id: string, cwd: string, name?: string): TerminalInfo => ({
    id,
    name: name ?? cwd.split("/").pop() ?? "shell",
    cwd,
    exited: null,
    error: null,
  });
  return {
    ipc: {
      createTerminal: vi.fn(async (id: string, cwd: string) => info(id, cwd)),
      listTerminals: vi.fn(async () => []),
      writeTerminal: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}),
      renameTerminal: vi.fn(async (id: string, name: string) => {
        if (name === "dupe") throw 'a terminal named "dupe" already exists';
        return info(id, "/tmp/x", name);
      }),
      closeTerminal: vi.fn(async () => {}),
      restartTerminal: vi.fn(async (id: string) => info(id, "/tmp/x")),
      onData: vi.fn(async () => () => {}),
      onExit: vi.fn(async () => () => {}),
    },
  };
});

import { beforeSpawn, useStore } from "./store";
import { findGroup, findGroupOf, type GroupNode, type SplitNode } from "./lib/layout";

beforeEach(() => {
  useStore.setState({
    terminals: {},
    order: [],
    layout: null,
    focusedGroupId: null,
    focusedTerminalId: null,
    draggingTerminalId: null,
    lastCwd: null,
  });
  beforeSpawn.hook = async () => {};
});

describe("createTerminal", () => {
  it("adds the terminal, places it in the focused group, and focuses it", async () => {
    const id1 = await useStore.getState().createTerminal("/tmp/a");
    const s1 = useStore.getState();
    expect(s1.order).toEqual([id1]);
    expect(s1.terminals[id1].cwd).toBe("/tmp/a");
    expect(s1.layout?.kind).toBe("group");
    expect(s1.focusedTerminalId).toBe(id1);
    expect(s1.focusedGroupId).toBe((s1.layout as GroupNode).id);
    expect(s1.lastCwd).toBe("/tmp/a");

    const id2 = await useStore.getState().createTerminal("/tmp/b");
    const s2 = useStore.getState();
    expect((s2.layout as GroupNode).tabs).toEqual([id1, id2]);
    expect(s2.focusedTerminalId).toBe(id2);
  });

  it("runs the beforeSpawn hook with the id before spawning", async () => {
    const seen: string[] = [];
    beforeSpawn.hook = async (id) => {
      seen.push(id);
    };
    const id = await useStore.getState().createTerminal("/tmp/a");
    expect(seen).toEqual([id]);
  });
});

describe("closeTerminal and markExited", () => {
  it("removes the terminal from state and layout", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    await useStore.getState().closeTerminal(id);
    const s = useStore.getState();
    expect(s.order).toEqual([]);
    expect(s.layout).toBeNull();
    expect(s.focusedTerminalId).toBeNull();
  });

  it("markExited records the exit code", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().markExited(id, 2);
    expect(useStore.getState().terminals[id].exited).toBe(2);
    await useStore.getState().restartTerminal(id);
    expect(useStore.getState().terminals[id].exited).toBeNull();
  });
});

describe("renameTerminal", () => {
  it("returns null on success and the error message on failure", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    expect(await useStore.getState().renameTerminal(id, "api")).toBeNull();
    expect(useStore.getState().terminals[id].name).toBe("api");
    expect(await useStore.getState().renameTerminal(id, "dupe")).toContain("already exists");
    expect(useStore.getState().terminals[id].name).toBe("api");
  });
});

describe("layout actions", () => {
  it("splitTerminal, moveTerminal and focusTerminal keep focus consistent", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const g1 = (useStore.getState().layout as GroupNode).id;
    useStore.getState().splitTerminal(b, g1, "right");
    let s = useStore.getState();
    expect(s.layout?.kind).toBe("split");
    const g2 = findGroupOf(s.layout, b)!.id;
    expect(s.focusedGroupId).toBe(g2);
    expect(s.focusedTerminalId).toBe(b);

    useStore.getState().focusTerminal(a);
    s = useStore.getState();
    expect(s.focusedGroupId).toBe(g1);
    expect(s.focusedTerminalId).toBe(a);

    useStore.getState().moveTerminal(a, g2);
    s = useStore.getState();
    expect(s.layout?.kind).toBe("group");
    expect(findGroup(s.layout, g2)?.tabs).toEqual([b, a]);
    expect(s.focusedGroupId).toBe(g2);
    expect(s.focusedTerminalId).toBe(a);
  });

  it("resizeSplit updates sizes", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    void a;
    const g1 = (useStore.getState().layout as GroupNode).id;
    useStore.getState().splitTerminal(b, g1, "right");
    const sid = (useStore.getState().layout as SplitNode).id;
    useStore.getState().resizeSplit(sid, [70, 30]);
    expect((useStore.getState().layout as SplitNode).sizes).toEqual([70, 30]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test
```

Expected: `./store` cannot be resolved.

- [ ] **Step 4: Implement the store**

`src/store.ts`:

```ts
import { create } from "zustand";
import { ipc, type TerminalInfo } from "./lib/ipc";
import {
  addTab,
  allGroups,
  findGroupOf,
  moveToGroup,
  removeTerminal,
  resizeSplit as resizeSplitNode,
  setActive,
  splitWith,
  type Layout,
  type Side,
} from "./lib/layout";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const beforeSpawn: { hook: (id: string) => Promise<void> } = {
  hook: async () => {},
};

export interface WorkbenchState {
  terminals: Record<string, TerminalInfo>;
  order: string[];
  layout: Layout;
  focusedGroupId: string | null;
  focusedTerminalId: string | null;
  draggingTerminalId: string | null;
  lastCwd: string | null;

  createTerminal(cwd: string): Promise<string>;
  closeTerminal(id: string): Promise<void>;
  restartTerminal(id: string): Promise<void>;
  renameTerminal(id: string, name: string): Promise<string | null>;
  markExited(id: string, code: number | null): void;
  focusTerminal(id: string): void;
  focusGroup(groupId: string): void;
  moveTerminal(id: string, groupId: string): void;
  splitTerminal(id: string, targetGroupId: string, side: Side): void;
  resizeSplit(splitId: string, sizes: number[]): void;
  setDragging(id: string | null): void;
}

function focusFor(layout: Layout, termId: string | null) {
  if (!termId) return { focusedGroupId: null, focusedTerminalId: null };
  const g = findGroupOf(layout, termId);
  return { focusedGroupId: g?.id ?? null, focusedTerminalId: g ? termId : null };
}

export const useStore = create<WorkbenchState>((set) => ({
  terminals: {},
  order: [],
  layout: null,
  focusedGroupId: null,
  focusedTerminalId: null,
  draggingTerminalId: null,
  lastCwd: null,

  async createTerminal(cwd) {
    const id = crypto.randomUUID();
    await beforeSpawn.hook(id);
    const info = await ipc.createTerminal(id, cwd, DEFAULT_COLS, DEFAULT_ROWS);
    set((s) => {
      const layout = addTab(s.layout, info.id, s.focusedGroupId);
      return {
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        layout,
        lastCwd: cwd,
        ...focusFor(layout, info.id),
      };
    });
    return info.id;
  },

  async closeTerminal(id) {
    await ipc.closeTerminal(id);
    set((s) => {
      const terminals = { ...s.terminals };
      delete terminals[id];
      const layout = removeTerminal(s.layout, id);
      const stillFocused = s.focusedTerminalId && s.focusedTerminalId !== id ? s.focusedTerminalId : null;
      const fallback = stillFocused ?? findGroupOf(layout, s.order.find((t) => t !== id) ?? "")?.active ?? null;
      return {
        terminals,
        order: s.order.filter((t) => t !== id),
        layout,
        ...focusFor(layout, fallback),
      };
    });
  },

  async restartTerminal(id) {
    const info = await ipc.restartTerminal(id, DEFAULT_COLS, DEFAULT_ROWS);
    set((s) => ({ terminals: { ...s.terminals, [id]: info } }));
  },

  async renameTerminal(id, name) {
    try {
      const info = await ipc.renameTerminal(id, name);
      set((s) => ({ terminals: { ...s.terminals, [id]: info } }));
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  markExited(id, code) {
    set((s) => {
      const t = s.terminals[id];
      if (!t) return {};
      return { terminals: { ...s.terminals, [id]: { ...t, exited: code ?? -1 } } };
    });
  },

  focusTerminal(id) {
    set((s) => {
      const g = findGroupOf(s.layout, id);
      if (!g) return {};
      const layout = setActive(s.layout, g.id, id);
      return { layout, focusedGroupId: g.id, focusedTerminalId: id };
    });
  },

  focusGroup(groupId) {
    set((s) => {
      const group = allGroups(s.layout).find((g) => g.id === groupId);
      return { focusedGroupId: groupId, focusedTerminalId: group?.active ?? null };
    });
  },

  moveTerminal(id, groupId) {
    set((s) => {
      const layout = moveToGroup(s.layout, id, groupId);
      return { layout, ...focusFor(layout, id) };
    });
  },

  splitTerminal(id, targetGroupId, side) {
    set((s) => {
      const layout = splitWith(s.layout, targetGroupId, id, side);
      return { layout, ...focusFor(layout, id) };
    });
  },

  resizeSplit(splitId, sizes) {
    set((s) => ({ layout: resizeSplitNode(s.layout, splitId, sizes) }));
  },

  setDragging(id) {
    set({ draggingTerminalId: id });
  },
}));
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test && npm run typecheck
```

Expected: 24 passed (17 layout + 7 store), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ipc.ts src/store.ts src/store.test.ts
git commit -m "feat(ui): ipc wrappers and workbench store"
```

---

### Task 7: xterm registry and TerminalPane

**Files:**
- Create: `src/lib/xtermRegistry.ts`, `src/components/TerminalPane.tsx`

**Interfaces:**
- Consumes: `ipc`, `useStore`, `beforeSpawn` from Task 6.
- Produces:
  ```ts
  // xtermRegistry.ts
  export function prepare(id: string): Promise<void>;          // creates xterm + listeners; resolves when listeners are live
  export function attach(id: string, container: HTMLElement): { term: Terminal; fit: FitAddon };
  export function fitAndFocus(id: string): void;
  export function dispose(id: string): void;
  // TerminalPane.tsx
  export function TerminalPane({ id }: { id: string }): JSX.Element;
  ```

- [ ] **Step 1: Write `xtermRegistry.ts`**

```ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { beforeSpawn, useStore } from "../store";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  ready: Promise<void>;
  unlisten: UnlistenFn[];
  opened: boolean;
}

const entries = new Map<string, Entry>();

function createEntry(id: string): Entry {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: "#0f1115",
      foreground: "#d4d4d8",
      cursor: "#d4d4d8",
      selectionBackground: "#3b4252",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((data) => {
    void ipc.writeTerminal(id, data);
  });
  term.onResize(({ cols, rows }) => {
    void ipc.resizeTerminal(id, cols, rows);
  });

  const entry: Entry = { term, fit, ready: Promise.resolve(), unlisten: [], opened: false };
  entry.ready = Promise.all([
    ipc.onData(id, (bytes) => term.write(bytes)),
    ipc.onExit(id, (code) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code ?? "unknown"}]\x1b[0m\r\n`);
      useStore.getState().markExited(id, code);
    }),
  ]).then((fns) => {
    entry.unlisten = fns;
  });
  entries.set(id, entry);
  return entry;
}

export function prepare(id: string): Promise<void> {
  const entry = entries.get(id) ?? createEntry(id);
  return entry.ready;
}

export function attach(id: string, container: HTMLElement): { term: Terminal; fit: FitAddon } {
  const entry = entries.get(id) ?? createEntry(id);
  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
  } else if (entry.term.element && entry.term.element.parentElement !== container) {
    container.appendChild(entry.term.element);
  }
  return { term: entry.term, fit: entry.fit };
}

export function fitAndFocus(id: string): void {
  const entry = entries.get(id);
  if (!entry || !entry.opened) return;
  try {
    entry.fit.fit();
  } catch {
    // container not laid out yet; the ResizeObserver will retry
  }
  entry.term.focus();
}

export function dispose(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.unlisten.forEach((fn) => fn());
  entry.term.dispose();
  entries.delete(id);
}

beforeSpawn.hook = prepare;
```

- [ ] **Step 2: Write `TerminalPane.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { attach, fitAndFocus } from "../lib/xtermRegistry";

export function TerminalPane({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.terminals[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  const restart = useStore((s) => s.restartTerminal);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { fit } = attach(id, el);
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // ignore fit errors during layout thrash
        }
      });
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    refit();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [id]);

  useEffect(() => {
    if (focused) fitAndFocus(id);
  }, [focused, id]);

  return (
    <div className="relative h-full w-full bg-[#0f1115]">
      <div ref={ref} className="absolute inset-0 p-1" />
      {info?.exited !== null && info?.exited !== undefined && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-neutral-900/95 px-3 py-2 text-sm text-neutral-300 border-t border-neutral-700">
          <span>
            Process exited with code {info.exited}
            {info.error ? `: ${info.error}` : ""}
          </span>
          <button
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
            onClick={() => void restart(id)}
          >
            Restart shell
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and build**

```bash
npm run typecheck && npm run build
```

Expected: clean. (`xtermRegistry` is not yet imported by the app; that happens in Task 8. Vite may tree-shake it; that is fine for this step.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/xtermRegistry.ts src/components/TerminalPane.tsx
git commit -m "feat(ui): xterm registry and terminal pane"
```

---

### Task 8: TabGroup and Workbench (splits + drag and drop)

**Files:**
- Create: `src/components/TabGroup.tsx`, `src/components/Workbench.tsx`

**Interfaces:**
- Consumes: `useStore`, `TerminalPane`, layout types.
- Produces: `Workbench(): JSX.Element` rendering the whole right-hand area. Drag payload MIME type is `application/x-swarmz-terminal` and the id is also mirrored in `draggingTerminalId` in the store (WebKit only exposes `getData` on drop).

- [ ] **Step 1: Write `TabGroup.tsx`**

```tsx
import { useState, type DragEvent } from "react";
import type { GroupNode, Side } from "../lib/layout";
import { useStore } from "../store";
import { TerminalPane } from "./TerminalPane";

export const DRAG_MIME = "application/x-swarmz-terminal";

export function startTerminalDrag(e: DragEvent, id: string) {
  e.dataTransfer.setData(DRAG_MIME, id);
  e.dataTransfer.effectAllowed = "move";
  useStore.getState().setDragging(id);
}

export function endTerminalDrag() {
  useStore.getState().setDragging(null);
}

const ZONES: { side: Side; className: string }[] = [
  { side: "left", className: "left-0 top-0 h-full w-1/4" },
  { side: "right", className: "right-0 top-0 h-full w-1/4" },
  { side: "top", className: "left-1/4 top-0 h-1/4 w-1/2" },
  { side: "bottom", className: "left-1/4 bottom-0 h-1/4 w-1/2" },
];

export function TabGroup({ group }: { group: GroupNode }) {
  const terminals = useStore((s) => s.terminals);
  const focusedGroupId = useStore((s) => s.focusedGroupId);
  const dragging = useStore((s) => s.draggingTerminalId);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const focusGroup = useStore((s) => s.focusGroup);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const moveTerminal = useStore((s) => s.moveTerminal);
  const splitTerminal = useStore((s) => s.splitTerminal);
  const [hoverZone, setHoverZone] = useState<Side | "center" | null>(null);

  const isFocused = focusedGroupId === group.id;
  const showZones = dragging !== null && !(group.tabs.length === 1 && group.tabs[0] === dragging);

  const allowDrop = (e: DragEvent) => {
    if (dragging) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const dropOnTabs = (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_MIME) || dragging;
    if (id) moveTerminal(id, group.id);
    endTerminalDrag();
    setHoverZone(null);
  };

  const dropOnZone = (side: Side | "center") => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(DRAG_MIME) || dragging;
    if (id) {
      if (side === "center") moveTerminal(id, group.id);
      else splitTerminal(id, group.id, side);
    }
    endTerminalDrag();
    setHoverZone(null);
  };

  return (
    <div
      className={`flex h-full w-full flex-col ${isFocused ? "ring-1 ring-inset ring-blue-500/40" : ""}`}
      onMouseDown={() => focusGroup(group.id)}
    >
      <div
        className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-neutral-800 bg-neutral-900"
        onDragOver={allowDrop}
        onDrop={dropOnTabs}
      >
        {group.tabs.map((id) => {
          const t = terminals[id];
          const active = group.active === id;
          return (
            <div
              key={id}
              draggable
              onDragStart={(e) => startTerminalDrag(e, id)}
              onDragEnd={endTerminalDrag}
              onClick={() => focusTerminal(id)}
              className={`group flex cursor-default select-none items-center gap-2 border-r border-neutral-800 px-3 text-xs ${
                active ? "bg-[#0f1115] text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${t?.exited !== null && t?.exited !== undefined ? "bg-neutral-600" : "bg-emerald-500"}`} />
              <span className="max-w-[160px] truncate">{t?.name ?? id}</span>
              <button
                className="ml-1 rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTerminal(id);
                }}
                title="Close"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalPane key={group.active} id={group.active} />
        {showZones && (
          <div className="absolute inset-0 z-10" onDragOver={allowDrop} onDrop={dropOnZone("center")}>
            {ZONES.map(({ side, className }) => (
              <div
                key={side}
                className={`absolute ${className} ${hoverZone === side ? "bg-blue-500/30" : "bg-blue-500/5"} transition-colors`}
                onDragOver={(e) => {
                  allowDrop(e);
                  setHoverZone(side);
                }}
                onDragLeave={() => setHoverZone(null)}
                onDrop={dropOnZone(side)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `Workbench.tsx`**

```tsx
import { Fragment } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { LayoutNode } from "../lib/layout";
import { useStore } from "../store";
import { TabGroup } from "./TabGroup";

function Node({ node }: { node: LayoutNode }) {
  const resizeSplit = useStore((s) => s.resizeSplit);
  if (node.kind === "group") return <TabGroup group={node} />;

  const horizontal = node.dir === "row";
  const key = node.children.map((c) => c.id).join("|");
  return (
    <Group
      key={key}
      orientation={horizontal ? "horizontal" : "vertical"}
      className="h-full w-full"
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        resizeSplit(
          node.id,
          node.children.map((c) => layout[c.id] ?? 0),
        );
      }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <Separator
              className={`${horizontal ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"} bg-neutral-800 transition-colors hover:bg-blue-500 data-[resize-handle-active]:bg-blue-500`}
            />
          )}
          <Panel id={child.id} defaultSize={`${node.sizes[i]}`} minSize="10">
            <Node node={child} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

export function Workbench() {
  const layout = useStore((s) => s.layout);
  if (!layout) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        No terminals yet. Click + in the sidebar to open one.
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <Node node={layout} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and build**

```bash
npm run typecheck && npm run build
```

Expected: clean. If `onLayoutChanged`'s second argument is typed differently in the installed version, check `node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts` for `LayoutChangedMeta` and adjust the parameter annotation only.

- [ ] **Step 4: Commit**

```bash
git add src/components/TabGroup.tsx src/components/Workbench.tsx
git commit -m "feat(ui): tab groups, split rendering, drag and drop"
```

---

### Task 9: Sidebar, App shell, and end-to-end smoke

**Files:**
- Create: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useStore`, `startTerminalDrag`/`endTerminalDrag` from `TabGroup.tsx`, `open` from `@tauri-apps/plugin-dialog`.
- Produces: the complete stage 1 app.

- [ ] **Step 1: Write `Sidebar.tsx`**

```tsx
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { endTerminalDrag, startTerminalDrag } from "./TabGroup";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function Row({ id }: { id: string }) {
  const t = useStore((s) => s.terminals[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!t) return null;
  const exited = t.exited !== null;

  const commit = async () => {
    const err = await renameTerminal(id, draft);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setEditing(false);
  };

  return (
    <div
      draggable={!editing}
      onDragStart={(e) => startTerminalDrag(e, id)}
      onDragEnd={endTerminalDrag}
      onClick={() => focusTerminal(id)}
      onDoubleClick={() => {
        setDraft(t.name);
        setEditing(true);
      }}
      className={`group flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm ${
        focused ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
      }`}
      title={t.cwd}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${exited ? "bg-neutral-600" : "bg-emerald-500"}`} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
                if (e.key === "Escape") {
                  setEditing(false);
                  setError(null);
                }
              }}
              onBlur={() => void commit()}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-1 text-sm text-neutral-100 outline-none focus:border-blue-500"
            />
            {error && <div className="mt-0.5 text-xs text-red-400">{error}</div>}
          </div>
        ) : (
          <>
            <div className="truncate">{t.name}</div>
            <div className="truncate text-xs text-neutral-500">{basename(t.cwd)}</div>
          </>
        )}
      </div>
      <button
        className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          void closeTerminal(id);
        }}
        title="Close terminal"
      >
        ×
      </button>
    </div>
  );
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const lastCwd = useStore((s) => s.lastCwd);
  const createTerminal = useStore((s) => s.createTerminal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTerminal = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await open({ directory: true, multiple: false, defaultPath: lastCwd ?? undefined });
      if (typeof picked === "string") await createTerminal(picked);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex h-8 items-center justify-between border-b border-neutral-800 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <span>Terminals</span>
        <button
          className="rounded px-2 text-base leading-none text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          onClick={() => void addTerminal()}
          disabled={busy}
          title="New terminal"
        >
          +
        </button>
      </div>
      {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {order.map((id) => (
          <Row key={id} id={id} />
        ))}
        {order.length === 0 && <div className="px-2 py-4 text-xs text-neutral-500">No terminals</div>}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Replace `App.tsx`**

```tsx
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import "./lib/xtermRegistry";

export default function App() {
  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <Workbench />
      </main>
    </div>
  );
}
```

The side-effect import of `xtermRegistry` installs the `beforeSpawn` hook before any terminal is created.

- [ ] **Step 3: Full automated check**

```bash
npm test && npm run typecheck && npm run build
cd src-tauri && cargo test && cd ..
```

Expected: all green.

- [ ] **Step 4: Manual smoke (run by a human, or by the agent if a display is available)**

```bash
npm run tauri dev
```

Check each item:
1. Window opens with the sidebar and the empty-state message.
2. Click `+`, pick a directory. A tab appears, a shell prompt renders, typing `ls` works, colours render.
3. Add a second terminal. It appears as a second tab in the same group.
4. Drag the second tab onto the right edge of the pane. The area splits into two panes side by side. Drag the separator; both terminals refit (run `tput cols` to confirm).
5. Drag a sidebar row onto the other group's tab bar. It moves there.
6. Double-click a sidebar row, rename it to the other terminal's name. An inline error appears. Rename to something unique; it applies.
7. Type `exit` in a terminal. The banner appears with code 0. Click Restart shell; a fresh prompt appears in the same pane.
8. Close all terminals. The empty state returns.

Record any failures as follow-up items in the commit message body, then fix them before finishing the task.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx
git commit -m "feat(ui): sidebar and app shell; workbench stage 1 complete"
```

---

## Self-review notes

- Spec 4.1 sidebar status dot and one-line task come from the ledger (stage 2); stage 1 shows a running/exited dot and the cwd basename in that slot.
- Spec 4.3 pane header "Launch Claude" button is stage 2; the tab bar carries name and close in stage 1.
- Spec 4.4 Ledger panel is stage 2.
- Spec 3.1 `pty:exit` and registry `exited` state, 4.2 rules, 4.3 single xterm instance, 8 error handling (spawn failure, exit banner, duplicate name), and 9 reducer tests are all covered above.
- Spec 4.3 says inactive tabs stay mounted and hidden with CSS. The implementation renders only the active tab and re-parents the xterm element via the registry; scrollback and state survive because the Terminal object lives in `xtermRegistry`. Revisit if the smoke test shows scroll-position glitches after re-docking.
