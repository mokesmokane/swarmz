# Scratch terminal (design)

Date: 2026-10-10. In a Claude or Codex tile, open a small plain shell in the agent's folder to run
a few commands outside the agent, then close it. The agent can also open it for the user, and
never sees it.

## 1. What the user sees

- A `>_` button in the tile group's header, beside split, window and zoom, shown only while the
  active tab is an agent tile (`settings[id].claude?.enabled`, Claude or Codex). It toggles the
  scratch window: the first click starts the shell, later clicks hide and show it. While a scratch
  shell is running the button stays highlighted, so a hidden one is not forgotten.
- The scratch window floats over the agent's output, anchored bottom-right, about half the
  tile's width and 40% of its height. Its title bar reads `scratch · <folder>` (for remote tiles
  `scratch · <machine>:<folder>`) with **–** (hide) and **✕** (end the shell). It can be dragged
  by the title bar and resized from its corner; it always stays inside the tile. Its position
  and size are remembered per tile until swarmz quits.
- Opening or showing the window puts the keyboard in the scratch shell. Hiding it, or clicking
  the agent's output, puts the keyboard back in the agent. Keys typed in the scratch window never
  reach the agent.
- Each agent tile has its own scratch shell. Switching to another tab in the group hides the
  window; switching back shows it again if it was open.
- When the shell exits on its own (`exit`), the window closes, the same as ✕.

## 2. Lifecycle

- **Identity.** At most one scratch shell per agent tile, with terminal id `scratch-<tile id>`
  (valid for holders: letters, digits and `-`, at most 64 characters). Its registry name is
  requested as `<tile name>-scratch`, so it never takes a name a real tile would get.
- **Start.** The first open calls `ipc.createTerminal` directly, after `beforeSpawn.hook`, with
  the tile's current folder (`tileFolder`; for remote tiles see §3, which spawn in the local
  home). It does not go through the store's `createTerminal`: the shell never enters
  `terminals`, `order`, `settings` or the layout, so it is not saved, synced, shown in the
  sidebar, or listed by the tool's `tiles`/`ls` for the phone and conductors.
- **State.** The store keeps an in-memory map `scratch: { [tileId]: { open: boolean; rect } }`.
  It is not part of the workspace and does not trigger saves.
- **End.** One path, `endScratch(tileId)`: `ipc.closeTerminal` (terminates the holder), the xterm
  registry's `dispose`, and the map entry removed. It runs on ✕, on `pty:exit` of the scratch
  id, when the agent's tile closes (`closeTerminal`), and on quit: when the app exits, Rust
  closes every registry entry whose id starts with `scratch-`.
- **Leftovers.** After a crash or force-quit the holder keeps running. On launch, before outside
  sessions are listed, the app closes every running local session whose id starts with
  `scratch-`, and `refreshOutsideSessions` never lists such ids.
- **Missing folder.** If the holder refuses with `cwd_missing`, the scratch shell opens in the
  home folder and the title bar says so.
- **Isolation.** Folder polling, OSC 7 and agent-exit checks key off the store, so they skip the
  scratch id and it can never change the tile's saved folder. Its `SWARMZ_TERMINAL_ID` is the
  scratch id, so a stray `swarmz card` there fails with `unknown_tile` and changes nothing.
- **Windows.** The scratch window belongs to the swarmz window that opened it; other windows do
  not show it.

## 3. Remote tiles

For an ssh tile (including a foreign tile opened over ssh) the scratch shell spawns locally in the
home folder and, once it is up, types one line built by a new pure helper in `workspace.ts`:

    scratchSshLine(host, dir) = `${sshLine(host)} ${shellQuote(`cd ${shellQuote(dir)} && exec "$SHELL" -l`)}`

It reuses `SSH_OPTS` and the shared control socket, so there is no second login. `host` has
passed `validateHost`; `dir` is quoted twice, once for the remote shell and once for the local
line.

- The button is enabled only while the tile is `sshConnected`. While the tile is connecting or
  dropped it is greyed out with the hint "Connect the tile first".
- `exit` in the remote shell ends ssh and leaves the local scratch shell, as any terminal would;
  ✕ ends both.

## 4. Agents can open it for the user

An agent can pop up its tile's scratch shell when it needs the user to run something themselves
(a login, a password, anything outside its sandbox). It never sees the shell.

- **Command.** `swarmz scratch [--note "…"] [--command "…"]`. The tile comes from
  `SWARMZ_TERMINAL_ID`. Refusals: no tile id (`no_tile`); run from a scratch shell, an id starting
  `scratch-` (`self`); a note over 200 characters or a command over 500 (`too_long`); a newline or
  any other control character in either (`bad_text`), so the agent cannot send Enter. The reply
  is `{"v":1,"asked":true}` and nothing else.
- **Delivery.** The tool appends `<at>\t<tile>\tScratch\t{"note":…,"command":…}` to
  `~/.swarmz/agents/events.log`, as `board` does, so `agents.rs` delivers it as an `agent:event`
  for local and remote tiles alike. The app acts only on live events: a `Scratch` line replayed
  from history (before launch, or a remote log's backlog) never opens a window.
- **What the user sees.** The tile's scratch window opens (starting the shell if needed) with a
  banner under the title bar: "*<agent name>* asks: *note*", then the command in monospace with
  **Type it**. Type it writes the command at the prompt without Enter. The banner has its own ✕,
  a newer request replaces it, and ending the shell clears it.
- **Focus.** The scratch shell takes the keyboard only when the agent's tile is the focused tile.
  Otherwise the window opens without focus and the tile's `>_` button pulses, so an agent can never
  redirect the user's typing in another tile.
- **Remote tile not connected.** The request is kept in the `scratch` map and shown the next time
  the user opens that tile's scratch window.
- **Hidden from agents.** Every tool command that resolves a tile (`output`, `pending`, `answer`,
  `send`, `info`, `watch` and the rest) refuses ids starting `scratch-`, and `ls`/`tiles` never
  list them. `close` still accepts one: the app's own leftover sweep runs `swarmz close`, and
  ending a scratch shell reveals nothing. This is courtesy, not security: the agent runs as the same macOS user and could
  read that user's sockets and files directly.
- **Agents are told.** `briefing.rs` gains one line describing `swarmz scratch` and when to use it,
  and `AGENT_PERMISSIONS` (`agents.rs`) pre-approves it next to `card` and `board`.

## 5. Testing

- `workspace.test.ts`: `scratchSshLine` quoting, with folders containing spaces and `'`.
- `store.test.ts` (fake ipc registry):
  - opening creates `scratch-<id>` in the tile's folder and adds nothing to `terminals`,
    `order`, `settings` or the layout, and no workspace save fires;
  - hide keeps the shell; ✕, `pty:exit` and closing the agent tile each end it;
  - `cwd_missing` falls back to home;
  - ssh tiles type the scratch line, and opening is refused while the tile is not connected;
  - leftover `scratch-*` sessions are closed on launch and never become outside sessions.
- Component tests: `TabGroup` shows the button on agent tiles only and greys it out on a
  disconnected ssh tile; `ScratchWindow` hides, ends, and stays inside the tile while dragged or
  resized.
- Rust: a unit test for the `scratch-` id filter used on quit.
- Tool CLI tests (`tool/tests/cli.rs`): `swarmz scratch` refusals (`no_tile`, `self`,
  `too_long`, `bad_text`), the `Scratch` event line it appends, and tile commands refusing
  `scratch-` ids.
- `store.test.ts`: a live `Scratch` event opens the window with the banner, a replayed one does
  nothing; focus moves only when the agent's tile is focused; Type it writes the command with no
  CR or LF; a request for a disconnected remote tile waits for the next open.
- By hand in `npm run tauri dev`: a local Claude tile and an ssh tile.
