# swarmz SSH Remote Browse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SSH terminals share their authenticated connection so the app can browse remote folders; Claude starts in the interactive remote shell in a folder the user picks by navigating; previous SSH hosts are remembered and offered in the SSH form.

**Architecture:** The composed `ssh` line gains OpenSSH multiplexing options. A new Rust `remote` module runs short commands over that shared socket (`ssh -O check`, a directory listing). The frontend replaces the single startup line with ordered steps (local `ssh`, then a remote `cd && claude` typed once the socket reports connected), polls for connection in the store, and adds a remote folder picker, a "choose a folder" bar state, and an SSH history in the workspace file.

**Tech Stack:** unchanged (Tauri 2, Rust std::process, React 19, zustand 5, vitest 4, OpenSSH ≥ 8 on the local Mac).

**Spec:** `docs/superpowers/specs/2026-09-11-ssh-remote-browse-design.md` (amends `2026-09-11-workspace-persistence-design.md`).

## Global Constraints

- The ssh line is exactly `ssh -t -o ControlMaster=auto -o ControlPath=~/.swarmz/ssh/%C -o ControlPersist=10m <host>`; the core uses the same `ControlPath` with `-o ControlMaster=no -o BatchMode=yes` for its commands. `~` is expanded by ssh itself.
- `<HOME>/.swarmz/ssh` is created with mode 0700 before any ssh command runs.
- Startup steps table (spec section 3) is binding; the `exec $SHELL -lic` wrapper is removed.
- Nothing is typed into a terminal except: the user's keystrokes, step 1 on Run/Connect, and the remote step after a positive `ssh_check` (plus a 300 ms settle) or after the user picks a folder while connected.
- Host strings pass the existing allowlist on both sides before reaching `ssh` argv; remote paths are single-quoted with the `'\''` rule.
- Polling: every 500 ms, give up after 120 s with a note; polling stops on success, timeout, close, or exit.
- `sshHistory` in `workspace.json` is keyed by host, values `{ cwd: string | null, lastUsed: ISO string }`, capped at 20 most recent.
- Session reset rule (controller ruling, refines spec 5.2): when a Claude terminal's `ssh.cwd` changes and `claude.started` is true, generate a fresh `sessionId`, set `started: false`, and note "folder changed; Claude will start a new session". If `started` is false the id is unused and is kept.
- Commit after every task with a conventional-commit message ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014xUXNbx7voeP3tRbbRR67s
  ```
- Never commit `node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`, `.superpowers`.

---

## File structure

```
src-tauri/src/remote.rs             ssh_dir, sh_quote, validate_host, run_with_timeout, ssh_check, ssh_list_dir, parse_listing (tested)
src-tauri/src/commands.rs           ssh_check / ssh_list_dir commands
src-tauri/src/lib.rs                register, `pub mod remote;`, create ssh dir at startup
src/lib/workspace.ts                Step, sshLine, startupSteps, startupLine (display), needsRemoteFolder, startupIsSsh, SshHistory types, touchSshHistory, toWorkspace(sshHistory)
src/lib/workspace.test.ts
src/lib/ipc.ts                      sshCheck, sshListDir
src/store.ts                        sshConnected, sshConnecting, sshHistory; polling; runStartup steps; runRemoteStep; chooseRemoteDir; forgetSshHost; session reset
src/store.test.ts
src/components/RemoteDirPicker.tsx  folder browser panel
src/components/TerminalPane.tsx     bar states: pending / connecting / choose folder
src/components/TerminalSettings.tsx Browse button
src/components/NewSshTerminal.tsx   Recent hosts, hint, optional folder
```

---

### Task 1: Rust remote module and commands

**Files:**
- Create: `src-tauri/src/remote.rs`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces Tauri commands: `ssh_check(host: String) -> Result<bool, String>` (JS `{ host }`), `ssh_list_dir(host: String, path: Option<String>) -> Result<RemoteListing, String>` (JS `{ host, path }`), `RemoteListing { path: String, parent: Option<String>, dirs: Vec<String> }` serialised as `{ path, parent, dirs }`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/remote.rs` with only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_quote_wraps_and_escapes() {
        assert_eq!(sh_quote("/proj"), "'/proj'");
        assert_eq!(sh_quote("/a'b"), "'/a'\\''b'");
    }

    #[test]
    fn validate_host_allowlist() {
        assert!(validate_host("me@host.local").is_ok());
        assert!(validate_host("10.0.0.5").is_ok());
        assert!(validate_host("").is_err());
        assert!(validate_host("-oProxyCommand=x").is_err());
        assert!(validate_host("h; ls").is_err());
        assert!(validate_host("a|b").is_err());
    }

    #[test]
    fn parse_listing_orders_dirs_and_computes_parent() {
        let out = "/Users/me/projects\nzeta/\n.hidden/\nalpha/\n.git/\n";
        let l = parse_listing(out).unwrap();
        assert_eq!(l.path, "/Users/me/projects");
        assert_eq!(l.parent.as_deref(), Some("/Users/me"));
        assert_eq!(l.dirs, vec!["alpha", "zeta", ".git", ".hidden"]);
    }

    #[test]
    fn parse_listing_root_has_no_parent_and_top_level_parent_is_root() {
        assert_eq!(parse_listing("/\nbin/\n").unwrap().parent, None);
        assert_eq!(parse_listing("/Users\nme/\n").unwrap().parent.as_deref(), Some("/"));
    }

    #[test]
    fn parse_listing_rejects_empty_output() {
        assert!(parse_listing("").is_err());
    }

    #[test]
    fn remote_list_command_quotes_path() {
        assert_eq!(list_command(None), "cd && pwd && { ls -1Ap -- . | grep '/$' || true; }");
        assert_eq!(
            list_command(Some("/a'b")),
            "cd -- '/a'\\''b' && pwd && { ls -1Ap -- . | grep '/$' || true; }"
        );
    }

    #[test]
    fn ssh_dir_is_created_private() {
        let home = std::env::temp_dir().join(format!("swarmz-remote-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = ensure_ssh_dir_in(&home).unwrap();
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
```

Add `pub mod remote;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run to verify failure**

```bash
cd src-tauri && cargo test remote
```
Expected: compile error, `sh_quote` not found.

- [ ] **Step 3: Implement the module**

Prepend to `src-tauri/src/remote.rs`:

```rust
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CONTROL_PATH: &str = "~/.swarmz/ssh/%C";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RemoteListing {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<String>,
}

pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn validate_host(host: &str) -> Result<String, String> {
    let h = host.trim();
    if h.is_empty() {
        return Err("host cannot be empty".into());
    }
    let mut chars = h.chars();
    let first_ok = chars.next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
    let rest_ok = h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | ':' | '-'));
    if !first_ok || !rest_ok || h.len() > 253 {
        return Err("host may only contain letters, digits, . _ @ : - and cannot start with -".into());
    }
    Ok(h.to_string())
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
}

pub fn ensure_ssh_dir_in(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join(".swarmz").join("ssh");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not set permissions on {}: {e}", dir.display()))?;
    }
    Ok(dir)
}

pub fn ensure_ssh_dir() -> Result<PathBuf, String> {
    ensure_ssh_dir_in(&home_dir())
}

pub fn list_command(path: Option<&str>) -> String {
    let cd = match path {
        Some(p) => format!("cd -- {}", sh_quote(p)),
        None => "cd".to_string(),
    };
    format!("{cd} && pwd && {{ ls -1Ap -- . | grep '/$' || true; }}")
}

pub fn parse_listing(stdout: &str) -> Result<RemoteListing, String> {
    let mut lines = stdout.lines().map(|l| l.trim_end_matches('\r'));
    let path = lines.next().filter(|l| !l.is_empty()).ok_or_else(|| "empty listing".to_string())?.to_string();
    let mut visible: Vec<String> = Vec::new();
    let mut hidden: Vec<String> = Vec::new();
    for line in lines {
        let name = line.trim_end_matches('/');
        if name.is_empty() {
            continue;
        }
        if name.starts_with('.') {
            hidden.push(name.to_string());
        } else {
            visible.push(name.to_string());
        }
    }
    visible.sort();
    hidden.sort();
    visible.extend(hidden);
    let parent = if path == "/" {
        None
    } else {
        match path.rfind('/') {
            Some(0) => Some("/".to_string()),
            Some(i) => Some(path[..i].to_string()),
            None => None,
        }
    };
    Ok(RemoteListing { path, parent, dirs: visible })
}

struct Finished {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<Finished, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run ssh: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut stdout);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut stderr);
                }
                return Ok(Finished { status, stdout, stderr });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ssh timed out".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("ssh failed: {e}")),
        }
    }
}

fn base_command() -> Result<Command, String> {
    ensure_ssh_dir()?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg(format!("ControlPath={CONTROL_PATH}"));
    Ok(cmd)
}

pub fn check(host: &str) -> Result<bool, String> {
    let host = validate_host(host)?;
    let mut cmd = base_command()?;
    cmd.arg("-O").arg("check").arg(&host);
    let done = run_with_timeout(cmd, Duration::from_secs(5))?;
    Ok(done.status.success())
}

pub fn list_dir(host: &str, path: Option<&str>) -> Result<RemoteListing, String> {
    let host = validate_host(host)?;
    let mut cmd = base_command()?;
    cmd.arg("-o").arg("ControlMaster=no").arg("-o").arg("BatchMode=yes").arg(&host).arg(list_command(path));
    let done = run_with_timeout(cmd, Duration::from_secs(10))?;
    if !done.status.success() {
        let code = done.status.code().unwrap_or(-1);
        if code == 255 {
            return Err("not connected: connect in the terminal first".into());
        }
        let msg = done.stderr.trim();
        return Err(if msg.is_empty() { format!("remote command failed (exit {code})") } else { msg.to_string() });
    }
    parse_listing(&done.stdout)
}
```

- [ ] **Step 4: Run remote tests**

```bash
cd src-tauri && cargo test remote
```
Expected: 7 passed.

- [ ] **Step 5: Commands and startup wiring**

Append to `src-tauri/src/commands.rs`:

```rust
#[tauri::command]
pub fn ssh_check(host: String) -> Result<bool, String> {
    crate::remote::check(&host)
}

#[tauri::command]
pub fn ssh_list_dir(host: String, path: Option<String>) -> Result<crate::remote::RemoteListing, String> {
    crate::remote::list_dir(&host, path.as_deref())
}
```

In `src-tauri/src/lib.rs`: add `pub mod remote;`, register `commands::ssh_check, commands::ssh_list_dir,` in `generate_handler!`, and add `.setup(|_app| { let _ = remote::ensure_ssh_dir(); Ok(()) })` to the builder before `.run(...)`.

- [ ] **Step 6: Full Rust verification**

```bash
cd src-tauri && cargo test
```
Expected: 26 passed (19 + 7), no warnings in the swarmz crate.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src
git commit -m "feat(core): ssh connection check and remote directory listing over a shared socket"
```

---

### Task 2: Startup steps, ssh line, history helpers, ipc

**Files:**
- Modify: `src/lib/workspace.ts`, `src/lib/workspace.test.ts`, `src/lib/ipc.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Step = { line: string; via: "local" | "remote" };
  export const SSH_OPTS = "-t -o ControlMaster=auto -o ControlPath=~/.swarmz/ssh/%C -o ControlPersist=10m";
  export function sshLine(host: string): string;                 // `ssh ${SSH_OPTS} ${host}`
  export function validHost(s: TerminalSettings): string | null;  // trimmed host if it passes validateHost
  export function startupIsSsh(s: TerminalSettings): boolean;     // no command and validHost
  export function startupSteps(s: TerminalSettings): Step[];
  export function startupLine(s: TerminalSettings): string | null; // steps joined with " ⏎ "
  export function needsRemoteFolder(s: TerminalSettings): boolean;
  export interface SshHistoryEntry { cwd: string | null; lastUsed: string }
  export type SshHistory = Record<string, SshHistoryEntry>;
  export const SSH_HISTORY_MAX = 20;
  export function touchSshHistory(h: SshHistory, host: string, cwd: string | null | undefined, now?: string): SshHistory; // undefined cwd keeps existing
  export function recentSshHosts(h: SshHistory, limit?: number): Array<{ host: string } & SshHistoryEntry>;
  // Workspace gains `sshHistory?: SshHistory`; toWorkspace input gains `sshHistory: SshHistory`
  // ipc
  ipc.sshCheck(host): Promise<boolean>; ipc.sshListDir(host, path: string | null): Promise<{ path: string; parent: string | null; dirs: string[] }>
  ```

- [ ] **Step 1: Update and add tests**

In `src/lib/workspace.test.ts` replace the two `exec $SHELL` expectations and add step tests. Replace the `"ssh and claude with a remote cwd"` and `"ssh and claude without a remote cwd"` tests with:

```ts
  it("ssh and claude with a remote cwd is two steps", () => {
    const steps = startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null });
    expect(steps).toEqual([
      { via: "local", line: sshLine("me@host") },
      { via: "remote", line: `cd ${shellQuote("/proj")} && claude --session-id ${claude.sessionId}` },
    ]);
    expect(startupLine({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null })).toBe(
      `${sshLine("me@host")} ⏎ cd '/proj' && claude --session-id ${claude.sessionId}`,
    );
  });

  it("ssh and claude without a remote cwd is only the ssh step and needs a folder", () => {
    const s = { ssh: { host: "me@host" }, claude, command: null };
    expect(startupSteps(s)).toEqual([{ via: "local", line: sshLine("me@host") }]);
    expect(needsRemoteFolder(s)).toBe(true);
    expect(needsRemoteFolder({ ssh: { host: "me@host", cwd: "/p" }, claude, command: null })).toBe(false);
    expect(needsRemoteFolder({ ssh: { host: "me@host" }, claude, command: "ls" })).toBe(false);
    expect(needsRemoteFolder({ ssh: { host: "me@host" }, claude: null, command: null })).toBe(false);
  });

  it("sshLine carries the multiplexing options", () => {
    expect(sshLine("me@host")).toBe("ssh -t -o ControlMaster=auto -o ControlPath=~/.swarmz/ssh/%C -o ControlPersist=10m me@host");
    expect(startupSteps({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toEqual([{ via: "local", line: sshLine("me@host") }]);
    expect(startupIsSsh({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toBe(true);
    expect(startupIsSsh({ ...EMPTY_SETTINGS, ssh: { host: "me@host" }, command: "ls" })).toBe(false);
    expect(startupIsSsh({ ...EMPTY_SETTINGS, ssh: { host: "h; ls" } })).toBe(false);
  });
```

Update the existing `"ssh only"` expectation to `toBe(sshLine("me@host"))`, the unsafe-claude test line `toBe("ssh -t h")` to `toBe(sshLine("h"))`, and the `startupUsesClaude` expectations stay as they are. Add `sshLine, startupSteps, startupIsSsh, needsRemoteFolder, touchSshHistory, recentSshHosts` to the import.

Add:

```ts
describe("ssh history", () => {
  it("touch adds or refreshes an entry and keeps an existing cwd when none is given", () => {
    let h = touchSshHistory({}, "a@x", "/p", "2026-01-01T00:00:00Z");
    expect(h["a@x"]).toEqual({ cwd: "/p", lastUsed: "2026-01-01T00:00:00Z" });
    h = touchSshHistory(h, "a@x", undefined, "2026-01-02T00:00:00Z");
    expect(h["a@x"]).toEqual({ cwd: "/p", lastUsed: "2026-01-02T00:00:00Z" });
    h = touchSshHistory(h, "a@x", null, "2026-01-03T00:00:00Z");
    expect(h["a@x"].cwd).toBeNull();
  });

  it("caps at the most recent entries and lists them newest first", () => {
    let h: SshHistory = {};
    for (let i = 0; i < 25; i++) h = touchSshHistory(h, `h${i}`, null, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    expect(Object.keys(h).length).toBe(20);
    expect(h["h0"]).toBeUndefined();
    const recent = recentSshHosts(h, 3).map((e) => e.host);
    expect(recent).toEqual(["h24", "h23", "h22"]);
  });
});
```
(add `type SshHistory` to the import). In the `toWorkspace` test add `sshHistory: { "a@x": { cwd: null, lastUsed: "t" } }` to the input and assert `ws.sshHistory` equals it; also assert that with an empty `sshHistory: {}` the key is absent (`expect("sshHistory" in ws).toBe(false)`).

- [ ] **Step 2: Run to verify failure**

```bash
npm test
```
Expected: failures in workspace.test.ts for the new names.

- [ ] **Step 3: Implement in `src/lib/workspace.ts`**

Replace `startupLine` and add the helpers:

```ts
export type Step = { line: string; via: "local" | "remote" };

export const SSH_OPTS = "-t -o ControlMaster=auto -o ControlPath=~/.swarmz/ssh/%C -o ControlPersist=10m";

export function sshLine(host: string): string {
  return `ssh ${SSH_OPTS} ${host}`;
}

export function validHost(s: TerminalSettings): string | null {
  const raw = s.ssh?.host?.trim();
  return raw && validateHost(raw) === null ? raw : null;
}

export function startupIsSsh(s: TerminalSettings): boolean {
  return trimmedCommand(s) === null && validHost(s) !== null;
}

export function startupSteps(s: TerminalSettings): Step[] {
  const command = trimmedCommand(s);
  if (command) return [{ via: "local", line: command }];
  const claudeConfig = safeClaude(s);
  const claude = claudeConfig ? claudeLine(claudeConfig) : null;
  const host = validHost(s);
  if (host) {
    const steps: Step[] = [{ via: "local", line: sshLine(host) }];
    if (claude && s.ssh?.cwd) steps.push({ via: "remote", line: `cd ${shellQuote(s.ssh.cwd)} && ${claude}` });
    return steps;
  }
  return claude ? [{ via: "local", line: claude }] : [];
}

/** Display form of the startup steps, or null when there are none. */
export function startupLine(s: TerminalSettings): string | null {
  const steps = startupSteps(s);
  return steps.length ? steps.map((st) => st.line).join(" ⏎ ") : null;
}

export function needsRemoteFolder(s: TerminalSettings): boolean {
  return startupIsSsh(s) && !!safeClaude(s) && !s.ssh?.cwd;
}

export interface SshHistoryEntry {
  cwd: string | null;
  lastUsed: string;
}
export type SshHistory = Record<string, SshHistoryEntry>;
export const SSH_HISTORY_MAX = 20;

export function touchSshHistory(h: SshHistory, host: string, cwd: string | null | undefined, now: string = new Date().toISOString()): SshHistory {
  const key = host.trim();
  const prev = h[key];
  const next: SshHistory = { ...h, [key]: { cwd: cwd === undefined ? (prev?.cwd ?? null) : cwd, lastUsed: now } };
  const keys = Object.keys(next).sort((a, b) => (next[b].lastUsed > next[a].lastUsed ? 1 : next[b].lastUsed < next[a].lastUsed ? -1 : 0));
  const kept: SshHistory = {};
  for (const k of keys.slice(0, SSH_HISTORY_MAX)) kept[k] = next[k];
  return kept;
}

export function recentSshHosts(h: SshHistory, limit = 8): Array<{ host: string } & SshHistoryEntry> {
  return Object.entries(h)
    .map(([host, e]) => ({ host, ...e }))
    .sort((a, b) => (b.lastUsed > a.lastUsed ? 1 : b.lastUsed < a.lastUsed ? -1 : 0))
    .slice(0, limit);
}
```

Keep `startupUsesClaude` as is (it depends on `safeClaude` and `trimmedCommand` only). Extend `Workspace` with `sshHistory?: SshHistory;` and `toWorkspace`'s input with `sshHistory: SshHistory`; in the return, include `...(Object.keys(input.sshHistory).length ? { sshHistory: input.sshHistory } : {})`.

- [ ] **Step 4: ipc wrappers**

In `src/lib/ipc.ts` add:

```ts
export interface RemoteListing {
  path: string;
  parent: string | null;
  dirs: string[];
}
```
and inside `ipc`:
```ts
  sshCheck: (host: string) => invoke<boolean>("ssh_check", { host }),
  sshListDir: (host: string, path: string | null) => invoke<RemoteListing>("ssh_list_dir", { host, path }),
```

- [ ] **Step 5: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: workspace tests pass; the store tests that still assert the old `exec $SHELL` form and `"ssh -t mokes@other-mac.local\r"` will now FAIL (2 tests) and typecheck will flag `toWorkspace` calls in `store.ts` missing `sshHistory`. That is expected; Task 3 fixes both. Report the exact failing test names.

- [ ] **Step 6: Commit**

```bash
git add src/lib/workspace.ts src/lib/workspace.test.ts src/lib/ipc.ts
git commit -m "feat(ui): startup steps with ssh multiplexing, remote-folder helpers, ssh history"
```

---

### Task 3: Store: connection polling, two-step startup, folder choice, history

**Files:**
- Modify: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: Task 2 exports; `ipc.sshCheck`.
- Produces:
  ```ts
  // state
  sshConnected: Record<string, boolean>;
  sshConnecting: Record<string, boolean>;
  sshHistory: SshHistory;
  // actions
  runStartup(id): Promise<void>;          // types step 1; starts polling for ssh
  runRemoteStep(id): Promise<void>;       // types the remote step if connected
  cancelConnecting(id): void;
  chooseRemoteDir(id, path: string): Promise<void>;
  forgetSshHost(host: string): void;
  createSshTerminal(opts: { host; cwd?: string | null; claude?: { skipPermissions } | null }, placement?): Promise<string>;
  // module exports
  export const SSH_POLL_MS = 500, SSH_POLL_TIMEOUT_MS = 120_000, SSH_SETTLE_MS = 300;
  export function __stopAllPolling(): void;   // tests
  ```

- [ ] **Step 1: Update and add tests**

In `src/store.test.ts`:
- `beforeEach`: add `sshConnected: {}, sshConnecting: {}, sshHistory: {},` to `setState`, call `__stopAllPolling()` (import it), and `vi.mocked(ipc.sshCheck).mockReset().mockResolvedValue(false);`.
- Mock factory: add `sshCheck: vi.fn(async () => false), sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),`.
- Imports: `SSH_POLL_MS, SSH_POLL_TIMEOUT_MS, SSH_SETTLE_MS, __stopAllPolling` from `./store`; `sshLine, shellQuote` from `./lib/workspace`.
- Replace in `createSshTerminal` tests: `"ssh -t mokes@other-mac.local\r"` → `` `${sshLine("mokes@other-mac.local")}\r` ``; in "enables claude…" replace the `written` expectation with: the last write is the ssh line (`` `${sshLine("me@box")}\r` ``) and `c.started` is **false** (not yet connected), and `useStore.getState().sshConnecting[id]` is true. Since that test set no cwd, also assert `needsRemoteFolder(useStore.getState().settings[id])` is true (import it).

Add:

```ts
describe("ssh two-step startup", () => {
  const sshClaude = (cwd: string | null) => ({
    ssh: { host: "me@box", cwd },
    claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false },
    command: null,
  });

  function seed(cwd: string | null) {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/home/me", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: sshClaude(cwd) },
      startupPending: { a: true },
    });
  }

  it("types ssh, polls, then types the remote step once connected", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `${sshLine("me@box")}\r`);
      expect(useStore.getState().sshConnecting.a).toBe(true);
      expect(useStore.getState().settings.a.claude?.started).toBe(false);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
      expect(ipc.sshCheck).toHaveBeenCalledWith("me@box");
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS + SSH_SETTLE_MS + 10);
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `cd ${shellQuote("/proj")} && claude --session-id sid\r`);
      const s = useStore.getState();
      expect(s.sshConnected.a).toBe(true);
      expect(s.sshConnecting.a).toBeUndefined();
      expect(s.settings.a.claude?.started).toBe(true);
      expect(s.startupPending.a).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the timeout and re-arms the bar with a note", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      await vi.advanceTimersByTimeAsync(SSH_POLL_TIMEOUT_MS + SSH_POLL_MS * 2);
      const s = useStore.getState();
      expect(s.sshConnecting.a).toBeUndefined();
      expect(s.sshConnected.a).toBeUndefined();
      expect(s.startupPending.a).toBe(true);
      expect(s.startupNotes.a).toContain("not detected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when the terminal exits or is cancelled", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      useStore.getState().markExited("a", 255);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
      expect(useStore.getState().sshConnecting.a).toBeUndefined();
      const calls = vi.mocked(ipc.sshCheck).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
      expect(vi.mocked(ipc.sshCheck).mock.calls.length).toBe(calls);

      seed(null);
      await useStore.getState().runStartup("a");
      useStore.getState().cancelConnecting("a");
      expect(useStore.getState().sshConnecting.a).toBeUndefined();
      expect(useStore.getState().startupPending.a).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connected with no folder waits for a folder; chooseRemoteDir types the remote step and records history", async () => {
    vi.useFakeTimers();
    try {
      seed(null);
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      await useStore.getState().runStartup("a");
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS + SSH_SETTLE_MS + 10);
      expect(useStore.getState().sshConnected.a).toBe(true);
      expect(vi.mocked(ipc.writeTerminal).mock.calls.length).toBe(1);
      await useStore.getState().chooseRemoteDir("a", "/remote/proj");
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `cd ${shellQuote("/remote/proj")} && claude --session-id sid\r`);
      const s = useStore.getState();
      expect(s.settings.a.ssh?.cwd).toBe("/remote/proj");
      expect(s.settings.a.claude?.started).toBe(true);
      expect(s.sshHistory["me@box"].cwd).toBe("/remote/proj");
    } finally {
      vi.useRealTimers();
    }
  });

  it("changing the folder of a started Claude session resets the session", async () => {
    seed("/old");
    useStore.setState((s) => ({
      settings: { a: { ...s.settings.a, claude: { ...s.settings.a.claude!, started: true } } },
      sshConnected: { a: false },
    }));
    await useStore.getState().chooseRemoteDir("a", "/new");
    const c = useStore.getState().settings.a.claude!;
    expect(c.sessionId).not.toBe("sid");
    expect(c.started).toBe(false);
    expect(useStore.getState().startupNotes.a).toContain("folder changed");
    expect(useStore.getState().startupPending.a).toBe(true);

    useStore.getState().updateSettings("a", { ssh: { host: "me@box", cwd: "/newer" } });
    expect(useStore.getState().settings.a.claude?.sessionId).toBe(c.sessionId); // not started: keep id
  });

  it("forgetSshHost removes history and history round-trips through save", async () => {
    vi.useFakeTimers();
    try {
      await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: null });
      expect(useStore.getState().sshHistory["me@box"].cwd).toBe("/p");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const ws = calls[calls.length - 1][0] as Workspace;
      expect(ws.sshHistory?.["me@box"].cwd).toBe("/p");
      useStore.getState().forgetSshHost("me@box");
      expect(useStore.getState().sshHistory["me@box"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("loadWorkspace restores sshHistory", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, terminals: [], layout: null, sshHistory: { "x@y": { cwd: "/q", lastUsed: "t" } } });
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().sshHistory["x@y"].cwd).toBe("/q");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test
```
Expected: the new tests fail; the two updated createSshTerminal tests fail.

- [ ] **Step 3: Implement in `src/store.ts`**

Imports from `./lib/workspace`: add `needsRemoteFolder, startupIsSsh, startupSteps, touchSshHistory, type SshHistory`. Add constants after `SAVE_DEBOUNCE_MS`:
```ts
export const SSH_POLL_MS = 500;
export const SSH_POLL_TIMEOUT_MS = 120_000;
export const SSH_SETTLE_MS = 300;
```

State additions (interface + initial): `sshConnected: Record<string, boolean>`, `sshConnecting: Record<string, boolean>`, `sshHistory: SshHistory` (initial `{}` each). Actions: `runRemoteStep(id): Promise<void>`, `cancelConnecting(id): void`, `chooseRemoteDir(id, path): Promise<void>`, `forgetSshHost(host): void`.

Polling (module scope, above `useStore`):
```ts
const pollers = new Map<string, { timer: ReturnType<typeof setInterval>; started: number; busy: boolean }>();

function stopPolling(id: string) {
  const p = pollers.get(id);
  if (p) {
    clearInterval(p.timer);
    pollers.delete(id);
  }
}

export function __stopAllPolling() {
  for (const id of Array.from(pollers.keys())) stopPolling(id);
}

function startPolling(id: string, host: string) {
  stopPolling(id);
  useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: true }, sshConnected: omit(s.sshConnected, id) }));
  const entry = { timer: setInterval(() => void tick(), SSH_POLL_MS), started: Date.now(), busy: false };
  pollers.set(id, entry);

  async function tick() {
    if (entry.busy || !pollers.has(id)) return;
    const st = useStore.getState();
    const t = st.terminals[id];
    if (!t || t.exited !== null) {
      stopPolling(id);
      useStore.setState((s) => ({ sshConnecting: omit(s.sshConnecting, id) }));
      return;
    }
    if (Date.now() - entry.started > SSH_POLL_TIMEOUT_MS) {
      stopPolling(id);
      useStore.setState((s) => ({
        sshConnecting: omit(s.sshConnecting, id),
        startupPending: { ...s.startupPending, [id]: true },
        startupNotes: { ...s.startupNotes, [id]: "connection not detected; click Run to try again" },
      }));
      return;
    }
    entry.busy = true;
    let ok = false;
    try {
      ok = await ipc.sshCheck(host);
    } catch {
      ok = false;
    } finally {
      entry.busy = false;
    }
    if (!ok || !pollers.has(id)) return;
    stopPolling(id);
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true }, sshConnecting: omit(s.sshConnecting, id) }));
    await new Promise((r) => setTimeout(r, SSH_SETTLE_MS));
    await useStore.getState().runRemoteStep(id);
  }
}
```

Session-reset helper (module scope):
```ts
function resetSessionIfFolderChanged(cur: TerminalSettings, next: TerminalSettings): { settings: TerminalSettings; note: string | null } {
  const before = cur.ssh?.cwd ?? null;
  const after = next.ssh?.cwd ?? null;
  if (next.claude?.enabled && next.claude.started && before !== after) {
    return {
      settings: { ...next, claude: { ...next.claude, sessionId: crypto.randomUUID(), started: false } },
      note: "folder changed; Claude will start a new session",
    };
  }
  return { settings: next, note: null };
}
```

`runStartup` becomes:
```ts
  async runStartup(id) {
    const s = useStore.getState();
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    const steps = startupSteps(settings);
    if (steps.length === 0) return;
    await ipc.writeTerminal(id, steps[0].line + "\r");
    const isSsh = startupIsSsh(settings);
    set((st) => {
      if (!st.terminals[id]) return {};
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = !isSsh && startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return {
        settings: { ...st.settings, [id]: { ...cur, claude } },
        startupPending: { ...st.startupPending, [id]: false },
        startupNotes: omit(st.startupNotes, id),
      };
    });
    if (isSsh && settings.ssh?.host) startPolling(id, settings.ssh.host.trim());
  },

  async runRemoteStep(id) {
    const s = useStore.getState();
    if (!s.sshConnected[id] || !s.terminals[id]) return;
    const remote = startupSteps(s.settings[id] ?? EMPTY_SETTINGS).find((st) => st.via === "remote");
    if (!remote) return;
    await ipc.writeTerminal(id, remote.line + "\r");
    set((st) => {
      if (!st.terminals[id]) return {};
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return { settings: { ...st.settings, [id]: { ...cur, claude } }, startupPending: { ...st.startupPending, [id]: false } };
    });
  },

  cancelConnecting(id) {
    stopPolling(id);
    set((s) => ({ sshConnecting: omit(s.sshConnecting, id), startupPending: { ...s.startupPending, [id]: true } }));
  },

  async chooseRemoteDir(id, path) {
    const clean = path.trim();
    if (!clean) return;
    set((s) => {
      const cur = s.settings[id] ?? EMPTY_SETTINGS;
      if (!cur.ssh?.host) return {};
      const { settings, note } = resetSessionIfFolderChanged(cur, { ...cur, ssh: { ...cur.ssh, cwd: clean } });
      return {
        settings: { ...s.settings, [id]: settings },
        sshHistory: touchSshHistory(s.sshHistory, cur.ssh.host, clean),
        startupNotes: note ? { ...s.startupNotes, [id]: note } : s.startupNotes,
        startupPending: { ...s.startupPending, [id]: !s.sshConnected[id] },
      };
    });
    if (useStore.getState().sshConnected[id]) await useStore.getState().runRemoteStep(id);
  },

  forgetSshHost(host) {
    set((s) => ({ sshHistory: omit(s.sshHistory, host) }));
  },
```

`updateSettings`: after building `next` (and generating a missing session id), apply `const { settings: finalSettings, note } = resetSessionIfFolderChanged(current, next);` and return `settings: { ...s.settings, [id]: finalSettings }`, `startupPending: { ...s.startupPending, [id]: startupLine(finalSettings) !== null }`, and `startupNotes: note ? { ...s.startupNotes, [id]: note } : s.startupNotes`.

`createSshTerminal`: `cwd` becomes optional in `SshTerminalOptions` (already `cwd?: string | null`); in the `set`, add `sshHistory: touchSshHistory(s.sshHistory, opts.host, opts.cwd?.trim() || undefined)`; keep the final `await useStore.getState().runStartup(info.id)`.

`markExited`: also `sshConnected: omit(s.sshConnected, id), sshConnecting: omit(s.sshConnecting, id)` and call `stopPolling(id)` before `set`. `closeTerminal`: same plus `stopPolling(id)`. `restartTerminal`: `sshConnected: omit(...)`.

`loadWorkspace`/`reloadWorkspace`: after a successful load set `sshHistory: ws.sshHistory ?? {}` (in reload, replace it). `scheduleSave`: pass `sshHistory: s.sshHistory` to `toWorkspace` (both call sites). Subscription: add `|| s.sshHistory !== prev.sshHistory`.

- [ ] **Step 4: Run tests and typecheck**

```bash
npm test && npm run typecheck
```
Expected: all green (about 91: 81 existing, +3 net in Task 2, +7 here; report the exact count), tsc clean. If the two-step test's second `advanceTimersByTimeAsync` does not reach the remote write, extend it by one more `SSH_POLL_MS`; report what was needed.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat(ui): ssh connection polling, two-step startup, remote folder choice, ssh history"
```

---

### Task 4: Remote folder picker, bar states, Browse buttons, Recent hosts

**Files:**
- Create: `src/components/RemoteDirPicker.tsx`
- Modify: `src/components/TerminalPane.tsx`, `src/components/TerminalSettings.tsx`, `src/components/NewSshTerminal.tsx`

**Interfaces:**
- Consumes: store state/actions from Task 3; `ipc.sshListDir`; `needsRemoteFolder`, `recentSshHosts`.
- Produces: `RemoteDirPicker({ host, initialPath, onPick, onClose })`.

- [ ] **Step 1: `RemoteDirPicker.tsx`**

```tsx
import { useEffect, useState } from "react";
import { ipc, type RemoteListing } from "../lib/ipc";

export function RemoteDirPicker({
  host,
  initialPath,
  onPick,
  onClose,
}: {
  host: string;
  initialPath: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (path: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const l = await ipc.sshListDir(host, path);
      setListing(l);
      setPathInput(l.path);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const enter = (name: string) => {
    if (!listing) return;
    const base = listing.path === "/" ? "" : listing.path;
    void load(`${base}/${name}`);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-950/95 p-3 text-xs text-neutral-200" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-neutral-400">Folder on {host}</span>
        <button className="ml-auto rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
      </div>
      <div className="mb-2 flex gap-1">
        <input
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(pathInput.trim() || null);
          }}
        />
        <button className="rounded border border-neutral-700 px-2 hover:bg-neutral-800" onClick={() => void load(pathInput.trim() || null)} title="Go">Go</button>
        <button className="rounded border border-neutral-700 px-2 hover:bg-neutral-800" onClick={() => void load(null)} title="Home">~</button>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-2 text-red-400">
          <span className="flex-1">{error}</span>
          <button className="rounded border border-neutral-700 px-2 text-neutral-300 hover:bg-neutral-800" onClick={() => void load(listing?.path ?? initialPath)}>Retry</button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-800">
        {loading && <div className="px-2 py-1 text-neutral-500">Loading…</div>}
        {!loading && listing && (
          <ul>
            {listing.parent !== null && (
              <li className="cursor-default px-2 py-1 hover:bg-neutral-800" onDoubleClick={() => void load(listing.parent)}>
                ..
              </li>
            )}
            {listing.dirs.map((d) => (
              <li
                key={d}
                className={`cursor-default px-2 py-1 hover:bg-neutral-800 ${d.startsWith(".") ? "text-neutral-500" : ""}`}
                onDoubleClick={() => enter(d)}
                title="Double-click to open"
              >
                {d}/
              </li>
            ))}
            {listing.dirs.length === 0 && <li className="px-2 py-1 text-neutral-500">No subfolders</li>}
          </ul>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-neutral-400" title={listing?.path ?? ""}>{listing?.path ?? ""}</span>
        <button
          className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={!listing || loading}
          onClick={() => listing && onPick(listing.path)}
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Bar states in `TerminalPane.tsx`**

Add store reads: `sshConnecting`, `sshConnected`, `cancelConnecting`, `chooseRemoteDir`, plus `const [picking, setPicking] = useState(false); const [typedPath, setTypedPath] = useState("");` and `const needsFolder = !pending && !connecting && connected && needsRemoteFolder(settings);` where `connecting = useStore((s) => s.sshConnecting[id] === true)` and `connected = useStore((s) => s.sshConnected[id] === true)`. Import `needsRemoteFolder` from `../lib/workspace` and `RemoteDirPicker` from `./RemoteDirPicker`.

Render, in place of the single `{pending && line && (...)}` block:

```tsx
      {pending && line && ( /* existing pending bar unchanged */ )}
      {connecting && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-300">
          <span className="flex-1">Connecting… authenticate in the terminal if prompted.</span>
          <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={() => cancelConnecting(id)}>Cancel</button>
        </div>
      )}
      {needsFolder && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-300">
          <span className="shrink-0">Choose a folder for Claude:</span>
          <input
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
            placeholder="/path/on/remote"
            value={typedPath}
            onChange={(e) => setTypedPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && typedPath.trim()) void chooseRemoteDir(id, typedPath.trim());
            }}
          />
          <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => setPicking(true)}>Browse…</button>
        </div>
      )}
      {picking && settings.ssh?.host && (
        <RemoteDirPicker
          host={settings.ssh.host}
          initialPath={settings.ssh.cwd ?? null}
          onPick={(p) => {
            setPicking(false);
            void chooseRemoteDir(id, p);
          }}
          onClose={() => setPicking(false)}
        />
      )}
```
Update the container padding condition to `(pending && line) || connecting || needsFolder ? "pt-9" : ""`.

- [ ] **Step 3: Browse in `TerminalSettings.tsx`**

Add `const connected = useStore((s) => s.sshConnected[id] === true);` and `const [picking, setPicking] = useState(false);`. Next to the remote directory input, wrap input + button in a flex row and add:
```tsx
        <button
          className="rounded border border-neutral-700 px-2 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          disabled={!connected || !host.trim()}
          title={connected ? "Browse folders on the remote host" : "Connect first"}
          onClick={() => setPicking(true)}
        >
          Browse…
        </button>
```
and at the end of the panel `{picking && <div className="relative h-64"><RemoteDirPicker host={host.trim()} initialPath={remoteCwd.trim() || null} onPick={(p) => { setRemoteCwd(p); setPicking(false); }} onClose={() => setPicking(false)} /></div>}`.

- [ ] **Step 4: `NewSshTerminal.tsx`: Recent hosts and hint**

Read `const history = useStore((s) => s.sshHistory); const forget = useStore((s) => s.forgetSshHost);` and `const recent = recentSshHosts(history);` (import from `../lib/workspace`). Above the host field render, when `recent.length > 0`:
```tsx
      <label className={label}>Recent</label>
      <ul className="mb-1 max-h-32 overflow-y-auto rounded border border-neutral-800">
        {recent.map((r) => (
          <li key={r.host} className="flex items-center gap-2 px-2 py-1 hover:bg-neutral-800">
            <button
              className="min-w-0 flex-1 truncate text-left text-neutral-200"
              title={r.cwd ?? "no folder yet"}
              onClick={() => {
                setHost(r.host);
                setRemoteCwd(r.cwd ?? "");
              }}
            >
              {r.host} <span className="text-neutral-500">{r.cwd ?? ""}</span>
            </button>
            <button className="text-neutral-500 hover:text-neutral-200" title="Forget" onClick={() => forget(r.host)}>×</button>
          </li>
        ))}
      </ul>
```
Change the remote directory label to `Remote directory (optional)` with a hint line under it: `<div className="text-[10px] text-neutral-500">You can pick the folder after connecting.</div>`.

- [ ] **Step 5: Full verification**

```bash
npm test && npm run typecheck && npm run build && (cd src-tauri && cargo test)
```
Expected: about 91 vitest (report exact), 26 cargo, tsc clean, build OK.

- [ ] **Step 6: Manual smoke (user)**

1. `+` → SSH terminal…: your other Mac appears under Recent; click it. Untick folder (leave empty), tick Run Claude, Connect.
2. The bar shows "Connecting…"; authenticate if prompted; then "Choose a folder for Claude" appears.
3. Browse… → home listing; double-click into the project; Use this folder. Claude starts there in the remote shell.
4. Quit, relaunch: tile shows two steps; Run; watch it reconnect and resume.
5. Gear → Browse… while connected lists folders; pick another one; Save; note says the session will be new.

- [ ] **Step 7: Commit**

```bash
git add src/components
git commit -m "feat(ui): remote folder picker, connecting/choose-folder bar, recent ssh hosts"
```

---

## Self-review notes

- Spec 5.2 said "differs from the previous non-null one"; the plan's rule (reset only when `started`) is stricter and avoids discarding an unused id. Recorded as a controller ruling.
- `ssh -O check` prints to stderr; only the exit status is used.
- Test counts: 81 → Task 2 nets +3 (replaces 2, adds 5) → 84; Task 3 adds 7 → 91.
