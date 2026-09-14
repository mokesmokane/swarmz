# swarmz Tailscale Machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote terminals are created by picking a machine on the user's Tailscale network; each machine carries an alias, username and colour that every tile, tab and sidebar row for it displays.

**Architecture:** A Rust `tailscale` module runs `tailscale status --json` and returns the peers. The workspace file gains a `machines` map (replacing `sshHistory`). The store gains machine config actions and `createRemoteTerminal`, which resolves `user@name` and reuses the existing `createSshTerminal` path (still used by tile splits). The remote form lists machines, edits them inline, and reuses the existing connect → pick folder → create flow. Colour is applied from a single selector to rows, tabs, the tile bar, and xterm's background.

**Tech Stack:** unchanged (Tauri 2, Rust std::process + serde_json, React 19, zustand 5, vitest 4 + jsdom/Testing Library).

**Spec:** `docs/superpowers/specs/2026-09-14-tailscale-machines-design.md`

## Global Constraints

- Machine key = short MagicDNS name (`DNSName` up to the first dot). SSH host for a machine = `${user}@${name}` where `user` is the machine's configured username or the local `$USER`.
- `MACHINE_COLORS = ["#f59e0b","#ef4444","#ec4899","#8b5cf6","#3b82f6","#06b6d4","#22c55e","#a3e635"]`; a colour is one of these or null. Terminal background tint = base `#0f1115` mixed 10 % toward the colour.
- `machines` capped at 50 entries by `lastUsed`. `sshHistory` is no longer written; ignored on load.
- Alias follows the registry name rules (trimmed, 1–64 chars, none of `" ' \` \ $` or control chars).
- Tailscale CLI candidates, in order: `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. 5 s timeout. `running: false` with a message when missing, not `Running`, or failing.
- Nothing about connect/liveness/typing changes; `createSshTerminal` remains the primitive.
- Commit after every task with a conventional-commit message ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014xUXNbx7voeP3tRbbRR67s
  ```
- Never commit `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`, `.superpowers`.

---

## File structure

```
src-tauri/src/tailscale.rs          find_cli, parse_status (tested), status, open_app
src-tauri/src/remote.rs             run_with_timeout + Finished become pub(crate)
src-tauri/src/commands.rs           tailscale_status, tailscale_open
src-tauri/src/lib.rs                register + `pub mod tailscale;`
src/lib/workspace.ts                machines model + helpers; SshConfig.machine; Workspace.machines; sshHistory helpers removed
src/lib/workspace.test.ts
src/lib/ipc.ts                      tailscaleStatus, tailscaleOpen, types
src/store.ts                        machines, tailscale, refreshTailscale, updateMachine, createRemoteTerminal, machineFor; sshHistory removed
src/store.test.ts
src/components/NewRemoteTerminal.tsx   replaces NewSshTerminal.tsx (deleted with its test)
src/components/NewRemoteTerminal.test.tsx
src/components/MachineSettings.tsx
src/components/Sidebar.tsx          menu label, row colour/border, tooltip
src/components/TabGroup.tsx         tab dot colour; split passes machine + name
src/components/TerminalPane.tsx     2 px top bar
src/components/TerminalSettings.tsx host read-only for machine terminals
src/lib/xtermRegistry.ts            background tint per terminal, store subscription
src/App.tsx                         refresh Tailscale every 30 s while remote terminals exist
```

---

### Task 1: Rust tailscale module and commands

**Files:**
- Create: `src-tauri/src/tailscale.rs`
- Modify: `src-tauri/src/remote.rs` (visibility), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces commands `tailscale_status() -> Result<TailscaleStatus, String>` and `tailscale_open() -> Result<(), String>`, where `TailscaleStatus` serialises as `{ running, message, user, self, peers: [{ name, hostName, ip, os, online }] }`.

- [ ] **Step 1: Failing tests**

Create `src-tauri/src/tailscale.rs` with only:

```rust
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
```

Add `pub mod tailscale;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run to verify failure**

```bash
cd src-tauri && cargo test tailscale
```
Expected: compile error, `parse_status` not found.

- [ ] **Step 3: Implement**

In `src-tauri/src/remote.rs` change `struct Finished` to `pub(crate) struct Finished` with `pub(crate)` fields, and `fn run_with_timeout` to `pub(crate) fn run_with_timeout`.

Prepend to `src-tauri/src/tailscale.rs`:

```rust
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
    let done = run_with_timeout(cmd, Duration::from_secs(5))?;
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
```

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub async fn tailscale_status() -> Result<crate::tailscale::TailscaleStatus, String> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::status)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailscale_open() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::tailscale::open_app)
        .await
        .map_err(|e| e.to_string())?
}
```

Register `commands::tailscale_status, commands::tailscale_open,` in `lib.rs`.

- [ ] **Step 4: Verify**

```bash
cd src-tauri && cargo test
```
Expected: 36 passed (32 + 4), no warnings in the swarmz crate.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(core): tailscale status and open commands"
```

---

### Task 2: Machines model, helpers, ipc

**Files:**
- Modify: `src/lib/workspace.ts`, `src/lib/workspace.test.ts`, `src/lib/ipc.ts`

**Interfaces:**
- Produces (spec §4.1): `MACHINE_COLORS`, `MachineConfig`, `Machines`, `MACHINES_MAX = 50`, `machineLabel`, `machineHost`, `touchMachine`, `validateAlias`, `isMachineColor`, `tintBackground`; `SshConfig.machine?: string | null`; `Workspace.machines?: Machines`; `toWorkspace` input gains `machines: Machines` and drops `sshHistory`. ipc: `tailscaleStatus(): Promise<TailscaleStatus>`, `tailscaleOpen(): Promise<void>`, exported types `TailscaleMachine`, `TailscaleStatus`.
- Removes: `SshHistoryEntry`, `SshHistory`, `SSH_HISTORY_MAX`, `touchSshHistory`, `recentSshHosts`, `filterSshHosts` and their tests.

- [ ] **Step 1: Tests**

In `src/lib/workspace.test.ts` delete the `describe("ssh history"...)` and `describe("filterSshHosts"...)` blocks and the corresponding imports; in the `toWorkspace` test replace `sshHistory` with `machines: { "m1": { alias: "a", lastUsed: "t" } }` asserting `ws.machines` equals it and that with `machines: {}` the key is absent. Add:

```ts
describe("machines", () => {
  it("label and host", () => {
    expect(machineLabel("martins-mac-mini", undefined)).toBe("martins-mac-mini");
    expect(machineLabel("martins-mac-mini", { alias: " desk mini ", lastUsed: "t" })).toBe("desk mini");
    expect(machineLabel("martins-mac-mini", { alias: "", lastUsed: "t" })).toBe("martins-mac-mini");
    expect(machineHost("martins-mac-mini", undefined, "mokes")).toBe("mokes@martins-mac-mini");
    expect(machineHost("martins-mac-mini", { user: "root", lastUsed: "t" }, "mokes")).toBe("root@martins-mac-mini");
    expect(machineHost("martins-mac-mini", { user: " ", lastUsed: "t" }, "mokes")).toBe("mokes@martins-mac-mini");
  });

  it("touchMachine merges, stamps lastUsed unless told not to, and caps at 50", () => {
    let m = touchMachine({}, "a", { cwd: "/x" }, "2026-01-01T00:00:00Z");
    expect(m.a).toEqual({ cwd: "/x", lastUsed: "2026-01-01T00:00:00Z" });
    m = touchMachine(m, "a", { alias: "A" }, "2026-01-02T00:00:00Z", { bump: false });
    expect(m.a).toEqual({ cwd: "/x", alias: "A", lastUsed: "2026-01-01T00:00:00Z" });
    for (let i = 0; i < 60; i++) m = touchMachine(m, `h${i}`, {}, new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString());
    expect(Object.keys(m).length).toBe(50);
    expect(m.a).toBeUndefined();
    expect(m.h59).toBeDefined();
  });

  it("validateAlias follows the name rules", () => {
    expect(validateAlias("desk mini")).toBeNull();
    expect(validateAlias("")).not.toBeNull();
    expect(validateAlias("a\"b")).not.toBeNull();
    expect(validateAlias("x".repeat(65))).not.toBeNull();
  });

  it("colours", () => {
    expect(isMachineColor(null)).toBe(true);
    expect(isMachineColor("#f59e0b")).toBe(true);
    expect(isMachineColor("#123456")).toBe(false);
    expect(tintBackground("#0f1115", null)).toBe("#0f1115");
    expect(tintBackground("#000000", "#ffffff")).toBe("#1a1a1a");
    expect(tintBackground("#0f1115", "#f59e0b")).toBe("#261f14");
  });
});
```
Import `machineLabel, machineHost, touchMachine, validateAlias, isMachineColor, tintBackground` (and drop the removed names).

- [ ] **Step 2: Run to verify failure**

```bash
npm test
```
Expected: workspace tests fail to import the new names.

- [ ] **Step 3: Implement in `src/lib/workspace.ts`**

Delete the `SshHistoryEntry`/`SshHistory`/`SSH_HISTORY_MAX`/`touchSshHistory`/`recentSshHosts`/`filterSshHosts` definitions. Add `machine?: string | null;` to `SshConfig`. Replace `sshHistory?: SshHistory;` on `Workspace` with `machines?: Machines;`. Add:

```ts
export const MACHINE_COLORS = ["#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#a3e635"] as const;
export const MACHINES_MAX = 50;

export interface MachineConfig {
  alias?: string | null;
  user?: string | null;
  color?: string | null;
  cwd?: string | null;
  lastUsed: string;
}
export type Machines = Record<string, MachineConfig>;

export function machineLabel(name: string, cfg: MachineConfig | undefined): string {
  const alias = cfg?.alias?.trim();
  return alias ? alias : name;
}

export function machineHost(name: string, cfg: MachineConfig | undefined, defaultUser: string): string {
  const user = cfg?.user?.trim() || defaultUser.trim();
  return `${user}@${name}`;
}

export function touchMachine(
  m: Machines,
  name: string,
  patch: Partial<Omit<MachineConfig, "lastUsed">>,
  now: string = new Date().toISOString(),
  opts: { bump?: boolean } = {},
): Machines {
  const prev = m[name];
  const lastUsed = opts.bump === false && prev ? prev.lastUsed : now;
  const next: Machines = { ...m, [name]: { ...prev, ...patch, lastUsed } };
  const keys = Object.keys(next).sort((a, b) => (next[b].lastUsed > next[a].lastUsed ? 1 : next[b].lastUsed < next[a].lastUsed ? -1 : 0));
  const kept: Machines = {};
  for (const k of keys.slice(0, MACHINES_MAX)) kept[k] = next[k];
  return kept;
}

const UNSUPPORTED_ALIAS = /["'`\\$\x00-\x1f\x7f]/;
export function validateAlias(alias: string): string | null {
  const a = alias.trim();
  if (!a) return "alias cannot be empty";
  if (a.length > 64 || UNSUPPORTED_ALIAS.test(a)) return "alias may not contain quotes, backslash, $ or control characters, and must be at most 64 characters";
  return null;
}

export function isMachineColor(c: string | null | undefined): boolean {
  return c === null || c === undefined || (MACHINE_COLORS as readonly string[]).includes(c);
}

export function tintBackground(base: string, color: string | null): string {
  if (!color) return base;
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [br, bg, bb] = hex(base);
  const [cr, cg, cb] = hex(color);
  const mix = (b: number, c: number) => Math.round(b * 0.9 + c * 0.1);
  const out = [mix(br, cr), mix(bg, cg), mix(bb, cb)].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `#${out}`;
}
```
In `toWorkspace`, replace the `sshHistory` handling with `const machines = input.machines ?? {};` and `...(Object.keys(machines).length ? { machines } : {})`; change the input type accordingly.

- [ ] **Step 4: ipc**

Add to `src/lib/ipc.ts`:
```ts
export interface TailscaleMachine { name: string; hostName: string; ip: string | null; os: string; online: boolean }
export interface TailscaleStatus { running: boolean; message: string | null; user: string; self: TailscaleMachine | null; peers: TailscaleMachine[] }
```
and inside `ipc`: `tailscaleStatus: () => invoke<TailscaleStatus>("tailscale_status"), tailscaleOpen: () => invoke<void>("tailscale_open"),`.

- [ ] **Step 5: Verify (expected residual failures)**

```bash
npm test; npm run typecheck
```
Expected: workspace tests green; `store.ts`, `store.test.ts`, `NewSshTerminal.tsx` and its test fail to compile/import the removed history names. Task 3 and 4 fix them. Report the exact errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspace.ts src/lib/workspace.test.ts src/lib/ipc.ts
git commit -m "feat(ui): machines model, colour helpers, tailscale ipc"
```

---

### Task 3: Store: machines, Tailscale status, createRemoteTerminal

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes Task 2.
- Produces:
  ```ts
  // state
  machines: Machines;
  tailscale: TailscaleStatus | null;
  tailscaleError: string | null;
  // actions
  refreshTailscale(): Promise<void>;
  updateMachine(name: string, patch: { alias?: string | null; user?: string | null; color?: string | null }): Promise<string | null>; // error or null
  createRemoteTerminal(opts: { machine: string; cwd: string | null; claude: { skipPermissions: boolean } | null }, placement?: Placement): Promise<string>;
  // SshTerminalOptions gains name?: string; machine?: string | null
  export function machineFor(s: WorkbenchState, id: string): { name: string; cfg: MachineConfig | undefined } | null;
  export function terminalColor(s: WorkbenchState, id: string): string | null;
  ```
- Removes: `sshHistory` state, `forgetSshHost`.

- [ ] **Step 1: Tests**

In `src/store.test.ts`: mock factory gains `tailscaleStatus: vi.fn(async () => ({ running: true, message: null, user: "mokes", self: null, peers: [] })), tailscaleOpen: vi.fn(async () => {})`; `beforeEach` `setState` replaces `sshHistory: {}` with `machines: {}, tailscale: null, tailscaleError: null`. Delete the `forgetSshHost … history round-trips` and `loadWorkspace restores sshHistory` tests and the `createSshTerminal reuses a remembered folder` describe. Replace `sshHistory` assertions in the two-step tests (`s.sshHistory["me@box"].cwd`) with nothing (remove that line). Add:

```ts
describe("machines and tailscale", () => {
  it("refreshTailscale stores the status or the error", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValueOnce({
      running: true, message: null, user: "mokes", self: null,
      peers: [{ name: "martins-mac-mini", hostName: "Mini", ip: "100.1.1.1", os: "macOS", online: true }],
    });
    await useStore.getState().refreshTailscale();
    expect(useStore.getState().tailscale?.peers[0].name).toBe("martins-mac-mini");
    expect(useStore.getState().tailscaleError).toBeNull();
    vi.mocked(ipc.tailscaleStatus).mockRejectedValueOnce("boom");
    await useStore.getState().refreshTailscale();
    expect(useStore.getState().tailscaleError).toContain("boom");
  });

  it("createRemoteTerminal resolves user@name, names the tile after the alias, tags the machine, bumps lastUsed", async () => {
    useStore.setState({
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] },
      machines: { "martins-mac-mini": { alias: "desk mini", color: "#f59e0b", cwd: "/old", lastUsed: "2026-01-01T00:00:00Z" } },
    });
    const id = await useStore.getState().createRemoteTerminal({ machine: "martins-mac-mini", cwd: "/proj", claude: null });
    const s = useStore.getState();
    const calls = vi.mocked(ipc.createTerminal).mock.calls;
    expect(calls[calls.length - 1][4]).toBe("desk mini");
    expect(s.settings[id].ssh).toEqual({ host: "mokes@martins-mac-mini", cwd: "/proj", machine: "martins-mac-mini" });
    expect(s.machines["martins-mac-mini"].lastUsed > "2026-01-01T00:00:00Z").toBe(true);
    expect(s.machines["martins-mac-mini"].cwd).toBe("/proj");
    expect(terminalColor(s, id)).toBe("#f59e0b");
    expect(machineFor(s, id)?.name).toBe("martins-mac-mini");
  });

  it("createRemoteTerminal uses the machine's username and falls back to the remembered folder", async () => {
    useStore.setState({
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] },
      machines: { box: { user: "root", cwd: "/srv", lastUsed: "t" } },
    });
    const id = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    expect(useStore.getState().settings[id].ssh?.host).toBe("root@box");
    expect(useStore.getState().settings[id].ssh?.cwd).toBeNull();
    const id2 = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: undefined as unknown as null, claude: null });
    expect(useStore.getState().settings[id2].ssh?.cwd).toBe("/srv");
  });

  it("updateMachine validates and renames open terminals that carry the old label", async () => {
    useStore.setState({ tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] }, machines: {} });
    const id = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    expect(useStore.getState().terminals[id].name).toBe("box");
    expect(await useStore.getState().updateMachine("box", { alias: "a\"b" })).not.toBeNull();
    expect(await useStore.getState().updateMachine("box", { color: "#000000" })).not.toBeNull();
    expect(await useStore.getState().updateMachine("box", { alias: "home mini", color: "#3b82f6" })).toBeNull();
    expect(useStore.getState().machines.box.alias).toBe("home mini");
    expect(ipc.renameTerminal).toHaveBeenLastCalledWith(id, "home mini");
  });

  it("chooseRemoteDir records the folder on the machine", async () => {
    useStore.setState({ tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] }, machines: {} });
    const id = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    await useStore.getState().chooseRemoteDir(id, "/picked");
    expect(useStore.getState().machines.box.cwd).toBe("/picked");
  });

  it("machines load from and save to the workspace; sshHistory is ignored", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ persistenceReady: false });
      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1, terminals: [], layout: null,
        machines: { box: { alias: "b", lastUsed: "t" } },
        ...({ sshHistory: { "x@y": { cwd: "/q", lastUsed: "t" } } } as object),
      });
      await useStore.getState().loadWorkspace();
      expect(useStore.getState().machines.box.alias).toBe("b");
      await useStore.getState().updateMachine("box", { color: "#22c55e" });
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const ws = calls[calls.length - 1][0] as Workspace;
      expect(ws.machines?.box.color).toBe("#22c55e");
      expect("sshHistory" in ws).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
```
Import `machineFor, terminalColor` from `./store`.

- [ ] **Step 2: Run to verify failure**

```bash
npm test
```

- [ ] **Step 3: Implement in `src/store.ts`**

Imports: replace `touchSshHistory, type SshHistory` with `isMachineColor, machineHost, machineLabel, touchMachine, validateAlias, type MachineConfig, type Machines`; import `type TailscaleStatus` from `./lib/ipc`.

`SshTerminalOptions` gains `name?: string; machine?: string | null;`. State: replace `sshHistory` with `machines: Machines; tailscale: TailscaleStatus | null; tailscaleError: string | null;` (initial `{}`, `null`, `null`); remove `forgetSshHost`; add the three actions.

Selectors (module scope, exported):
```ts
export function machineFor(s: WorkbenchState, id: string): { name: string; cfg: MachineConfig | undefined } | null {
  const name = s.settings[id]?.ssh?.machine;
  return name ? { name, cfg: s.machines[name] } : null;
}
export function terminalColor(s: WorkbenchState, id: string): string | null {
  return machineFor(s, id)?.cfg?.color ?? null;
}
```

`createSshTerminal` changes: remembered folder comes from the machine, not history:
```ts
    const machineName = opts.machine ?? null;
    const remembered = machineName ? (useStore.getState().machines[machineName]?.cwd ?? null) : null;
    const rememberedOrGivenCwd = opts.cwd === undefined ? remembered : opts.cwd?.trim() || null;
    …
    const info = await ipc.createTerminal(id, home, dims.cols, dims.rows, opts.name ?? hostLabel(opts.host));
    …
      ssh: { host: opts.host.trim(), cwd: rememberedOrGivenCwd, machine: machineName },
    …
    // in the set(): replace the sshHistory line with
        machines: machineName ? touchMachine(s.machines, machineName, rememberedOrGivenCwd ? { cwd: rememberedOrGivenCwd } : {}) : s.machines,
```

New actions:
```ts
  async refreshTailscale() {
    try {
      const st = await ipc.tailscaleStatus();
      set({ tailscale: st, tailscaleError: null });
    } catch (e) {
      set({ tailscaleError: typeof e === "string" ? e : String(e) });
    }
  },

  async updateMachine(name, patch) {
    if (patch.alias !== undefined && patch.alias !== null && patch.alias.trim() !== "") {
      const err = validateAlias(patch.alias);
      if (err) return err;
    }
    if (patch.color !== undefined && !isMachineColor(patch.color)) return "unsupported colour";
    const before = useStore.getState();
    const oldLabel = machineLabel(name, before.machines[name]);
    const cleaned = {
      ...(patch.alias !== undefined ? { alias: patch.alias?.trim() || null } : {}),
      ...(patch.user !== undefined ? { user: patch.user?.trim() || null } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    };
    set((s) => ({ machines: touchMachine(s.machines, name, cleaned, undefined, { bump: false }) }));
    const after = useStore.getState();
    const newLabel = machineLabel(name, after.machines[name]);
    if (newLabel !== oldLabel) {
      for (const id of after.order) {
        if (after.settings[id]?.ssh?.machine === name && after.terminals[id]?.name === oldLabel) {
          await useStore.getState().renameTerminal(id, newLabel);
        }
      }
    }
    return null;
  },

  async createRemoteTerminal(opts, placement) {
    const s = useStore.getState();
    const cfg = s.machines[opts.machine];
    const user = s.tailscale?.user ?? "";
    if (!cfg?.user?.trim() && !user.trim()) throw "no username for this machine";
    return useStore.getState().createSshTerminal(
      { host: machineHost(opts.machine, cfg, user), cwd: opts.cwd, claude: opts.claude, name: machineLabel(opts.machine, cfg), machine: opts.machine },
      placement,
    );
  },
```
`chooseRemoteDir`: in its `set`, add `machines: cur.ssh.machine ? touchMachine(s.machines, cur.ssh.machine, { cwd: clean }) : s.machines,` and remove the `sshHistory` line. `loadWorkspace`/`reloadWorkspace`: `set({ machines: sanitizeMachines(ws.machines) })` where `sanitizeMachines` (module scope) keeps entries whose value is an object with a string `lastUsed`, string-or-null `alias/user/cwd`, and `isMachineColor(color)`, dropping the rest. `scheduleSave`: pass `machines: s.machines` instead of `sshHistory`. Subscription: watch `s.machines`.

- [ ] **Step 4: Verify (expected residual failures)**

```bash
npm test; npm run typecheck
```
Expected: store tests green; only `NewSshTerminal.tsx` and its test still fail (removed in Task 4). Report exact counts.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): machines in the store, tailscale status, createRemoteTerminal"
```

---

### Task 4: Remote form, machine settings, colour everywhere

**Files:**
- Create: `src/components/NewRemoteTerminal.tsx`, `src/components/NewRemoteTerminal.test.tsx`, `src/components/MachineSettings.tsx`
- Delete: `src/components/NewSshTerminal.tsx`, `src/components/NewSshTerminal.test.tsx`
- Modify: `src/components/Sidebar.tsx`, `src/components/TabGroup.tsx`, `src/components/TerminalPane.tsx`, `src/components/TerminalSettings.tsx`, `src/lib/xtermRegistry.ts`, `src/App.tsx`

**Interfaces:**
- Consumes Task 3.
- Produces `NewRemoteTerminal({ onClose })`, `MachineSettings({ name, onClose })`; `xtermRegistry.applyColor(id)`.

- [ ] **Step 1: `MachineSettings.tsx`**

```tsx
import { useState } from "react";
import { useStore } from "../store";
import { MACHINE_COLORS } from "../lib/workspace";

const field = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-blue-500";
const label = "mt-2 block text-[10px] uppercase tracking-wide text-neutral-500";

export function MachineSettings({ name, onClose }: { name: string; onClose: () => void }) {
  const cfg = useStore((s) => s.machines[name]);
  const defaultUser = useStore((s) => s.tailscale?.user ?? "");
  const updateMachine = useStore((s) => s.updateMachine);
  const [alias, setAlias] = useState(cfg?.alias ?? "");
  const [user, setUser] = useState(cfg?.user ?? "");
  const [color, setColor] = useState<string | null>(cfg?.color ?? null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const err = await updateMachine(name, { alias: alias.trim() || null, user: user.trim() || null, color });
    if (err) {
      setError(err);
      return;
    }
    onClose();
  };

  return (
    <div className="mx-1 mb-1 rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="text-neutral-400">{name}</div>
      <label className={label}>Alias</label>
      <input className={field} placeholder={name} value={alias} onChange={(e) => setAlias(e.target.value)} />
      <label className={label}>Username</label>
      <input className={field} placeholder={defaultUser || "user"} value={user} onChange={(e) => setUser(e.target.value)} />
      <label className={label}>Colour</label>
      <div className="flex flex-wrap gap-1">
        <button
          className={`h-5 w-5 rounded-full border ${color === null ? "border-white" : "border-neutral-700"} bg-neutral-800`}
          title="None"
          aria-label="No colour"
          onClick={() => setColor(null)}
        />
        {MACHINE_COLORS.map((c) => (
          <button
            key={c}
            className={`h-5 w-5 rounded-full border ${color === c ? "border-white" : "border-transparent"}`}
            style={{ backgroundColor: c }}
            title={c}
            aria-label={`Colour ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
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

- [ ] **Step 2: `NewRemoteTerminal.tsx`**

Port the connect/pick flow from `NewSshTerminal.tsx` (the `stage`, `createdId`, `connected`, `connecting`, `rearmed`, `connectNote` state and the "connecting" and "pick" renders) unchanged except: `host` is derived (`machineHost(selected, machines[selected], tailscale.user)`), creation calls `createRemoteTerminal({ machine: selected, cwd, claude })` instead of `createSshTerminal`, and the "pick" header reads `Choose the folder on {machineLabel(selected, cfg)}`. The `remembered` folder is `machines[selected]?.cwd ?? null`. The "form" stage becomes:

```tsx
  const tailscale = useStore((s) => s.tailscale);
  const tailscaleError = useStore((s) => s.tailscaleError);
  const machines = useStore((s) => s.machines);
  const refresh = useStore((s) => s.refreshTailscale);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // form stage:
  if (!tailscale || !tailscale.running) {
    return (
      <div className="border-b border-neutral-800 p-2 text-xs text-neutral-300">
        <div className="text-amber-300">{tailscale?.message ?? tailscaleError ?? "Checking Tailscale…"}</div>
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
          <button className="rounded px-2 py-0.5 text-neutral-300 hover:bg-neutral-800" onClick={() => void ipc.tailscaleOpen().catch(() => {})}>Open Tailscale</button>
          <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void refresh()}>Retry</button>
        </div>
      </div>
    );
  }
  return (
    <div className="border-b border-neutral-800 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500">
        <span>Machines on your tailnet</span>
        <button className="text-neutral-500 hover:text-neutral-200" title="Refresh" onClick={() => void refresh()}>↻</button>
      </div>
      {tailscale.peers.length === 0 && <div className="px-1 py-2 text-neutral-500">No other machines yet. Install Tailscale on them with the same account.</div>}
      <ul role="listbox" className="max-h-48 overflow-y-auto rounded border border-neutral-800">
        {tailscale.peers.map((p) => {
          const cfg = machines[p.name];
          const isSel = selected === p.name;
          return (
            <li key={p.name} role="option" aria-selected={isSel}>
              <div
                className={`flex cursor-default items-center gap-2 px-2 py-1 ${isSel ? "bg-neutral-800" : "hover:bg-neutral-800/60"} ${p.online ? "" : "opacity-60"}`}
                onClick={() => setSelected(p.name)}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-600" style={{ backgroundColor: cfg?.color ?? "transparent" }} />
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.online ? "bg-emerald-500" : "bg-neutral-600"}`} title={p.online ? "online" : "offline"} />
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {machineLabel(p.name, cfg)}
                  {cfg?.alias?.trim() && <span className="ml-1 text-neutral-500">{p.name}</span>}
                  {cfg?.cwd && <span className="ml-1 text-neutral-500">{cfg.cwd}</span>}
                </span>
                <button
                  className="text-neutral-500 hover:text-neutral-200"
                  title="Machine settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(editing === p.name ? null : p.name);
                  }}
                >
                  ⚙
                </button>
              </div>
              {editing === p.name && <MachineSettings name={p.name} onClose={() => setEditing(null)} />}
            </li>
          );
        })}
      </ul>
      {selected && (
        <>
          <label className="mt-2 flex items-center gap-2 text-neutral-300">
            <input type="checkbox" checked={claudeOn} onChange={(e) => setClaudeOn(e.target.checked)} />
            Run Claude
          </label>
          <label className="mt-1 flex items-center gap-2 text-neutral-300">
            <input type="checkbox" checked={skip} disabled={!claudeOn} onChange={(e) => setSkip(e.target.checked)} />
            Skip permissions <span className="text-red-400">(dangerous)</span>
          </label>
        </>
      )}
      {error && <div className="mt-1 text-red-400">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-50" onClick={() => void connect()} disabled={busy || !selected}>Connect</button>
      </div>
    </div>
  );
```
`connect()` keeps the headless attempt (`ipc.sshOpenMaster(host)`) and the two branches, calling `createRemoteTerminal({ machine: selected, cwd: null, claude })` for the interactive path and, in `onPick`, `createRemoteTerminal({ machine: selected, cwd: p, claude })` for the headless path or `chooseRemoteDir(createdId, p)` when a tile already exists. Delete `NewSshTerminal.tsx` and its test.

- [ ] **Step 3: Colour everywhere**

- `src/lib/xtermRegistry.ts`: add
  ```ts
  import { terminalColor } from "../store";
  import { tintBackground } from "./workspace";
  const BASE_BG = "#0f1115";
  export function applyColor(id: string): void {
    const entry = entries.get(id);
    if (!entry) return;
    const bg = tintBackground(BASE_BG, terminalColor(useStore.getState(), id));
    if (entry.term.options.theme?.background !== bg) entry.term.options.theme = { ...entry.term.options.theme, background: bg };
  }
  useStore.subscribe((s, prev) => {
    if (s.settings !== prev.settings || s.machines !== prev.machines) for (const id of entries.keys()) applyColor(id);
  });
  ```
  and call `applyColor(id)` at the end of `attach`.
- `TerminalPane.tsx`: `const color = useStore((s) => terminalColor(s, id));` and render `{color && <div className="absolute inset-x-0 top-0 z-20 h-0.5" style={{ backgroundColor: color }} />}` as the first child of the outer div; set the outer div's inline `style={{ backgroundColor: tintBackground("#0f1115", color) }}` instead of the `bg-[#0f1115]` class.
- `TabGroup.tsx`: `const colors = useStore((s) => Object.fromEntries(group.tabs.map((id) => [id, terminalColor(s, id)])))` is wasteful; instead inside the map use a small child component `TabDot({ id, exited })` that reads `terminalColor` and renders the dot with `style={{ backgroundColor: color ?? undefined }}` (falling back to the emerald/neutral classes when null). Also in `openWith`, when `activeSsh` exists pass `name` and `machine` through: read `const activeMachine = useStore((s) => s.settings[group.active]?.ssh?.machine ?? null)` and call `createSshTerminal({ host, cwd, claude, machine: activeMachine, name: activeMachine ? machineLabel(activeMachine, machines[activeMachine]) : undefined }, placement)` (read `machines` from the store).
- `Sidebar.tsx`: rows read `const color = useStore((s) => terminalColor(s, id))` and `const machine = useStore((s) => machineFor(s, id))`; the status dot gets `style={{ backgroundColor: color ?? undefined }}` when not exited; the row gets `style={{ borderLeft: color ? `2px solid ${color}` : undefined }}`; the second line shows `machine ? machine.name : settings?.ssh?.host ? `ssh ${settings.ssh.host}` : basename(t.cwd)`; tooltip on machine rows: `online on Tailscale` / `offline` from `s.tailscale?.peers.find(p => p.name === machine.name)?.online`. Menu: rename "SSH terminal…" to "Remote terminal…" and render `NewRemoteTerminal`.
- `TerminalSettings.tsx`: when `current.ssh?.machine` is set, render the host as read-only text `{current.ssh.host}` with the note "managed by the machine's settings" instead of the input.
- `App.tsx`: add an effect: every 30 s, if any terminal has `settings[id]?.ssh?.machine`, call `refreshTailscale()`; clear on unmount.

- [ ] **Step 4: Component test `NewRemoteTerminal.test.tsx`**

Copy the mock block from the deleted `NewSshTerminal.test.tsx`, adding `tailscaleStatus` and `tailscaleOpen` mocks. Tests:
1. "lists tailnet machines online first with alias and colour, and connects headlessly then picks a folder": seed `machines: { "martins-mac-mini": { alias: "desk mini", color: "#f59e0b", cwd: "/Users/mokes/projects", lastUsed: "t" } }`; `tailscaleStatus` resolves with peers `[home-mini offline, martins-mac-mini online]`; render; expect options in order `desk mini…`, `home-mini`; click `desk mini`; `sshOpenMaster` → true; `sshListDir` resolves `{ path: "/Users/mokes/projects", parent: "/Users/mokes", dirs: ["swarmz"] }`; click Connect; expect "Choose the folder on desk mini"; click "Use this folder"; assert the new terminal's `settings.ssh` equals `{ host: "mokes@martins-mac-mini", cwd: "/Users/mokes/projects", machine: "martins-mac-mini" }` and its name is `desk mini`; `onClose` called.
2. "not running state offers Retry and Open Tailscale": `tailscaleStatus` resolves `{ running: false, message: "Tailscale is NeedsLogin", … }`; expect the message; click "Open Tailscale" → `ipc.tailscaleOpen` called; click Retry → `tailscaleStatus` called twice.
3. "gear edits alias and colour": render with one peer; click ⚙; type alias "home"; click the `#3b82f6` swatch (`getByLabelText("Colour #3b82f6")`); Save; expect `machines[name].alias === "home"` and `color === "#3b82f6"`.

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run build && (cd src-tauri && cargo test)
```
Expected: about 112 vitest (report exact), 36 cargo, tsc clean, build OK. Manual smoke for the user: Remote terminal… lists both minis; set alias + colour on the desk mini; Connect; pick folder; tile/tab/row carry the colour; quit and relaunch; alias and colour persist.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(ui): tailscale machine picker with alias, username and colour; colour on rows, tabs and tiles"
```

---

## Self-review notes

- `createSshTerminal` stays public (TabGroup splits use it); `createRemoteTerminal` is the only path the form uses.
- Existing terminals restored from files with `ssh.host` but no `machine` render uncoloured with the host line, as before.
- The 30 s refresh only runs while a machine terminal exists, so the app makes no Tailscale calls otherwise.
