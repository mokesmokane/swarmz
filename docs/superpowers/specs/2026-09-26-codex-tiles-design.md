# Codex tiles (design)

Date: 2026-09-26. Adds OpenAI's Codex CLI as a second agent beside Claude Code, with the same
standing in swarmz: a tile can run Codex, resume its conversations, show its status, keep a card
and a board, be a conductor or answer to one, and be started and driven from the phone. Checked
against Codex CLI 0.157.1.

## 1. What the user sees

- **New terminal** (local and remote) asks for an agent: None, Claude or Codex. "Skip
  permissions" applies to either. **+ → Conductor…** keeps Claude and gains a Codex choice.
- A tile running Codex looks like a Claude tile: status dot, title, recap, board, history,
  conductor badge, Needs you card with Allow/Deny. Its second line carries a small `codex` chip.
- Typing `codex` in a plain tile makes it a Codex tile once Codex reports its session, the way
  typing `claude` does today.
- The first Codex session on a Mac shows Codex's own **Hooks need review** prompt for swarmz's
  hook. Trusting it (once per Mac, or later with `/hooks`) is what lets swarmz see the tile's
  status; until then the tile runs but shows no status. swarmz never bypasses hook trust.
- The phone's New session gains the same Claude/Codex choice; a Codex tile opens on its terminal
  with the agent quick keys.

## 2. The tile

A workspace def carries `codex` with the shape of `claude`
(`{enabled, sessionId, skipPermissions, started}`); a def has one of them at most. It is a
separate key, not a field inside `claude`, so an older app or tool (which keeps unknown def keys
through `extra`) sees a plain shell tile rather than a Claude tile it would start with `claude`.

Inside the desktop the agent config stays in `settings.claude`, with `agent: "codex"` added
(absent means Claude), so every gate that asks "is this an agent tile" keeps working; `toWorkspace`
writes it back under `codex`. The tool's `TerminalDef` gains `codex`, with `def.agent()` returning
which agent and its config. `ls` rows give Codex tiles `kind: "codex"`.

## 3. Starting and resuming

- New: `codex`, plus `--dangerously-bypass-approvals-and-sandbox` when permissions are skipped.
- Resume: `codex resume <sessionId>` (plus the flag). Codex cannot be given a session id up front,
  so a new Codex tile has `started: false` and its id is learned from `SessionStart`, which Codex
  sends with the first prompt (not at launch); `UserPromptSubmit` then marks it started, as for
  Claude. While `started` is false the id is ignored and the line is plain `codex`.
- Remote tiles type `export SWARMZ_TERMINAL_ID=<id> && cd <dir> && <codex line>`, as for Claude.
- A resume Codex does not know prints `No saved session found with ID <id>`; the resume watch
  treats it as Claude's "No conversation found" (the record is dropped, the tile starts fresh).
- `restart`/`resume_in_shell` and `swarmz new --agent codex` (default `claude`) type the Codex
  line; `new` records the def under `codex`.

## 4. Hooks and status

Codex's hooks match Claude's closely: `~/.codex/hooks.json` in the same shape, the same stdin
fields (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt`,
`last_assistant_message`), the tile's environment (so `SWARMZ_TERMINAL_ID`), and it accepts
Claude's `SessionStart` output (`hookSpecificOutput.additionalContext`).

- The install writes `~/.swarmz/hooks/codex.sh`, a wrapper that runs `claude.sh <event> codex`,
  and merges entries for `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`,
  `PostToolUse` and `SessionEnd` into `~/.codex/hooks.json` (same sync/async split and timeout as
  Claude's). The command line never changes between versions, so Codex's trust (kept against the
  hook's hash) survives script updates. It runs locally and on each tailnet Mac, only where
  `~/.codex` exists.
- `claude.sh` given `codex` as its second argument adds `"agent":"codex"` to the logged JSON;
  `parse_line` carries `agent` on the event, and a `SessionStart` with it adopts the tile as Codex.
- Status folds exactly as for Claude: `PermissionRequest` blocks, `PostToolUse` unblocks, `Stop`
  idles. Codex has no `Notification` event, and it may exit without `SessionEnd`: a Codex tile
  whose holder says its shell is in front reads offline (the tool's rows, and the desktop's
  existing 5 s folder poll for local tiles).
- `Stop`'s `last_assistant_message` is kept by the fold and is a Codex row's `lastMessage` (the
  tool does not read Codex's rollout files; `transcript`/`image` refuse Codex tiles with
  `unsupported`).

## 5. Card, board, briefing, conductor

The briefing arrives through `SessionStart` as for Claude, so a Codex session keeps its card and
board and follows the conductor rules unchanged (the text says "the agent" where it said Claude).

Codex runs shell commands in its sandbox, which cannot write `~/.swarmz`. The install writes
`~/.codex/rules/swarmz.rules` with `prefix_rule(..., decision="allow")` for `swarmz card` and
`swarmz board` (both `~/.swarmz/bin/swarmz` and the absolute path), Codex's equivalent of the
`permissions.allow` rules Claude gets: they run outside the sandbox without asking. Other swarmz
commands (a conductor's `send`, `fleet`, …) ask as they do in Claude, unless permissions are
skipped.

A Codex tile can be a conductor, top or sub; the pickers list agent tiles, not only Claude ones.
The conductor folder gets an `AGENTS.md` beside its `CLAUDE.md`.

## 6. Screen

- Input box: Codex's prompt is `›`. `box_text`/`still_in_box` accept it, and the cursor rule
  (§7 of the tile board spec) holds: an empty box shows a dim placeholder with the cursor right
  after the prompt.
- Working: Codex shows `Working (… • esc to interrupt)`, which the existing check reads.
- Approvals: `Would you like to run the following command?` (and Codex's other "Would you like
  to …" headings), options `› 1. Yes, proceed (y)`, `2. Yes, and don't ask again … (p)`,
  `3. No, and tell Codex what to do differently (esc)`, footer `Press enter to confirm or esc to
  cancel`. `dialog.rs` reads it as a permission; `answer yes|always|no` pick options 1, 2 and 3.
  Other Codex pickers (footer `enter select · esc back`/`enter confirm`) read as a question with
  their options.

## 7. Elsewhere

- `stats` counts Codex sessions (`codex`) beside Claude's; Machines shows them when there are any.
- History lists Codex tiles' conversations like Claude's.
- Phone: `kind: "codex"` gets the agent quick keys (Esc, and `/compact`, `/model`, `/status`);
  New session sends `--agent codex`.
- Mixed versions: an older app or tool shows a Codex tile as a shell tile and never types a
  Claude line into it; its status still shows wherever the hooks are installed.
