# swarmz: the conductor tile

Date: 2026-09-23
Status: approved design; steps 1 (tool: conductor with claims, the guard, --on, fleet, ask, reply, briefing; hook script v4) and 2 (desktop badge, claim bar, Make conductor, Conductor…, the workspace fields; `ls`/`watch` report the conductor and claim; phone mark and claim card) and 3 (Telegram: the per-Mac file, `notify`, `telegram-follow` with claim answers, the Notifications panel with fan-out and a test, the follower on the conductor's Mac) implemented 2026-09-23
Amends: `2026-09-10-swarmz-design.md` §5–§6 (the ledger, MCP tools and
messaging are replaced: agents do not talk to each other; one tile talks to
all of them); `2026-09-16-swarmz-phone-design.md` §4.7 (the gate's
allow-list gains `notify`, `fleet` and `conductor`); `2026-09-21-conversation-cards-design.md`
§4.1 (the briefing comes from the tool, not a fixed file).

## 1. Purpose

One tile in the workspace is the **conductor**: the only Claude allowed to
act on the other tiles. You ask it "what is everyone doing?", "tell the
certifyIP tile to run the tests", "wake me when the load test finishes",
and it does that by reading the other tiles and typing into them. It can
also reach you when you are away, on Telegram, and you can reach it from
Telegram.

Every other tile stays as it is: it keeps its own card, and answers the
conductor when asked. Agents never message each other; the conductor never
reads a tile's conversation (it would drown in it): it asks, and the tile
answers in a few lines.

Non-goals: several conductors; conductors on the phone (the phone already
does what a conductor does, for a human); a queue or inbox between agents;
scheduling (the conductor watches, it does not cron).

## 2. What the conductor can do

Everything the phone can, on every Mac, from its shell, through the tool:

| Need | Command (existing unless marked) |
|---|---|
| See every tile: title, machine, status, needs, recap, last message (each cut short) | `swarmz fleet` **(new)**: `ls` on this Mac and, over the shared ssh master, on every online Mac, in one JSON; `recap` and `lastMessage` are capped at 280 characters |
| Watch for changes | `swarmz fleet --follow` **(new)**: one line per change, as `watch` does per Mac |
| Ask a tile something | `swarmz ask <tile> -- "…"` **(new)**: types `[conductor <title>] <question> (answer with: swarmz reply -- "...")` into the tile (ASCII only: a plain shell scrambles wide characters in a pasted line) |
| Tell a tile to do something | `swarmz [--on <mac>] send <tile> -- "…"`, the same line with `[conductor <title>]` in front so the tile knows who is speaking |
| Answer a tile's question or permission | `swarmz [--on <mac>] pending <tile>`, `answer <tile> …` |
| Start, stop, restart a tile | `new`, `close`, `restart` |
| Tell the user | `swarmz notify "…"` **(new)**: Telegram |
| Glance at a tile's screen | `swarmz [--on <mac>] output <tile> --lines N`: the last N lines (at most 200 from another tile, no `--follow`), to see what it is doing or whether a sent line landed (amended 2026-09-23: the hook state lags, and a glance is bounded) |

**Not** `transcript` or `image` on another tile: the conductor never
reads a conversation. What it knows about a tile is its card, its status,
its answers, and a screenful at a time.

### 2.1 Replies

Any tile may run `swarmz reply -- "…"` **(new)**. It types
`[<tile title>] <text>` into the conductor tile (over ssh when the
conductor is on another Mac), at most 1000 characters, so an answer arrives
as a prompt the conductor reads like any other. A reply with no conductor
set is `denied`. The ordinary briefing tells every tile: when a line
starting `[conductor` asks you something, answer it with `swarmz reply`, in
a few lines, and carry on.

`--on <mac>` **(new)** runs the same command on another Mac over the shared
ssh master (`BatchMode`, like `workspace_pull`); the reply comes back as
is. It needs the other Mac's tool to be installed, which the agent-state
fan-out already does.

## 3. Who is the conductor

- `workspace.json` gains a top-level `conductor: "<tile id>"` (through
  `extra`, synced like everything else), so every Mac and the phone know.
  At most one. It is set from the desktop (§6), or **claimed**:
- **Any Claude may claim the role**, and only the user can grant it.
  `swarmz conductor --claim` (from a tile; the id from
  `SWARMZ_TERMINAL_ID`) writes `conductorClaim: {tile, title, at}` into the
  workspace and returns `{claimed: true, pending: true}`; a claim by the
  current conductor is a no-op. The desktop shows the claim as a bar at the
  top of the sidebar, **"<title> asks to be the conductor" · Approve ·
  Deny**, and the phone as a needs-you card with the same two buttons; once
  Telegram is set up the user gets a message too, with the same choice by
  reply (`approve` / `deny`). Approve sets `conductor` and clears the claim;
  Deny clears it; a newer claim replaces an older one. The tile that
  claimed is told the outcome as a prompt (`[swarmz] you are the
  conductor` / `[swarmz] the conductor claim was denied`) so it can carry
  on either way. `swarmz conductor` (no flag) reads the current conductor
  and any pending claim; `--set` and `--clear` exist for the desktop and
  tests, not for agents (the guard refuses them from a tile).
- **Enforcement is in the tool, on every Mac.** A command that acts on a
  tile other than the caller's own (`send`, `ask`, `key`, `answer`,
  `pending`, `close`, `restart`, `new`, `fleet`, `--on`, `notify`) is
  refused with `denied` unless `SWARMZ_TERMINAL_ID` equals the workspace's
  conductor; `transcript` and `image` on another tile are refused for every
  tile, the conductor included, and `output` on another tile is the
  conductor's alone, capped at 200 lines and never followed. A tile may
  always act on itself
  (`card`, `reply`, `conductor --claim`). The phone's key is not a tile: it
  keeps its access through the gate as today.
- This is a guardrail, not a sandbox: an agent with a shell could reach a
  holder's socket or ssh by hand. The briefing tells ordinary tiles the
  rule; the tool enforces the ordinary path. That is the same standing as
  the phone's gate (phone spec §7.3).

## 4. Telling the agents

The `SessionStart` hook stops printing a fixed file and instead runs
`swarmz briefing` **(new)**, which prints the context for the calling tile:
`~/.swarmz/briefing.md` as today, plus, when the tile is the conductor, a
**conductor section**: what it may do (§2 as prose, with the command
lines), how to answer "what's everyone doing" (run `fleet`, summarise by
machine, lead with what needs the user), how to find out more (`ask` the
tile and wait for its `[<title>]` reply as a prompt; never try to read its
conversation), how to hand work to a tile (`send` a clear instruction,
then `fleet --follow` or check back), when to use `notify` (the user asked
to be told; a tile has waited on a question for more than a few minutes;
something failed), and never to type into a tile that is blocked on a
permission unless the user said so. The **ordinary section** gains two
lines: how to answer a `[conductor …]` ask with `swarmz reply`, and that
`swarmz conductor --claim` asks the user to make this tile the conductor.
A user-edited `briefing.md` still wins for the common part.

## 5. Telegram

- `~/.swarmz/telegram.json` on each Mac: `{"token": "…", "chatId": "…"}`,
  mode 0600, never in `workspace.json`. Set from the desktop's
  **Notifications** panel (§6), which writes it here and, like the hooks,
  on every online Mac over ssh, so the conductor can run anywhere.
- `swarmz notify [--tile <id>] -- <text>` **(new)**: `sendMessage` to `chatId`
  with the text (4000 characters max, cut; HTML parse mode, escaped),
  prefixed by the tile's title in bold when `--tile` is given. Only the
  conductor (or the user: the desktop and the phone's gate) may call it.
  Errors: `not_configured`, `failed` (with Telegram's description). Requests
  go through `curl` with the token in a config on stdin, so it is in no
  argument list; `SWARMZ_TELEGRAM_API` overrides the base URL for tests.
- **Inbound** `swarmz telegram-follow [--once]` **(new)**: long-polls
  `getUpdates` and, for each message from `chatId` (any other sender is
  dropped), types it into the conductor tile as `[telegram] <text>`
  (wherever the conductor runs, as `reply` does); `approve` / `deny` while
  a claim is pending answer it instead, and Telegram hears the outcome.
  With no conductor set, Telegram is told so. One JSON line per message
  (`outcome`: `delivered`, `approved`, `denied`, `no_conductor`, `failed`);
  `--once` polls a single time (tests). The desktop app keeps it running
  on the conductor's home Mac while the conductor is a running local tile
  there (one instance, restarted after it ends). A reply from the
  conductor comes back only if the conductor runs `notify`, which its
  briefing tells it to do for messages that arrived with the `[telegram]`
  prefix. A claim is also sent to Telegram by `conductor --claim` when the
  file is set up.
- The desktop panel has a **Send test** button.

## 6. Desktop

- A tile's row and tab carry a 🎛 badge when it is the conductor; the
  hover card says "Conductor".
- A pending claim is a bar at the top of the sidebar (§3): the claimant's
  title, **Approve**, **Deny**. It appears on every Mac (the claim is in the
  workspace); the first answer wins and clears it everywhere.
- The row gains **Make conductor** (and **Not the conductor** on the
  current one; as built, a 🎛 button that shows on hover, since rows have
  no menu), which sets `conductor` in the workspace through the tool, so
  the tile is told. Only Claude tiles qualify.
- The **+** menu gains **Conductor…**: a local terminal in a folder you
  pick (default `~/.swarmz/conductor`, created if missing, with a
  `CLAUDE.md` that says what this folder is for), with Claude enabled, made
  the conductor at once.
- A **Notifications** panel (a 🔔 button beside 📱) with the Telegram token
  (never shown back; an empty field keeps it) and chat id, Save (which
  also pushes the file to every Mac with a connected tile; the rest get it
  when their tiles connect, alongside the hooks), Send test, Remove, and a
  line saying whether this Mac listens for messages.

## 7. Phone

The conductor's row shows the 🎛 badge, and a pending claim is a needs-you
card on Home with **Approve** and **Deny** (`swarmz conductor --set` /
`--deny` through the gate, which allows them from a phone key). For that,
`ls` and the `watch` snapshot carry `conductor` and `claim` beside the
rows, `watch` emits a `{"type":"conductor","conductor":…,"claim":…}` event
when either changes, and each row has `conductor: true` when it is the
conductor.

## 8. Testing

- **Tool:** `conductor` set/clear/read bumps the revision; `--claim`
  records a claim and is a no-op for the conductor; the guard denies
  cross-tile commands for a non-conductor tile, allows them for the
  conductor and for a phone key, refuses `transcript` on another tile for
  everyone and allows a capped `output` there to the conductor alone; `ask` types the prefixed line and `reply` types
  `[<title>] …` into the conductor, locally and over `--on`, cut at 1000
  characters, `denied` with no conductor; `--on` builds the ssh line and passes the
  reply through (fixture, no real ssh); `fleet` merges rows from several
  Macs and marks each with its machine; `notify` posts the right JSON to a
  fake endpoint (URL overridable for tests) and refuses without a config;
  `telegram-follow` types only the configured chat's messages, with the
  prefix; `briefing` prints the conductor section only for the conductor.
- **Desktop:** the badge; Make conductor; the + menu; the claim bar's
  Approve and Deny set and clear the field and tell the claimant; the panel
  writes the file and fans out; a test send.
- **By hand:** make a tile the conductor, ask it what everyone is doing,
  have it tell another tile to do something, and send yourself a Telegram
  message; reply from Telegram and see it land in the conductor.

## 9. Build order

1. Tool: `conductor` with `--claim`, the guard, `--on`, `fleet`, `ask`,
   `reply`, `briefing`; the hook script calls `briefing` (version 4).
2. Desktop: badge, Make conductor, Conductor…, the workspace field.
3. Telegram: config file and panel with fan-out, `notify`, `telegram-follow`
   and its watcher.

After step 1 a tile set as conductor by hand (`swarmz conductor --set`)
already works from its shell; after step 2 it is a click; step 3 adds the
phone-away channel.
