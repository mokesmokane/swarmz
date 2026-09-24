# swarmz: a tree of conductors

Date: 2026-09-24
Status: approved design, implemented 2026-09-24 (steps 1–2)
Amends: `2026-09-23-conductor-design.md` §2 (who may act on whom), §3 (who is a conductor, the
guard, claims), §4 (the briefing), §6–§7 (the badge). Telegram (§5) is unchanged: it stays the
top conductor's.

## 1. Purpose

One conductor for everything gets crowded: the certifyIP tiles alone are a team's worth of work.
A **sub-conductor** looks after one area (say every tile under the certifyIP folders), answers to
the conductor above it, and the conductor above talks to it rather than to every tile under it.

Two rules make the tree:

- **A conductor acts only on its direct children.** It sends to, asks, answers for, starts,
  restarts and closes the tiles that answer to it, which include the sub-conductors below it, and
  never a tile further down. To get something done under a sub-conductor it asks the
  sub-conductor.
- **A conductor may glance at any descendant's screen.** `output` (at most 200 lines, never
  followed) reaches every tile below it at any depth, so it can check on work without asking.
  Transcripts and images stay refused for everyone, as before.

Non-goals: more than one top conductor; a tile answering to two conductors; sub-conductors
talking to the user on Telegram (they escalate to their parent, which may).

## 2. Who answers to whom

- The **top conductor** is the workspace's `conductor`, as today. Older tools keep reading it.
- **Sub-conductors** are a new top-level workspace field, synced like the rest:
  `conductors: { "<tile id>": { "parent": "<conductor tile id>", "folders": ["/abs/prefix", …] } }`.
  A sub-conductor's parent is the top conductor or another sub-conductor.
- A sub-conductor's **scope** is its folder prefixes, compared as plain string prefixes with a
  trailing `/` dropped, so `…/projects/certifyip` covers `certifyip_services` and
  `certifyip-desktop` alike: a tile belongs to the sub-conductor whose prefix matches the tile's
  folder longest (the ssh folder for an ssh tile, else the tile's
  `cwd`), so a new tile or worktree under the certifyIP folders joins it without anyone listing
  it. A tile in no scope answers to the top conductor.
- A sub-conductor itself answers to its `parent`, whatever its own folder says. A conductor never
  answers to itself or to anything below it: an entry that would make a loop, or whose parent is
  gone, is ignored (the tile is then an ordinary tile) until the user fixes it.
- `owner(tile)` is the conductor a tile answers to; `ancestors(tile)` is the chain above it.

## 3. The guard

For a command run from tile `caller` against tile `target`:

| Command | Allowed when |
|---|---|
| `send`, `ask`, `key`, `answer`, `pending`, `close`, `restart` on another tile | `owner(target) == caller` |
| `output` on another tile | `caller` is in `ancestors(target)`; capped at 200 lines, no `--follow` |
| `transcript`, `image` on another tile | never |
| `fleet` | any conductor; a sub-conductor sees only its descendants (and itself) |
| `new` | any conductor; a sub-conductor's new tile must land inside its scope (`--folder` under one of its prefixes) |
| `--on <mac>` | any conductor (the far Mac's tool checks the command again) |
| `notify`, `telegram-follow` | the top conductor only |
| `conductor --set/--deny/--clear/--remove` | never a tile (the user's, from the desktop or phone) |

`reply` goes to `owner(caller)`, so a tile under a sub-conductor answers it, and a sub-conductor
answering its own parent is simply a reply. The desktop and the phone's gate still carry no tile
and pass everything.

## 4. Making one

- **Claim:** `swarmz conductor --claim --folder <prefix> [--folder <prefix>…]` asks to be a
  sub-conductor for those folders, under the conductor the claimant answers to now. The claim
  (`conductorClaim`) gains `folders` and `parent`. The user approves or denies it exactly as
  today (the claim bar, the phone card, Telegram); approving a claim with folders makes a
  sub-conductor, one without folders the top conductor.
- **Directly:** `swarmz conductor --set <tile> --parent <id> --folder <prefix>…` (the user's) makes
  a sub-conductor; `--set <tile>` alone still sets the top conductor. `swarmz conductor --remove
  <tile>` turns a sub-conductor back into an ordinary tile; its tiles go back to its parent.
- **Desktop:** the 🎛 button on a Claude row opens a menu: **Make conductor** (the top, replacing
  any other), **Make sub-conductor…** (only once there is a top), which asks for the folders
  (defaulting to the tile's own folder) and the parent (defaulting to the conductor it answers to
  now), and **Not the conductor** / **Not a conductor** on a conductor.
- `swarmz conductor` reports `{conductor, conductors, claim}`.

## 5. Telling them

The briefing's conductor section is written per conductor: a sub-conductor is told its scope,
its parent's title, that it acts only on the tiles directly under it, that it may glance at any
screen below it, and to raise what needs the user with its parent through `swarmz reply`, never
Telegram. The top conductor is told the sub-conductors under it and to route work below them
through them. An ordinary tile's briefing is unchanged.

## 6. Seeing it

- Every conductor's row, tab and hover card carry 🎛; a sub-conductor's hover card names its
  folders and its parent. `ls`/`watch` rows carry `conductor: true` for every conductor, so the
  phone marks them all.
- The hover card of any tile names the conductor it answers to.

## 7. Compatibility

A Mac on an older tool sees sub-conductors as ordinary tiles, so it refuses them what they may
not do anyway; it would drop `conductors` on its next save, so every Mac is updated together, as
for the conductor itself. The desktop keeps top-level workspace fields it does not know through
a save, so the next field added here cannot be lost this way.

## 8. Testing

- **Tool:** owner resolution (longest prefix, ssh folder, a sub-conductor answers to its parent,
  loops and orphans ignored); the guard table row by row, including a grandchild refused to act
  and allowed to glance; `reply` routed to the owner; `fleet` filtered; `new` inside and outside a
  scope; a claim with folders approved into a sub-conductor; `--remove`; the briefing per role.
- **Desktop:** `conductors` read, written and compared; unknown top-level fields kept; badge and
  hover card; Make sub-conductor.
- **By hand:** make a certifyIP sub-conductor; from the top, ask it for a status; try to send to a
  certifyIP tile directly and be refused; glance at one with `output`.

## 9. Build order

1. Tool: `conductors`, owner resolution, the guard, `reply` routing, `fleet` filter, claims with
   folders, `--set --parent --folder`, `--remove`, per-role briefing.
2. Desktop: the field (and unknown top-level fields) through load, save and adopt; badges, hover
   card, Make sub-conductor. Both ship in one release, since an older desktop drops the field.
