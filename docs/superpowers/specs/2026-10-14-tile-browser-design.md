# Tile browser (design)

Date: 2026-10-14. In a Claude or Codex tile, open a small built-in browser floating over the
agent's output, the way the scratch shell floats (scratch terminal spec, 2026-10-10). Any site
loads, logins included. The agent can open a page in it for the user with a note, and never sees
the page. Letting agents read and drive the page is out of scope (§7).

## 1. What the user sees

- A 🌐 button in the tile group's header beside `>_`, shown only while the active tab is an agent
  tile (`settings[id].claude?.enabled`, Claude or Codex). The first click opens the browser on a
  blank page with the address bar focused; later clicks hide and show it. While a browser is open
  (shown or hidden) the button stays highlighted.
- The browser window floats over the agent's output, about two thirds of the tile's width and 60%
  of its height, anchored top-right. It can be dragged by its title bar and resized from its
  corner, always inside the tile; position and size are remembered per tile until swarmz quits.
- Its frame, top to bottom:
  - title bar: the page's title, **–** (hide, keeps the page) and **✕** (close the browser);
  - toolbar: back, forward, reload, the address bar, and **Open in Safari**;
  - the agent's note banner, when there is a request (§4);
  - an error strip when the page failed to load (§5);
  - the page.
- ⌘L in the frame focuses the address bar. Clicking the page gives it the keyboard; while it has
  it, the page gets keys first, so swarmz shortcuts work only with focus outside the page.
- One browser per agent tile. Switching to another tab in the group hides it; switching back shows
  it again if it was open.

## 2. Lifecycle

- **Identity.** At most one browser per agent tile. Its native view's label is `browse-<tile id>`.
- **Start.** The first open creates the view in the window that shows the tile, on the given
  address or `about:blank`.
- **Hide.** **–**, switching tabs, zooming another tile, a drag, or an overlapping overlay (§3)
  hide the view without destroying it: the page, its form contents and scroll position stay.
- **Close.** **✕**, closing the tile, the agent being turned off for the tile, or quitting swarmz
  destroy the view. Closing a tile while its view is still being created closes the view as soon
  as it exists.
- **Moving windows.** When the tile moves to another swarmz window, the view is closed in the old
  window and created in the new one at its current address (form contents are lost).
- **Nothing persists** in the workspace: the browser is not saved, synced, shown to the phone or
  conductors, or listed by the tool. A relaunch starts with no browsers open.
- **Logins** live in the app's own WebKit data store, shared by every tile's browser and kept
  across relaunches; they are separate from Safari's.

## 3. The native view

- Built with Tauri's multi-webview support (cargo feature `unstable`): the core adds a child
  webview to the tile's window (`Window::add_child`) and moves, resizes, shows and hides it.
  Tauri is 2.11.
- **Placement.** The frame has an empty box where the page goes. The frontend measures that box
  (window-relative, CSS pixels) and sends it to the core on open, on every frame move or resize,
  on the box's ResizeObserver, and on layout tree or window size changes. The view is inset a few
  pixels inside the frame, so the frame's buttons and resize corner always stay clickable.
- **Visibility.** The view is shown only while: the browser is open, the tile's tab is active in
  its group, the window is not zoomed onto another tile, no tile or tab drag is in progress
  (`draggingTerminalId`), and no app overlay is open (connect card, folder bar, conductors panel,
  file viewer, notifications and other side panels drawn over panes, menus, preset gallery,
  closed-tab notice, identify labels excepted). Where an overlay's overlap is not cheap to check,
  any open overlay hides every browser view: a blank box for a moment beats an unreachable menu.
- **Isolation.** The view has no Tauri capabilities and no IPC: a website cannot call any swarmz
  command. Only `http:` and `https:` load; other schemes are refused (§5).
- **User agent.** The view presents itself as Safari (the current Safari user-agent string for
  macOS), so sign-ins that refuse embedded browsers work.
- **New windows.** A page opening a new window: a sign-in popup (the opener is waiting on it:
  `window.open` with a reference kept, from Apple, Google, Microsoft or GitHub sign-in hosts)
  opens as a sheet inside the same frame and closes when it calls `window.close()`; anything else
  opens in Safari. Downloads open in Safari too.
- **Page reports.** On navigation and title change the core emits `browser:page:<tile>`
  `{url, title, loading}`, and on a load failure `browser:error:<tile>` `{url, message}`.

## 4. Agents open it

- `swarmz browse --url <address> [--note <text>]`, run by the agent in its tile. It needs
  `SWARMZ_TERMINAL_ID` (`no_tile`). The address must be `http` or `https`, parse as a URL, have no
  spaces or control characters (`invalid`), and be at most 2000 characters (`too_long`). The note
  is at most 200 characters (`too_long`) with no control characters (`bad_text`), trimmed, empty
  meaning none. It appends `{ts}\t{tile}\tBrowse\t{"url","note"}` to
  `~/.swarmz/agents/events.log` on the Mac it runs on and prints `{"v":1,"asked":true}`. It never
  says what the user did.
- `agents.rs` parses `Browse` lines into `AgentEvent.url` and `.note`; the event reaches the
  desktop like any agent event, remote ones over the existing tail.
- The desktop acts on a `Browse` event only when it is live: the same rule as `Scratch`
  (`ts` at or after this app's launch and within 30 s of now), deduped by host, tile and `ts`, for
  an agent tile that exists and is local or connected.
  - Browser closed or hidden: it opens (or shows) on the address, with the note banner.
  - Browser showing another page: it stays on that page; the banner shows the note, the address
    and **Go there**.
  - Banner text: "Claude asks:" or "Codex asks:", then the note; **Dismiss** clears it. **Go
    there** navigates and keeps the note.
  - Focus: the browser takes the keyboard only when the user is already in that tile; otherwise
    the 🌐 button pulses until the tile is focused.
- The briefing gains a paragraph on `swarmz browse` (briefing version bump), and the hooks
  install allows it without a prompt: `AGENT_PERMISSIONS` and `CODEX_RULES` gain `swarmz browse`
  entries.
- Remote tiles: the request is written on the remote Mac and the browser opens on this Mac. A
  `localhost` address therefore means this Mac.

## 5. Errors

- **Load failure** (offline, certificate, refused): the error strip says what happened, with
  **Retry** and **Open in Safari**. It clears on the next successful navigation.
- **Address bar.** Text with a scheme other than `http`/`https` is refused with a note in the
  strip. Text without a scheme that looks like a host (contains a dot or is `localhost`, optional
  port and path, no spaces) gets `https://` (`http://` for `localhost` and IP addresses).
  Anything else becomes a DuckDuckGo search.
- **View creation fails** (core error): the frame shows the error with **Retry**, and the 🌐
  button pulses.
- **Remote tile not connected:** a request is ignored the same way as anything else about that
  tile; the 🌐 button works regardless, since the browser runs here.

## 6. Testing

- Rust: address and note checks; `swarmz browse` CLI tests (each error, the events.log line, the
  reply); `parse_line` carrying `url` and `note`; quitting closes browser views.
- Store (vitest, ipc mocked): open, hide, close, placement; the request rules (live check, dedupe,
  pulse, **Go there** while another page shows); closing the tile closes the browser; hiding for
  drags, zoom, inactive tabs and overlays; mirroring and forwarding to other windows; address bar
  input rules.
- Components: `BrowserWindow` (toolbar, address bar, Safari, banner, error strip) and the 🌐
  button in `TabGroup`.
- Not covered by automated tests, checked by hand after a release: the native view following the
  frame, a drag and a second window; sign-in to App Store Connect and to Google; a sign-in popup.

## 7. Later

- Agents reading and driving the page (`swarmz browse --read/--click/--type/--screenshot`) through
  WebKit script evaluation from the core, behind a per-browser "agent may control this page"
  switch. Not part of this design; nothing here should prevent it.
