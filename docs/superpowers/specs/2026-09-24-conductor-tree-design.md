# swarmz: a tree of conductors

Date: 2026-09-24
Status: approved design, implemented 2026-09-24 (steps 1–2); amended 2026-09-24: membership is an explicit list of tiles, not folder prefixes (§2, §4 as amended)
Amends: `2026-09-23-conductor-design.md` §2 (who may act on whom), §3 (who is a conductor, the
guard, claims), §4 (the briefing), §6–§7 (the badge). Telegram (§5) is unchanged: it stays the
top conductor's.

## 1. Purpose

One conductor for everything gets crowded: the certifyIP tiles alone are a team's worth of work.
A **sub-conductor** looks after a set of tiles (say every certifyIP session), answers to
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
  `conductors: { "<tile id>": { "parent": "<conductor tile id>", "tiles": ["<tile id>", …] } }`.
  A sub-conductor's parent is the top conductor or another sub-conductor.
- **Membership is explicit** (amended 2026-09-24; the first build used folder prefixes, which
  answered the wrong question: a conductor looks after Claude sessions, not places on disk). A
  tile answers to the sub-conductor whose `tiles` lists it; a tile in no list answers to the top.
  A tile is in at most one list: assigning it moves it. A tile that closes leaves its list.
- A sub-conductor itself answers to its `parent`. A conductor never answers to itself or to
  anything below it: an entry that would make a loop, or whose parent is gone, is ignored (its
  tiles then answer to the top) until the user fixes it.
- `owner(tile)` is the conductor a tile answers to; `ancestors(tile)` is the chain above it.

## 3. The guard

For a command run from tile `caller` against tile `target`:

| Command | Allowed when |
|---|---|
| `send`, `ask`, `key`, `answer`, `pending`, `close`, `restart` on another tile | `owner(target) == caller` |
| `output` on another tile | `caller` is in `ancestors(target)`; capped at 200 lines, no `--follow` |
| `transcript`, `image` on another tile | never |
| `fleet` | any conductor; a sub-conductor sees only its descendants (and itself) |
| `new` | any conductor; a tile a sub-conductor starts is added to its `tiles` |
| `--on <mac>` | any conductor (the far Mac's tool checks the command again) |
| `notify`, `telegram-follow` | the top conductor only |
| `conductor --assign <tile> --to <conductor>` | the user; or a conductor moving a tile that answers to it into a sub-conductor directly under it |
| `conductor --set/--deny/--clear/--remove` | never a tile (the user's, from the desktop or phone) |

`restart` brings back whatever is not running (amended 2026-09-24): a stopped tile afresh, or,
when its shell is up and idle but Claude has exited, Claude resumed on the tile's conversation in
that shell, so a conductor never has to type a `claude` line with `send` (which marks the line as
the conductor's, and a shell cannot run it). `reply` goes to `owner(caller)`, so a tile under a sub-conductor answers it, and a sub-conductor
answering its own parent is simply a reply. The desktop and the phone's gate still carry no tile
and pass everything.

## 4. Making one

- **Claim:** `swarmz conductor --claim` asks to be a sub-conductor under the conductor the
  claimant answers to now (the claim, `conductorClaim`, gains `sub: true` and `parent`) whenever
  a top conductor exists; replacing the top takes `--claim --top`, and with no top a plain claim
  is for the top. The claim bar and Telegram say which (a claim to replace the top says so). The user
  approves or denies it exactly as today (the claim bar, the phone card, Telegram); approving a
  sub claim makes a sub-conductor with no tiles yet, a plain claim the top conductor.
- **Directly:** `swarmz conductor --set <tile> --parent <id>` (the user's) makes a sub-conductor;
  `--set <tile>` alone still sets the top conductor. `swarmz conductor --remove <tile>` turns a
  sub-conductor back into an ordinary tile; its tiles go back to its parent.
- **Assigning:** `swarmz conductor --assign <tile> --to <conductor>` puts a tile under a
  sub-conductor, or back under the top (`--to` the top's id). The user may assign anything; a
  conductor may move a tile that answers to it into a sub-conductor directly under it.
- **Desktop:** the 🎛 button on a Claude row opens a menu: **Make conductor** (the top, replacing
  any other), **Make sub-conductor…** (only once there is a top), which asks for the conductor it
  answers to, **Not the conductor** / **Not a conductor** on a conductor, and **Answers to**, a
  choice of the top and every sub-conductor, on any other tile.
- `swarmz conductor` reports `{conductor, conductors, claim}`.

## 5. Telling them

The briefing's conductor section is written per conductor: a sub-conductor is told its tiles,
its parent's title, that it acts only on the tiles directly under it, that it may glance at any
screen below it, and to raise what needs the user with its parent through `swarmz reply`, never
Telegram. The top conductor is told the sub-conductors under it and to route work below them
through them. An ordinary tile's briefing is unchanged.

## 6. Seeing it

- Every conductor's row, tab and hover card carry 🎛; a sub-conductor's hover card names its
  tiles and its parent. `ls`/`watch` rows carry `conductor: true` for every conductor, so the
  phone marks them all.
- The hover card of any tile names the conductor it answers to.

- **The Conductors dialog** (a 🎛 button in the sidebar header, and **Arrange conductors…** in a
  row's menu) draws the whole tree: the top, each sub-conductor under its parent, and every tile
  under the conductor it answers to. Dragging a tile onto a conductor puts it under that
  conductor; dragging a conductor onto another moves it with everything under it; each row also
  has an **Answers to** select, a button to make a Claude tile a conductor where it stands, and
  one to turn a conductor back into a tile. With no top yet it lists the Claude tiles to pick
  one from.
- The sidebar's **Group by** gains **Tree**: the sidebar's own rows (click, rename, hover card,
  dragging into a pane all as in every view) nested under the conductor each answers to, with
  indent guides. A conductor folds shut with its arrow (remembered per Mac) and then says how many
  tiles are under it and how many need you. Dragging a row onto a conductor puts it there, a
  conductor onto another moves it with everything under it; the innermost conductor under the
  pointer decides, and a drop that changes nothing is ignored. An empty conductor shows a
  "Drag tiles here" slot. With no top yet the view is the plain list and a hint.

## 7. Roles survive other Macs' saves

Every Mac saves the whole workspace every few seconds, and last-writer-wins on the file revision
meant a Mac saving from a copy made before a role change wrote the old roles back over it (a
sub-conductor made, told, and gone within seconds). The conductor fields therefore carry their
own stamp, `conductorAt`, written by every change to them, and the newer set of roles wins
independently of the file's revision: an adopted file with older roles leaves the store's roles
in place (and the next save carries them back out), a save first takes newer roles from the file
on disk, and the desktop applies the tool's reply to a role change before adopting anything.

## 8. Compatibility

A Mac on an older tool sees sub-conductors as ordinary tiles, so it refuses them what they may
not do anyway; it would drop `conductors` on its next save, so every Mac is updated together, as
for the conductor itself. The desktop keeps top-level workspace fields it does not know through
a save, so the next field added here cannot be lost this way.

## 9. Testing

- **Tool:** owner resolution (the list, a sub-conductor answers to its parent, loops and orphans
  ignored, a tile in one list only); the guard table row by row, including a grandchild refused to act
  and allowed to glance; `reply` routed to the owner; `fleet` filtered; `new` joining the caller's list; a sub claim approved into a sub-conductor;
  assigning by the user and by a conductor; `--remove`; the briefing per role.
- **Desktop:** `conductors` read, written and compared; unknown top-level fields kept; badge and
  hover card; Make sub-conductor.
- **By hand:** make a certifyIP sub-conductor; from the top, ask it for a status; try to send to a
  certifyIP tile directly and be refused; glance at one with `output`.

## 10. Build order

1. Tool: `conductors`, owner resolution, the guard, `reply` routing, `fleet` filter, sub claims,
   `--set --parent`, `--assign`, `--remove`, per-role briefing.
2. Desktop: the field (and unknown top-level fields) through load, save and adopt; badges, hover
   card, Make sub-conductor. Both ship in one release, since an older desktop drops the field.
