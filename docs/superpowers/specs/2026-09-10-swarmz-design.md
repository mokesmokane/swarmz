# swarmz: tiled terminal workbench for Claude Code agents

Date: 2026-09-10
Status: approved design, not yet implemented

## 1. Purpose

swarmz is a native macOS desktop app for running many terminals at once, most of
them Claude Code sessions. It has three jobs:

1. **Workbench**: a sidebar listing every terminal and a tiled area on the right
   where terminals can be docked side by side or tabbed together in groups.
2. **Ledger**: a shared board where each Claude Code agent keeps a short card
   describing what it is doing, visible to every other agent and to the user.
3. **Messaging**: agents working on related things can send each other messages,
   which the app delivers straight into the recipient's terminal when it is idle.

Non-goals for v1: remote terminals, multiple windows, terminal sessions that
survive an app restart, any agent runtime other than Claude Code.

## 2. Stack

- Tauri 2 with a Rust backend.
- React 19, TypeScript, Vite, Tailwind 4, zustand for state.
- xterm.js for terminal rendering, react-resizable-panels for split handles.
- Rust crates: portable-pty (PTYs), axum (HTTP), rmcp (MCP server), serde,
  tokio.
- Tests: vitest for the frontend, cargo test for Rust.

## 3. Architecture

Single process. The Rust core owns all state that matters; the React frontend
is a view over Tauri commands and events.

```
+-----------------------------+        +-----------------------------------+
| React frontend              |  IPC   | Rust core (Tauri)                 |
|  Sidebar | Workbench | Ledger| <----> |  pty  | ledger | mcp (axum+rmcp)   |
+-----------------------------+        +-----------------------------------+
                                                   ^  HTTP (localhost)
                                                   |  MCP tools + hook pings
                                          +--------+---------+
                                          | claude CLI in PTY |
                                          +-------------------+
```

### 3.1 Rust modules

**`pty`**
- `create(id, name, cwd)`: the frontend generates the id so it can subscribe to output events before the spawn; spawns the user's login shell in `cwd`
  with `SWARMZ_TERMINAL_ID` and `SWARMZ_TERMINAL_NAME` in its environment.
- `write(id, bytes)`, `resize(id, cols, rows)`, `kill(id)`.
- Output is streamed to the frontend as Tauri events `pty:data:<id>`. Exit is
  emitted as `pty:exit:<id>` with the exit code.

**`ledger`**
- In-memory `HashMap<TerminalId, Card>` plus `HashMap<TerminalId, Vec<Message>>`.
- All mutations go through one `Ledger` struct behind a mutex and emit
  `ledger:changed` (full snapshot) so the UI and agents see one truth.
- Owns the message dispatcher (section 6).

**`mcp`**
- axum server bound to `127.0.0.1` on a random free port chosen at startup.
- Routes: `POST /mcp` (MCP streamable HTTP via rmcp), `POST /hooks/:event`.
- Every request carries `Authorization: Bearer <token>`. The token maps to
  exactly one terminal; unknown tokens get 401. Agents cannot act as another
  terminal.

### 3.2 Frontend state (zustand)

- `terminals`: `{ id, name, cwd, exited?: number }[]`, mirrors the core.
- `layout`: the split tree (section 4.2). Frontend-owned, persisted via core.
- `ledger`: latest snapshot from `ledger:changed`.
- `ui`: which terminal is focused, whether the Ledger panel is open.

## 4. Workbench

### 4.1 Sidebar (left)

- One row per terminal: status dot, name, cwd basename, one-line `task` from
  its ledger card, unread-message badge.
- Row actions: focus (reveals its tab), rename inline, close.
- Header: "New terminal" (asks for a directory, defaults to the last used),
  toggle for the Ledger panel.
- Rows are draggable into the workbench.

### 4.2 Split tree

The right-hand area is a tree:

```
LayoutNode =
  | { kind: "split", dir: "row" | "col", children: LayoutNode[], sizes: number[] }
  | { kind: "group", id, tabs: TerminalId[], active: TerminalId }
```

Rules:
- A terminal lives in exactly one group at a time.
- Drop onto a group's tab bar: add as a tab and activate.
- Drop onto a group's left/right/top/bottom edge zone: split that group in that
  direction and put the terminal in the new sibling.
- Closing or moving the last tab out of a group removes the group. A split with
  one child is replaced by that child. Sizes are renormalised.
- New terminals open as a tab in the focused group, or as the root group if
  the tree is empty.

The tree lives in a pure TypeScript reducer with operations `addTab`,
`moveToGroup`, `splitWith`, `removeTerminal`, `setActive`, `resize`. This
reducer is unit tested in isolation.

### 4.3 Terminal panes

- Each terminal has one xterm.js instance created when the terminal is created
  and kept mounted (hidden with CSS) while it is an inactive tab, so scrollback
  and state survive re-tabbing and re-docking.
- Resizing a pane sends `resize` to the core with the fitted cols and rows.
- A pane whose process has exited shows a banner with the exit code and a
  "Restart shell" button that respawns in the same cwd with the same id.
- Pane header shows the name, the status dot, and a "Launch Claude" button
  (section 5.1) when the terminal is not already running Claude.

### 4.4 Ledger panel

A toggleable panel below the workbench showing every card as a tile: name,
status, task, recent `done` bullets, `touching`, tags, and time since the last
update. Below the tiles, a chronological feed of all messages between agents
with a compose box so the user can message any agent as "user".

## 5. Agent integration

### 5.1 Launching Claude

"Launch Claude" on terminal `T` does the following in the core:

1. Ensure `T` has a bearer token (generate once per terminal, keep in memory).
2. Write `~/.swarmz/run/<id>.mcp.json`:
   ```json
   { "mcpServers": { "swarmz": {
       "type": "http",
       "url": "http://127.0.0.1:<port>/mcp",
       "headers": { "Authorization": "Bearer <token>" } } } }
   ```
3. Write `~/.swarmz/run/<id>.settings.json` with hooks that each run
   `curl -s -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/hooks/<event>`:
   - `UserPromptSubmit` -> `/hooks/busy`
   - `Stop` -> `/hooks/idle`
   - `Notification` -> `/hooks/waiting`
   - `SessionEnd` -> `/hooks/offline`
4. Ensure `~/.swarmz/briefing.md` exists (written once from a bundled default;
   the user may edit it). It tells the agent: its terminal name, that other
   agents share the ledger, to call `ledger_update` when it starts, pivots or
   finishes a task and before asking the user a question, and that messages
   from other agents arrive as `[swarmz message from <name>]: ...` prompts.
5. Type into the PTY:
   ```
   claude --name "<name>" --mcp-config ~/.swarmz/run/<id>.mcp.json \
     --settings ~/.swarmz/run/<id>.settings.json \
     --append-system-prompt "$(cat ~/.swarmz/briefing.md)"
   ```
   The generated files substitute the terminal name into the briefing at
   launch time by appending a line `Your terminal name is "<name>".`

The core marks the card `idle` once the first hook ping arrives. Until then
the card stays `offline`.

### 5.2 MCP tools

Caller identity is always the terminal that owns the bearer token.

| Tool | Input | Effect |
|------|-------|--------|
| `ledger_update` | `{ task?, status?, done?: string[], touching?: string[], tags?: string[] }` | Merge into caller's card. `done` entries are appended and the list capped at 20. `status` may only set `working` or `waiting`; `idle` and `offline` come from hooks. |
| `ledger_read` | `{ terminal?: string }` | Return all cards, or one by name. |
| `send_message` | `{ to: string, body: string }` | `to` is a terminal name or `"all"`. Queues a message to each recipient except the sender. |
| `read_inbox` | `{ unread_only?: boolean }` | Return the caller's messages and mark them read. |

Validation: strings capped (task 500 chars, each bullet 200, body 4000),
arrays capped (touching 50, tags 20). Oversized input is truncated, not
rejected. Unknown recipient returns a tool error listing valid names.

### 5.3 Card

```
Card {
  id, name, cwd,
  status: "offline" | "idle" | "working" | "waiting",
  task: string,          // one sentence, may be empty
  done: string[],        // most recent last, max 20
  touching: string[],    // files, dirs or areas
  tags: string[],
  updated_at: timestamp
}
```

Every terminal has a card from creation. Plain shells are `offline` with an
empty task, so the sidebar and Ledger panel always match the terminal list.

### 5.4 Naming

- Names are unique; the core rejects a duplicate rename with an error.
- Default name is the cwd basename, suffixed `-2`, `-3` on collision.
- Renaming updates the card and the routing table immediately. A running
  Claude session keeps its old `--name` in its own UI, which is acceptable.

## 6. Messaging and delivery

```
Message { id, from: TerminalId | "user", to: TerminalId, body,
          sent_at, delivered_at?, read_at? }
```

- `send_message` (or the user compose box) appends to each recipient's queue
  and emits `ledger:changed`.
- The dispatcher runs whenever a message is queued or a status changes. For
  each recipient with undelivered messages:
  - `idle`: write `[swarmz message from <sender>]: <body>\r` to the PTY,
    set `delivered_at`. If several are pending, deliver them one per line in
    a single write, then one Enter.
  - `working` or `waiting`: hold. Delivery happens on the next `/hooks/idle`.
  - `offline`: hold indefinitely. The sidebar shows the unread count.
- After injection the core optimistically sets the recipient to `working`;
  the `UserPromptSubmit` hook confirms it.
- `read_inbox` marks messages read but does not suppress injection of
  messages that were still undelivered; an agent that reads its inbox
  mid-task will also see those messages injected once idle. This duplication
  is accepted for v1 for simplicity.

## 7. Persistence

- `~/.swarmz/state.json` written debounced (500 ms) after any change:
  terminals (id, name, cwd), layout tree, cards, messages (capped at the last
  500).
- On startup: read state, respawn each terminal as a fresh shell in its cwd
  with its old id and name, restore the layout, load cards with
  `status: "offline"` and their last `task` and `done` intact, load messages.
- Tokens are not persisted; a relaunched Claude gets a new one.
- Missing or corrupt state file: start empty and rename the bad file to
  `state.json.broken-<timestamp>`.

## 8. Error handling

- PTY spawn failure: terminal is created in the exited state with the error
  in its banner.
- PTY exit: banner with exit code and restart button; card set `offline`.
- MCP or hook request with a bad or missing token: 401, logged.
- Port collision: the OS assigns a free port; configs are regenerated on
  every launch so stale ports are never used.
- Duplicate terminal name: error surfaced inline in the sidebar rename field.
- `send_message` to an unknown name: tool error listing valid names.
- Card input over caps: truncated silently.

## 9. Testing

Rust (`cargo test`):
- Ledger merge semantics and caps.
- Message queueing, `"all"` fan-out excluding sender, unknown recipient error.
- Dispatcher gating by status, single-write batching, delivered_at bookkeeping.
- Token auth: unknown token rejected, token maps to the right terminal.
- MCP handlers exercised against an in-process rmcp server.
- Persistence round trip and corrupt-file fallback.

Frontend (`vitest`):
- Layout reducer: addTab, moveToGroup, splitWith, removeTerminal (including
  group collapse and split flattening), setActive, resize normalisation.
- Sidebar and Ledger selectors derive the right rows from a snapshot.

Manual smoke: create two terminals, launch Claude in both, ask one to message
the other, confirm injection lands only when the recipient is idle.

## 10. Build order

Each stage is its own implementation plan and is usable on its own.

1. **Workbench**: Tauri shell, PTYs, xterm panes, sidebar, split tree, tabs.
2. **Ledger and MCP**: core ledger, HTTP server, hooks, launch action,
   Ledger panel (cards only).
3. **Messaging**: send/inbox tools, dispatcher, message feed and compose box.
4. **Persistence**: state file, restore on startup.
