# swarmz: shared workspace across tailnet machines

Date: 2026-09-14
Status: approved design, not yet implemented
Amends: `2026-09-11-workspace-persistence-design.md` (§2 file, §5.2 store) and
`2026-09-14-tailscale-machines-design.md`.

## 1. Purpose

Open swarmz on any Mac in the tailnet and see the same sidebar and tiles as on
the others. The workspace file travels over the tailnet by itself; a terminal
that was local on another Mac opens here as a remote terminal to that Mac, in
the same folder, so Claude sessions resume where they live.

Non-goals: sharing live PTYs or scrollback; more than one person; machines
outside the tailnet; merging two divergent edits (last writer wins).

## 2. Data

### 2.1 File additions

```json
{
  "version": 1,
  "sync": { "revision": 42, "updatedAt": "2026-09-14T15:02:11Z", "updatedBy": "martins-mac-mini-2" },
  "terminals": [
    { "id": "…", "name": "swarmz", "cwd": "/Users/mokes/projects/swarmz", "origin": "martins-mac-mini-2", "ssh": null, … }
  ],
  …
}
```

- `sync.revision` is a monotonic counter bumped by every local save;
  `updatedAt`/`updatedBy` record when and on which machine. Rust preserves
  `sync` through its top-level `extra` flatten; TS reads and writes it.
- `terminals[].origin` is the Tailscale name of the machine the terminal was
  created on. Legacy defs without it are stamped with the current machine on
  first load when Tailscale is running.
- Everything else is unchanged. Machine aliases and colours are already in the
  file and therefore shared.

### 2.2 Self identity

`self` is `tailscale.self.name` from `tailscale_status`. When Tailscale is not
running, sync is off, `origin` is not stamped, and the app behaves exactly as
before.

## 3. Opening rules

On load or when adopting a newer file, for each def with self `S`:

| def | opens as |
|-----|----------|
| `ssh` set | remote terminal, unchanged |
| no `ssh`, `origin` absent or `= S` | local shell in `cwd`, as today |
| no `ssh`, `origin = O ≠ S`, `O` known | **foreign local**: local shell in `$HOME`, in-memory `ssh = { host: machineHost(O, machines[O], user), cwd: def.cwd, machine: O }`, settings flagged `foreign: { cwd: def.cwd }`; startup bar as for any remote terminal |
| no `ssh`, `origin = O ≠ S`, `O` unknown | local shell in `cwd`, with the note `origin machine O is not on your tailnet; opened locally` |

`O` is *known* when it is a tailnet peer or a machine recorded in `machines`; otherwise
`machineHost` would invent an address for a machine that does not exist and every
startup would fail. `self` is resolved (a Tailscale refresh) *before* any def is
opened, so a foreign local is never mistaken for one of ours.

A foreign local is written back exactly as it was read (`ssh: null`,
`cwd: def.cwd`, `origin: O`), so the origin machine still opens it as a plain
local shell. Its Claude config is carried as-is; `--resume` runs on `O`.

## 4. Sync

All copies are full copies; the newest `revision` wins.

- **Pull**: `workspace_pull(host)` runs `cat ~/.swarmz/workspace.json` on a
  peer over ssh (`BatchMode=yes`, `ConnectTimeout=5`, the shared
  `ControlPath`, 10 s timeout). `Ok(None)` when the file does not exist. The
  store pulls from every online peer whose host it can derive
  (`machineHost(peer, machines[peer], tailscale.user)`), on launch (after the
  local load), on window focus, and every 30 s. The candidate with the
  highest `revision` (then newest `updatedAt`) that is newer than the local
  one is **adopted**: saved locally verbatim, then applied with the reload
  semantics (open missing defs, close defs absent from the file without a
  confirm, replace layout/machines). A pending local save is flushed (saved and
  bumped) before any comparison; adoption is skipped only while another
  adoption or reload is in progress. Adoptions and reloads are serialised, so
  two of them can never open the same def twice.
- **Peers**: only *online macOS* peers are pulled from and pushed to — anything
  else on the tailnet does not run swarmz, and every round would report a
  timeout against it. Pushes run in parallel.
- **First sync**: a machine that has never synced has terminals that are not an
  older copy of the peer's workspace — they were never shared. "Never synced"
  is decided once, when the workspace file is loaded (no `sync` block, or no
  file at all), and holds until this machine's first pull completes: its own
  saves write a `sync` block, so re-deriving the state from the file would end
  it after one save. Such a machine **pulls before it ever pushes**: it does not
  flush a pending save ahead of the pull, and a save made before that first
  pull completes is written locally but not pushed — otherwise its own file
  would reach the peers first and the union below would merge its copy back
  into itself. Its first pull adopts the *union*: the peer's workspace plus any
  local terminal the peer does not have, with the peer's `sync`. The union is
  then saved (bumped, pushed), so the peers converge on it too.
- **Changes during an adoption**: edits made while adopting are not saved (the
  file already is the adopted state). When adoption finishes, the reconciled
  state is compared with the file that was adopted and saved if it differs, so
  a rename or a new tile made meanwhile is not lost. The comparison is
  *content-based*: terminals as a map keyed by id (name, cwd, ssh, claude,
  command, origin), the layout structurally, machines as a map, `sync` ignored.
  It must not depend on the order things are written down, or two machines that
  reconcile the same file into the same terminals — listed differently — would
  rewrite each other once per poll forever. A terminal's name is machine-local
  whenever the registry had to deduplicate it; the shared file keeps the name
  that was requested. An adoption also applies the file's name to terminals
  that are already open; if this machine cannot use that name, the difference is
  treated as machine-local. For the same reason adoption also
  takes the file's **sidebar order** (ids it lists, in its order, then anything
  local it does not mention), not just its layout. An adoption that fails
  before it reconciles writes nothing back.
- **Closed terminals**: when an adoption closes N ≥ 1 terminals it says so in
  the dismissible workspace line: `N terminal(s) closed by a workspace update
  from <updatedBy>`.
- **Malformed peer copy**: a pulled candidate is only considered when it parses
  and has `version: 1`, an array of `terminals` and a numeric `sync.revision`;
  otherwise it is skipped and named in the sync line. An adoption that fails
  (cannot save or reconcile) is reported there too and never leaves the app
  stuck in "adopting".
- **Push**: after every successful local save, `workspace_push(host, text)`
  writes the file to each online macOS peer (`mkdir -p ~/.swarmz && cat >
  ~/.swarmz/workspace.json.sync.$$ && mv -f … workspace.json`, contents on
  stdin; the `$$` is the remote shell's pid, so two pushes arriving at once
  cannot share a temporary file). Best effort; failures show in the sync line
  and do not block.
- **External change**: every 5 s the store calls `workspace_stat()` (local
  file mtime). If the mtime differs from the last one the app wrote or saw,
  the file is loaded and adopted when its `revision` is newer. This is how a
  push from another Mac is noticed within seconds. If the file that appeared is
  *older* than what this machine holds (a peer pushed a stale copy, a backup was
  restored), our copy is re-asserted instead: it is saved — which bumps the
  revision — and pushed, so the other machine adopts ours.
- **Bumping**: `scheduleSave` sets `sync = { revision: prev + 1, updatedAt:
  now, updatedBy: self }` before writing. Adopting never bumps.
- Requires: Remote Login on each Mac and your key in each `authorized_keys`.
  Without key access to a peer, pull/push to it fail quietly and the sync
  line says so.

## 5. UI

Sidebar header gains a one-line sync status under the title:
- `Synced · 1/2 machines · 12 s ago` (reachable/total peers; click: pull now)
- `Sync off · Tailscale not running`
- `Sync error · <message>` (click: retry)

Foreign locals look like any remote terminal: the origin machine's colour and
alias, the second line `martins-mac-mini-2 · /Users/mokes/projects/swarmz`.

## 6. Errors

- Peer unreachable / no key: that peer is skipped; the sync line reports how
  many succeeded.
- Remote file malformed: ignored for that round, error shown.
- Adopted file fails to open some defs: the existing "saving is paused" rule
  applies, and pulling continues.
- Two Macs save within the same second: higher revision wins; if revisions tie
  the newer `updatedAt` wins; on an exact tie the higher `updatedBy` (string
  order) wins, so both Macs pick the same winner and converge; the loser's
  change is overwritten (accepted).

## 7. Testing

Rust: pull/push command strings (pure), push feeds stdin, pull maps "No such
file" to `None`, stat returns mtime.

Frontend: `pickNewest`, `isNewer` (including the `updatedBy` tiebreak),
`mergeForFirstSync`, `openingFor(def, self, machines, user, knownMachines)`
(four rules), `toWorkspace` writes a foreign local back unchanged and writes
`origin`/`sync`; store: origin stamping on create and load, save bumps
revision and pushes, adopt when a pulled copy is newer (opens/closes/relayouts,
no confirm), skip adopt while a save is pending, stat poll adopts an external
newer file and ignores our own write, sync line states, identity resolved
before defs open, an older external file is re-asserted, a pull racing a stat
poll opens nothing twice, an edit made during an adoption is saved after it,
non-macOS peers are not pushed to, a malformed peer copy is skipped, and a
never-synced machine keeps its own terminals on its first pull.

Manual: run swarmz on both desk minis; add a tile on one, see it on the other
within seconds; a local tile from A shows on B as A's colour and connects to A;
quit A, relaunch: A's layout equals B's.
