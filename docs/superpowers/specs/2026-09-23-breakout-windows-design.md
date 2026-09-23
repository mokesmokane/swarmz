# swarmz: a tile in its own window

Date: 2026-09-23
Status: proposed, not yet implemented
Amends: `2026-09-10-swarmz-design.md` §4.2 (the split tree stays the one
layout; a breakout is a per-Mac view, not a layout change),
`2026-09-14-shared-workspace-design.md` (nothing about a breakout window is
shared), `2026-09-16-swarmz-phone-design.md` §3 (a second viewer of a holder
from the same app).

## 1. Purpose

Drag a tile's tab out of the workbench and it opens in a window of its own,
which can live on another monitor. Drag it back, or close the window, and
it returns to where it was. Everything a pane does in the main window it
does in a breakout window: the same shell, Claude, hooks, folder tracking,
image paste, hover card.

Non-goals: several tiles in one breakout window (one tile per window; open
two windows for two tiles); a second full workbench; breakout windows that
follow a Mac to another Mac; the phone.

## 2. The decision that matters: a view, not a move

The workspace's split tree is shared across every Mac and adopted on every
sync. If breaking a tile out *removed* it from the tree, this Mac's next
save would push a layout without it, every other Mac would drop it from
their windows and then re-add it as a stray tab (`reconcileLayout`), and
the next pull here would put it back. So a breakout changes nothing in the
shared workspace:

- The tile **stays in the layout tree** on every Mac. Only this Mac hides
  it from the workbench while it is out, and only this Mac knows.
- The set of broken-out tiles and each window's bounds live in
  `~/.swarmz/windows.json` on this Mac (never synced, never in
  `workspace.json`), so a relaunch restores the windows.
- In the main window the tile's tab stays in its group, drawn as a
  placeholder: dimmed title, `↗ own window`, and a click that brings the
  window forward. Its pane is not rendered there (the holder has one
  viewer per window; see §3). When it is the group's active tab the group
  shows the placeholder card, not an empty pane, and the next tab is
  activated on breakout so the group is never blank.
- Sync, adoption, rename, close, session history, hooks: unchanged. Closing
  the tile from either window closes it everywhere, as today.

## 3. Core: one holder, one viewer per window

Today `create_terminal` attaches the main window to the tile's holder as
its viewer, and output is emitted on `pty:data:<id>`, which Tauri delivers
to **every** window. A breakout window therefore needs no new data event,
only its own replay, its own size, and a home for its writes:

- `open_view(id)` (new command, called by the breakout window on load):
  connects a second `HolderClient` to `~/.swarmz/sessions/<id>.sock` for
  the calling window (viewer label `window:<label>`), kept in
  `AppState.views: HashMap<(String /*window*/, String /*id*/), Arc<PtySession>>`,
  and emits the replay on `pty:replay:<id>:<label>` so the main window's
  pane does not reset. Data from either viewer goes to `pty:data:<id>` as
  now (the holder broadcasts to every viewer; the core forwards the first
  viewer's stream only, so nothing is doubled).
- `write_terminal` and `resize_terminal` take the calling window's viewer
  when it has one, else the main one. The holder already sizes to whoever
  typed last (phone spec §3.5), so a breakout window on a bigger monitor
  gets its columns once something is typed there, and the main window's
  hidden pane never fights it.
- `close_view(id)` drops the window's viewer; the window's close event
  does the same.
- `terminal_foreground_busy`, `terminal_cwd` and friends keep using the
  main viewer.

## 4. The breakout window

- A second Vite entry, `breakout.html` → `src/breakout.tsx`, rendering
  `BreakoutApp` for the tile named in the URL (`?tile=<id>`). It does not
  run `loadWorkspace`, sync, agent watchers or the updater; it reads what
  it needs from the main window through two new commands, `tile_snapshot(id)`
  (name, cwd, settings, card, agent state) and a `tile:changed:<id>` event
  the main window's store emits when any of those change. Writes that
  change settings (title edit, folder) go through the main window: the
  breakout window invokes them via `main_window_action`, a small command
  that forwards to the main window with an event, so the store stays in one
  place.
- Chrome: a 28 px header with the machine chip, title, name and folder
  (the sidebar's second line), the status dot, and **Return to workspace**.
  Below it the same `TerminalPane` (xterm registry entry keyed by tile id,
  in this window's registry), the connect card and the exited banner.
- Window: label `tile-<id>`, title `<title> · swarmz`, no minimum below
  480×320, `dragDropEnabled: false` like the main window, created with
  `WebviewWindow` from the main window at the cursor's screen position
  (§5) and 900×600 by default. Capabilities: a second capability file for
  `tile-*` windows with the same permissions as `main`.
- Closing the window (traffic light, ⌘W) returns the tile to the workbench.
  Quitting the app closes them all; the list in `windows.json` restores
  them on the next launch, at their saved bounds, once the main window has
  opened the tile.

## 5. The gesture

- **Drag out.** Tabs are already draggable (`startTerminalDrag`). When the
  drag ends with no drop target and the pointer is outside the main
  window's bounds (`dragend` with `dropEffect === "none"` and
  `screenX/screenY` outside `getCurrentWindow().outerPosition/outerSize`),
  the tile breaks out, with the new window placed at the pointer's screen
  position (its top-left 40 px left and above, so the header sits under the
  cursor). HTML5 drag does not cross windows, so this is the whole gesture;
  there is no drop into another breakout window.
- **Drag back.** A breakout window's header is a drag source of the same
  tile; dropping it on the main window's tab bar or edge zones moves it
  there and closes the breakout window. (A drop needs the main window to
  receive `dragover`, which it does for tabs today; the drag data is the
  tile id, as now.)
- **Menu and keys.** Right-click a tab → **Open in own window**; in a
  breakout window ⌘⇧W or the header button returns it. A placeholder tab's
  click brings the window forward (`WebviewWindow.getByLabel(...).setFocus()`).

## 6. Edge cases

- The tile closes or exits while out: the breakout window shows the exited
  banner with Restart, as the main pane would; closing it removes the
  tile's entry from `windows.json`.
- The workspace is reloaded or adopted without the tile: the breakout
  window closes with a note in the sidebar.
- A breakout window's saved bounds are off every current screen (a monitor
  unplugged): it opens centred on the main window's screen.
- Two breakouts of the same tile: refused; the existing window is focused.
- The main window closes: breakout windows close with it (the app has one
  main window, and quitting is what closing it means today).

## 7. Testing

- **Core (Rust):** a second viewer on a holder receives data and its own
  replay; writes from the second viewer reach the shell; dropping it leaves
  the first intact; `open_view` for an unknown tile or a closed session is
  an error.
- **Frontend (vitest):** the store's breakout set (add, remove, restore
  from `windows.json`, dropping ids the workspace no longer has); the tab
  placeholder; a drag ending outside the window calls the breakout action
  and one ending inside does not; `BreakoutApp` renders the header from a
  snapshot and updates on the event; return-to-workspace.
- **By hand:** drag a tab onto a second monitor; type there and see the
  main window's placeholder stay put; drag it back; relaunch with two
  breakouts open.

## 8. Build order

1. Core: per-window viewers (`open_view`, `close_view`, viewer-aware
   write/resize), replay per window.
2. Breakout window: entry, capability, `BreakoutApp`, the snapshot command
   and event, return button, `windows.json` restore.
3. Gestures: drag out, drag back, tab menu, placeholder tab.

Each step is testable alone; after step 2 a tile can be broken out from
the tab's menu even before the drag gesture exists.
