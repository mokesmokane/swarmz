# swarmz on the phone: session holder, Mac tool, Android app, alerts

Date: 2026-09-16
Status: approved design; sub-project 1 (session holder) implemented
Amends: `2026-09-10-swarmz-design.md` §3.1 (the swarmz window no longer owns
PTYs); `2026-09-15-agent-state-hooks-design.md` §2.1 (status colours), §3.2
(hook events gain `PermissionRequest`); `2026-09-15-tile-folder-and-session-history-design.md`
§3.2 (remote folders are read from the remote holder, so a bare `cd` is
tracked).

UI reference: the "Swarmz Phone" design canvas (`Swarmz Phone.dc.html`, held
outside the repo because it bundles the CertifyIP design system). Its
decisions are captured in §6 and are binding.

## 1. Purpose

Drive the terminals running on your Macs from an Android phone (a Galaxy Z
Fold in practice) with a proper app: a list of what needs you, Claude sessions
as conversations with a rich composer and hold-to-dictate, plain shells as
readable coloured output with a command box, answers to Claude's permission
questions from the app or straight from a notification, and new Claude
sessions started from the phone.

Non-goals: a terminal emulator on the phone; iPhone; editing files on the
phone; sharing with other people; sessions surviving a Mac reboot; image
attachments from the phone; search.

## 2. Architecture

**One rule: every tile's shell lives in a session holder on its home Mac**
(the Mac whose folder it runs in). The swarmz window on any Mac and the phone
are viewers of that holder.

```
 swarmz window (Mac A)      swarmz window (Mac B)          phone
   local tile ──socket──┐     remote tile                    │
                        │       └─ ssh A swarmz attach ──┐   │ ssh A swarmz <cmd>
                        ▼                                ▼   ▼
                 Mac A: holder(tile) ◄──────── ~/.swarmz/bin/swarmz (tool)
                        │                                ▲
                        └── login shell ── claude ── hooks ─► events.log
```

Four sub-projects, built in order, each with its own plan and review:

1. **Session holder** (§3): tiles survive swarmz quitting or relaunching; the
   swarmz window becomes a viewer.
2. **Mac tool** (§4): the `swarmz` command the phone (and swarmz) runs over
   ssh; plus the `PermissionRequest` hook and the desktop colour change.
3. **Phone app** (§6, §7): home, tile, composer, dictation, new session,
   pairing, both fold states.
4. **Background link and alerts** (§8).

The tool and the holder are one Rust binary, `swarmz`, built from the same
crate as the app (a second `[[bin]]`), bundled with swarmz and installed at
`~/.swarmz/bin/swarmz` on every Mac.

## 3. Session holder

### 3.1 Process model

- `swarmz hold <tile> --cwd <dir> --name <name> [--env K=V]...` starts a
  holder for the tile unless one is already running, and prints
  `{"v":1,"socket":…,"existed":bool,"pid":…,"shellPid":…}`.
- A new holder detaches completely (one fork plus `setsid`, so it has no
  controlling terminal and is reparented to launchd when `hold` exits; stdin
  from `/dev/null`, stdout and stderr to `~/.swarmz/sessions/<tile>.log`,
  working directory `/`) so it survives the swarmz app, ssh sessions, and
  terminal closures.
- It spawns `$SHELL -l` in `<dir>` (falling back to `$HOME` with the existing
  "no longer exists" note if `<dir>` is missing) in a PTY with
  `TERM=xterm-256color`, `COLORTERM=truecolor`, `SWARMZ_TERMINAL_ID`,
  `SWARMZ_TERMINAL_NAME` and any `--env`. `SSH_AUTH_SOCK`, `SSH_TTY`,
  `SSH_CONNECTION` and `SSH_CLIENT` are removed (they describe whichever ssh
  session started the holder) unless given with `--env`.
- It listens on `~/.swarmz/sessions/<tile>.sock` (directory mode 0700,
  socket 0600) and writes `~/.swarmz/sessions/<tile>.json`
  `{v, pid, shellPid, cwd, name, startedAt}`.
- When the shell exits: broadcast `Exit(code)` to viewers, record the code in
  the metadata file (`exitedAt`, `exitCode`), remove the socket, exit.
- `Terminate` from a viewer (tile closed in swarmz) sends SIGHUP to the
  shell's process group, then SIGKILL after 3 s.
- Sessions do not survive a reboot. A metadata file whose `pid` is not
  running, or a socket that refuses connections, is stale: `hold` removes it
  and starts fresh.

### 3.2 Wire protocol

Frames on the socket: `type: u8`, `len: u32 BE`, `payload`.

| Type | Direction | Payload |
|------|-----------|---------|
| `Hello` 1 | viewer→holder | JSON `{v, cols, rows, viewer}` (`viewer` is a free label, e.g. `window`, `phone`, `tool`); `cols` or `rows` of 0 means "no size yet" (§3.5) |
| `Welcome` 2 | holder→viewer | JSON `{v, shellPid, cwd, startedAt, cols, rows}`, where `cols`/`rows` is the PTY size applied when the viewer connected (the size its replay was written at; absent from older holders); a holder with a different major `v` closes the connection after sending it |
| `Replay` 3 | holder→viewer | bytes (§3.3), sent once right after `Welcome` (empty for `tool` viewers) |
| `Data` 4 | both | bytes: shell output to viewers, input from a viewer |
| `Resize` 5 | viewer→holder | `cols: u16`, `rows: u16` |
| `Exit` 6 | holder→viewer | JSON `{code}` (null when killed by a signal) |
| `Terminate` 7 | viewer→holder | empty |
| `Info` 8 / `InfoReply` 9 | request/response | JSON `{cwd, foregroundBusy, foregroundCommand}` |
| `Screen` 10 / `ScreenReply` 11 | request/response | JSON: styled lines of the screen and scrollback (§3.4) |

Unknown frame types are ignored. Viewers may connect and disconnect at any
time; the holder never blocks on a slow viewer (per-viewer queue capped at
8 MiB; a viewer over the cap is disconnected).

### 3.3 Replay

- The holder keeps the last 2 MiB of output in a ring buffer.
- On attach it sends, as one `Replay` frame: `ESC [ ! p` (soft reset), then
  the buffer starting at the first `\n` after the ring's start (so replay
  never begins inside an escape sequence).
- After `Replay` it sends SIGWINCH to the shell's foreground process group,
  so full-screen programs (Claude) redraw for the viewer.
- A `tool` viewer only asks questions: its `Replay` is empty and it causes no
  SIGWINCH.

### 3.4 Screen model

The holder feeds all output through a VT parser (`vt100` crate) at the size
currently applied, keeping 5 000 lines of scrollback. `Screen` returns lines
as `[{text, fg, bg, bold}]` spans with colours as `#rrggbb` or palette index.
The tool's `output` and `pending` commands (§4) use it; viewers do not.

### 3.5 Size

- The applied PTY size is the size of the **most recently active viewer**:
  the last one to send `Data` or `Hello`.
- A `Hello` with a zero size (a swarmz window rejoining a running session
  before its pane is laid out) does not make the viewer active and applies
  nothing; its first non-zero `Resize` counts as its `Hello`, and `Data` from
  it adopts the size already applied. A `Resize` with a zero is ignored.
- When that viewer disconnects, the next most recent viewer's last size
  applies.
- Viewers that never type (the tool, the phone's output stream) send
  `Hello` with their size but a `viewer` label of `tool`; `tool` viewers
  never become the active size.

### 3.6 swarmz window integration

- The app installs its bundled `swarmz` binary to `~/.swarmz/bin/swarmz` at
  startup when `swarmz version` differs (atomic copy, mode 0755).
- **Local tile:** `create_terminal`/`restart_terminal` run `swarmz hold` and
  connect to the socket as `window`. The current `PtySession` is replaced by
  a `HolderClient` with the same surface (`write`, `resize`, `on_data`,
  `on_exit`, `foreground_busy`, `cwd`), so everything above the Rust core is
  unchanged. `close_terminal` sends `Terminate`.
- **Relaunch:** `loadWorkspace` holds every local def. `existed: true` means
  the session is alive: the tile attaches and **no connect card is shown**.
  Only a new holder arms the card (today's behaviour after a reboot), except
  that a rejoined ssh tile whose ssh has died shows it. The window joins a
  running session with a zero-size `Hello`, parses the replay at the
  `Welcome` size (sent with the replay event), then fits, and sends its own
  size once the session is recorded (immediately if the pane is laid out,
  else on its first real fit), even when it equals the current size. A replay with history that
  arrives in a pane that already shows output (a reattach) resets the pane
  first. Agent events from before launch still apply to tiles that rejoined
  a running session, from that holder's `startedAt` on; the app holds them
  until its first load has opened the tiles.
- **Remote tile (home is another Mac):** the tile's local holder runs a
  shell, and the app types
  `ssh -t <shared-socket opts> <host> ~/.swarmz/bin/swarmz attach <tile> --cwd <dir> --name <name>`
  into it, so the ssh itself also survives a relaunch. Attach is used only
  when this Mac's own machine name is known and the host is not this Mac;
  `attach` also refuses (code `self`) when its `SWARMZ_TERMINAL_ID` is the
  tile it was asked to attach.
  `attach` holds (starting a holder if needed), then bridges the ssh stdin
  and stdout to the socket in raw mode, forwarding window-size changes.
  Before bridging it writes `ESC ] 1337 ; swarmz-attach ; new=<0|1> ; end=1 BEL`,
  then the replay, then `ESC ] 1337 ; swarmz-replay-end BEL` (`end=1`
  promises that end marker; the app ignores clipboard and folder escapes
  until it arrives, and still parses the plain `new=<0|1>` form from older
  tools). The xterm registry handles the OSC and, only when `new=1` for an
  attach line it typed, types the remote startup step (`export SWARMZ_TERMINAL_ID=… && cd … && claude …`).
  The attach marker is written together with the replay, after the holder
  has answered, so a failed attach prints only its JSON error.
  A dropped ssh connection leaves the remote holder and its Claude running;
  reconnecting reattaches. **Closing** a remote tile closes both holders: the
  app ends the local one and, best effort and without waiting, runs
  `swarmz close <tile>` on the host over the shared ssh socket
  (`remote_tile_close`) when the host's tool is ready or the tile attached
  this run.
- **Checks move to the holder.** Local `foreground_busy`/`cwd` come from
  `Info`. Remote folder tracking asks the remote tool (`swarmz info <tile>`
  over the shared ssh socket) on the same Enter/interval schedule, so a bare
  `cd` on a remote shell is tracked. "Is the remote tile connected" becomes
  "the local PTY's ssh process is alive and the attach marker arrived".
- Remote installs of the tool happen with the hooks install (first connect
  per run) and refuse to copy when `uname -m` differs from this Mac's. A
  remote tool with the same version but other bytes is replaced only when
  its build id (`swarmz version` reports `build`) is missing or older than
  ours; the local install likewise keeps a newer build of the same version.
  Only a definite "not usable" answer is remembered per host; a failed check
  is retried on the next Run.
- Everything that passes bytes (scrollback, copy on select, OSC 52, OSC 7,
  Shift+Enter, image paste, resume-failure detection) is unchanged because the
  holder passes bytes through untouched.

### 3.7 Migration

Tiles running when the new build first starts are ordinary PTYs owned by the
old app and die with it, as today. From that launch on, every tile is held.

## 4. The Mac tool

Every command prints one JSON document (or, with `--follow`, one per line),
each carrying `"v": 1`. Failures exit non-zero with
`{"v":1,"error":"…","code":"…"}` on stdout. `swarmz version` prints
`{v, tool, protocol}`.

### 4.1 Commands

| Command | Output |
|---------|--------|
| `hold <tile> …` | §3.1 |
| `attach <tile> …` | raw bridge (§3.6); never used by the phone |
| `info <tile>` | `{cwd, foregroundBusy, foregroundCommand, running}` |
| `close <tile>` | ends the tile's holder (`Terminate`) and waits up to 5 s: `{closed}`, false when none was running |
| `version` | `{v, tool, protocol, build}` |
| `machines` | `[{name, alias, color, online, self}]` from `workspace.json` machines and `tailscale status` (with `TERM` set) |
| `ls` | tiles homed on this Mac: `[{id, name, cwd, kind: "claude"\|"shell", running, exitCode, status, needs, since, lastEvent, mode, lastMessage, turnEndedAt}]` |
| `watch` | stream: a full `ls` snapshot first, then `{type:"tile", tile:{…}}` on every change and `{type:"gone", id}` when a tile is closed |
| `transcript <tile> [--before <id>] [--limit 50] [--follow]` | normalised messages (§4.3) |
| `image <tile> <imageId>` | `{mime, base64}` |
| `output <tile> [--lines 200] [--follow]` | styled lines from `Screen` (§3.4); `--follow` emits replaced and appended lines |
| `send <tile> <text>` | types the text as a bracketed paste, then Enter as a separate write 50 ms later |
| `key <tile> <name>` | one of `esc`, `ctrl-c`, `tab`, `shift-tab`, `up`, `down`, `enter` |
| `pending <tile>` | `{tool, summary, options:[{n, label}]}` or `null` (§4.4) |
| `answer <tile> <yes\|always\|no\|deny\|n>` | selects that option if the same question is still pending (§4.4); otherwise `{ignored:true}` |
| `folders [<path>]` | `{path, parent, dirs}` (same rules as the desktop folder picker) |
| `new --folder <dir> [--skip-permissions] [--name <name>]` | the new tile, §4.5 |
| `restart <tile>` | holds a fresh session for a tile that is not running and types its startup step (Claude tiles resume their session); returns the tile |
| `phone add --name <device> --key <pubkey>` / `phone ls` / `phone revoke <device>` | §7.2 |

### 4.2 Status

The tool folds `~/.swarmz/agents/events.log` with the same rules as
`src/lib/agentState.ts`: `status` is `offline | working | idle | blocked`.
It adds:

- `needs`: `"permission"` while blocked on a `PermissionRequest` or
  `permission_prompt`, `"question"` while blocked on any other blocking
  notification, else `null`.
- `turnEndedAt`: the time of the last `Stop`. Viewers decide "finished and
  not yet seen" themselves.
- `mode`: from the latest event's `permission_mode`
  (`plan`, `acceptEdits` → "accept edits", `default`, `bypassPermissions`).
- `lastMessage`: the last assistant text of the current session (first
  240 characters), from the transcript.

A shared fixture file, `tests/fixtures/agent-status.json` (event sequences
and expected states), is run by both the TypeScript and Rust test suites so
the two implementations cannot drift.

### 4.3 Transcript normalisation

From the session's `transcript_path` (known from `SessionStart`):

- Kept: user text (including slash commands), assistant text, user images.
- Tool use and tool results are grouped into `tools: [{name, summary, ok}]`
  on the assistant message they belong to. Summaries: `Edit`/`Write` →
  "Edited <file>", `Read` → "Read <file>", `Bash` → "Ran <first word>" plus
  a `✓/✗` from the result, `Grep`/`Glob` → "Searched", others → the tool
  name. Consecutive same-kind summaries collapse ("Edited 3 files").
- Dropped: thinking, system and attachment entries, meta entries,
  sidechains (subagents), and hook output.
- Each message: `{id (transcript uuid), ts, role, text, images:[{id, mime}], tools}`.
- Paging: newest first with `--before`; `--follow` streams new messages
  after the newest one returned, and resumes from a given id after a
  reconnect with no gaps or duplicates.

### 4.4 Permission questions

- The hook set gains `PermissionRequest` (async, 5 s timeout); the hook
  script version becomes 2 and installs update it on every Mac. Its event
  carries `tool_name` and `tool_input`; the tool derives `summary`
  (`Bash` → the command, `Edit`/`Write` → the file path, `WebFetch` → the
  URL, others → the tool name).
- `pending` reads the dialog from the holder's screen model. Verified
  against Claude Code 2.1.273 (spike, 2026-09-16), the dialog is: a heading
  (for example "Bash command"), the command or target, a one-line
  description, "Do you want to proceed?", numbered options, and a footer line
  starting "Esc to cancel". An option is a line matching
  `^\s*[❯>]?\s*(\d+)\.\s+(.+)$`; indented lines after it, up to the next
  option or the footer, are continuations of its label (long labels wrap).
  The heading and command line give `summary` when the hook event has not
  arrived yet. If no footer is on screen, `pending` returns `null`.
- Option numbers are not fixed (the spike showed "No" as option 3, after a
  wrapped "Yes, and always allow …"). `answer` therefore takes an option
  label (`yes`, `always`, `no`) or a number, resolves it against the options
  currently on screen, checks the same dialog is still showing, and sends
  that digit. `answer <tile> deny` sends Esc, which always cancels the
  request; notification **Deny** actions use it.

### 4.5 New sessions

`new` on the tile's home Mac:

1. creates a tile id and a Claude session id (UUIDs) and a unique name
   (folder basename, `-2`, `-3` … on collision with names in the workspace);
2. holds a session in `--folder` and types
   `claude [--dangerously-skip-permissions] --session-id <id>` into it;
3. adds the def to `~/.swarmz/workspace.json` with `origin` = this Mac,
   `claude.started = false`, bumps `sync.revision` (`updatedBy` = this Mac),
   and writes atomically.

A running swarmz app notices the change through its existing external-change
check, adopts it and pushes it to peers.

### 4.6 Desktop changes in this sub-project

- Status colours everywhere become: **working** green `#25BF35`, **needs
  you** amber `#FFB21B` (blocked, or finished and unseen), **idle** grey
  `#475569`, **exited with an error** red `#FF0303`. A tile with no Claude
  session keeps its machine colour. `dotPresentation` and its tests change
  accordingly.
- The local hook installer and the remote install path install hook
  script version 2 (with `PermissionRequest`).

### 4.7 The ssh gate

Phone keys are installed with a forced command (§7.2). `swarmz ssh-gate`
reads `SSH_ORIGINAL_COMMAND`, splits it with POSIX shell-word rules, requires
the first word to be `swarmz` or the tool's absolute path and the second to
be one of the §4.1 subcommands except `attach`, `hold` and `phone add`, then
execs the tool with those arguments. Anything else exits 126 with an error.

## 5. Shared rules

- Tile ids, session ids and folder paths passed on a command line are
  validated by the tool (UUID shape, absolute path without control
  characters); text for `send` is passed as one argument and never
  interpreted by a shell on the Mac beyond ssh's own word splitting, which
  the phone guards by single-quoting every argument.
- The tool never deletes user files; `Terminate` only signals the shell's
  process group.

## 6. The phone app

### 6.1 Platform

Kotlin, Jetpack Compose, Material 3 with a custom theme, `minSdk 31`,
`targetSdk 35`. Libraries: sshj (ssh), kotlinx.serialization (JSON),
material3-adaptive (list–detail layout), a Compose Markdown renderer,
DataStore (settings), Android Keystore (key protection), Android
`SpeechRecognizer` (dictation), `compose-markdown` (Markdown rendering). Sideloaded APK.

### 6.2 Visual language (from the design)

- Background `#0F172A`; cards `#151C2C`, highlighted card
  gradient `#1A2236→#151C2C`; borders `#1B2436`, `#253045`, `#2C3852`,
  `#3A4761`.
- Text `#F8FAFC` (titles), `#E2E8F0`, `#CBD5E1` (body), `#94A3B8`,
  `#64748B` (secondary). Code in messages `#FFD27A`; error lines
  `#F87171`.
- Primary `#363B94` (buttons, your message bubbles, mic).
- Status colours per §4.6; needs-you dots carry a soft amber halo.
- Inter for UI text, system monospace for paths, code and shell output.
- Radii: 8 px cards and bubbles, 4 px buttons and badges, pills fully round.

### 6.3 Layouts

- **Folded** (compact width): one screen at a time, home or tile.
- **Unfolded** (expanded width): tile list (312 dp) on the left, the open
  tile on the right; opening a tile never leaves the list.
- Folding or unfolding keeps the open tile, the composer text and scroll
  position.

### 6.4 Home (folded)

- Status bar row, then a headline: "N agents need you" (or "Nothing needs
  you") and "M others running quietly".
- **Needs-you cards**, newest first:
  - Permission: status dot with halo, tile name, `PERMISSION` badge,
    "Claude wants to run `<summary>` in <folder>", buttons **Allow once**
    (primary) and **Deny**.
  - Question / finished turn: dot, name, relative time, Claude's last
    message in quotes, and an inline **Reply** field with a mic.
  - Tapping a card's body opens the tile.
- **Running**: a wrapping row of pill chips (dot + name) for every other
  tile; tapping opens it.
- Bottom: a full-width **New session** pill.
- A tile counts as needing you when `needs` is set or its `turnEndedAt` is
  later than the phone's own seen time for that tile (set when the tile is
  open on screen).

### 6.5 Tile list (unfolded)

"Tiles" title with a `+` (new session). Sections: **NEEDS YOU** (amber
label), then one section per Mac (alias, uppercase). Rows: dot (halo when it
needs you), name, and a sub-line "<Mac> · permission" / "<folder> ·
working" / "exited 1". The open tile's row is highlighted. Offline Macs'
sections are dimmed with "last seen …".

### 6.6 Tile screen

- Header: back arrow (folded only), status dot, name, `<Mac> · <folder>` in
  monospace, and a mode badge (`plan`, `accept edits`, `default`, `shell`).
- **Claude tile:** messages bottom-aligned; yours in `#363B94` bubbles on
  the right (max 80 % folded, 62 % unfolded); Claude's as plain Markdown text
  on the left (max 72 % unfolded) with tool chips underneath; images inline
  (tap to enlarge); code blocks with a copy button; a status line with a
  blinking cursor ("working · 12s", "waiting on you", "idle"). Scrolling up
  loads older messages.
- **Permission card** above the composer when `pending` is set: `PERMISSION`,
  "Run `<summary>`?", one button per option (design: **Yes**, **Yes,
  always**, **No**); horizontal on unfolded.
- **Shell tile:** monospace coloured output lines (from `output --follow`),
  bottom-aligned, following new output; "[process exited with code N]" when
  it ends.
- **Quick keys** row: Claude → `Esc`, `^C`, `⇧Tab <mode>`, `/` (slash
  command picker); shell → `^C`, `↑`, `Tab`, **Restart shell**.
- **Composer:** growing text field ("Message <name>…" / "Type a command…")
  and a round mic button. Tap the send arrow (shown when the field has text)
  to send. Your message appears immediately with sending / sent / failed
  (tap to retry).

### 6.7 Dictation

Press and hold the mic: a waveform overlay rises from the bottom with
"Release to insert · slide up to cancel". Partial results appear in the
field while holding. Release inserts the text at the cursor; sliding up
cancels. Dictation never sends. Language follows the phone unless set in
settings.

### 6.8 New session

1. Pick a Mac (online ones only).
2. Browse folders (`folders`), recent folders from that Mac's tiles'
   session histories first.
3. Optional **Skip permissions** switch with a red warning.
4. **Start** runs `new` and opens the conversation.

### 6.9 Settings

Macs (paired Mac, discovered Macs, online state), background watching on or
off, notification kinds, dictation language, revoke this phone.

### 6.10 Errors

- Offline Mac: greyed, "last seen …", its tiles read-only.
- Dropped connection: reconnect with backoff (1, 2, 4 … 30 s); streams
  resume from their cursors.
- `answer` returning `ignored`: the card disappears quietly.
- Tool too old (`protocol` below the app's): banner "Update swarmz on
  <Mac>".
- Tile not running (`running: false`): history shown with a **Restart**
  button (runs `hold` + the startup step through a `restart` subcommand
  added to the tool).

## 7. Connection and pairing

### 7.1 Connection

- The phone reaches each Mac over Tailscale by its MagicDNS name; the
  Tailscale app must be connected.
- One sshj connection per online Mac, keep-alive 30 s; each command runs as
  a channel on it. Host keys are trusted on first use (Tailscale already
  authenticates the machine) and pinned afterwards; a changed host key
  blocks that Mac with an explanation.

### 7.2 Pairing (once per phone)

1. First launch: the phone creates an Ed25519 key; the private key is stored
   encrypted with a hardware-backed Android Keystore key and never leaves the
   phone.
2. You enter one Mac's name, your Mac username and password (macOS Remote
   Login must be on, as it already is for swarmz between Macs).
3. The phone logs in with the password once and runs
   `~/.swarmz/bin/swarmz phone add --name <device> --key <pubkey>`. The
   password is not stored.
4. `phone add` appends
   `command="$HOME/.swarmz/bin/swarmz ssh-gate",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <pubkey> swarmz-phone:<device>`
   to `~/.ssh/authorized_keys` (creating it with mode 0600) unless present,
   then runs the same `phone add` on every Mac in `machines` it can reach over
   its existing ssh, and prints which Macs accepted it.
5. The phone learns the other Macs from `machines` and connects with its key.

Keys do not expire. `phone revoke <device>` (and a "Phones" list in swarmz
settings) removes the line on every reachable Mac. Pairing requires swarmz to
have run once on the first Mac (so the tool is installed).

## 8. Background link and alerts

- A foreground service (`specialUse`) holds the Mac connections and runs
  `watch` on each. Its ongoing notification reads "swarmz · watching N Macs"
  with a **Pause** action.
- The app asks once to be exempt from battery optimisation.
- On reconnect, `watch`'s initial snapshot is diffed against the last known
  state so anything that started needing you while offline alerts once.
- **Alerts** (notification channels, each switchable):
  - *Needs you — permission* (high priority): "<tile> wants to run
    <summary>", actions **Allow once** (`answer yes`) and **Deny** (`answer deny`).
  - *Needs you — question* (high): Claude's last message, action **Reply**
    (inline text, sent with `send`).
  - *Finished* (default): "<tile> finished" with the last message.
- Tapping opens the tile. No alert fires for the tile currently open on
  screen. An alert is withdrawn when its tile stops needing you.
- Pausing, or Tailscale being off, stops alerts; resuming catches up.

## 9. Testing

- **Holder (Rust):** start a real shell under a holder; two viewers see the
  same output; replay after reconnect; size follows the most recent typist;
  `tool` viewers never set the size; exit code reaches viewers; the holder
  outlives the process that started it (spawn from a child that then exits);
  stale sockets are cleaned; protocol version mismatch closes cleanly.
- **Tool (Rust):** every command against a temporary `HOME` with fixture
  hook logs and transcripts; `send`/`key`/`pending`/`answer` against a real
  holder running a fake dialog script; `new` writes a valid workspace with a
  bumped revision; `ssh-gate` accepts only the allowed commands; the shared
  status fixture passes in Rust and TypeScript.
- **swarmz window:** existing suites stay green with `HolderClient`; new
  tests for relaunch reattach (no connect card), remote attach marker
  handling, remote folder tracking.
- **Phone:** unit tests for JSON parsing, needs-you logic, reconnect cursors;
  Compose UI tests for home, tile list, tile screen, composer and dictation
  overlay at compact and expanded widths, against a fake tool; one emulator
  end-to-end run against a real Mac.
- **By hand on the Fold:** pair; open a live Claude tile; answer a
  permission from a notification; dictate and send a reply; start a new
  session and see it appear in swarmz; fold and unfold mid-conversation;
  quit swarmz on the Mac and see the session keep running.

## 10. Tooling and distribution

- This Mac needs a Java runtime (Temurin 17), the Android SDK command-line
  tools and platform 35, and Gradle (via the wrapper), installed with
  Homebrew. Android Studio is optional (emulator).
- The APK is signed with a release key kept outside the repo, built with
  `./gradlew assembleRelease`, installed over USB (`adb install`) the first
  time and from a GitHub release afterwards.
- The phone app lives in `android/` in this repository.

## 11. Build order and spikes

Before sub-project 1's plan, two short spikes (throwaway):

1. A detached child started from a macOS app keeps running after the app
   ends. Done 2026-09-16: yes (double fork + `setsid`, reparented to
   launchd); sub-project 1 re-checks it with the real swarmz and Cmd+Q.
2. Claude Code's permission dialog can be read from a screen model.
   Done 2026-09-16: yes, with wrapped labels and variable numbering (§4.4).

Then:

1. Session holder and swarmz window integration (§3).
2. Mac tool, `PermissionRequest` hook, desktop colours (§4, §5).
3. Phone app with pairing (§6, §7).
4. Background link and alerts (§8).
