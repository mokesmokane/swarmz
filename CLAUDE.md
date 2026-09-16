# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

swarmz is a Tauri 2 desktop app (macOS) that hosts many terminal sessions at once, most of them Claude Code sessions, arranged as a split tree of tab groups. A Rust core owns PTYs and the terminal registry; a React 19 / TypeScript / Tailwind 4 / zustand frontend renders xterm.js panes. The workspace (terminals + layout) persists to `~/.swarmz/workspace.json` and can be shared across Macs on a Tailscale tailnet over plain ssh.

## Commands

```bash
npm install                  # on npm 10.9.x an Arborist bug may require `npx npm@11 install`
npm run tauri dev            # launch the app (runs vite on :1420, then cargo build + window)
npm test                     # frontend unit tests (vitest, one-shot)
npm run test:watch
npx vitest run src/store.test.ts            # single test file
npx vitest run -t "adopts the peer file"    # single test by name
npm run typecheck            # tsc --noEmit
npm run build                # tsc && vite build (frontend only)
npm run build:tool:debug     # build the session holder / swarmz tool
cd src-tauri && cargo test --workspace   # Rust unit tests (app + swarmz-tool)
cd src-tauri && cargo test registry::       # single Rust module
```

There is no linter configured. Vite watches `src/` only and ignores `src-tauri/`; Rust changes need the tauri dev process to rebuild.

## Architecture

### Process split and the IPC contract

- `src-tauri/src/lib.rs` registers every Tauri command. `src/lib/ipc.ts` is the single frontend wrapper over `invoke`/`listen`; nothing else imports `@tauri-apps/api/core`. Adding a command means touching both files (plus `commands.rs`).
- PTY output is emitted as base64 strings on `pty:data:<id>` events, exit as `pty:exit:<id>`. Each PTY spawn gets a generation number so a late exit callback from a restarted terminal cannot clobber the new session (see `take_if_current` in `commands.rs`).
- Rust `TerminalRegistry` (`registry.rs`) is the source of truth for terminal id/name/cwd and enforces unique, shell-safe names. The store mirrors it in `terminals`.
- Rust's `Workspace` struct deliberately knows only `version`, `terminals[].{id,name,cwd,ssh,claude,command}` and `layout`; everything else (`sync`, `machines`, `origin`, unknown fields) rides through `#[serde(flatten)] extra` maps so TS can add fields without Rust changes. TS mirrors this with `TerminalSettings.extra`.

### Frontend state

- `src/store.ts` is one zustand store holding terminals, layout tree, per-terminal settings, ssh/tailscale/sync state, and all actions. Most logic lives here and in `src/lib/`; components are thin.
- `src/lib/layout.ts` is the pure layout tree (`GroupNode` of tabs | `SplitNode` with sizes). All mutations are pure functions returning a normalised tree; `Workbench.tsx` renders it with react-resizable-panels.
- `src/lib/xtermRegistry.ts` owns xterm `Terminal` instances outside React so panes survive re-parenting when tiles move. It imports the store, so the store must not import it: instead it registers `prepare`/`size` onto the store's exported `beforeSpawn` object at module load (imported for side effect in `App.tsx`). The store calls `beforeSpawn.hook(id)` before spawning so event listeners are attached before the first PTY byte.

### Startup lines, not spawn args

Terminals always spawn the user's login shell locally. SSH connections, Claude sessions and custom commands are *typed into the PTY* as lines. `startupSteps()` in `src/lib/workspace.ts` composes them: `via: "local"` lines go straight in; `via: "remote"` lines (e.g. `cd <dir> && claude --resume <id>`) wait until the ssh master is up. Anything interpolated into these lines must go through `shellQuote` and the `validate*`/`isSafe*` guards, and terminal names/aliases are restricted at the registry level for the same reason.

SSH uses OpenSSH multiplexing with a control socket under `~/.swarmz/ssh/%C` (`SSH_OPTS` in TS, `CONTROL_PATH` in `remote.rs`). The interactive terminal session becomes the master; the core's short-lived commands (`ssh_check`, `ssh_list_dir`, `workspace_pull/push`) reuse it with `BatchMode=yes` and never prompt.

Ctrl+V in a connected ssh tile with an image on the local clipboard pushes it as a PNG to `~/.swarmz/paste/` on the remote and types the path (`paste.rs`, `IMAGE_PASTE_KEY` in the registry); text paste is untouched. Panes honour OSC 52 clipboard writes (how Claude Code copies its own selections) via the clipboard plugin, refusing queries; `decodeOsc52` in the registry. Shift+Enter sends LF (`SHIFT_ENTER_SEQUENCE`) because xterm.js sends CR for it and has no kitty keyboard protocol; Claude Code treats LF as a newline, shells as Enter.

### Session holders

Every local tile's shell runs in a detached holder process (`src-tauri/tool`, binary `swarmz-tool`, installed as `~/.swarmz/bin/swarmz`, bundled as `Contents/MacOS/swarmz-tool`). `swarmz hold <tile>` starts or finds it under a per-tile lock (errors: `usage`, `cwd_missing`, `busy`, `failed`); the app connects to `~/.swarmz/sessions/<tile>.sock` as a viewer (`HolderClient`, `session.rs`), so quitting or relaunching swarmz leaves shells and agents running, closing a tile terminates its holder, and reattaching replays recent output on `pty:replay:<id>` (while it parses, OSC 52, OSC 7 and the resume scan are ignored). `create_terminal` returns `existed`; existing tiles skip the connect card and startup lines. The sessions lock is never held across `connect` (writes and resizes take it on the main thread).

A tile whose home is another Mac types `ssh … ~/.swarmz/bin/swarmz attach <tile>` when `tool_remote_ready` says the remote tool is usable (the app installs or updates it over the ssh master when the remote is a Darwin machine of the same architecture, never downgrading a newer tool). `attach` writes `OSC 1337 swarmz-attach;new=<0|1>;end=1`, the replay, then `OSC 1337 swarmz-replay-end`: `new=1` types the startup step once (gated by `attachPending`), `new=0` types nothing except an explicitly picked session when the remote shell is idle, and the frontend ignores clipboard and folder escapes until the end marker. Remote folders come from `remote_tile_info`. A failed tool check is cached per host until a failed attach or the next agent install re-checks it.

### Workspace persistence and tailnet sync

- Saves are debounced (`SAVE_DEBOUNCE_MS`) and written atomically by Rust (`workspace.rs`, tmp + rename; a corrupt file is moved aside as `workspace.json.broken-*`).
- Sync (`docs/superpowers/specs/2026-09-14-shared-workspace-design.md`) is last-writer-wins on `sync.{revision,updatedAt,updatedBy}` with a machine-name tiebreak (`isNewer`). Every save bumps the revision and pushes the file to every online tailnet peer via `cat`/`mv` over ssh (`sync.rs`); `App.tsx` pulls on load, on focus, every `SYNC_PULL_MS`, and stats the local file every `SYNC_STAT_MS` to detect hand edits.
- `terminals[].origin` records which machine created a terminal. A local terminal whose origin is another machine opens here as an ssh terminal to that machine in the same cwd (`openingFor`), and is written back as a local def of its origin (`toWorkspace` uses `settings.foreign`). A machine's first sync merges rather than adopts (`mergeForFirstSync`).
- Adoption must converge: comparisons use `sameWorkspaceContent` (order-insensitive, ignores `sync`) so two machines never ping-pong revisions over terminal order. Keep any new comparison order-insensitive.
- Tailscale is only used for discovery: `tailscale status --json` via the CLI (`tailscale.rs`), short MagicDNS name as the machine key. Login is plain ssh over the tailnet.

### Agent state

Claude Code lifecycle hooks (installed once per machine into `~/.claude/settings.json`, script at `~/.swarmz/hooks/claude.sh`) append one line per event to `~/.swarmz/agents/events.log` on the machine Claude runs on. `agents.rs` tails that file locally and over the shared ssh socket for each tailnet machine with a connected tile, emitting `agent:event`. `src/lib/agentState.ts` is the pure reducer (offline / working / idle / blocked, plus `unseen`); the store owns watcher lifecycle, replay rules and the `claude.started` flip on the first `UserPromptSubmit`. Remote claude lines carry `SWARMZ_TERMINAL_ID=<id>` because the remote shell does not inherit the local env.

### Folder tracking and session history

A tile's saved folder is live: local tiles poll the shell's own pid for its cwd (`terminal_cwd`, via `lsof`) 300 ms after Enter and every 5 s while the window is focused, and every tile honours the OSC 7 directory escape, for ssh and foreign tiles only once ssh is connected so a local prompt cannot overwrite the remote folder; hook events also carry Claude's cwd. Changes route through `setTerminalCwd` (registry for local, `settings.ssh.cwd` for ssh, `settings.foreign.cwd` for foreign locals). `src/lib/sessions.ts` keeps each tile's `sessions` list (newest first, max 20); `applyAgentEvent` adopts the live session on SessionStart, `selectSession` goes back to one (moving a local shell with `cd` first), and a `--resume` that Claude reports as gone removes the record.

## Tests

- Store and lib tests run in node; component tests need `// @vitest-environment jsdom` as the first line. Every frontend test mocks `./lib/ipc` (and `@tauri-apps/api/path`, `@tauri-apps/plugin-dialog` where used) with `vi.mock`; look at `src/store.test.ts` for the reusable fake registry pattern.
- `src/store.test.ts` is the main spec for sync/adoption behaviour; new sync rules belong there.
- Rust modules carry their own `#[cfg(test)]` blocks; `workspace.rs` tests use per-process temp dirs.

## Docs and workflow

Design specs live in `docs/superpowers/specs/` and implementation plans in `docs/superpowers/plans/`, dated `YYYY-MM-DD-<topic>.md`. Later specs amend earlier ones and say so in their header; check the newest spec for a feature before changing behaviour. Commit messages follow `type(scope): summary` (e.g. `fix(ui): …`, `feat(core): …`).
