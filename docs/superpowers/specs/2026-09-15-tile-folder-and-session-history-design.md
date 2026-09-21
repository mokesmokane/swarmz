# swarmz: tiles follow their folder and keep a session history

Date: 2026-09-15
Status: approved design, not yet implemented
Amends: `2026-09-11-workspace-persistence-design.md` §2 (file: `cwd` is now
live, `sessions` added), `2026-09-15-agent-state-hooks-design.md` §5 and §6
(`AgentEvent` gains `cwd` and `permission_mode`; SessionStart adopts the
session and folder).

## 1. Purpose

A tile always knows the folder its shell is in, so a restart or another Mac
opens it where the user actually was. Each tile keeps its own history of the
Claude sessions that ran in it, with the folder each ran in, so the user can
go back to an earlier session in that tile. Nothing is shared between tiles.

Non-goals: storing prompt text; tracking the folder of a remote shell that
neither runs Claude nor announces its directory; history for anything other
than Claude Code; a global "all sessions" view.

## 2. Data

### 2.1 Workspace file

`TerminalDef` gains:

```ts
interface SessionRecord {
  sessionId: string;
  cwd: string;              // folder Claude ran in; remote path for ssh tiles
  skipPermissions: boolean; // permission_mode was "bypassPermissions"
  startedAt: string;        // ISO, first SessionStart seen
  lastActiveAt: string;     // ISO, latest event of any kind
}
sessions?: SessionRecord[]; // newest first, at most 20
```

- Rides through Rust's `#[serde(flatten)] extra` untouched; TS reads and
  writes it. Files without it load as before.
- `sameWorkspaceContent` compares it (as a list, order is meaningful).
- `def.cwd` and `def.ssh.cwd` are now live values (§3), not just the
  folder the tile was opened in.

### 2.2 Hook events

The core's `AgentEvent` gains `cwd: Option<String>` and
`permission_mode: Option<String>`, parsed from the same JSON the hook already
logs. The log format is unchanged.

### 2.3 In-memory

`TerminalInfo.cwd` (registry, Rust) is the tile's current local folder. The
store mirrors it in `terminals[id].cwd` as today.

## 3. The tile's folder

### 3.1 Local tiles

The core polls the shell's working directory:

- `pty::cwd(&self) -> Option<String>`: runs
  `lsof -a -p <shell pid> -d cwd -Fn` and returns the path after the `n`
  prefix. Always the shell's own pid, never the PTY's foreground process
  group: a `(cd /other && make)` subshell is where a command is running, not
  where the tile is. `lsof` is used because `libproc` does not implement the
  lookup on macOS; it costs about 16 ms.
- Tauri command `terminal_cwd(id) -> Option<String>`.
- The frontend asks after every Enter typed into a tile (300 ms later, so
  the `cd` has run) and every 5 s, never for exited tiles. The 5 s interval
  tick is skipped while the window is unfocused; the Enter poll always runs.
  Each check is one call; results equal to the current value are dropped.
- A changed value goes through the new Tauri command
  `set_terminal_cwd(id, cwd)`, which validates the id and updates the
  registry, then the store updates `terminals[id].cwd`, which the existing
  save path persists as `def.cwd`.

### 3.2 Remote tiles

The shell is on another Mac. Two sources, in priority order:

1. **OSC 7.** xterm's parser registers an OSC 7 handler per terminal
   (`term.parser.registerOscHandler(7, …)`). The payload is a
   `file://host/path` URL; the path (percent-decoded) becomes
   `settings.ssh.cwd` when it differs, but only while the tile's ssh is
   connected (`sshConnected`), so the local prompt's own OSC 7 before or
   after the remote session never overwrites the remote folder. Most prompt integrations (Terminal.app
   defaults, iTerm shell integration, oh-my-zsh, starship) emit it.
2. **Claude hooks.** Every hook event carries `cwd`; SessionStart from that
   tile sets `settings.ssh.cwd` when it differs (§4). (Amended 2026-09-21:
   UserPromptSubmit no longer does. Claude Code reports the folder of its
   own Bash shell in `cwd`, which moves as Claude `cd`s, while the tile's
   shell does not; applying both made a tile's folder flip between the two
   on every event, each flip re-arming the connect card and bumping the
   shared workspace on every Mac. SessionStart's `cwd` is the session's
   project folder, which is what Connect needs to resume it.)

A bare `cd` in a remote shell with neither source is not tracked; the
folder updates the next time Claude runs there. Accepted.

For a foreign local opened here as a remote (`settings.foreign`), the same
sources update `settings.foreign.cwd`, which is what `toWorkspace` writes
back as the def's `cwd`.

### 3.3 Local tiles also honour OSC 7

If a local shell emits OSC 7 it is used immediately and the poll is a
fallback. Same handler, same target (`set_terminal_cwd`).

### 3.4 Validation

Paths from OSC 7 and hooks pass `isSafeRemotePath` (no control characters);
`set_terminal_cwd` additionally requires an absolute path. Anything else is
ignored.

## 4. Session adoption

On a hook event for tile `T` (after the host and replay checks in the hooks
spec §6):

| Event | Effect on `T` |
|-------|---------------|
| `SessionStart` with session `S`, folder `D`, mode `M` | Upsert `S` at the head of `T.sessions` with `cwd: D`, `skipPermissions: M === "bypassPermissions"`, `lastActiveAt: now`, keeping an existing `startedAt`; cap at 20. If `T.claude` is null or `T.claude.sessionId !== S`, set `T.claude = { enabled: true, sessionId: S, skipPermissions, started: false }`. Update the folder per §3 (`D` is authoritative for this event). |
| `UserPromptSubmit` | Bump `lastActiveAt` of the record for the event's session if present, and apply the folder rule; the `started` flip from the hooks spec is unchanged. |
| `Stop`, `StopFailure`, `Notification` | No change to history or folder; the `started` flip from the hooks spec is unchanged. |
| `SessionEnd` | No change to history or folder. |

A tile with a custom `command` is not adopted (Claude there is incidental).

## 5. Going back

### 5.1 Connect card

Below the main line, when `T.sessions` has entries other than the current
one: a "Previous sessions in this tile" list of up to five rows, newest
first, each `basename(cwd) · <relative lastActiveAt>` with the full cwd as
tooltip, excluding the current session. Clicking a row:

1. sets `T.claude = { enabled: true, sessionId, skipPermissions, started: true }`,
2. applies the folder rule with the record's cwd,
3. moves the record to the head, and
4. runs Connect (`runStartup`).

### 5.2 Sidebar settings panel

The sidebar row shows a ↺ button on hover when the tile has a previous session; it opens a popover with the same list. Clicking a row behaves exactly as in the connect card (makes it current and connects). `selectSession` keeps the `connect: false` behaviour for callers but no UI surface uses it.

### 5.3 Dead sessions

After typing a line that contains `--resume <id>`, the store watches that
tile's PTY output for `No conversation found with session ID <id>` for 10 s.
On a match: remove the record, set `T.claude.started = false` if it names
that id, and set a startup note "session <id> is gone; Connect starts a new
one". The PTY output hook lives in `xtermRegistry` (it already sees every
byte) and posts to the store; the store keeps the 10 s window.

## 6. Store

- `adoptSession(id, event)` implements §4; called from `applyAgentEvent`
  after the existing state fold.
- `setTerminalCwd(id, cwd, source: "poll" | "osc7" | "hook")` implements
  §3: routes to registry (local), `settings.ssh.cwd` (ssh) or
  `settings.foreign.cwd` (foreign), ignoring unchanged and invalid values.
- `pollCwd(id)` and the Enter/interval scheduling live in `xtermRegistry`
  (it owns the terminals and sees keystrokes) and call `setTerminalCwd`.
- `selectSession(id, sessionId, connect: boolean)` implements §5.
- `noteResumeFailure(id, sessionId)` implements §5.3.

Saves flow through the existing subscription (settings, terminals).

## 7. Sync

`sessions`, `cwd` and `claude` changes save and push like any other change.
Two Macs both adopting the same tile's session produce identical records
(same id, same folder), so adoption converges; `lastActiveAt` may differ by
a few seconds and the newer revision wins as usual. This is why only
`SessionStart` and `UserPromptSubmit` write history (§4): every change to a
tile's settings is a debounced save, a revision bump and a push to every
online peer, and `Stop`/`Notification` fire several times per Claude turn.

## 8. Error handling

- `lsof` missing or failing: the poll silently yields nothing; OSC 7 and
  hooks still work.
- OSC 7 with a host that is not `localhost`, empty, or the local machine on
  a local tile is still accepted (the path is what matters); a path failing
  §3.4 is ignored.
- `set_terminal_cwd` for an unknown id or a relative path returns an error;
  callers drop it.
- Resume failure detection is best effort: if Claude's wording changes the
  record simply stays.

## 9. Testing

Rust:
- `parse_line` reads `cwd` and `permission_mode`.
- `set_terminal_cwd` updates the registry and rejects unknown ids and
  relative paths.
- `pty::cwd` parsing of `lsof -Fn` output (pure parse function tested with
  fixture text); an integration test that spawns `/bin/sh -c "cd /tmp && sleep 5"`
  and reads its cwd as `/tmp` or `/private/tmp`.

Frontend:
- `sessions.ts` pure helpers: upsert keeps newest first, caps at 20, keeps
  `startedAt`, bump touches only the matching record, select moves to head.
- `store.test.ts`: SessionStart with a new id replaces `claude` and adds a
  record; with the current id only bumps; folder adoption for local, ssh
  and foreign tiles; custom-command tile not adopted; `selectSession` with
  connect types the line; resume-failure note removes the record.
- `xtermRegistry.test.ts`: OSC 7 handler calls `setTerminalCwd` with the
  decoded path; Enter schedules a poll; disposed terminals stop polling.
- Component tests: connect card lists previous sessions excluding the
  current one and selecting one connects; settings panel list.

Manual: `cd` around in a local tile and watch the sidebar tooltip follow;
start Claude by hand in a subfolder, quit swarmz, relaunch, and see the
connect card offer that session in that folder; pick an older session from
the list and see `--resume` typed in its folder.

## 10. Build order

1. Rust: `cwd` lookup, `terminal_cwd`, `set_terminal_cwd`, event fields.
2. Folder tracking: `setTerminalCwd`, poll on Enter and interval, OSC 7.
3. Session records: `sessions.ts`, adoption on hook events, sync equality.
4. Going back: connect card list, settings panel list, dead-session note.
