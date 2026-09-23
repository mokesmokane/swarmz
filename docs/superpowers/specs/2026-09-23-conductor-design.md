# swarmz: the conductor tile

Date: 2026-09-23
Status: proposed, not yet implemented
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

Every other tile stays as it is: it may keep its own card, and nothing
else. Agents never message each other.

Non-goals: several conductors; conductors on the phone (the phone already
does what a conductor does, for a human); a queue or inbox between agents;
scheduling (the conductor watches, it does not cron).

## 2. What the conductor can do

Everything the phone can, on every Mac, from its shell, through the tool:

| Need | Command (existing unless marked) |
|---|---|
| See every tile: title, machine, status, needs, recap, last message | `swarmz fleet` **(new)**: `ls` on this Mac and, over the shared ssh master, on every online Mac, in one JSON |
| Watch for changes | `swarmz fleet --follow` **(new)**: one line per change, as `watch` does per Mac |
| Read a conversation | `swarmz [--on <mac>] transcript <tile>` |
| See the screen | `swarmz [--on <mac>] output <tile>` |
| Say something to a tile | `swarmz [--on <mac>] send <tile> -- "…"` |
| Answer its question or permission | `swarmz [--on <mac>] pending <tile>`, `answer <tile> …` |
| Start, stop, restart a tile | `new`, `close`, `restart` |
| Tell the user | `swarmz notify "…"` **(new)**: Telegram |

`--on <mac>` **(new)** runs the same command on another Mac over the shared
ssh master (`BatchMode`, like `workspace_pull`); the reply comes back as
is. It needs the other Mac's tool to be installed, which the agent-state
fan-out already does.

## 3. Who is the conductor

- `workspace.json` gains a top-level `conductor: "<tile id>"` (through
  `extra`, synced like everything else), so every Mac and the phone know.
  At most one. It is set from the desktop (§6) or the tool
  (`swarmz conductor --set <tile>` / `--clear` / no flag to read), which
  bumps the revision like `card` does.
- **Enforcement is in the tool, on every Mac.** A command that acts on a
  tile other than the caller's own (`send`, `key`, `answer`, `transcript`,
  `output`, `pending`, `image`, `close`, `restart`, `new`, `fleet`,
  `--on`, `notify`) is refused with `denied` unless `SWARMZ_TERMINAL_ID`
  equals the workspace's conductor. A tile may always act on itself
  (`card`, and its own `transcript`/`output`). The phone's key is not a
  tile: it keeps its access through the gate as today.
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
machine, lead with what needs the user), how to hand work to a tile (`send`
a clear instruction, then `fleet --follow` or check back), when to use
`notify` (the user asked to be told; a tile has waited on a question for
more than a few minutes; something failed), and never to type into a tile
that is blocked on a permission unless the user said so. A user-edited
`briefing.md` still wins for the common part.

## 5. Telegram

- `~/.swarmz/telegram.json` on each Mac: `{"token": "…", "chatId": "…"}`,
  mode 0600, never in `workspace.json`. Set from the desktop's
  **Notifications** panel (§6), which writes it here and, like the hooks,
  on every online Mac over ssh, so the conductor can run anywhere.
- `swarmz notify [--tile <id>] <text>` **(new)**: `sendMessage` to `chatId`
  with the text (4000 characters max, cut), prefixed by the tile's title in
  bold when `--tile` is given. Only the conductor may call it. Errors:
  `not_configured`, `failed` (with Telegram's description).
- **Inbound** `swarmz telegram-follow` **(new)**: long-polls `getUpdates`
  and, for each message from `chatId` (any other sender is dropped), types
  it into the conductor tile as `[telegram] <text>` with `send`. The
  desktop app runs it as a watcher on the conductor's home Mac while the
  conductor is running there (one instance; a watcher like the agent log
  tails). A reply from the conductor comes back only if the conductor runs
  `notify`, which its briefing tells it to do for messages that arrived
  with the `[telegram]` prefix.
- The desktop panel has a **Send test** button.

## 6. Desktop

- A tile's row and tab carry a 🎛 badge when it is the conductor; the
  hover card says "Conductor".
- The row's menu gains **Make conductor** (and **Not the conductor** on
  the current one), which sets `conductor` in the workspace. Only Claude
  tiles qualify.
- The **+** menu gains **Conductor…**: a local terminal in a folder you
  pick (default `~/.swarmz/conductor`, created if missing, with a
  `CLAUDE.md` that says what this folder is for), with Claude enabled, made
  the conductor at once.
- A **Notifications** panel (a 🔔 button beside 📱) with the Telegram token
  and chat id, Send test, and the per-Mac install state.

## 7. Phone

The conductor's row shows the 🎛 badge. Nothing else changes.

## 8. Testing

- **Tool:** `conductor` set/clear/read bumps the revision; the guard denies
  cross-tile commands for a non-conductor tile and allows them for the
  conductor and for a phone key; `--on` builds the ssh line and passes the
  reply through (fixture, no real ssh); `fleet` merges rows from several
  Macs and marks each with its machine; `notify` posts the right JSON to a
  fake endpoint (URL overridable for tests) and refuses without a config;
  `telegram-follow` types only the configured chat's messages, with the
  prefix; `briefing` prints the conductor section only for the conductor.
- **Desktop:** the badge; Make conductor; the + menu; the panel writes the
  file and fans out; a test send.
- **By hand:** make a tile the conductor, ask it what everyone is doing,
  have it tell another tile to do something, and send yourself a Telegram
  message; reply from Telegram and see it land in the conductor.

## 9. Build order

1. Tool: `conductor`, the guard, `--on`, `fleet`, `briefing`; the hook
   script calls `briefing` (version 4).
2. Desktop: badge, Make conductor, Conductor…, the workspace field.
3. Telegram: config file and panel with fan-out, `notify`, `telegram-follow`
   and its watcher.

After step 1 a tile set as conductor by hand (`swarmz conductor --set`)
already works from its shell; after step 2 it is a click; step 3 adds the
phone-away channel.
