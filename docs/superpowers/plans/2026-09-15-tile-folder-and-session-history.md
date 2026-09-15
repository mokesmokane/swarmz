# Tile Folder Tracking and Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tile follows the folder its shell is in and keeps its own list of the Claude sessions that ran in it, so a restart or another Mac opens it where the user was and the user can go back to an earlier session in that tile.

**Architecture:** The Rust core learns a local shell's working directory with `lsof` and exposes `terminal_cwd`/`set_terminal_cwd`; the hook event parser also reports Claude's `cwd` and `permission_mode`. The xterm registry drives folder polling (after Enter and on an interval) and reads the OSC 7 directory escape. A pure `sessions.ts` module keeps per-tile session records; the store adopts sessions and folders from hook events and offers `selectSession` for going back. UI: a `SessionHistory` list in the connect card and in a popover from the sidebar row.

**Tech Stack:** Rust (Tauri 2, std::process for lsof), TypeScript, React 19, zustand, xterm.js 6 parser hooks, vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-tile-folder-and-session-history-design.md`

**Spec deviation, recorded here:** §5.2 refers to a "sidebar settings panel"; the sidebar has no such panel today. The same list is offered from a hover button on the sidebar row that opens a popover. Task 8 amends the spec text.

## Global Constraints

- `SessionRecord = { sessionId, cwd, skipPermissions, startedAt, lastActiveAt }`; `sessions` is newest first, at most 20, stored on the def and on `TerminalSettings`; files without it load as before.
- Folder values must be absolute paths with no control characters (`isSafeRemotePath` plus a leading `/`); anything else is ignored. Unchanged values are ignored.
- Local tiles: poll `terminal_cwd` 300 ms after each Enter and every 5000 ms; never for exited tiles; never for tiles whose settings have `ssh`. Remote tiles: OSC 7 first, hook `cwd` second.
- Folder routing: local tile → `set_terminal_cwd` then `terminals[id].cwd`; ssh tile → `settings.ssh.cwd`; foreign local (`settings.foreign`) → `settings.foreign.cwd`.
- Adoption on `SessionStart`: upsert record, replace `claude` when the session id differs (`started: false`), apply the folder. Prompts/stops/notifications bump `lastActiveAt`; `UserPromptSubmit` also applies the folder. Tiles with a custom `command` are never adopted. Host and replay checks from the hooks spec run first.
- Going back: selecting a record sets `claude = { enabled: true, sessionId, skipPermissions, started: true }`, applies its folder, moves it to the head; with `connect` it runs `runStartup`.
- Dead session: after a typed line containing `--resume <id>`, the phrase `No conversation found with session ID <id>` within 10 s removes the record, sets `started: false` if current, and notes `session <id> is gone; Connect starts a new one`.
- `sameWorkspaceContent` includes `sessions` (order-sensitive list).
- Commit messages follow `type(scope): summary` and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `npm test`, `npm run typecheck` and `cd src-tauri && cargo test` before every commit that touches the respective side. Never run `tauri dev` or `tauri build` during implementation.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src-tauri/src/pty.rs` | `cwd()` via `lsof`; pure `parse_lsof_cwd`. |
| `src-tauri/src/registry.rs` | `set_cwd(id, cwd)`. |
| `src-tauri/src/agents.rs` | `AgentEvent` gains `cwd`, `permission_mode`. |
| `src-tauri/src/commands.rs`, `lib.rs` | `terminal_cwd`, `set_terminal_cwd` commands. |
| `src/lib/sessions.ts` (new) + test | Pure record helpers: `upsertSession`, `bumpSession`, `promoteSession`, `removeSession`, `isSafeFolder`. |
| `src/lib/workspace.ts` | `SessionRecord`, `sessions` on settings and defs, `toWorkspace`, `sameWorkspaceContent`. |
| `src/lib/agentState.ts` | `AgentEvent` gains `cwd`, `permissionMode`. |
| `src/lib/ipc.ts` | `terminalCwd`, `setTerminalCwd`. |
| `src/store.ts` | `setTerminalCwd`, adoption in `applyAgentEvent`, `selectSession`, `resumeWatch` + `noteResumeFailure`, `sessions` in `settingsFromDef`/`KNOWN_DEF_KEYS`. |
| `src/lib/xtermRegistry.ts` + test | Enter/interval polling, OSC 7 handler, resume-failure scanning. |
| `src/components/SessionHistory.tsx` (new) + test | The list, used by the card and the sidebar popover. |
| `src/components/TerminalPane.tsx`, `Sidebar.tsx` + tests | Card list; row hover button + popover. |

---

### Task 1: Rust: shell working directory, registry `set_cwd`, event fields, commands

**Files:**
- Modify: `src-tauri/src/pty.rs` (after `foreground_busy`)
- Modify: `src-tauri/src/registry.rs` (after `rename`)
- Modify: `src-tauri/src/agents.rs:236-265`
- Modify: `src-tauri/src/commands.rs` (after `terminal_foreground_busy`), `src-tauri/src/lib.rs` (handler list)

**Interfaces:**
- Produces: `pty::parse_lsof_cwd(stdout: &str) -> Option<String>`, `PtySession::cwd(&self) -> Option<String>`, `TerminalRegistry::set_cwd(&mut self, id: &str, cwd: &str) -> Result<TerminalInfo, RegistryError>`, `AgentEvent { …, cwd: Option<String>, permission_mode: Option<String> }` (camelCase `cwd`, `permissionMode`), Tauri commands `terminal_cwd(id: String) -> Result<Option<String>, String>` and `set_terminal_cwd(id: String, cwd: String) -> Result<TerminalInfo, String>`.

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/pty.rs`, add at the bottom (create the module if the file has none):

```rust
#[cfg(test)]
mod cwd_tests {
    use super::*;

    #[test]
    fn parse_lsof_cwd_takes_the_n_line() {
        assert_eq!(parse_lsof_cwd("p123\nfcwd\nn/Users/me/proj\n"), Some("/Users/me/proj".to_string()));
        assert_eq!(parse_lsof_cwd("p123\n"), None);
        assert_eq!(parse_lsof_cwd(""), None);
        // A directory containing a newline cannot be represented; the first n-line wins.
        assert_eq!(parse_lsof_cwd("n/a\nn/b\n"), Some("/a".to_string()));
    }

    #[test]
    fn cwd_of_a_shell_that_changed_directory() {
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "cd /tmp && sleep 5".to_string()],
            cwd: "/".to_string(),
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let session = PtySession::spawn(spec, |_| {}, |_| {}).unwrap();
        // Give the shell a moment to run the cd.
        let mut got = None;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            got = session.cwd();
            if got.as_deref() == Some("/tmp") || got.as_deref() == Some("/private/tmp") {
                break;
            }
        }
        session.kill();
        assert!(matches!(got.as_deref(), Some("/tmp") | Some("/private/tmp")), "got {got:?}");
    }
}
```

In `src-tauri/src/registry.rs` tests module add:

```rust
    #[test]
    fn set_cwd_updates_the_entry_and_rejects_unknown_ids() {
        let mut reg = TerminalRegistry::new();
        reg.add("a".into(), None, "/one".into()).unwrap();
        let info = reg.set_cwd("a", "/two").unwrap();
        assert_eq!(info.cwd, "/two");
        assert_eq!(reg.get("a").unwrap().cwd, "/two");
        assert_eq!(reg.set_cwd("nope", "/x"), Err(RegistryError::NotFound("nope".into())));
    }
```

In `src-tauri/src/agents.rs` tests module add:

```rust
    #[test]
    fn parse_line_reads_cwd_and_permission_mode() {
        let line = "t\tid\tSessionStart\t{\"session_id\":\"s\",\"cwd\":\"/p\",\"permission_mode\":\"bypassPermissions\"}";
        let ev = parse_line(line).unwrap();
        assert_eq!(ev.cwd.as_deref(), Some("/p"));
        assert_eq!(ev.permission_mode.as_deref(), Some("bypassPermissions"));
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["cwd"], "/p");
        assert_eq!(v["permissionMode"], "bypassPermissions");
        let none = parse_line("t\tid\tStop\t{}").unwrap();
        assert_eq!(none.cwd, None);
        assert_eq!(none.permission_mode, None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test cwd_tests:: set_cwd parse_line_reads_cwd 2>&1 | grep -E "cannot find|no method|no field" | head`
Expected: errors for `parse_lsof_cwd`, `cwd`, `set_cwd`, and the two new fields.

- [ ] **Step 3: Implement**

`src-tauri/src/pty.rs`, add after `foreground_busy`:

```rust
    /// The working directory of the process in the foreground of this PTY (the shell when
    /// nothing else is running), via `lsof`. `libproc` does not implement the lookup on macOS;
    /// `lsof -a -p <pid> -d cwd -Fn` costs about 16 ms. None when unknown.
    #[cfg(unix)]
    pub fn cwd(&self) -> Option<String> {
        let shell_pid = self.shell_pid?;
        let leader = self.master.lock().ok()?.process_group_leader().map(|p| p as u32);
        let pid = leader.unwrap_or(shell_pid);
        let out = std::process::Command::new("lsof")
            .arg("-a").arg("-p").arg(pid.to_string()).arg("-d").arg("cwd").arg("-Fn")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        parse_lsof_cwd(&String::from_utf8_lossy(&out.stdout))
    }

    #[cfg(not(unix))]
    pub fn cwd(&self) -> Option<String> {
        None
    }
}

/// `lsof -Fn` prints one field per line with a one-letter prefix; the cwd is the first `n` line.
pub fn parse_lsof_cwd(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|l| l.strip_prefix('n')).filter(|p| p.starts_with('/')).map(|p| p.to_string())
}
```

(The `}` before the doc comment closes `impl PtySession`; place `parse_lsof_cwd` at module level after the impl block.)

`src-tauri/src/registry.rs`, after `rename`:

```rust
    pub fn set_cwd(&mut self, id: &str, cwd: &str) -> Result<TerminalInfo, RegistryError> {
        let entry = self
            .entries
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| RegistryError::NotFound(id.to_string()))?;
        entry.cwd = cwd.to_string();
        Ok(entry.clone())
    }
```

`src-tauri/src/agents.rs`: add to `AgentEvent`

```rust
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
```

and to `parse_line`'s constructor `cwd: s("cwd"), permission_mode: s("permission_mode"),`.

`src-tauri/src/commands.rs`, after `terminal_foreground_busy`:

```rust
#[tauri::command]
pub async fn terminal_cwd(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let session = state.sessions.lock().unwrap().get(&id).map(|(_, s)| s.clone());
    let Some(session) = session else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || session.cwd()).await.map_err(|e| e.to_string())
}

/// Records the folder a tile's shell has moved to. Absolute paths only; the directory need not
/// exist here (a foreign tile's folder lives on another machine).
#[tauri::command]
pub fn set_terminal_cwd(state: State<'_, AppState>, id: String, cwd: String) -> Result<TerminalInfo, String> {
    if !cwd.starts_with('/') || cwd.chars().any(|c| c.is_control()) {
        return Err("folder must be an absolute path without control characters".into());
    }
    state.registry.lock().unwrap().set_cwd(&id, &cwd).map_err(|e| e.to_string())
}
```

`src-tauri/src/lib.rs`: add `commands::terminal_cwd,` and `commands::set_terminal_cwd,` after `commands::terminal_foreground_busy,`.

- [ ] **Step 4: Run all Rust tests**

Run: `cd src-tauri && cargo test 2>&1 | grep -E "test result|warning|error" | head`
Expected: all `ok`, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs src-tauri/src/registry.rs src-tauri/src/agents.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(core): shell working directory lookup, set_terminal_cwd, cwd and permission mode on hook events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Frontend data: `sessions.ts`, workspace types, ipc

**Files:**
- Create: `src/lib/sessions.ts`, `src/lib/sessions.test.ts`
- Modify: `src/lib/workspace.ts` (`TerminalSettings`, `TerminalDef`, `toWorkspace`, `sameWorkspaceContent`), `src/lib/workspace.test.ts`
- Modify: `src/lib/agentState.ts:12-19`, `src/lib/agentState.test.ts` (the `ev` helper gains the two fields)
- Modify: `src/lib/ipc.ts`
- Modify: `src/store.ts:469` (`KNOWN_DEF_KEYS`), `settingsFromDef`

**Interfaces:**
- Produces:
  ```ts
  // sessions.ts
  export const SESSIONS_MAX = 20;
  export interface SessionRecord { sessionId: string; cwd: string; skipPermissions: boolean; startedAt: string; lastActiveAt: string }
  export function isSafeFolder(p: string): boolean;                       // absolute, no control chars
  export function upsertSession(list: SessionRecord[] | undefined, rec: { sessionId: string; cwd: string; skipPermissions: boolean }, now: string): SessionRecord[];
  export function bumpSession(list: SessionRecord[] | undefined, sessionId: string, now: string): SessionRecord[] | undefined; // undefined = unchanged
  export function promoteSession(list: SessionRecord[], sessionId: string, now: string): SessionRecord[];
  export function removeSession(list: SessionRecord[] | undefined, sessionId: string): SessionRecord[];
  export function sanitizeSessions(v: unknown): SessionRecord[] | undefined;
  // workspace.ts: TerminalSettings.sessions?: SessionRecord[]; TerminalDef inherits it
  // agentState.ts: AgentEvent.cwd: string | null; AgentEvent.permissionMode: string | null
  // ipc.ts: terminalCwd(id) => Promise<string | null>; setTerminalCwd(id, cwd) => Promise<TerminalInfo>
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/sessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bumpSession, isSafeFolder, promoteSession, removeSession, sanitizeSessions, SESSIONS_MAX, upsertSession, type SessionRecord } from "./sessions";

const rec = (id: string, t = "2026-09-15T10:00:00Z"): SessionRecord => ({ sessionId: id, cwd: `/${id}`, skipPermissions: false, startedAt: t, lastActiveAt: t });

describe("isSafeFolder", () => {
  it("accepts absolute paths and rejects relative or control-character ones", () => {
    expect(isSafeFolder("/Users/me/proj")).toBe(true);
    expect(isSafeFolder("proj")).toBe(false);
    expect(isSafeFolder("/a\x1bb")).toBe(false);
    expect(isSafeFolder("")).toBe(false);
  });
});

describe("upsertSession", () => {
  it("adds a new record at the head with startedAt = lastActiveAt = now", () => {
    const out = upsertSession([rec("a")], { sessionId: "b", cwd: "/b", skipPermissions: true }, "2026-09-15T11:00:00Z");
    expect(out.map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(out[0]).toEqual({ sessionId: "b", cwd: "/b", skipPermissions: true, startedAt: "2026-09-15T11:00:00Z", lastActiveAt: "2026-09-15T11:00:00Z" });
  });
  it("moves an existing record to the head, keeps startedAt, updates cwd and lastActiveAt", () => {
    const out = upsertSession([rec("a"), rec("b")], { sessionId: "b", cwd: "/b2", skipPermissions: false }, "2026-09-15T12:00:00Z");
    expect(out.map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(out[0].startedAt).toBe("2026-09-15T10:00:00Z");
    expect(out[0].lastActiveAt).toBe("2026-09-15T12:00:00Z");
    expect(out[0].cwd).toBe("/b2");
  });
  it("caps at SESSIONS_MAX dropping the oldest", () => {
    let list: SessionRecord[] = [];
    for (let i = 0; i < SESSIONS_MAX + 3; i++) list = upsertSession(list, { sessionId: `s${i}`, cwd: "/x", skipPermissions: false }, `2026-09-15T10:${String(i).padStart(2, "0")}:00Z`);
    expect(list).toHaveLength(SESSIONS_MAX);
    expect(list[0].sessionId).toBe(`s${SESSIONS_MAX + 2}`);
    expect(list.at(-1)?.sessionId).toBe("s3");
  });
  it("works from undefined", () => {
    expect(upsertSession(undefined, { sessionId: "a", cwd: "/a", skipPermissions: false }, "t")).toHaveLength(1);
  });
});

describe("bumpSession", () => {
  it("updates only the matching record's lastActiveAt and keeps order", () => {
    const out = bumpSession([rec("a"), rec("b")], "b", "2026-09-15T13:00:00Z")!;
    expect(out.map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(out[1].lastActiveAt).toBe("2026-09-15T13:00:00Z");
    expect(out[0].lastActiveAt).toBe("2026-09-15T10:00:00Z");
  });
  it("returns undefined when nothing matches", () => {
    expect(bumpSession([rec("a")], "zz", "t")).toBeUndefined();
    expect(bumpSession(undefined, "a", "t")).toBeUndefined();
  });
});

describe("promoteSession / removeSession", () => {
  it("promote moves to head and bumps lastActiveAt", () => {
    const out = promoteSession([rec("a"), rec("b")], "b", "2026-09-15T14:00:00Z");
    expect(out.map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(out[0].lastActiveAt).toBe("2026-09-15T14:00:00Z");
  });
  it("remove drops the record and tolerates undefined", () => {
    expect(removeSession([rec("a"), rec("b")], "a").map((r) => r.sessionId)).toEqual(["b"]);
    expect(removeSession(undefined, "a")).toEqual([]);
  });
});

describe("sanitizeSessions", () => {
  it("keeps well-formed records, drops malformed ones, and caps", () => {
    const good = rec("a");
    const out = sanitizeSessions([good, { sessionId: 1 }, "x", { ...rec("b"), cwd: "rel" }, null])!;
    expect(out).toEqual([good]);
    expect(sanitizeSessions(undefined)).toBeUndefined();
    expect(sanitizeSessions("nope")).toBeUndefined();
    expect(sanitizeSessions([])).toEqual([]);
  });
});
```

`src/lib/workspace.test.ts`, add:

```ts
describe("sessions in the workspace file", () => {
  const sess = [{ sessionId: "s1", cwd: "/p", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }];
  it("toWorkspace writes sessions and sameWorkspaceContent compares them", () => {
    const base = {
      order: ["a"],
      terminals: { a: { id: "a", name: "A", cwd: "/p" } },
      settings: { a: { ...EMPTY_SETTINGS, sessions: sess } },
      layout: { kind: "group" as const, id: "g", tabs: ["a"], active: "a" },
      machines: {},
    };
    const ws = toWorkspace(base);
    expect(ws.terminals[0].sessions).toEqual(sess);
    const without = toWorkspace({ ...base, settings: { a: EMPTY_SETTINGS } });
    expect(sameWorkspaceContent(ws, without)).toBe(false);
    expect(sameWorkspaceContent(ws, toWorkspace(base))).toBe(true);
  });
  it("omits the key when there are no sessions", () => {
    const ws = toWorkspace({ order: ["a"], terminals: { a: { id: "a", name: "A", cwd: "/p" } }, settings: { a: EMPTY_SETTINGS }, layout: null, machines: {} });
    expect("sessions" in ws.terminals[0]).toBe(false);
  });
});
```

`src/lib/agentState.test.ts`: extend the `ev` helper's literal with `cwd: null, permissionMode: null,` so it satisfies the new type (no behaviour assertion needed).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sessions.test.ts src/lib/workspace.test.ts 2>&1 | grep -E "×|Failed to resolve|Tests " | head`
Expected: sessions tests fail to resolve the module; workspace tests fail on `sessions` missing.

- [ ] **Step 3: Implement**

`src/lib/sessions.ts`:

```ts
export const SESSIONS_MAX = 20;

/** One Claude session that ran in a tile, and where. Newest first in `sessions`. */
export interface SessionRecord {
  sessionId: string;
  cwd: string;
  skipPermissions: boolean;
  startedAt: string;
  lastActiveAt: string;
}

export function isSafeFolder(p: string): boolean {
  return p.startsWith("/") && !/[\x00-\x1f\x7f]/.test(p);
}

export function upsertSession(
  list: SessionRecord[] | undefined,
  rec: { sessionId: string; cwd: string; skipPermissions: boolean },
  now: string,
): SessionRecord[] {
  const rest = (list ?? []).filter((r) => r.sessionId !== rec.sessionId);
  const prev = (list ?? []).find((r) => r.sessionId === rec.sessionId);
  const head: SessionRecord = { ...rec, startedAt: prev?.startedAt ?? now, lastActiveAt: now };
  return [head, ...rest].slice(0, SESSIONS_MAX);
}

export function bumpSession(list: SessionRecord[] | undefined, sessionId: string, now: string): SessionRecord[] | undefined {
  if (!list?.some((r) => r.sessionId === sessionId)) return undefined;
  return list.map((r) => (r.sessionId === sessionId ? { ...r, lastActiveAt: now } : r));
}

export function promoteSession(list: SessionRecord[], sessionId: string, now: string): SessionRecord[] {
  const hit = list.find((r) => r.sessionId === sessionId);
  if (!hit) return list;
  return [{ ...hit, lastActiveAt: now }, ...list.filter((r) => r.sessionId !== sessionId)];
}

export function removeSession(list: SessionRecord[] | undefined, sessionId: string): SessionRecord[] {
  return (list ?? []).filter((r) => r.sessionId !== sessionId);
}

function isRecord(v: unknown): v is SessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sessionId === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(o.sessionId) &&
    typeof o.cwd === "string" &&
    isSafeFolder(o.cwd) &&
    typeof o.skipPermissions === "boolean" &&
    typeof o.startedAt === "string" &&
    typeof o.lastActiveAt === "string"
  );
}

/** Records loaded from workspace.json: well-formed ones only, capped. Undefined when absent or not a list. */
export function sanitizeSessions(v: unknown): SessionRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(isRecord).slice(0, SESSIONS_MAX);
}
```

`src/lib/workspace.ts`:
- `import { sanitizeSessions, type SessionRecord } from "./sessions";`
- In `TerminalSettings` add `/** Claude sessions that ran in this tile, newest first. */ sessions?: SessionRecord[];`
- In `toWorkspace`'s returned def add `...(s.sessions?.length ? { sessions: s.sessions } : {}),` after the `origin` spread.
- In `sameWorkspaceContent`'s per-terminal key add `sessions: t.sessions ?? [],`.
- Export `sanitizeSessions` is not needed from workspace; the store imports it from `./lib/sessions`.

`src/lib/agentState.ts`: add `cwd: string | null; permissionMode: string | null;` to `AgentEvent`.

`src/lib/ipc.ts`, after `terminalForegroundBusy`:

```ts
  terminalCwd: (id: string) => invoke<string | null>("terminal_cwd", { id }),
  setTerminalCwd: (id: string, cwd: string) => invoke<TerminalInfo>("set_terminal_cwd", { id, cwd }),
```

`src/store.ts`:
- `KNOWN_DEF_KEYS` gains `"sessions"`.
- In `settingsFromDef`, the returned settings gain `sessions: sanitizeSessions(d.sessions)` (import from `./lib/sessions`), placed before `extra` so key order stays `ssh, claude, command, sessions, extra, origin`. Because `openDefs` compares settings with `JSON.stringify`, also make `openingFor`'s result carry no `sessions` key (it does not today; nothing to change) and ensure `EMPTY_SETTINGS`-based settings created by `createTerminal`/`createSshTerminal` do not get a `sessions` key until one is needed.
- Add the six new ipc mocks `terminalCwd: vi.fn(async () => null)`, `setTerminalCwd: vi.fn(async (id: string, cwd: string) => ({ id, name: "x", cwd, exited: null, error: null }))` to the ipc mock in `src/store.test.ts`, `src/components/Sidebar.test.tsx`, `src/components/NewRemoteTerminal.test.tsx`, `src/components/TerminalPane.test.tsx`, `src/components/TabGroup.test.tsx`, and `src/lib/xtermRegistry.test.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sessions.ts src/lib/sessions.test.ts src/lib/workspace.ts src/lib/workspace.test.ts src/lib/agentState.ts src/lib/agentState.test.ts src/lib/ipc.ts src/store.ts src/store.test.ts src/components/*.test.tsx src/lib/xtermRegistry.test.ts
git commit -m "feat(ui): session records on terminal defs; cwd and permission mode on hook events; cwd ipc

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Store: `setTerminalCwd` routing

**Files:**
- Modify: `src/store.ts` (interface, action), `src/store.test.ts`

**Interfaces:**
- Produces: `setTerminalCwd(id: string, cwd: string, source: "poll" | "osc7" | "hook"): Promise<void>` on the store.

- [ ] **Step 1: Write the failing tests**

Append to `src/store.test.ts`:

```ts
describe("setTerminalCwd", () => {
  it("local tile: updates the registry then the store", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    await useStore.getState().setTerminalCwd(id, "/tmp/b", "poll");
    expect(ipc.setTerminalCwd).toHaveBeenCalledWith(id, "/tmp/b");
    expect(useStore.getState().terminals[id].cwd).toBe("/tmp/b");
  });
  it("ssh tile: updates settings.ssh.cwd and never calls the registry", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    vi.mocked(ipc.setTerminalCwd).mockClear();
    await useStore.getState().setTerminalCwd(id, "/q", "osc7");
    expect(ipc.setTerminalCwd).not.toHaveBeenCalled();
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/q");
  });
  it("foreign local: updates settings.foreign.cwd", async () => {
    const id = await useStore.getState().createTerminal("/home/me");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], ssh: { host: "root@desk", cwd: "/proj", machine: "desk" }, foreign: { cwd: "/proj" }, origin: "desk" } },
    }));
    await useStore.getState().setTerminalCwd(id, "/proj/sub", "hook");
    expect(useStore.getState().settings[id].foreign?.cwd).toBe("/proj/sub");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/proj/sub");
  });
  it("ignores unchanged, relative, and unsafe values, and unknown ids", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.setTerminalCwd).mockClear();
    await useStore.getState().setTerminalCwd(id, "/tmp/a", "poll");
    await useStore.getState().setTerminalCwd(id, "rel", "poll");
    await useStore.getState().setTerminalCwd(id, "/bad\x1b", "poll");
    await useStore.getState().setTerminalCwd("nope", "/x", "poll");
    expect(ipc.setTerminalCwd).not.toHaveBeenCalled();
  });
  it("a registry failure leaves the store untouched", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.setTerminalCwd).mockRejectedValueOnce("no");
    await useStore.getState().setTerminalCwd(id, "/tmp/b", "poll");
    expect(useStore.getState().terminals[id].cwd).toBe("/tmp/a");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/store.test.ts -t "setTerminalCwd" 2>&1 | grep -E "×|is not a function" | head -3`
Expected: `setTerminalCwd is not a function`.

- [ ] **Step 3: Implement**

`src/store.ts`: interface `setTerminalCwd(id: string, cwd: string, source: "poll" | "osc7" | "hook"): Promise<void>;` and the action (import `isSafeFolder` from `./lib/sessions`):

```ts
  async setTerminalCwd(id, cwd, _source) {
    const s = useStore.getState();
    const t = s.terminals[id];
    if (!t || !isSafeFolder(cwd)) return;
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    if (settings.foreign) {
      if (settings.foreign.cwd === cwd) return;
      set((st) => {
        const cur = st.settings[id];
        if (!cur?.foreign) return {};
        return { settings: { ...st.settings, [id]: { ...cur, foreign: { cwd }, ssh: cur.ssh ? { ...cur.ssh, cwd } : cur.ssh } } };
      });
      return;
    }
    if (settings.ssh) {
      if (settings.ssh.cwd === cwd) return;
      set((st) => {
        const cur = st.settings[id];
        if (!cur?.ssh) return {};
        return { settings: { ...st.settings, [id]: { ...cur, ssh: { ...cur.ssh, cwd } } } };
      });
      return;
    }
    if (t.cwd === cwd) return;
    try {
      const info = await ipc.setTerminalCwd(id, cwd);
      set((st) => (st.terminals[id] ? { terminals: { ...st.terminals, [id]: { ...st.terminals[id], cwd: info.cwd } } } : {}));
    } catch {
      // registry refused (unknown id or bad path); the next poll will try again
    }
  },
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): setTerminalCwd routes a tile's new folder to registry, ssh or foreign settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: xterm registry: folder polling and OSC 7

**Files:**
- Modify: `src/lib/xtermRegistry.ts`, `src/lib/xtermRegistry.test.ts`

**Interfaces:**
- Consumes: `ipc.terminalCwd`, store `setTerminalCwd`.
- Produces: exported constants `CWD_POLL_AFTER_ENTER_MS = 300`, `CWD_POLL_INTERVAL_MS = 5000`; exported `decodeOsc7(data: string): string | null`.

- [ ] **Step 1: Write the failing tests**

Extend the fake `Terminal` in `src/lib/xtermRegistry.test.ts` with a parser and a data handler capture:

```ts
    dataHandler: ((d: string) => void) | null = null;
    oscHandlers: Record<number, (data: string) => boolean | Promise<boolean>> = {};
    parser = { registerOscHandler: (n: number, cb: (data: string) => boolean | Promise<boolean>) => { this.oscHandlers[n] = cb; return { dispose: () => {} }; } };
    onData(cb: (d: string) => void) { this.dataHandler = cb; }
```

Add `terminalCwd: vi.fn(async () => null), setTerminalCwd: vi.fn(async (id: string, cwd: string) => ({ id, name: "x", cwd, exited: null, error: null }))` to the ipc mock in this file if Task 2 did not already. Then add:

```ts
describe("folder tracking", () => {
  beforeEach(() => {
    useStore.setState({ terminals: { f: { id: "f", name: "f", cwd: "/a", exited: null, error: null } }, order: ["f"], settings: { f: { ssh: null, claude: null, command: null, extra: {} } } });
    vi.mocked(ipc.terminalCwd).mockReset().mockResolvedValue("/b");
    vi.mocked(ipc.setTerminalCwd).mockClear();
  });

  it("polls the folder 300 ms after Enter and applies a change", async () => {
    vi.useFakeTimers();
    try {
      const { term } = attach("f", document.createElement("div"));
      (term as unknown as { dataHandler: (d: string) => void }).dataHandler("\r");
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      expect(ipc.terminalCwd).toHaveBeenCalledWith("f");
      await vi.advanceTimersByTimeAsync(0);
      expect(ipc.setTerminalCwd).toHaveBeenCalledWith("f", "/b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls on the interval and stops after dispose", async () => {
    vi.useFakeTimers();
    try {
      attach("f", document.createElement("div"));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.terminalCwd).toHaveBeenCalledTimes(1);
      dispose("f");
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS * 2);
      expect(ipc.terminalCwd).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never polls an ssh tile or an exited tile", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState((s) => ({ settings: { ...s.settings, f: { ...s.settings.f, ssh: { host: "me@box", cwd: "/p" } } } }));
      const { term } = attach("f", document.createElement("div"));
      (term as unknown as { dataHandler: (d: string) => void }).dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS + CWD_POLL_AFTER_ENTER_MS);
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
      useStore.setState((s) => ({ settings: { ...s.settings, f: { ...s.settings.f, ssh: null } }, terminals: { f: { ...s.terminals.f, exited: 0 } } }));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("OSC 7 applies the decoded path for any tile", async () => {
    const { term } = attach("f", document.createElement("div"));
    const handler = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[7];
    expect(handler("file://box/Users/me/my%20proj")).toBe(true);
    await vi.waitFor(() => expect(ipc.setTerminalCwd).toHaveBeenCalledWith("f", "/Users/me/my proj"));
  });

  it("decodeOsc7 handles hostless and malformed payloads", () => {
    expect(decodeOsc7("file://localhost/a/b")).toBe("/a/b");
    expect(decodeOsc7("file:///a/b")).toBe("/a/b");
    expect(decodeOsc7("/plain")).toBe("/plain");
    expect(decodeOsc7("nonsense")).toBeNull();
    expect(decodeOsc7("file://h/%ZZ")).toBeNull();
  });
});
```

Import `CWD_POLL_AFTER_ENTER_MS`, `CWD_POLL_INTERVAL_MS`, `decodeOsc7` from `./xtermRegistry` and `ipc` from `./ipc` in the test.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/xtermRegistry.test.ts 2>&1 | grep -E "×|does not provide|Tests " | head`
Expected: new tests fail on missing exports.

- [ ] **Step 3: Implement**

In `src/lib/xtermRegistry.ts`:

```ts
export const CWD_POLL_AFTER_ENTER_MS = 300;
export const CWD_POLL_INTERVAL_MS = 5000;

/** The path inside an OSC 7 payload (`file://host/path`, `file:///path`, or a bare path). */
export function decodeOsc7(data: string): string | null {
  let path = data;
  if (data.startsWith("file://")) {
    const rest = data.slice("file://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    path = rest.slice(slash);
  }
  if (!path.startsWith("/")) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}
```

Extend `Entry` with `enterTimer: ReturnType<typeof setTimeout> | null; pollTimer: ReturnType<typeof setInterval> | null;` (initialised null in `createEntry`). In `createEntry`, inside `term.onData` after the write: `if (data.includes("\r")) scheduleEnterPoll(id, entry);`. Register the OSC handler in `createEntry`:

```ts
  term.parser.registerOscHandler(7, (data) => {
    const path = decodeOsc7(data);
    if (path) void useStore.getState().setTerminalCwd(id, path, "osc7");
    return true;
  });
```

Module helpers:

```ts
function localTileAlive(id: string): boolean {
  const s = useStore.getState();
  return !!s.terminals[id] && s.terminals[id].exited === null && !s.settings[id]?.ssh;
}

async function pollCwd(id: string): Promise<void> {
  if (!localTileAlive(id)) return;
  try {
    const cwd = await ipc.terminalCwd(id);
    if (cwd) await useStore.getState().setTerminalCwd(id, cwd, "poll");
  } catch {
    // lsof missing or the tile is gone; the next poll or OSC 7 will catch up
  }
}

function scheduleEnterPoll(id: string, entry: Entry): void {
  if (entry.enterTimer) clearTimeout(entry.enterTimer);
  entry.enterTimer = setTimeout(() => {
    entry.enterTimer = null;
    void pollCwd(id);
  }, CWD_POLL_AFTER_ENTER_MS);
}
```

In `attach`, when the terminal is first opened, start the interval: `entry.pollTimer = setInterval(() => void pollCwd(id), CWD_POLL_INTERVAL_MS);`. In `dispose`, clear both timers before `term.dispose()`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass. The `TerminalPane.test.tsx` and `TabGroup.test.tsx` mocks of `../lib/xtermRegistry` are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/xtermRegistry.ts src/lib/xtermRegistry.test.ts
git commit -m "feat(ui): tiles follow their shell's folder via polling after Enter and OSC 7

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Store: session adoption from hook events

**Files:**
- Modify: `src/store.ts` (`applyAgentEvent`), `src/store.test.ts`

**Interfaces:**
- Consumes: `upsertSession`, `bumpSession` from `./lib/sessions`; `setTerminalCwd` from Task 3.

- [ ] **Step 1: Write the failing tests**

Inside `describe("agent state")` in `src/store.test.ts` (the `ev(...)` helper there builds `{ host, event }`; extend its event literal with `cwd: null, permissionMode: null` defaults if Task 2 did not):

```ts
  it("SessionStart with a new session id adopts it, records it, and applies its folder", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "new1", cwd: "/tmp/sub", permissionMode: "bypassPermissions" }));
    await vi.waitFor(() => expect(useStore.getState().terminals[id].cwd).toBe("/tmp/sub"));
    const s = useStore.getState().settings[id];
    expect(s.claude).toEqual({ enabled: true, sessionId: "new1", skipPermissions: true, started: false });
    expect(s.sessions?.[0]).toMatchObject({ sessionId: "new1", cwd: "/tmp/sub", skipPermissions: true });
  });

  it("SessionStart with the current session id only bumps the record", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true } });
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "cur", cwd: "/tmp/a", permissionMode: "default", ts: "2026-09-15T10:00:00Z" }));
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "cur", cwd: "/tmp/a", permissionMode: "default", ts: "2026-09-15T10:05:00Z" }));
    const s = useStore.getState().settings[id];
    expect(s.claude?.started).toBe(true);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions?.[0].lastActiveAt).toBe("2026-09-15T10:05:00Z");
    expect(s.sessions?.[0].startedAt).toBe("2026-09-15T10:00:00Z");
  });

  it("prompts and stops bump lastActiveAt and prompts apply the folder", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "s", cwd: "/tmp/a", ts: "2026-09-15T10:00:00Z" }));
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit", { sessionId: "s", cwd: "/tmp/moved", ts: "2026-09-15T10:01:00Z" }));
    await vi.waitFor(() => expect(useStore.getState().terminals[id].cwd).toBe("/tmp/moved"));
    useStore.getState().applyAgentEvent(ev(id, "Stop", { sessionId: "s", ts: "2026-09-15T10:02:00Z" }));
    expect(useStore.getState().settings[id].sessions?.[0].lastActiveAt).toBe("2026-09-15T10:02:00Z");
  });

  it("an ssh tile's folder follows the hook's cwd into settings.ssh.cwd", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    useStore.getState().applyAgentEvent({ ...ev(id, "SessionStart", { sessionId: "r1", cwd: "/p/deeper" }), host: "me@box" });
    await vi.waitFor(() => expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper"));
    expect(useStore.getState().settings[id].sessions?.[0].cwd).toBe("/p/deeper");
  });

  it("a tile with a custom command is never adopted", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { command: "npm run dev" });
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "x", cwd: "/tmp/z" }));
    expect(useStore.getState().settings[id].claude).toBeNull();
    expect(useStore.getState().settings[id].sessions).toBeUndefined();
  });

  it("SessionEnd changes nothing in history", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "s", cwd: "/tmp/a" }));
    const before = useStore.getState().settings[id].sessions;
    useStore.getState().applyAgentEvent(ev(id, "SessionEnd", { sessionId: "s" }));
    expect(useStore.getState().settings[id].sessions).toBe(before);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/store.test.ts -t "adopts|only bumps|bump lastActiveAt|follows the hook|never adopted|changes nothing" 2>&1 | grep -E "×|✓" | head`
Expected: all six fail.

- [ ] **Step 3: Implement**

In `applyAgentEvent` (`src/store.ts`), after the existing `patch` computation and before `return patch;`, add adoption. The `set` callback must stay synchronous, so compute the settings patch inside it and call `setTerminalCwd` after `set` returns:

```ts
      // Session adoption and history (folder/session spec §4).
      const trimmed = settings.command?.trim();
      let folderToApply: string | null = null;
      if (!trimmed && event.sessionId) {
        const now = event.ts;
        const base = patch.settings?.[id] ?? settings;
        let next: TerminalSettings | null = null;
        if (event.event === "SessionStart") {
          const skipPermissions = event.permissionMode === "bypassPermissions";
          const cwd = event.cwd && isSafeFolder(event.cwd) ? event.cwd : (base.sessions?.find((r) => r.sessionId === event.sessionId)?.cwd ?? null);
          if (cwd) {
            const sessions = upsertSession(base.sessions, { sessionId: event.sessionId, cwd, skipPermissions }, now);
            const claude = base.claude?.enabled && base.claude.sessionId === event.sessionId
              ? base.claude
              : { enabled: true, sessionId: event.sessionId, skipPermissions, started: false };
            next = { ...base, sessions, claude };
            folderToApply = cwd;
          }
        } else if (["UserPromptSubmit", "Stop", "StopFailure", "Notification"].includes(event.event)) {
          const bumped = bumpSession(base.sessions, event.sessionId, now);
          if (bumped) next = { ...base, sessions: bumped };
          if (event.event === "UserPromptSubmit" && event.cwd && isSafeFolder(event.cwd)) folderToApply = event.cwd;
        }
        if (next) patch.settings = { ...(patch.settings ?? s.settings), [id]: next };
      }
      return patch;
    });
    if (folderToApply) void useStore.getState().setTerminalCwd(id, folderToApply, "hook");
```

`folderToApply` and `id` must be declared outside the `set` callback (`let folderToApply: string | null = null; const id = event.terminal;` before `set`, and inside the callback assign rather than declare). Import `bumpSession`, `upsertSession`, `isSafeFolder` from `./lib/sessions` and `TerminalSettings` type if not already imported.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): adopt the live Claude session and folder from hook events; per-tile session history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Going back: `selectSession`, the list component, card and sidebar

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`
- Create: `src/components/SessionHistory.tsx`, `src/components/SessionHistory.test.tsx`
- Modify: `src/components/TerminalPane.tsx`, `src/components/TerminalPane.test.tsx`, `src/components/Sidebar.tsx`, `src/components/Sidebar.test.tsx`

**Interfaces:**
- Produces: store `selectSession(id: string, sessionId: string, opts: { connect: boolean }): Promise<void>`; component `SessionHistory({ id, onPick }: { id: string; onPick?: () => void })` rendering rows with `data-testid="session-row-<sessionId>"`.

- [ ] **Step 1: Write the failing store tests**

Append to `src/store.test.ts`:

```ts
describe("selectSession", () => {
  const rec = (sid: string, cwd: string, t: string) => ({ sessionId: sid, cwd, skipPermissions: sid === "old", startedAt: t, lastActiveAt: t });
  it("makes the record current, applies its folder, moves it to the head, and connects when asked", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [rec("cur", "/tmp/a", "t2"), rec("old", "/tmp/old", "t1")] } },
      startupPending: { ...s.startupPending, [id]: true },
    }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: true });
    const s = useStore.getState();
    expect(s.settings[id].claude).toEqual({ enabled: true, sessionId: "old", skipPermissions: true, started: true });
    expect(s.settings[id].sessions?.map((r) => r.sessionId)).toEqual(["old", "cur"]);
    expect(s.terminals[id].cwd).toBe("/tmp/old");
    expect(ipc.writeTerminal).toHaveBeenCalledWith(id, expect.stringContaining("--resume old"));
    expect(s.startupPending[id]).toBe(false);
  });
  it("without connect and with a busy shell it only becomes current and notes the switch", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], sessions: [rec("old", "/tmp/old", "t1")] } } }));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValueOnce(true);
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: false });
    expect(useStore.getState().settings[id].claude?.sessionId).toBe("old");
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().startupNotes[id]).toBe("switch takes effect on next Connect");
  });
  it("without connect and an idle local shell it types the resume line", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], sessions: [rec("old", "/tmp/old", "t1")] } } }));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValueOnce(false);
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: false });
    expect(ipc.writeTerminal).toHaveBeenCalledWith(id, expect.stringMatching(/^cd '\/tmp\/old' && claude .*--resume old\r$/));
  });
  it("unknown session ids are ignored", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    await useStore.getState().selectSession(id, "zz", { connect: true });
    expect(useStore.getState().settings[id].claude).toBeNull();
  });
});
```

Note the third test: for a local tile the typed line is `cd '<folder>' && <claude line>` so Claude starts in the record's folder even if the shell moved; for an ssh tile `runRemoteStep`'s line already contains the `cd`.

- [ ] **Step 2: Write the failing component tests**

`src/components/SessionHistory.test.tsx` (copy the ipc mock block and the jsdom directive from `TerminalPane.test.tsx`, plus the `../lib/xtermRegistry` mock and `FakeResizeObserver` are not needed here):

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Paste the whole `vi.mock("../lib/ipc", …)` block from src/components/TerminalPane.test.tsx here
// verbatim (it already includes terminalCwd and setTerminalCwd after Task 2).
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { useStore } from "../store";
import { SessionHistory } from "./SessionHistory";

const ID = "t1";
const rec = (sid: string, cwd: string, t: string) => ({ sessionId: sid, cwd, skipPermissions: false, startedAt: t, lastActiveAt: t });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: null, error: null } },
    order: [ID],
    settings: { [ID]: { ssh: null, claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, command: null, extra: {}, sessions: [rec("cur", "/home/me/a", "2026-09-15T10:00:00Z"), rec("old", "/home/me/b", "2026-09-15T09:00:00Z"), rec("older", "/home/me/c", "2026-09-15T08:00:00Z")] } },
    startupPending: {},
    startupNotes: {},
  });
});
afterEach(cleanup);

describe("SessionHistory", () => {
  it("lists previous sessions newest first, excluding the current one, with folder basename and full path tooltip", () => {
    render(<SessionHistory id={ID} />);
    const rows = screen.getAllByRole("button", { name: /ago|just now/ });
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["session-row-old", "session-row-older"]);
    expect(screen.getByTestId("session-row-old").textContent).toContain("b");
    expect(screen.getByTestId("session-row-old").title).toBe("/home/me/b");
  });
  it("renders nothing when there are no previous sessions", () => {
    useStore.setState((s) => ({ settings: { ...s.settings, [ID]: { ...s.settings[ID], sessions: [rec("cur", "/x", "t")] } } }));
    const { container } = render(<SessionHistory id={ID} />);
    expect(container.textContent).toBe("");
  });
  it("clicking a row selects it with connect and calls onPick", async () => {
    const select = vi.fn(async () => {});
    useStore.setState({ selectSession: select });
    const onPick = vi.fn();
    render(<SessionHistory id={ID} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("session-row-old"));
    expect(select).toHaveBeenCalledWith(ID, "old", { connect: true });
    expect(onPick).toHaveBeenCalled();
  });
  it("caps at five rows", () => {
    const many = Array.from({ length: 8 }, (_, i) => rec(`s${i}`, `/p${i}`, `2026-09-15T0${i}:00:00Z`));
    useStore.setState((s) => ({ settings: { ...s.settings, [ID]: { ...s.settings[ID], sessions: many } } }));
    render(<SessionHistory id={ID} />);
    expect(screen.getAllByRole("button").length).toBe(5);
  });
});
```

`src/components/TerminalPane.test.tsx`, add:

```tsx
  it("the connect card lists previous sessions", () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, [ID]: { ...s.settings[ID], sessions: [{ sessionId: "abc", cwd: "/proj", skipPermissions: true, startedAt: "t", lastActiveAt: "t" }, { sessionId: "old", cwd: "/other", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    render(<TerminalPane id={ID} />);
    expect(screen.getByText("Previous sessions in this tile")).toBeTruthy();
    expect(screen.getByTestId("session-row-old")).toBeTruthy();
    expect(screen.queryByTestId("session-row-abc")).toBeNull();
  });
```

`src/components/Sidebar.test.tsx`, add:

```tsx
describe("session history popover", () => {
  it("shows a history button when the tile has previous sessions and opens the list", () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, [ID]: { ...s.settings[ID], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [{ sessionId: "cur", cwd: "/a", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }, { sessionId: "old", cwd: "/b", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    expect(screen.getByTestId("session-row-old")).toBeTruthy();
  });
  it("hides the history button without previous sessions", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Previous sessions" })).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/store.test.ts -t "selectSession" src/components/SessionHistory.test.tsx src/components/TerminalPane.test.tsx src/components/Sidebar.test.tsx 2>&1 | grep -E "×|Failed to resolve|is not a function" | head`
Expected: failures on the missing action, module and UI.

- [ ] **Step 4: Implement**

`src/store.ts` interface: `selectSession(id: string, sessionId: string, opts: { connect: boolean }): Promise<void>;` and action (import `promoteSession`):

```ts
  async selectSession(id, sessionId, { connect }) {
    const s = useStore.getState();
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    const rec = settings.sessions?.find((r) => r.sessionId === sessionId);
    if (!s.terminals[id] || !rec) return;
    const now = new Date().toISOString();
    set((st) => {
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      return {
        settings: {
          ...st.settings,
          [id]: { ...cur, claude: { enabled: true, sessionId, skipPermissions: rec.skipPermissions, started: true }, sessions: promoteSession(cur.sessions ?? [], sessionId, now) },
        },
        startupNotes: omit(st.startupNotes, id),
      };
    });
    await useStore.getState().setTerminalCwd(id, rec.cwd, "hook");
    const after = useStore.getState();
    const isSsh = !!after.settings[id]?.ssh;
    if (connect) {
      await useStore.getState().runStartup(id);
      return;
    }
    const busy = await safeForegroundBusy(id);
    const live = isSsh ? await tileLive(id, after.settings[id]!.ssh!.host) : !busy;
    if (!live || (isSsh && busy)) {
      set((st) => ({ startupNotes: { ...st.startupNotes, [id]: "switch takes effect on next Connect" } }));
      return;
    }
    if (isSsh) {
      await useStore.getState().runRemoteStep(id);
    } else {
      const claude = startupSteps(after.settings[id] ?? EMPTY_SETTINGS, id).find((st) => st.via === "local")?.line;
      if (!claude) return;
      await ipc.writeTerminal(id, `cd ${shellQuote(rec.cwd)} && ${claude}\r`);
      set((st) => ({ startupPending: { ...st.startupPending, [id]: false } }));
    }
  },
```

`shellQuote` is exported from `./lib/workspace`; import it. For a local tile with an idle shell, "live" means simply not busy; `tileLive` is for ssh tiles. If `runRemoteStep` for a connected ssh tile requires `sshConnected[id]`, that is already the case for a live tile.

`src/components/SessionHistory.tsx`:

```tsx
import { useStore } from "../store";

const MAX_ROWS = 5;

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Previous Claude sessions of one tile, newest first, current one excluded. Empty when none. */
export function SessionHistory({ id, onPick }: { id: string; onPick?: () => void }) {
  const sessions = useStore((s) => s.settings[id]?.sessions);
  const current = useStore((s) => s.settings[id]?.claude?.sessionId ?? null);
  const selectSession = useStore((s) => s.selectSession);
  const rows = (sessions ?? []).filter((r) => r.sessionId !== current).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs uppercase tracking-wide text-neutral-500">Previous sessions in this tile</div>
      {rows.map((r) => (
        <button
          key={r.sessionId}
          data-testid={`session-row-${r.sessionId}`}
          title={r.cwd}
          className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm text-neutral-200 hover:bg-neutral-800"
          onClick={() => {
            void selectSession(id, r.sessionId, { connect: true });
            onPick?.();
          }}
        >
          <span className="min-w-0 flex-1 truncate">{basename(r.cwd)}</span>
          {r.skipPermissions && <span className="rounded bg-red-900/60 px-1 text-[10px] text-red-300">skip-perms</span>}
          <span className="shrink-0 text-xs text-neutral-500">{relative(r.lastActiveAt)}</span>
        </button>
      ))}
    </div>
  );
}
```

`src/components/TerminalPane.tsx`: inside the connect card, after the `{note && …}` line, add `<SessionHistory id={id} />` (import it).

`src/components/Sidebar.tsx`: in `Row`, next to the close button, add a history button shown only when the tile has a previous session, toggling a small popover:

```tsx
  const hasHistory = useStore((s) => (s.settings[id]?.sessions ?? []).some((r) => r.sessionId !== s.settings[id]?.claude?.sessionId));
  const [historyOpen, setHistoryOpen] = useState(false);
  …
      {hasHistory && (
        <button
          className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); setHistoryOpen((v) => !v); }}
          title="Previous sessions"
          aria-label="Previous sessions"
        >
          ↺
        </button>
      )}
```

and, wrapping the row in a `relative` container, render the popover below it when open:

```tsx
      {historyOpen && (
        <div className="absolute left-2 right-2 z-30 mt-1 rounded border border-neutral-700 bg-neutral-900 p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <SessionHistory id={id} onPick={() => setHistoryOpen(false)} />
        </div>
      )}
```

Row clicks on the popover must not bubble to `focusTerminal` (the `stopPropagation` above). Selecting from the popover uses `connect: true` via the component; the spec's "idle shell types the resume line" path is what `selectSession` does when `connect` is false, which the popover does not use — the card and popover both connect. (Recorded as a simplification: one behaviour for both surfaces.)

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/store.test.ts src/components/SessionHistory.tsx src/components/SessionHistory.test.tsx src/components/TerminalPane.tsx src/components/TerminalPane.test.tsx src/components/Sidebar.tsx src/components/Sidebar.test.tsx
git commit -m "feat(ui): go back to a previous Claude session from the connect card or the sidebar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Dead session detection

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`, `src/lib/xtermRegistry.ts`, `src/lib/xtermRegistry.test.ts`

**Interfaces:**
- Produces: store `resumeWatch: Record<string, { sessionId: string; until: number }>`, `watchResume(id: string, sessionId: string): void`, `noteResumeFailure(id: string, sessionId: string): void`; `RESUME_WATCH_MS = 10_000`; xterm registry scans PTY output while a watch is active.

- [ ] **Step 1: Write the failing tests**

`src/store.test.ts`:

```ts
describe("dead session detection", () => {
  it("typing a resume line arms a 10 s watch", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createTerminal("/tmp/a");
      useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "gone", skipPermissions: false, started: true } });
      await useStore.getState().runStartup(id);
      expect(useStore.getState().resumeWatch[id]).toMatchObject({ sessionId: "gone" });
      await vi.advanceTimersByTimeAsync(RESUME_WATCH_MS + 1);
      expect(useStore.getState().resumeWatch[id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("noteResumeFailure removes the record, unstarts the session, and notes it", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "gone", skipPermissions: false, started: true }, sessions: [{ sessionId: "gone", cwd: "/tmp/a", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }, { sessionId: "keep", cwd: "/k", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
      resumeWatch: { [id]: { sessionId: "gone", until: Date.now() + 5000 } },
    }));
    useStore.getState().noteResumeFailure(id, "gone");
    const s = useStore.getState();
    expect(s.settings[id].sessions?.map((r) => r.sessionId)).toEqual(["keep"]);
    expect(s.settings[id].claude?.started).toBe(false);
    expect(s.startupNotes[id]).toBe("session gone is gone; Connect starts a new one");
    expect(s.startupPending[id]).toBe(true);
    expect(s.resumeWatch[id]).toBeUndefined();
  });
  it("a failure for a session that is not the current one only drops the record", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [{ sessionId: "other", cwd: "/o", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    useStore.getState().noteResumeFailure(id, "other");
    expect(useStore.getState().settings[id].claude?.started).toBe(true);
    expect(useStore.getState().settings[id].sessions).toEqual([]);
  });
});
```

`src/lib/xtermRegistry.test.ts` (the fake ipc `onData` mock must capture its callback: change it to `onData: vi.fn(async (_id: string, cb: (b: Uint8Array) => void) => { dataCallbacks[_id] = cb; return () => {}; })` with a hoisted `dataCallbacks` record):

```ts
describe("resume failure scanning", () => {
  it("reports the phrase for the watched session even when split across chunks", async () => {
    const note = vi.fn();
    useStore.setState({ noteResumeFailure: note, resumeWatch: { r: { sessionId: "abc", until: Date.now() + 10_000 } }, terminals: { r: { id: "r", name: "r", cwd: "/", exited: null, error: null } }, settings: { r: { ssh: null, claude: null, command: null, extra: {} } } });
    await prepare("r");
    const enc = new TextEncoder();
    dataCallbacks.r(enc.encode("No conversation found with sess"));
    dataCallbacks.r(enc.encode("ion ID abc\r\n"));
    expect(note).toHaveBeenCalledWith("r", "abc");
  });
  it("ignores output when no watch is active or the id differs", async () => {
    const note = vi.fn();
    useStore.setState({ noteResumeFailure: note, resumeWatch: {}, terminals: { q: { id: "q", name: "q", cwd: "/", exited: null, error: null } }, settings: { q: { ssh: null, claude: null, command: null, extra: {} } } });
    await prepare("q");
    dataCallbacks.q(new TextEncoder().encode("No conversation found with session ID zzz\r\n"));
    expect(note).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/store.test.ts -t "dead session" src/lib/xtermRegistry.test.ts -t "resume failure" 2>&1 | grep -E "×|is not a function" | head`
Expected: failures on missing state and actions.

- [ ] **Step 3: Implement**

`src/store.ts`:
- `export const RESUME_WATCH_MS = 10_000;`
- state `resumeWatch: Record<string, { sessionId: string; until: number }>` (initial `{}`; add `resumeWatch: {}` to the test `beforeEach` reset).
- interface `watchResume(id: string, sessionId: string): void; noteResumeFailure(id: string, sessionId: string): void;`
- actions:

```ts
  watchResume(id, sessionId) {
    const until = Date.now() + RESUME_WATCH_MS;
    set((s) => ({ resumeWatch: { ...s.resumeWatch, [id]: { sessionId, until } } }));
    setTimeout(() => {
      set((s) => (s.resumeWatch[id]?.until === until ? { resumeWatch: omit(s.resumeWatch, id) } : {}));
    }, RESUME_WATCH_MS);
  },

  noteResumeFailure(id, sessionId) {
    set((s) => {
      const cur = s.settings[id];
      if (!cur) return {};
      const isCurrent = cur.claude?.enabled && cur.claude.sessionId === sessionId;
      const claude = isCurrent && cur.claude ? { ...cur.claude, started: false } : cur.claude;
      return {
        settings: { ...s.settings, [id]: { ...cur, claude, sessions: removeSession(cur.sessions, sessionId) } },
        resumeWatch: omit(s.resumeWatch, id),
        ...(isCurrent
          ? { startupNotes: { ...s.startupNotes, [id]: `session ${sessionId} is gone; Connect starts a new one` }, startupPending: { ...s.startupPending, [id]: true } }
          : {}),
      };
    });
  },
```

- In `runStartup` after the first `ipc.writeTerminal(id, steps[0].line + "\r")`, in `runRemoteStep` after its write, and in `selectSession`'s local typed line: if the written line contains `--resume ` followed by the current session id, call `useStore.getState().watchResume(id, sessionId)`. Use a small helper: `function resumedSessionIn(line: string): string | null { const m = /--resume ([A-Za-z0-9-]{1,64})/.exec(line); return m ? m[1] : null; }`.

`src/lib/xtermRegistry.ts`: `Entry` gains `tail: string` (initial `""`). In `createEntry`'s `ipc.onData` callback, after `term.write(bytes)`:

```ts
      const watch = useStore.getState().resumeWatch[id];
      if (!watch) {
        entry.tail = "";
        return;
      }
      entry.tail = (entry.tail + new TextDecoder().decode(bytes)).slice(-400);
      if (entry.tail.includes(`No conversation found with session ID ${watch.sessionId}`)) {
        entry.tail = "";
        useStore.getState().noteResumeFailure(id, watch.sessionId);
      }
```

(The callback is defined before `entry` exists today; restructure so `entry` is created first and the listeners reference it, as the existing `ready` promise pattern already allows.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts src/lib/xtermRegistry.ts src/lib/xtermRegistry.test.ts
git commit -m "feat(ui): drop a session from history when Claude reports it is gone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Verification, spec amendment, docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-tile-folder-and-session-history-design.md` §5.2
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run everything**

Run: `npm test && npm run typecheck && (cd src-tauri && cargo test)`
Expected: all green, no warnings.

- [ ] **Step 2: Amend the spec**

Replace §5.2's first sentence with: "The sidebar row shows a ↺ button on hover when the tile has a previous session; it opens a popover with the same list. Clicking a row behaves exactly as in the connect card (makes it current and connects)." Remove the "if the tile's shell is idle … types the resume line" sentence and the "switch takes effect on next Connect" note from §5.2; `selectSession` keeps that behaviour for callers that pass `connect: false`, but no UI surface uses it yet.

- [ ] **Step 3: CLAUDE.md**

Add to the Architecture section after "Agent state":

```markdown
### Folder tracking and session history

A tile's saved folder is live: local tiles poll the shell's cwd (`terminal_cwd`, via `lsof`) 300 ms after Enter and every 5 s, and every tile honours the OSC 7 directory escape; hook events also carry Claude's cwd. Changes route through `setTerminalCwd` (registry for local, `settings.ssh.cwd` for ssh, `settings.foreign.cwd` for foreign locals). `src/lib/sessions.ts` keeps each tile's `sessions` list (newest first, max 20); `applyAgentEvent` adopts the live session on SessionStart, `selectSession` goes back to one, and a `--resume` that Claude reports as gone removes the record.
```

- [ ] **Step 4: Manual smoke (release build, after the user relaunches)**

1. In a local tile, `cd` somewhere and wait 5 s: the sidebar tooltip shows the new folder; quit and relaunch: the tile opens there.
2. Start `claude` by hand in a subfolder: the tile's dot goes green, the sidebar shows skip-perms if used, `workspace.json` gains a `sessions` entry for it.
3. Quit Claude, `cd` elsewhere, start another `claude`: the connect card (after a relaunch) lists the first as a previous session; picking it types `cd '<first folder>' && claude --resume <id>`.
4. Pick a record whose session was deleted: the note "session … is gone" appears and the record disappears.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-15-tile-folder-and-session-history-design.md
git commit -m "docs: folder tracking and session history in CLAUDE.md; spec 5.2 matches the popover

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
