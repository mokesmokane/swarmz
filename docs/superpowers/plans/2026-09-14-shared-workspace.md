# swarmz Shared Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workspace file syncs between the user's tailnet Macs by itself (newest revision wins), and a terminal that was local on another Mac opens here as a remote terminal to that Mac in the same folder.

**Architecture:** The file gains `sync { revision, updatedAt, updatedBy }` and per-terminal `origin`. A Rust `sync` module pulls/pushes the file over ssh (shared ControlPath, BatchMode) and reports the local file's mtime. The store bumps `sync` on every save, pushes after saving, pulls from online peers on launch/focus/every 30 s, polls the local mtime every 5 s to notice pushes, and adopts a newer copy with reload semantics (no confirm). A pure `openingFor` decides how each def opens (local / remote / foreign local), and `toWorkspace` writes foreign locals back unchanged.

**Tech Stack:** unchanged.

**Spec:** `docs/superpowers/specs/2026-09-14-shared-workspace-design.md`

## Global Constraints

- `sync.revision` bumps only on local saves; adoption never bumps. Newer = higher `revision`, then later `updatedAt`.
- Foreign local (no `ssh`, `origin` ≠ self): PTY in `$HOME`, in-memory `ssh = { host: machineHost(origin, machines[origin], user), cwd: def.cwd, machine: origin }`, `settings.foreign = { cwd: def.cwd }`; written back as `ssh: null, cwd: def.cwd, origin`.
- Self = `tailscale.self.name`; with Tailscale off, sync is off and nothing else changes.
- Pull: `ssh -o ControlPath=~/.swarmz/ssh/%C -o ControlMaster=auto -o ControlPersist=10m -o BatchMode=yes -o ConnectTimeout=5 <host> 'cat ~/.swarmz/workspace.json'`, 10 s timeout. Push: same options, remote `mkdir -p ~/.swarmz && cat > ~/.swarmz/workspace.json.sync && mv -f ~/.swarmz/workspace.json.sync ~/.swarmz/workspace.json`, file contents on stdin.
- Adoption is skipped while a save is pending or another adoption is in progress. Adoption closes local terminals absent from the newer file without a confirm.
- Cadence: pull on launch (after local load), on window focus, every 30 s; local mtime check every 5 s.
- Commit after every task with a conventional-commit message ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014xUXNbx7voeP3tRbbRR67s
  ```
- Never commit `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`, `.superpowers`.

---

## File structure

```
src-tauri/src/remote.rs             run_with_timeout gains an optional stdin payload
src-tauri/src/sync.rs               pull/push/stat + pure command builders and classifier (tested)
src-tauri/src/commands.rs           workspace_pull, workspace_push, workspace_stat
src-tauri/src/lib.rs                register + `pub mod sync;`
src/lib/workspace.ts                SyncMeta, origin/foreign on settings, isNewer, pickNewest, bumpSync, openingFor, toWorkspace write-back
src/lib/workspace.test.ts
src/lib/ipc.ts                      workspacePull, workspacePush, workspaceStat
src/store.ts                        selfMachine, syncMeta, sync status; origin stamping; foreign opening; save bump + push; pull/adopt; mtime check
src/store.test.ts
src/components/Sidebar.tsx          sync status line; foreign local row line
src/App.tsx                         pull/stat/focus loops
```

---

### Task 1: Rust sync module

**Files:**
- Create: `src-tauri/src/sync.rs`
- Modify: `src-tauri/src/remote.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- `remote.rs`: `pub(crate) fn run_with_timeout_input(cmd: Command, timeout: Duration, program: &str, input: Option<&[u8]>) -> Result<Finished, String>`; existing `run_with_timeout` delegates with `None`.
- Commands: `workspace_pull(host: String) -> Result<Option<String>, String>`, `workspace_push(host: String, contents: String) -> Result<(), String>`, `workspace_stat() -> Result<Option<u64>, String>` (mtime in ms).

- [ ] **Step 1: Failing tests**

Create `src-tauri/src/sync.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_strings_are_exact() {
        assert_eq!(PULL_COMMAND, "cat ~/.swarmz/workspace.json");
        assert_eq!(
            PUSH_COMMAND,
            "mkdir -p ~/.swarmz && cat > ~/.swarmz/workspace.json.sync && mv -f ~/.swarmz/workspace.json.sync ~/.swarmz/workspace.json"
        );
    }

    #[test]
    fn classify_pull_maps_missing_file_to_none() {
        assert_eq!(classify_pull(Some(0), "{}", "").unwrap(), Some("{}".to_string()));
        assert_eq!(classify_pull(Some(1), "", "cat: /Users/x/.swarmz/workspace.json: No such file or directory").unwrap(), None);
        assert!(classify_pull(Some(255), "", "ssh: connect to host x port 22: Connection refused").unwrap_err().contains("not reachable"));
        assert!(classify_pull(Some(1), "", "Permission denied").is_err());
    }

    #[test]
    fn stdin_payload_reaches_the_child() {
        let path = std::env::temp_dir().join(format!("swarmz-sync-test-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut cmd = std::process::Command::new("sh");
        cmd.arg("-c").arg(format!("cat > {}", path.display()));
        let done = crate::remote::run_with_timeout_input(cmd, std::time::Duration::from_secs(5), "sh", Some(b"hello sync")).unwrap();
        assert!(done.status.success());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello sync");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stat_of_missing_file_is_none_and_existing_file_has_mtime() {
        let dir = std::env::temp_dir().join(format!("swarmz-stat-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("workspace.json");
        assert_eq!(stat_mtime_ms(&file).unwrap(), None);
        std::fs::write(&file, "{}").unwrap();
        assert!(stat_mtime_ms(&file).unwrap().unwrap() > 1_600_000_000_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

Add `pub mod sync;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run to verify failure**

```bash
cd src-tauri && cargo test sync
```
Expected: compile error.

- [ ] **Step 3: Implement**

In `src-tauri/src/remote.rs`, rename the existing `run_with_timeout` body into:

```rust
pub(crate) fn run_with_timeout_input(mut cmd: Command, timeout: Duration, program: &str, input: Option<&[u8]>) -> Result<Finished, String> {
    let mut child = cmd
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if let Some(bytes) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let bytes = bytes.to_vec();
            std::thread::spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(&bytes);
            });
        }
    }
    // … the existing reader threads, poll loop, timeout/kill and join logic, unchanged …
}

pub(crate) fn run_with_timeout(cmd: Command, timeout: Duration, program: &str) -> Result<Finished, String> {
    run_with_timeout_input(cmd, timeout, program, None)
}
```
(keep the existing drain/kill/join code inside `run_with_timeout_input`; only the spawn line and the stdin block change).

Prepend to `src-tauri/src/sync.rs`:

```rust
use crate::remote::{run_with_timeout, run_with_timeout_input, validate_host, CONTROL_PATH};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

pub const PULL_COMMAND: &str = "cat ~/.swarmz/workspace.json";
pub const PUSH_COMMAND: &str =
    "mkdir -p ~/.swarmz && cat > ~/.swarmz/workspace.json.sync && mv -f ~/.swarmz/workspace.json.sync ~/.swarmz/workspace.json";

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

pub fn classify_pull(code: Option<i32>, stdout: &str, stderr: &str) -> Result<Option<String>, String> {
    match code {
        Some(0) => Ok(Some(stdout.to_string())),
        Some(255) => Err(format!("not reachable: {}", stderr.trim())),
        _ if stderr.contains("No such file") => Ok(None),
        Some(c) => Err(if stderr.trim().is_empty() { format!("remote read failed (exit {c})") } else { stderr.trim().to_string() }),
        None => Err("ssh was terminated".into()),
    }
}

pub fn pull(host: &str) -> Result<Option<String>, String> {
    let host = validate_host(host)?;
    let mut cmd = ssh_command(&host)?;
    cmd.arg(PULL_COMMAND);
    let done = run_with_timeout(cmd, Duration::from_secs(10), "ssh")?;
    classify_pull(done.status.code(), &done.stdout, &done.stderr)
}

pub fn push(host: &str, contents: &str) -> Result<(), String> {
    let host = validate_host(host)?;
    let mut cmd = ssh_command(&host)?;
    cmd.arg(PUSH_COMMAND);
    let done = run_with_timeout_input(cmd, Duration::from_secs(10), "ssh", Some(contents.as_bytes()))?;
    if done.status.success() {
        Ok(())
    } else if done.status.code() == Some(255) {
        Err(format!("not reachable: {}", done.stderr.trim()))
    } else {
        Err(if done.stderr.trim().is_empty() { "remote write failed".into() } else { done.stderr.trim().to_string() })
    }
}

pub fn stat_mtime_ms(path: &Path) -> Result<Option<u64>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta.modified().map_err(|e| e.to_string())?;
            let ms = modified.duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
            Ok(Some(ms))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn stat_local() -> Result<Option<u64>, String> {
    stat_mtime_ms(&crate::workspace::default_path())
}
```
`validate_host` and `CONTROL_PATH` in `remote.rs` must be `pub` (they are `pub fn`/`pub const` already; confirm) and `ensure_ssh_dir` is `pub`.

Commands (append to `commands.rs`):

```rust
#[tauri::command]
pub async fn workspace_pull(host: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::sync::pull(&host)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_push(host: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::sync::push(&host, &contents)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_stat() -> Result<Option<u64>, String> {
    tauri::async_runtime::spawn_blocking(crate::sync::stat_local).await.map_err(|e| e.to_string())?
}
```
Register all three in `lib.rs`.

- [ ] **Step 4: Verify**

```bash
cd src-tauri && cargo test
```
Expected: 41 passed (37 + 4), no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(core): workspace pull/push over ssh and local mtime stat"
```

---

### Task 2: Sync model, opening rules, write-back, ipc

**Files:**
- Modify: `src/lib/workspace.ts`, `src/lib/workspace.test.ts`, `src/lib/ipc.ts`

**Interfaces:**
```ts
export interface SyncMeta { revision: number; updatedAt: string; updatedBy: string }
// TerminalSettings gains: origin?: string | null; foreign?: { cwd: string } | null   (foreign is never persisted)
// Workspace gains: sync?: SyncMeta
export function isNewer(a: SyncMeta | undefined | null, b: SyncMeta | undefined | null): boolean; // a strictly newer than b
export function pickNewest(cands: Workspace[]): Workspace | null;
export function bumpSync(prev: SyncMeta | undefined | null, self: string, now?: string): SyncMeta;
export function openingFor(def: TerminalDef, self: string | null, machines: Machines, defaultUser: string): { cwd: string | null; settings: TerminalSettings }; // cwd null = $HOME
// toWorkspace input gains sync?: SyncMeta | null; writes origin, foreign write-back, sync
// ipc: workspacePull(host): Promise<string | null>; workspacePush(host, contents): Promise<void>; workspaceStat(): Promise<number | null>
```

- [ ] **Step 1: Tests** (append to `src/lib/workspace.test.ts`; extend imports)

```ts
describe("sync meta", () => {
  const a = { revision: 3, updatedAt: "2026-01-02T00:00:00Z", updatedBy: "a" };
  const b = { revision: 3, updatedAt: "2026-01-01T00:00:00Z", updatedBy: "b" };
  it("isNewer compares revision then updatedAt and treats missing as oldest", () => {
    expect(isNewer(a, b)).toBe(true);
    expect(isNewer(b, a)).toBe(false);
    expect(isNewer({ ...b, revision: 4 }, a)).toBe(true);
    expect(isNewer(a, undefined)).toBe(true);
    expect(isNewer(undefined, a)).toBe(false);
    expect(isNewer(a, a)).toBe(false);
  });
  it("pickNewest returns the newest candidate or null", () => {
    const w = (sync: SyncMeta | undefined): Workspace => ({ version: 1, terminals: [], layout: null, ...(sync ? { sync } : {}) });
    expect(pickNewest([])).toBeNull();
    expect(pickNewest([w(b), w(a), w(undefined)])?.sync).toEqual(a);
  });
  it("bumpSync increments and stamps", () => {
    expect(bumpSync(undefined, "me", "t1")).toEqual({ revision: 1, updatedAt: "t1", updatedBy: "me" });
    expect(bumpSync(a, "me", "t2")).toEqual({ revision: 4, updatedAt: "t2", updatedBy: "me" });
  });
});

describe("openingFor", () => {
  const machines: Machines = { desk: { user: "root", color: "#ef4444", lastUsed: "t" } };
  const base = { id: "t", name: "n", cwd: "/proj", ssh: null, claude: null, command: null };
  it("remote defs open unchanged", () => {
    const def = { ...base, ssh: { host: "me@x", cwd: "/r", machine: "x" }, origin: "elsewhere" };
    const o = openingFor(def, "here", machines, "mokes");
    expect(o.cwd).toBeNull();
    expect(o.settings.ssh).toEqual(def.ssh);
    expect(o.settings.foreign).toBeUndefined();
  });
  it("locals from here or without origin open locally", () => {
    expect(openingFor({ ...base, origin: "here" }, "here", machines, "mokes").cwd).toBe("/proj");
    expect(openingFor(base, "here", machines, "mokes").cwd).toBe("/proj");
    expect(openingFor({ ...base, origin: "desk" }, null, machines, "mokes").cwd).toBe("/proj");
  });
  it("locals from another machine open as foreign remotes", () => {
    const o = openingFor({ ...base, origin: "desk", claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true } }, "here", machines, "mokes");
    expect(o.cwd).toBeNull();
    expect(o.settings.ssh).toEqual({ host: "root@desk", cwd: "/proj", machine: "desk" });
    expect(o.settings.foreign).toEqual({ cwd: "/proj" });
    expect(o.settings.origin).toBe("desk");
    expect(o.settings.claude?.sessionId).toBe("s");
  });
});

describe("toWorkspace with sync and foreign locals", () => {
  it("writes origin and sync, and writes a foreign local back unchanged", () => {
    const ws = toWorkspace({
      order: ["f", "l"],
      terminals: { f: { id: "f", name: "F", cwd: "/home/me" }, l: { id: "l", name: "L", cwd: "/here" } },
      settings: {
        f: { ...EMPTY_SETTINGS, origin: "desk", foreign: { cwd: "/proj" }, ssh: { host: "root@desk", cwd: "/proj", machine: "desk" } },
        l: { ...EMPTY_SETTINGS, origin: "here" },
      },
      layout: null,
      machines: {},
      sync: { revision: 7, updatedAt: "t", updatedBy: "here" },
    });
    expect(ws.sync).toEqual({ revision: 7, updatedAt: "t", updatedBy: "here" });
    expect(ws.terminals[0]).toMatchObject({ id: "f", cwd: "/proj", ssh: null, origin: "desk" });
    expect("foreign" in ws.terminals[0]).toBe(false);
    expect(ws.terminals[1]).toMatchObject({ id: "l", cwd: "/here", origin: "here" });
  });
});
```
Imports to add: `isNewer, pickNewest, bumpSync, openingFor, type SyncMeta, type Workspace, type Machines`.

- [ ] **Step 2: Run to verify failure**: `npm test`.

- [ ] **Step 3: Implement in `src/lib/workspace.ts`**

```ts
export interface SyncMeta { revision: number; updatedAt: string; updatedBy: string }
```
`TerminalSettings`: add `origin?: string | null;` and `foreign?: { cwd: string } | null;`. `Workspace`: add `sync?: SyncMeta;`.

```ts
export function isNewer(a: SyncMeta | undefined | null, b: SyncMeta | undefined | null): boolean {
  if (!a) return false;
  if (!b) return true;
  if (a.revision !== b.revision) return a.revision > b.revision;
  return a.updatedAt > b.updatedAt;
}

export function pickNewest(cands: Workspace[]): Workspace | null {
  let best: Workspace | null = null;
  for (const c of cands) if (!best || isNewer(c.sync, best.sync)) best = c;
  return best;
}

export function bumpSync(prev: SyncMeta | undefined | null, self: string, now: string = new Date().toISOString()): SyncMeta {
  return { revision: (prev?.revision ?? 0) + 1, updatedAt: now, updatedBy: self };
}

export function openingFor(def: TerminalDef, self: string | null, machines: Machines, defaultUser: string): { cwd: string | null; settings: TerminalSettings } {
  const origin = def.origin ?? null;
  const base: TerminalSettings = { ssh: def.ssh ?? null, claude: def.claude ?? null, command: def.command ?? null, origin };
  if (def.ssh) return { cwd: null, settings: base };
  if (self && origin && origin !== self) {
    return {
      cwd: null,
      settings: { ...base, ssh: { host: machineHost(origin, machines[origin], defaultUser), cwd: def.cwd, machine: origin }, foreign: { cwd: def.cwd } },
    };
  }
  return { cwd: def.cwd, settings: base };
}
```
`toWorkspace`: input gains `sync?: SyncMeta | null`; per def:
```ts
      const foreign = s.foreign ?? null;
      return {
        ...s.extra,
        id: t.id,
        name: t.name,
        cwd: foreign ? foreign.cwd : t.cwd,
        ssh: foreign ? null : s.ssh,
        claude: s.claude,
        command: s.command,
        ...(s.origin ? { origin: s.origin } : {}),
      };
```
and add `...(input.sync ? { sync: input.sync } : {})` to the returned object. (`extra` handling in the store's `extraFromDef` must exclude `origin`: Task 3.)

- [ ] **Step 4: ipc**
```ts
  workspacePull: (host: string) => invoke<string | null>("workspace_pull", { host }),
  workspacePush: (host: string, contents: string) => invoke<void>("workspace_push", { host, contents }),
  workspaceStat: () => invoke<number | null>("workspace_stat"),
```

- [ ] **Step 5: Verify**: `npm test && npm run typecheck` (store tests still pass: new fields are optional). Report counts.

- [ ] **Step 6: Commit**
```bash
git add src/lib/workspace.ts src/lib/workspace.test.ts src/lib/ipc.ts
git commit -m "feat(ui): sync meta, opening rules for foreign locals, write-back"
```

---

### Task 3: Store: origin, foreign opening, save bump + push, pull/adopt, mtime check

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
```ts
// state
selfMachine: string | null;
syncMeta: SyncMeta | null;
sync: { enabled: boolean; lastPullAt: string | null; lastPushAt: string | null; peersOk: number; peersTotal: number; error: string | null; adopting: boolean };
// actions
pullWorkspace(): Promise<void>;
checkExternalChange(): Promise<void>;
// exports
export const SYNC_PULL_MS = 30_000, SYNC_STAT_MS = 5_000;
export function applyWorkspace(ws: Workspace, opts: { confirmClose: boolean }): Promise<void>;  // internal helper used by reloadWorkspace and adopt
```

- [ ] **Step 1: Tests** (in `src/store.test.ts`)

Mock factory additions: `workspacePull: vi.fn(async () => null), workspacePush: vi.fn(async () => {}), workspaceStat: vi.fn(async () => null)`. `beforeEach` `setState` additions: `selfMachine: null, syncMeta: null, sync: { enabled: false, lastPullAt: null, lastPushAt: null, peersOk: 0, peersTotal: 0, error: null, adopting: false }`.

```ts
describe("shared workspace", () => {
  const online = (name: string) => ({ name, hostName: name, ip: null, os: "macOS", online: true });
  const ts = (peers: string[]) => ({ running: true, message: null, user: "mokes", self: online("here"), peers: peers.map(online) });

  it("refreshTailscale records self and enables sync", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValueOnce(ts(["desk"]));
    await useStore.getState().refreshTailscale();
    expect(useStore.getState().selfMachine).toBe("here");
    expect(useStore.getState().sync.enabled).toBe(true);
  });

  it("new terminals carry origin; saves bump the revision and push to online peers", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), sync: { ...useStore.getState().sync, enabled: true } });
      const id = await useStore.getState().createTerminal("/tmp/a");
      expect(useStore.getState().settings[id].origin).toBe("here");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const ws = calls[calls.length - 1][0] as Workspace;
      expect(ws.sync?.revision).toBe(1);
      expect(ws.sync?.updatedBy).toBe("here");
      expect(ws.terminals[0].origin).toBe("here");
      expect(ipc.workspacePush).toHaveBeenCalledWith("mokes@desk", expect.stringContaining('"revision": 1'));
      expect(useStore.getState().syncMeta?.revision).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loadWorkspace opens a foreign local as a remote to its origin and stamps missing origins", async () => {
    useStore.setState({ persistenceReady: false, selfMachine: "here", tailscale: ts(["desk"]), machines: { desk: { user: "root", color: "#ef4444", lastUsed: "t" } } });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null, sync: { revision: 5, updatedAt: "t", updatedBy: "desk" },
      terminals: [
        { id: "f", name: "F", cwd: "/proj", ssh: null, claude: null, command: null, origin: "desk" },
        { id: "l", name: "L", cwd: "/tmp/l", ssh: null, claude: null, command: null },
      ],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    const calls = vi.mocked(ipc.createTerminal).mock.calls;
    expect(calls.find((c) => c[0] === "f")?.[1]).toBe("/home/me");
    expect(s.settings.f.ssh).toEqual({ host: "root@desk", cwd: "/proj", machine: "desk" });
    expect(s.settings.f.foreign).toEqual({ cwd: "/proj" });
    expect(s.startupPending.f).toBe(true);
    expect(s.settings.l.origin).toBe("here");
    expect(s.syncMeta?.revision).toBe(5);
  });

  it("pullWorkspace adopts a newer peer copy without confirming, and skips older or pending", async () => {
    useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), syncMeta: { revision: 2, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
    const a = await useStore.getState().createTerminal("/tmp/a");
    const newer: Workspace = {
      version: 1, layout: null, sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
      terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      machines: { desk: { alias: "Desk", lastUsed: "t" } },
    };
    vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(newer));
    await useStore.getState().pullWorkspace();
    let s = useStore.getState();
    expect(ipc.workspacePull).toHaveBeenCalledWith("mokes@desk");
    expect(ipc.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sync: newer.sync }));
    expect(confirm).not.toHaveBeenCalled();
    expect(s.order).toEqual(["n1"]);
    expect(s.terminals[a]).toBeUndefined();
    expect(s.syncMeta?.revision).toBe(9);
    expect(s.machines.desk.alias).toBe("Desk");
    expect(s.sync.peersOk).toBe(1);

    vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify({ ...newer, sync: { revision: 4, updatedAt: "t", updatedBy: "desk" } }));
    await useStore.getState().pullWorkspace();
    expect(useStore.getState().syncMeta?.revision).toBe(9);
  });

  it("pullWorkspace reports unreachable peers without failing", async () => {
    useStore.setState({ selfMachine: "here", tailscale: ts(["desk", "home"]), sync: { ...useStore.getState().sync, enabled: true } });
    vi.mocked(ipc.workspacePull).mockRejectedValueOnce("not reachable: refused").mockResolvedValueOnce(null);
    await useStore.getState().pullWorkspace();
    const s = useStore.getState();
    expect(s.sync.peersTotal).toBe(2);
    expect(s.sync.peersOk).toBe(1);
    expect(s.sync.error).toContain("desk");
  });

  it("checkExternalChange adopts a newer file written by another machine and ignores our own write", async () => {
    useStore.setState({ selfMachine: "here", syncMeta: { revision: 2, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(1000);
    await useStore.getState().checkExternalChange();
    expect(ipc.loadWorkspace).not.toHaveBeenCalled();
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(2000);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, layout: null, terminals: [], sync: { revision: 3, updatedAt: "t3", updatedBy: "desk" } });
    await useStore.getState().checkExternalChange();
    expect(useStore.getState().syncMeta?.revision).toBe(3);
  });
});
```
Import `confirm` (already imported), `Workspace` type (already), `SAVE_DEBOUNCE_MS` (already).

- [ ] **Step 2: Run to verify failure**: `npm test`.

- [ ] **Step 3: Implement in `src/store.ts`**

Imports from `./lib/workspace`: add `bumpSync, isNewer, openingFor, pickNewest, type SyncMeta`. Add `"origin"` to `KNOWN_DEF_KEYS`. Constants: `export const SYNC_PULL_MS = 30_000; export const SYNC_STAT_MS = 5_000;`.

State + initial values as in Interfaces. `refreshTailscale`: on success also `selfMachine: st.self?.name ?? null` and `sync: { ...s.sync, enabled: st.running && !!st.self }`.

Origin stamping: in `createTerminal` and `createSshTerminal`, settings get `origin: useStore.getState().selfMachine ?? null`.

`openDefs`: replace `spawnDef(regenerated)` usage with:
```ts
      const opening = openingFor(regenerated, st.selfMachine, st.machines, st.tailscale?.user ?? "");
      const { info, note } = await spawnDef({ ...regenerated, cwd: opening.cwd ?? (await homeDir()) });
      // settings from the opening (carries ssh/foreign/origin) plus extra:
      const settings: TerminalSettings = { ...opening.settings, extra: extraFromDef(regenerated), origin: opening.settings.origin ?? st.selfMachine ?? null };
```
where `st = useStore.getState()` at the top of the loop; use the same `settings` in the bulk pass (compute `settingsFromDef` via `openingFor` there too, so already-open foreign locals keep their derived ssh). `settingsFromDef(d)` becomes `openingFor(d, self, machines, user).settings` + extra.

`loadWorkspace`/`reloadWorkspace`/adopt share `applyWorkspace(ws, { confirmClose })` (module scope): the existing reload body (close absent defs, `openDefs`, machines, `sshHistory`-free) parameterised by whether to `confirm`; `loadWorkspace` keeps its own path but sets `syncMeta: ws.sync ?? null` after load, then `lastSeenMtime = await ipc.workspaceStat().catch(() => null)` (module-level `let lastSeenMtime: number | null = null`).

Save + push: in `scheduleSave`'s timer callback:
```ts
    const self = s.selfMachine ?? "unknown";
    const sync = bumpSync(s.syncMeta, self);
    useStore.setState({ syncMeta: sync });
    const ws = toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout, machines: s.machines, sync });
    ipc.saveWorkspace(ws)
      .then(async () => {
        lastSeenMtime = await ipc.workspaceStat().catch(() => null);
        await pushWorkspace(JSON.stringify(ws, null, 2));
      })
      .catch((e) => { … existing persistError … });
```
Module-scope helpers:
```ts
function peerHosts(): { name: string; host: string }[] {
  const s = useStore.getState();
  if (!s.tailscale?.running) return [];
  return s.tailscale.peers.filter((p) => p.online).map((p) => ({ name: p.name, host: machineHost(p.name, s.machines[p.name], s.tailscale?.user ?? "") })).filter((p) => validateHost(p.host) === null);
}

async function pushWorkspace(text: string) {
  const peers = peerHosts();
  if (peers.length === 0 || !useStore.getState().sync.enabled) return;
  let ok = 0; const failed: string[] = [];
  for (const p of peers) {
    try { await ipc.workspacePush(p.host, text); ok += 1; } catch (e) { failed.push(`${p.name}: ${typeof e === "string" ? e : String(e)}`); }
  }
  useStore.setState((s) => ({ sync: { ...s.sync, lastPushAt: new Date().toISOString(), peersOk: ok, peersTotal: peers.length, error: failed.length ? `push failed for ${failed.join("; ")}` : null } }));
}

async function adopt(ws: Workspace) {
  useStore.setState((s) => ({ sync: { ...s.sync, adopting: true } }));
  try {
    await ipc.saveWorkspace(ws);
    lastSeenMtime = await ipc.workspaceStat().catch(() => null);
    useStore.setState({ syncMeta: ws.sync ?? null });
    await applyWorkspace(ws, { confirmClose: false });
  } finally {
    useStore.setState((s) => ({ sync: { ...s.sync, adopting: false } }));
  }
}
```
Actions:
```ts
  async pullWorkspace() {
    const s = useStore.getState();
    if (!s.sync.enabled || s.sync.adopting || saveTimer) return;
    const peers = peerHosts();
    const cands: Workspace[] = []; let ok = 0; const failed: string[] = [];
    for (const p of peers) {
      try {
        const text = await ipc.workspacePull(p.host);
        ok += 1;
        if (text) { const parsed = JSON.parse(text) as Workspace; if (parsed && typeof parsed === "object" && parsed.sync) cands.push(parsed); }
      } catch (e) { failed.push(`${p.name}: ${typeof e === "string" ? e : String(e)}`); }
    }
    set((st) => ({ sync: { ...st.sync, lastPullAt: new Date().toISOString(), peersOk: ok, peersTotal: peers.length, error: failed.length ? `pull failed for ${failed.join("; ")}` : null } }));
    const best = pickNewest(cands);
    if (best && isNewer(best.sync, useStore.getState().syncMeta) && !saveTimer) await adopt(best);
  },

  async checkExternalChange() {
    const s = useStore.getState();
    if (!s.sync.enabled || s.sync.adopting || saveTimer) return;
    const mtime = await ipc.workspaceStat().catch(() => null);
    if (mtime === null || mtime === lastSeenMtime) return;
    lastSeenMtime = mtime;
    let ws: Workspace | null = null;
    try { ws = await ipc.loadWorkspace(); } catch { return; }
    if (ws && isNewer(ws.sync, useStore.getState().syncMeta)) await adopt(ws);
  },
```
Also: `saveTimer` guard in `pullWorkspace` reads the module variable; adoption while `persistenceReady` is false must still set `persistenceReady` per `applyWorkspace`'s existing rules.

- [ ] **Step 4: Verify**: `npm test && npm run typecheck`. Expected: all green (about 122; report exact).

- [ ] **Step 5: Commit**
```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): shared workspace: origin stamping, foreign locals, save bump + push, pull/adopt, external change check"
```

---

### Task 4: Sync status line, loops, smoke

**Files:**
- Modify: `src/components/Sidebar.tsx`, `src/App.tsx`, `src/components/Sidebar.test.tsx`

- [ ] **Step 1: Sidebar**

Under the header row add:
```tsx
      <SyncLine />
```
with, in the same file:
```tsx
function SyncLine() {
  const enabled = useStore((s) => s.sync.enabled);
  const error = useStore((s) => s.sync.error);
  const peersOk = useStore((s) => s.sync.peersOk);
  const peersTotal = useStore((s) => s.sync.peersTotal);
  const lastPullAt = useStore((s) => s.sync.lastPullAt);
  const running = useStore((s) => s.tailscale?.running ?? false);
  const pull = useStore((s) => s.pullWorkspace);
  const ago = lastPullAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(lastPullAt)) / 1000))} s ago` : "not yet";
  const text = !running ? "Sync off · Tailscale not running" : !enabled ? "Sync off" : error ? `Sync error · ${error}` : `Synced · ${peersOk}/${peersTotal} machines · ${ago}`;
  return (
    <button
      className={`w-full truncate border-b border-neutral-800 px-3 py-1 text-left text-[10px] ${error ? "text-amber-300" : "text-neutral-500"} hover:bg-neutral-800/60`}
      title={error ?? "Click to sync now"}
      onClick={() => void pull()}
    >
      {text}
    </button>
  );
}
```
Row second line for machine terminals: `${machineName} · ${settings?.ssh?.cwd ?? ""}` (so foreign locals show origin and folder).

- [ ] **Step 2: App loops**

Replace the 30 s effect with one that always calls `refreshTailscale()` then `pullWorkspace()` every `SYNC_PULL_MS`, add a `SYNC_STAT_MS` interval calling `checkExternalChange()`, and a `window` `focus` listener calling `pullWorkspace()`. After `loadWorkspace()` on mount, call `refreshTailscale()` then `pullWorkspace()` once.

- [ ] **Step 3: Sidebar test**: add a case rendering with `sync.enabled: true, peersOk: 1, peersTotal: 2, lastPullAt: <now>` and `tailscale.running: true` asserting the line text contains "Synced · 1/2 machines"; and one with `tailscale: null` asserting "Sync off".

- [ ] **Step 4: Verify**
```bash
npm test && npm run typecheck && npm run build && (cd src-tauri && cargo test)
```

- [ ] **Step 5: Manual smoke (user)**: run swarmz on both desk minis; add a tile on one; within ~5 s it appears on the other with the origin machine's colour; Run connects to the origin; quit and relaunch one; layouts match.

- [ ] **Step 6: Commit**
```bash
git add src
git commit -m "feat(ui): sync status line and sync loops"
```

---

## Self-review notes

- Foreign locals are never converted back: `toWorkspace` emits their original `cwd`/`origin` with `ssh: null`.
- Adoption never bumps `sync`; only `scheduleSave` does.
- `saveTimer` is checked in both pull and external-change paths so a half-typed local change is never overwritten.
