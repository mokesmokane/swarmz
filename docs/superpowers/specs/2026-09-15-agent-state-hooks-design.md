# swarmz: agent state via Claude Code hooks

Date: 2026-09-15
Status: approved design, not yet implemented
Amends: `2026-09-10-swarmz-design.md` §5.1 (launch and hooks; this replaces the
HTTP hook pings and per-launch settings files with an installed hook and an
event log), `2026-09-11-workspace-persistence-design.md` §5.2 (`claude.started`
is now set by the first prompt, not by typing the line).

## 1. Purpose

Every tile that runs Claude Code shows whether Claude is working, idle, or
blocked waiting on the user, without the user opening the tile. The state is
reported by Claude Code's own lifecycle hooks, not by scraping the screen, and
is visible from every Mac in the tailnet that has the terminal open.

Non-goals: OS notifications and sounds; the ledger cards, MCP tools and
messaging from the original design; agents other than Claude Code; state for
plain shells beyond "offline".

## 2. States

```ts
type AgentStatus = "offline" | "working" | "idle" | "blocked";

interface AgentState {
  status: AgentStatus;
  sessionId: string | null;   // from SessionStart
  since: string;              // ISO time of the event that set `status`
  lastEvent: string;          // hook event name, for the tooltip
  unseen: boolean;            // went idle or blocked while not focused
}
```

- `offline`: no Claude session is known for this terminal. Every terminal
  starts here, and returns here on SessionEnd, PTY exit, or restart.
- `working`: a user prompt was submitted and Claude has not stopped yet.
- `idle`: Claude has stopped and is waiting for the next prompt.
- `blocked`: Claude is waiting on a permission decision or a question.
- `unseen` is set when a transition to `idle` (from `working`) or to
  `blocked` happens while the terminal is not the focused terminal or the
  window is not focused. It clears when the terminal becomes focused while
  the window is focused. It is how "done, not yet looked at" is shown
  without a fifth state.

### 2.1 Display

- Sidebar row dot and tab dot use the status colour: neutral-500 offline,
  amber-400 working, green-500 idle, red-500 blocked. The existing exited
  styling wins over all of these.
- `unseen` draws a 2px ring in the status colour around the dot.
- Tooltip on the dot: `<status> · <lastEvent> · <relative time>`.
- Nothing else changes visually. No panel, no counts.

## 3. The hook

### 3.1 Script

`~/.swarmz/hooks/claude.sh`, mode 0755, POSIX sh, installed by swarmz:

```sh
#!/bin/sh
# installed by swarmz; reinstalling overwrites this file.
# SWARMZ_HOOK_VERSION=1
set -u
id="${SWARMZ_TERMINAL_ID:-}"
[ -n "$id" ] || exit 0
event="${1:-}"
[ -n "$event" ] || exit 0
input=$(cat 2>/dev/null | tr -d '\n\r')
case "$input" in *'"agent_id"'*) exit 0 ;; esac
dir="$HOME/.swarmz/agents"
mkdir -p "$dir" 2>/dev/null || exit 0
log="$dir/events.log"
if [ -f "$log" ] && [ "$(wc -c < "$log" | tr -d ' ')" -gt 524288 ]; then
  mv -f "$log" "$log.1" 2>/dev/null
fi
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\t%s\t%s\t%s\n' "$ts" "$id" "$event" "$input" >> "$log"
exit 0
```

- One tab-separated line per event: time, terminal id, event name, raw hook
  JSON with newlines removed. Rust parses the JSON; the shell never does.
- Subagent events (`agent_id` present) are dropped so a subagent's Stop does
  not mark the tile idle.
- Rotation: when the log passes 512 KB it is renamed to `events.log.1`.
  `tail -F` follows the rename and continues on the new file.
- Every failure path exits 0 so a hook can never affect Claude.

### 3.2 Settings entries

Merged into `~/.claude/settings.json` under `hooks`:

| Event | Matcher | Async | Timeout |
|-------|---------|-------|---------|
| `SessionStart` | (none) | yes | 5 |
| `UserPromptSubmit` | (none) | yes | 5 |
| `Stop` | (none) | yes | 5 |
| `StopFailure` | (none) | yes | 5 |
| `Notification` | (none) | yes | 5 |
| `SessionEnd` | (none) | no | 5 |

Each is `{ "type": "command", "command": "sh \"$HOME/.swarmz/hooks/claude.sh\" <Event>", "async": true, "timeout": 5 }`.
The event name is passed as the argument so the script does not parse it.
`SessionEnd` omits `async` because Claude does not support it there.

### 3.3 Install

`agents::install_hooks(settings_json: Option<String>) -> InstallResult`
is a pure function: given the current settings file contents (or none), it
returns the new contents plus whether anything changed. Rules:

- A swarmz entry is any hook whose `command` contains `.swarmz/hooks/claude.sh`.
- For each event in the table, remove existing swarmz entries and add the
  current one. Entries that are not swarmz's are kept untouched, including
  other tools' hooks on the same events.
- Unknown top-level keys and key order are preserved (serde `Map` with
  `preserve_order`).
- Malformed settings are left alone and reported; swarmz never overwrites a
  file it could not parse.

Local: `agents_install_local` Tauri command. Writes the script if missing or
its `SWARMZ_HOOK_VERSION` is older, then applies `install_hooks` to
`~/.claude/settings.json` with tmp-and-rename. Runs at app startup; failure
is shown in the sidebar the same way as a persist error, with a retry.

Remote: `agents_install_remote(host)`. Over the shared ssh socket:
`cat ~/.swarmz/hooks/claude.sh` (to read the version, tolerating absence),
push the script with `mkdir -p ~/.swarmz/hooks && cat > … && chmod 755 …`,
`cat ~/.claude/settings.json` (tolerating absence), apply `install_hooks`
locally, push the result with `mkdir -p ~/.claude && cat > tmp && mv -f`.
Triggered by the store the first time a tile for that machine reaches
`sshConnected` in this app run, and remembered per machine per run so it is
not repeated. Failure sets a startup note on that tile and is retried on the
next connect.

## 4. Environment

- Local shells already have `SWARMZ_TERMINAL_ID` from the spawn.
- `startupSteps` prefixes the remote line with the id when Claude is part of
  it: `cd '<dir>' && SWARMZ_TERMINAL_ID=<id> claude …`. The id is a UUID and
  needs no quoting. `startupSteps` therefore takes the terminal id as a
  second argument.
- A local `claude` typed by hand in a swarmz tile reports because the env var
  is inherited. A remote `claude` typed by hand does not, unless the user
  exports the variable; that is accepted.

## 5. Watching

New Rust module `agents.rs`.

- `Watcher::spawn_local(app)` runs `tail -n 200 -F ~/.swarmz/agents/events.log`
  (creating the directory and an empty file first so tail has something to
  follow).
- `Watcher::spawn_remote(app, host)` runs `ssh <shared socket opts> host
  'mkdir -p ~/.swarmz/agents && touch ~/.swarmz/agents/events.log && tail -n 200 -F ~/.swarmz/agents/events.log'`.
- Each stdout line is parsed (`parse_line`) into

  ```rust
  struct AgentEvent { ts: String, terminal: String, event: String,
                      session_id: Option<String>, notification_type: Option<String>,
                      source: Option<String> /* SessionStart source */ }
  ```

  and emitted as the Tauri event `agent:event` with `{ host: Option<String>, event }`.
  Malformed lines are skipped.
- `AppState` holds `HashMap<Option<String>, Watcher>` keyed by host (`None`
  = local). Commands: `agents_watch(host: Option<String>)`,
  `agents_unwatch(host)`. Watching an already watched host is a no-op.
- If the child exits, the watcher is dropped and a Tauri event
  `agent:watch-ended` `{ host }` is emitted. The store re-issues
  `agents_watch` after a backoff (1s, 2s, 4s, capped at 30s) while it still
  has a connected tile for that host, and resets the backoff on success.
- The local watcher starts at app startup. Remote watchers start when a tile
  for that host reaches `sshConnected` and stop when the last such tile is
  closed or its ssh drops.

## 6. Store

New slice `agentState: Record<string, AgentState>` and a pure reducer
`applyAgentEvent(state, event, ctx) -> state` in `src/lib/agentState.ts`
where `ctx = { focusedTerminalId, windowFocused, now }`.

| Event | Effect |
|-------|--------|
| `SessionStart` | `idle`, record `sessionId`. Not `unseen`. |
| `UserPromptSubmit` | `working`. |
| `Stop`, `StopFailure` | `idle`; `unseen` if it was `working` and the tile is not focused. |
| `Notification` with `permission_prompt`, `idle_prompt`, `agent_needs_input`, `elicitation_dialog`, `elicitation_url_dialog` | `blocked`; `unseen` if not focused. |
| `Notification` with anything else | ignored. |
| `SessionEnd` | `offline`, `sessionId` null. |

Events for a terminal id the store does not have are ignored.

Replay: the first 200 lines a watcher delivers may predate this app run. A
Claude that ran in one of this app's own PTYs died with the app, so replayed
events (ts earlier than app launch) are applied only to terminals whose
settings have `ssh`, because their Claude may still be alive on the other
machine (for example a tile that is local on another Mac and open here as a
remote). Live events (ts after launch) apply to every terminal. A remote
Claude that died with its ssh session and never logged SessionEnd shows a
stale idle or working until the next real event; that is accepted.

Side effects in the store, not the reducer:

- On `UserPromptSubmit`, if `settings[id].claude` is enabled and its
  `sessionId` equals the event's session id, set `claude.started = true` and
  save. `runStartup` and `runRemoteStep` no longer set `started`. This is
  the fix for "No conversation found": a session that was started but never
  prompted keeps `started: false` and is launched with `--session-id` again.
- `focusTerminal` and the window `focus` event clear `unseen` on the focused
  terminal.
- `markExited`, `restartTerminal` and `closeTerminal` set or remove the
  terminal's state as `offline`.

Watcher lifecycle in the store: `ensureAgentWatchers()` runs after load and
whenever `sshConnected` changes; it computes the set of hosts with a
connected tile and calls `agents_watch`/`agents_unwatch` to match, and on
first connect per host per run calls `agents_install_remote`.

## 7. Error handling

- Local install failure: sidebar error line "could not install Claude hooks:
  <reason>" with a Retry button; the app works without state.
- Remote install failure: startup note on the tile; retried on next connect.
- Watcher child dies: reconnect with backoff as in §5; no user-facing error
  unless it has failed for 30s, then a sidebar line "agent state unavailable
  for <machine>".
- Malformed settings.json: reported, never overwritten.
- Malformed log lines: skipped.

## 8. Testing

Rust (`agents.rs`):
- `parse_line` round-trips a real SessionStart, Notification and Stop line;
  rejects lines with fewer than four fields or bad JSON.
- `install_hooks` on empty input produces the six entries; on input already
  containing them makes no change; on input with an older swarmz entry
  replaces only that entry; on input with a foreign hook on `Stop` keeps it
  and preserves unrelated top-level keys; on malformed input returns an
  error.
- Script content contains the version header and exits 0 with no env var
  (run it via `sh` in a test with a temp `HOME`).

Frontend:
- `agentState.test.ts`: every transition in §6 including `unseen` rules.
- `workspace.test.ts`: `startupSteps` prefixes the remote line with the id
  only when the line includes Claude.
- `store.test.ts`: `UserPromptSubmit` with a matching session id sets
  `claude.started`; a non-matching id does not; `runStartup` no longer sets
  it; `focusTerminal` clears `unseen`; `ensureAgentWatchers` watches a host
  when its tile connects and unwatches when the tile closes.
- `Sidebar.test.tsx` and a `TabGroup` test: dot class per status and the
  ring for `unseen`.

Manual: start Claude in a local tile and in a remote tile; both dots go green
on start, amber on a prompt, red on a permission prompt, green with a ring
after the answer while another tile is focused; quit Claude and both go grey.
Relaunch swarmz while Claude is still running remotely and the dot is green
or amber before any new event.

## 9. Build order

1. Hook script, `install_hooks`, local install at startup, tests.
2. `agents.rs` watcher, local only, `agent:event` emission, store reducer
   and dots. Usable end to end on one Mac.
3. Remote: line prefix, remote install, remote watchers and their lifecycle.
4. `claude.started` moves to `UserPromptSubmit`.
