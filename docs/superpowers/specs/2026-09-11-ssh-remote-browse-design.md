# swarmz: SSH connection sharing, two-step startup, and remote folder picker

Date: 2026-09-11
Status: approved design, not yet implemented
Amends: section 3 (Startup line) and 5.3 (UI) of
`2026-09-11-workspace-persistence-design.md`.

## 1. Purpose

An SSH terminal should let the user choose the remote project folder by
browsing, not by typing a path they have to know, before Claude starts there.
Claude must run inside the remote interactive login shell (so PATH is right),
and the folder browser must work without asking for the password again.

Non-goals: file browsing (folders only); browsing before the tile has
connected; password storage; anything beyond standard OpenSSH.

## 2. Connection sharing

Every SSH line the app composes carries OpenSSH multiplexing options:

```
ssh -t -o ControlMaster=auto -o ControlPath=<HOME>/.swarmz/ssh/%C -o ControlPersist=10m <host>
```

- `<HOME>/.swarmz/ssh/` is created by the core at startup with mode 0700.
- `%C` is OpenSSH's hash of local host, remote host, port and user, so the
  socket name is safe and deterministic for a given `<host>` string.
- The first (interactive) connection in the tile authenticates and becomes the
  master. Later short commands from the core reuse it with
  `-o ControlMaster=no -o ControlPath=… -o BatchMode=yes` and never prompt.
- `ControlPersist=10m` keeps the master alive for ten minutes after the tile's
  session ends, so a browse right after a disconnect still works.

## 3. Startup steps

`startupLine` is replaced by `startupSteps(settings) -> Step[]` with
`Step = { line: string; via: "local" | "remote" }`. `via: "local"` is typed
into the tile's local shell; `via: "remote"` is typed into the remote shell
once the connection is up.

| ssh | claude | steps |
|-----|--------|-------|
| no  | no     | `[]` |
| yes | no     | `[{ local: "ssh -t <opts> <host>" }]` |
| no  | yes    | `[{ local: "claude [--dangerously-skip-permissions] (--session-id X \| --resume X)" }]` |
| yes | yes, `ssh.cwd` set | `[{ local: ssh… }, { remote: "cd '<cwd>' && claude …" }]` |
| yes | yes, no `ssh.cwd` | `[{ local: ssh… }]` and the tile asks for a folder after connecting |

- `command`, when non-empty, wins: `[{ local: command }]`.
- The `exec $SHELL -lic` wrapper from the previous design is removed; the
  remote step runs in the interactive login shell that `ssh -t` opened.
- `startupLine(settings)` remains as a display helper: the steps' lines joined
  with `" ⏎ "`, or `null` when there are none.
- Unsafe host or session id rules from the previous spec still apply.

## 4. Core (Rust)

New module `remote.rs`, commands:

- `ssh_check(host: String) -> Result<bool, String>`: runs
  `ssh -o ControlPath=<dir>/%C -O check <host>`; `Ok(true)` on exit 0,
  `Ok(false)` on non-zero; `Err` only if `ssh` cannot be executed. 5 s timeout.
- `ssh_list_dir(host: String, path: Option<String>) -> Result<RemoteListing, String>`
  where `RemoteListing { path: String, parent: Option<String>, dirs: Vec<String> }`.
  Runs, over the shared connection with `BatchMode=yes`,
  `cd -- '<path>' && pwd && { ls -1Ap -- . | grep '/$' || true; }` (with
  `cd` alone when `path` is `None`, i.e. the remote home). First output line
  is the resolved path; remaining lines are directory names with the trailing
  `/` stripped, sorted: visible first, then dot-directories, each
  alphabetically. `parent` is `None` at `/`. 10 s timeout. Errors: not
  connected (exit 255 with no master), path not a directory (non-zero `cd`),
  timeout.
- `host` is validated in Rust with the same allowlist as the frontend before
  being passed as an argv word; the remote path is single-quoted with the
  `'\''` rule.
- `ssh_dir()` creates `<HOME>/.swarmz/ssh` (0700) on first use.

## 5. Frontend

### 5.1 Types and helpers (`workspace.ts`)

```ts
export type Step = { line: string; via: "local" | "remote" };
export function sshLine(host: string): string;          // with the multiplexing options
export function startupSteps(s: TerminalSettings): Step[];
export function startupLine(s: TerminalSettings): string | null;   // display only
export function needsRemoteFolder(s: TerminalSettings): boolean;   // ssh + claude enabled + no ssh.cwd + no command
```

Workspace file gains an optional top-level SSH history:

```json
"sshHistory": { "mokes@172.16.82.70": { "cwd": "/Users/mokes/projects/x", "lastUsed": "2026-09-11T14:02:11Z" } }
```

keyed by host, holding the last chosen remote folder (or `null`) and the last
use time. Rust preserves it as an unknown top-level field; TS reads and writes
it explicitly. An entry is written whenever an SSH terminal is created or its
folder chosen; the map is capped at the 20 most recently used hosts.

### 5.2 Store

New state: `sshConnected: Record<id, boolean>`,
`sshHistory: Record<host, { cwd: string | null; lastUsed: string }>`.

- `runStartup(id)`: types step 1. If step 1 is an ssh line, starts polling
  `ipc.sshCheck(host)` every 500 ms for up to 120 s. On success:
  `sshConnected[id] = true`; wait 300 ms; if a remote step exists, type it and
  set `claude.started = true`. If Claude is enabled but no folder is set, do
  nothing more (the bar offers Browse). Polling stops on success, timeout,
  close, or exit.
- `markExited(id)` and `closeTerminal(id)` set `sshConnected[id] = false` and
  stop polling.
- `chooseRemoteDir(id, path)`: sets `ssh.cwd = path` and records
  `sshHistory[host] = { cwd: path, lastUsed: now }`. If Claude is enabled and the folder differs from the previous
  non-null one, a fresh `sessionId` is generated with `started: false` and a
  note "folder changed; Claude will start a new session". If the tile is
  connected, the remote step is typed immediately and `started` set.
- `updateSettings` applies the same session-reset rule when `ssh.cwd` changes
  for a Claude terminal.
- `createSshTerminal(opts)`: as today, but `cwd` may be omitted when Claude is
  on; the tile then asks for a folder after connecting. Records
  `sshHistory[host]` (keeping an existing `cwd` when none was given).
- `forgetSshHost(host)`: removes a history entry.

### 5.3 UI

- **Startup bar** states for an SSH tile:
  1. pending: shows the steps and Run / Skip (as today).
  2. connecting: "Connecting…" with a Cancel that stops polling.
  3. connected, Claude on, no folder: "Choose a folder for Claude" with
     Browse and a text field for a typed path (Enter to use).
  4. otherwise hidden.
- **Remote folder picker** (`RemoteDirPicker`): a panel over the tile listing
  the current remote path as an editable breadcrumb, an "up" row, the
  subfolders (dot-folders dimmed at the bottom), "Use this folder", Cancel.
  Loading and error states inline. Double-click a folder to enter it.
- **Settings panel**: a Browse button next to the remote directory field,
  enabled only while that terminal is connected (`sshConnected[id]`);
  otherwise its tooltip says "Connect first".
- **SSH form**: remote directory optional even when Run Claude is on; hint
  text "You can pick the folder after connecting". Above the fields, a
  **Recent** list of hosts from `sshHistory` (most recent first, up to 8),
  each showing host and last folder; clicking one prefills host and remote
  directory; a small × forgets it.

## 6. Error handling

- `ssh_check` false forever (user never authenticates): polling ends after
  120 s and the bar returns to the pending state with a note "connection not
  detected; click Run to try again".
- Browse when not connected: button disabled; if the socket died meanwhile,
  the picker shows the core's error and a Retry.
- Listing a path that isn't a directory: inline error, stay on the previous
  listing.
- Typing the remote step while the remote shell is still initialising is
  tolerated by the tty's input buffer; the 300 ms delay reduces prompt noise.

## 7. Testing

Rust: `sh_quote` rule; `parse_listing` (pwd + entries, dot-dirs ordering,
trailing slash stripped, parent of `/` is None); host validation rejects a
leading `-`; `ssh_dir` creates the directory with 0700 (unix).

Frontend: `startupSteps` for every table row; `sshLine` options; `startupLine`
display join; `needsRemoteFolder`; store: `runStartup` for ssh+claude types
step 1, polls (fake timers), types step 2 on connect and marks started;
timeout path; `chooseRemoteDir` sets cwd, updates `sshHistory`, resets the
session on change, types the remote step when connected; `updateSettings`
session reset; `sshHistory` round-trips through `toWorkspace`, is capped at
20 and ordered by `lastUsed`; `forgetSshHost` removes an entry.

Manual smoke: create an SSH terminal with Run Claude and no folder; connect;
see "Choose a folder"; Browse from home into the project; Use this folder;
Claude starts there; quit and relaunch; Run; watch it reconnect and resume.
