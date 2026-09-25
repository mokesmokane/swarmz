# Windows and layouts (design)

Date: 2026-09-25. Amends the shared workspace spec (2026-09-14: the layout is no longer
shared) and replaces the breakout windows spec (2026-09-23: a tile in its own window becomes a
window of tabs, and moving a tile out of the main window takes its space with it).

## 1. What the user asked for

- The layout belongs to each Mac, not to the shared workspace.
- Dragging a tile into a new window removes its space in the main window.
- Every window can hold tabs and splits and be rearranged, like the main one.
- Tabs move between windows by dragging, the way Chrome's do.
- A group of tabbed tiles can be sent to a new window in one click.
- Predefined layouts, offered as a gallery of small drawings.
- Several tiles picked in the sidebar (Cmd/Ctrl-click) can be shown together in a layout.
- Empty slots with a picker, zoom a pane, windows remembered on their screens.
- Closing a tab or a window keeps the tile running; the user is reminded it still runs until
  it is removed from the sidebar.

## 2. The layout is per Mac

The workspace keeps the shared list of tiles. Where each tile shows (which window, which group,
which split) is this Mac's alone, kept in `localStorage` (`swarmz.layouts`: the main window's
tree and each other window's tree, by window label) beside the other per-Mac preferences.

- `workspace.json`'s `layout` is no longer read after the first run, never compared
  (`sameWorkspaceContent` ignores it) and never a reason to save. Every save writes back the
  `layout` the file last had, untouched, so an older swarmz on another Mac still has one.
- First run of this version on a Mac: the file's layout becomes the main window's (as today:
  every tile placed), and each tile that was in a breakout window gets a window of its own.
- A tile no window shows is *not open here*. It keeps running, the sidebar lists it, and a
  click on its row opens it as a tab in the main window's focused group (or brings forward the
  window that shows it).
- A tile created in this app opens where it was asked for. A tile that arrives through the
  file (made on another Mac, or by `swarmz new`) shows only in the sidebar until opened.
- A tile removed from the workspace leaves every window.

## 3. Closing is not stopping

- A tab's × closes the tab: the tile keeps running, not open here.
- The sidebar row's × stops the tile and removes it from the workspace, as today (its tooltip
  says so).
- Closing a tab or a window shows a notice in that window: "<title> is still running. Remove
  it from the sidebar to stop it." with **Undo**, which opens the tiles again where they were
  (a closed window comes back with its layout). The notice goes after 8 s.
- A row whose tile is not open here is marked in the sidebar (a hollow ◌, "not open in a
  window, still running").

## 4. Windows

Every window is a workbench: the main window (label `main`, with the activity bar and side
bar) and any number of others (`win-<id>`, only tabs and panes). Each has its own tree, with
tabs, splits, drop zones, the + and split buttons, empty slots, presets and zoom.

The main window owns the store, as before. Another window mirrors what its panes need
(`window:state:<label>`: the tiles, their settings and agent state, the connect state, its own
tree and focus, the drag in progress) and sends every change as an action from an allow-list
(`window:action`), which the main window applies to that window's tree. A tile's pane in
another window is a second viewer of its holder (`open_view`), opened when the tile arrives in
that window and closed when it leaves; the main window still receives and parses every tile's
output, so clipboard, folder and resume handling stay in one place.

- **New window.** Dropping a tab (or a sidebar row) outside every swarmz window opens a new
  window under the pointer with that tile. Each tab's ↗ does the same without a drag, and each
  tab strip's ⧉ moves the whole group, every tab of it, to a new window.
- **Between windows, like Chrome.** A drag starting in any window is announced to all of them,
  so every window shows its drop zones (the tab strip, the four sides, the centre) while it is
  under the pointer, and a drop there moves the tile: its space leaves the window it came from.
  When the webview does not deliver that drop, the drag's end still knows the pointer's screen
  position: over another swarmz window the drop is resolved there at that point (tab strip:
  a tab; a pane: the zone under the pointer); anywhere else it opens a new window. A window
  left with no tabs closes.
- **Moving without a drag.** A tab's context menu offers the other windows by name and
  "New window".
- **Closing.** The user closing a window closes its tabs (§3). Quitting swarmz does not: every
  window comes back at launch with its tree.

The window does not follow the pointer during a drag (Chrome's live tear-off); it appears where
the drag ends.

## 5. Windows keep their places

Every window's position and size (the main one's too) are kept per Mac and restored at launch,
when the saved rectangle still overlaps a connected display; otherwise the window opens at the
default place.

## 6. Preset layouts

A ▦ button in every tab strip opens the gallery: a grid of cards, each a small drawing of the
layout with its slots numbered, and its name.

| Preset | Slots |
| --- | --- |
| Single | 1 |
| Side by side | 2 |
| Stacked | 2 |
| Main and two | 3 |
| Three columns | 3 |
| Top and two | 3 |
| Grid | 4 |
| Main and three | 4 |
| Six grid | 6 |

Choosing one arranges that window's open tiles into it: each group's active tab first, in
reading order, then the other tabs. Tiles beyond the slots become tabs of the last slot; slots
beyond the tiles are empty slots (§7). The drawings come from the same trees the presets build,
so they cannot disagree.

## 7. Empty slots

A slot with no tile shows a picker: tiles not open here first, then tiles open elsewhere (which
move here), and **New shell here** (a local shell in the folder of the tile last focused, else
home). Its × removes the slot. A slot is kept only until it is filled; a group emptied later
closes as any group does.

## 8. Picking several tiles

In the sidebar, Cmd/Ctrl-click toggles a row into the selection and Shift-click adds the rows
between the last one picked and this one; Escape clears it. Each group header (Machine, Status,
Folder, and each conductor in Tree) has a button that selects its tiles. While tiles are
selected, a bar under the list shows how many, the preset drawings (the ones that fit that many
tiles marked), a target (**New window** or **Main window**) and **Clear**. Choosing a preset
arranges the selected tiles, in the order they were picked, into that target: in a new window
they leave wherever they were; in the main window the tiles it showed that are not selected are
closed there (still running, with the §3 notice and Undo).

## 9. Zoom

⤢ in a tab strip, or ⌘⇧↩, makes the focused group fill its window; the same again puts it back.
Zoom belongs to the window, is not saved, and ends when its group leaves the window.

## 10. Out of scope

Named or saved layouts, layouts shared between Macs, a "needs you" slot, the live tear-off
window, and the phone.

## 11. Tests

Pure: the per-window tree operations (place, move across windows, close, prune, empty slots),
preset trees and their drawings, the migration from the file layout and breakouts, the
selection range. Store: per-Mac layout never saved to the file nor adopted from it, tiles from
the file not opened, tab close keeps the tile, moving a tile between windows, a window emptied
closes, preset application, the notice and Undo. Components: the gallery, the empty slot
picker, the sidebar's selection and not-open mark, and a window's mirror applying state and
proxying actions.
