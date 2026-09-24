# swarmz: opening the files a tile talks about

Date: 2026-09-24
Status: approved design, implemented 2026-09-24 (steps 1–3)
Amends: `2026-09-10-swarmz-design.md` §4 (panes gain links), `2026-09-16-swarmz-phone-design.md`
(nothing here reaches the phone yet; §7 names the tool command that would).

## 1. Purpose

Claude prints the files it touched (`src/store.ts:2612`, `~/.swarmz/workspace.json`, a
screenshot's path) and the pane shows them as plain text. You should be able to click one and
see it: a text file right here, a picture right here, anything else in the app that owns it.
The same for a tile whose shell is on another Mac, where the file is not on this disk.

Non-goals (for now): editing files in swarmz; a file tree or browser; the phone (§7 says how it
would get there); files on a Mac whose tile is not connected.

## 2. Links in a pane

Panes get an xterm.js **link provider** (`src/lib/paneLinks.ts`, registered by the registry when
it creates a terminal): on hover it scans the row for **URLs** (`http`, `https`, `file`) and
**file paths**, underlines the match, and a click opens it.

A path is one of `/absolute/path`, `~/path`, `./relative` or `../relative`, or a bare relative
path with at least one `/` or a file extension (`src/store.ts`, `README.md`, `Cargo.toml`), any
of them with an optional `:line` or `:line:col` suffix and any of the wrappings Claude uses
(backticks, quotes, parentheses, a trailing `,` or `.`). It has to look like a path, not be one:
the viewer says "not found" when it is not, so hover costs no round trip (an ssh tile's would be
one). Relative paths resolve against the tile's folder (`terminals[id].cwd` locally,
`settings.ssh.cwd` for an ssh tile, the foreign cwd for a foreign local), which tracks the shell
(folder tracking spec); `~` against the home of the Mac the shell runs on.

A URL opens in the browser. A path opens the **viewer** (§3). Plain click, like a URL in any
terminal; xterm keeps the selection gesture separate.

## 3. The viewer

A modal over the workbench (`FileViewer`, the same shape as the phones dialog): the file's path
in the title with the machine chip when it is not this Mac, and a body by kind:

- **Text** (anything UTF-8, up to `VIEW_MAX` 2 MiB): monospace with line numbers, the linked
  line highlighted and scrolled into view, syntax colouring from highlight.js (core plus the
  languages in `HIGHLIGHT_LANGUAGES`, guessed from the extension; plain when unknown), a
  **Wrap** toggle, and the browser's own find (the body is plain DOM, so ⌘F works). Markdown
  shows rendered, with **Raw** to switch.
- **Image** (`png`, `jpg`, `gif`, `webp`, `svg`): shown at its size, scrollable, from a data URL.
- **Anything else** (binary, or over the cap): the size and a note, and the buttons below.

Buttons: **Open** (§4), **Reveal** (local only), **Copy path**, **Open in VS Code** when
`code` is on the PATH (§4). Esc or a click outside closes it.

Reading is one core command, `read_file(host, path)` (as built: the frontend resolves the
path and passes the tile's ssh host when it is connected): a local read for a local tile
(`std::fs`, refusing anything that is not a regular file or a folder), and for an ssh tile one
shell line over the shared ssh master (`BatchMode`, like `workspace_pull`) that prints what the
path is, its size and up to the cap base64-encoded, since bytes do not survive ssh's text
stream. Text is told from binary by content (UTF-8 without a NUL in the first 8 KiB), images by
extension. The reply is `{kind: "text"|"image"|"binary"|"dir", size, truncated, text?|base64?|entries?}`.
A tile whose ssh is not connected gets "not connected", not a prompt.

## 4. Opening outside

- **Local:** **Open** is macOS `open <path>` (the default app), **Reveal** is `open -R <path>`
  (Finder). No plugin: a core command shells out to `/usr/bin/open`, paths validated as the
  registry validates cwds.
- **Remote:** **Open** fetches the file to `~/.swarmz/remote/<machine>/<path>` on this Mac
  (`scp` over the master, replacing an older copy) and opens that copy, so a PDF or a photo on
  another Mac still opens here; the viewer says it is a copy. **Open in VS Code** runs
  `code --remote ssh-remote+<host> <path>` for a remote tile and `code --goto <path>:<line>`
  for a local one, which edits the real file in either case; the button shows only when `code`
  resolves on this Mac's PATH (checked once per run).

## 5. What is not clickable

Paths inside a running full-screen program's own chrome are still matched (Claude's file
listings are the point), but the provider only underlines on hover, so nothing changes until the
user points at it. Directories open in the viewer as a listing (`ls -la` semantics through the
same `read_file`, `kind: "dir"`), one level, each entry clickable.

## 6. Testing

- **`paneLinks`:** the matcher on Claude's actual output shapes (backticked paths, `path:line`,
  `(file.ts:12)`, a trailing period, `~/x`, `./x`, a URL beside a path, a Windows-looking
  string that must not match, `node_modules/x/y.js`), and resolution against a folder and a
  home.
- **Core:** `read_file` reads text, reports an image by extension and a binary by content,
  truncates at the cap, refuses a directory as text and lists it as a dir, refuses a socket;
  the remote command line is built and quoted right (fixture, no ssh).
- **Viewer:** renders text with the linked line marked, an image, a binary note; Raw/rendered
  for markdown; Open/Reveal call the core; the VS Code button is absent without `code`.
- **By hand:** click a path Claude printed in a local tile and in an ssh tile; a screenshot
  path; a PDF on the other Mac; ⌘F in a long file.

## 7. Later

The tool could serve the same read to the phone (`swarmz file <tile> <path>`, gated, capped), so
a tapped path opens a viewer there too. Editing in the viewer would reuse the workspace push's
write path. Neither is in the build below.

## 8. Build order

1. Links and the viewer for text and images, local and remote (`paneLinks`, `read_file`,
   `FileViewer`).
2. Open, Reveal, the remote fetch, Open in VS Code, directory listings.
3. URLs in the browser (the same provider; a one-line core command).
