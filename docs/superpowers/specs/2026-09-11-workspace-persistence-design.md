# swarmz: workspace persistence, startup commands, and Claude resume

Date: 2026-09-11
Status: approved design, not yet implemented
Supersedes: section 7 (Persistence) of `2026-09-10-swarmz-design.md`. Pulled
forward from stage 4 and extended with a hand-editable file, SSH startup
commands, and per-terminal Claude sessions.

## 1. Purpose

When swarmz starts, the same terminals come back in the same layout. Each
terminal can carry a startup command (an SSH connection, a Claude session, or
any free-form line) that the user runs with one click. Claude sessions resume
the exact previous conversation. The whole thing lives in one file the user can
read and edit.

Non-goals: preserving live PTYs or scrollback across restarts; running startup
commands without a click; multiple workspaces.

## 2. The file

`~/.swarmz/workspace.json`, pretty-printed JSON, written by the app on every
change and safe to edit while the app is closed (or re-read via "Reload
workspace").

```json
{
  "version": 1,
  "terminals": [
    {
      "id": "6f1c0d3e-…",
      "name": "api",
      "cwd": "/Users/mokes/projects/swarmz",
      "ssh": { "host": "mokes@other-mac.local", "cwd": "/Users/mokes/projects/swarmz" },
      "claude": { "enabled": true, "sessionId": "0b9e…", "skipPermissions": true, "started": false },
      "command": null
    }
  ],
  "layout": { "kind": "split", "dir": "row", "children": [ … ], "sizes": [50, 50] }
}
```

Field rules:
- `id`, `name`, `cwd` required. `name` obeys the registry's validation.
- `ssh`, `claude`, `command` optional; absent and `null` are equivalent.
- `ssh.cwd` optional; when absent the remote shell stays in its login dir.
- `claude.sessionId` is a UUID generated when `enabled` is first set.
- `claude.started` is set true the first time the startup line is run.
- `command` is typed exactly as given and takes precedence over `ssh` and
  `claude` when non-empty.
- `layout` uses the frontend's `LayoutNode` shape unchanged, or `null`.
- Unknown fields are preserved on round-trip where practical; the app never
  needs to strip them.

## 3. Startup line

A pure function `startupLine(def) -> string | null`:

| ssh | claude | result |
|-----|--------|--------|
| no  | no     | `null` |
| yes | no     | `ssh -t <host>` |
| no  | yes    | `claude [--dangerously-skip-permissions] (--session-id X \| --resume X)` |
| yes | yes    | `ssh -t <host> '<cd> claude …'` where `<cd>` is `cd <ssh.cwd> && ` when set |

- `--session-id X` when `started` is false, `--resume X` when true.
- `--dangerously-skip-permissions` is included when `skipPermissions` is true.
- `command`, when non-empty, wins over the table.
- Remote arguments are single-quoted for the remote shell; single quotes inside
  `ssh.cwd` are escaped as `'\''`. The host is passed as a separate word and
  must not contain whitespace or quotes (validated in settings).

Stage 2 will append its MCP flags to the `claude …` segment in this same
function.

## 4. Core (Rust)

New module `workspace.rs`:
- `load_workspace() -> Result<Option<Workspace>, String>`: reads the file;
  `Ok(None)` when missing; on parse failure renames the file to
  `workspace.json.broken-<unix-seconds>` and returns `Err(message)`.
- `save_workspace(ws: Workspace) -> Result<(), String>`: serialises with
  `serde_json::to_string_pretty`, writes to `workspace.json.tmp`, then renames
  over the target. Creates `~/.swarmz` if needed.
- `Workspace` is a serde struct mirroring section 2 with `layout` as
  `serde_json::Value` (opaque to Rust). Unknown fields flow through as
  `#[serde(flatten)] extra: Map` on terminal definitions.
- Both exposed as Tauri commands. Path resolution uses the home directory from
  `std::env::var("HOME")`.

Registry change: `add` rejects a duplicate id with `RegistryError::DuplicateId`
so a saved id can never shadow a live terminal. `create_terminal` surfaces it
as an error string.

## 5. Frontend

### 5.1 Types

`src/lib/workspace.ts`:
```ts
export interface SshConfig { host: string; cwd?: string | null }
export interface ClaudeConfig { enabled: boolean; sessionId: string; skipPermissions: boolean; started: boolean }
export interface TerminalDef { id: string; name: string; cwd: string; ssh?: SshConfig | null; claude?: ClaudeConfig | null; command?: string | null }
export interface Workspace { version: 1; terminals: TerminalDef[]; layout: Layout }
export function startupLine(def: TerminalDef): string | null
export function reconcileLayout(layout: Layout, ids: string[]): Layout   // drop unknown ids, add missing ones to the first group, null if no ids
export function toWorkspace(state): Workspace
```

### 5.2 Store

New per-terminal fields kept in the store alongside `TerminalInfo`:
`settings: Record<id, { ssh, claude, command }>` and
`startupPending: Record<id, boolean>`.

Actions:
- `loadWorkspace()`: on app start. For each def: create the terminal with the
  saved id and name in `cwd` (falling back to `$HOME` when `cwd` no longer
  exists, and noting that in the startup bar). Then `layout =
  reconcileLayout(ws.layout, ids)`; `startupPending[id] = startupLine(def) !=
  null`.
- `updateSettings(id, patch)`: merges, generates `claude.sessionId` when
  `enabled` turns on without one, sets `startupPending[id] = true` if the
  resulting startup line is non-null, saves.
- `runStartup(id)`: writes `line + "\r"` to the PTY, sets
  `claude.started = true` when the line came from the claude branch, clears
  `startupPending[id]`, saves.
- `skipStartup(id)`: clears `startupPending[id]` (not persisted).
- `reloadWorkspace()`: re-reads the file; opens defs not currently open;
  closes open terminals absent from the file after a confirm; replaces
  layout and settings.
- Every mutation of `terminals`, `order`, `layout`, or `settings` schedules a
  debounced (500 ms) `save_workspace(toWorkspace(state))`. `restartTerminal`
  re-marks `startupPending` when a startup line exists.

### 5.3 UI

- **Sidebar row gear** opens an inline settings panel: name, directory, SSH
  host, SSH remote directory, "Run Claude" toggle, "Skip permissions
  (dangerous)" toggle, free-form startup command. Save applies
  `updateSettings`. Validation errors show inline (name rules, host with
  whitespace or quotes).
- **Startup bar** at the top of a tile whose terminal is `startupPending`:
  the line in monospace, "Run" and "Skip" buttons, plus the cwd-fallback note
  when applicable.
- **Sidebar header** gains "Reload workspace" and shows persistence errors
  (malformed file quarantined, save failed) as a dismissible line.

## 6. Error handling

- Missing file: start empty, silent.
- Malformed file: quarantined by the core; sidebar shows
  "workspace.json was invalid and moved to …".
- Save failure: sidebar shows the error; app continues; next change retries.
- Saved cwd missing: open in `$HOME`, note in the startup bar.
- Duplicate id on restore (file edited badly): that def is skipped and the
  error shown.
- Layout referencing unknown ids or missing known ids: reconciled silently.

## 7. Testing

Rust: round-trip save/load; atomic write leaves no `.tmp`; malformed file is
renamed and reported; missing file returns `None`; registry duplicate id
rejected.

Frontend (vitest): `startupLine` for all four combinations, skip-permissions
flag, session-id vs resume, quoting of a remote cwd with a single quote,
`command` precedence; `reconcileLayout` drop/add/null cases; store:
`loadWorkspace` restores terminals and layout and marks pending;
`updateSettings` generates a session id and marks pending; `runStartup` writes
the line, sets `started`, clears pending; a settings change triggers a save
(mocked ipc, fake timers).

Manual smoke: open two terminals, set one to SSH+Claude with skip
permissions, quit, relaunch, see both tiles with the startup bar, click Run,
see the ssh prompt; edit the file by hand while closed and see the change on
launch.

## 8. Build order

One plan, tasks roughly: Rust workspace module + registry guard → frontend
types and pure functions → store persistence and restore → settings panel →
startup bar and reload → smoke.
