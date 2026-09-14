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
| no `ssh`, `origin = O ≠ S` | **foreign local**: local shell in `$HOME`, in-memory `ssh = { host: machineHost(O, machines[O], user), cwd: def.cwd, machine: O }`, settings flagged `foreign: { cwd: def.cwd }`; startup bar as for any remote terminal |

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
  confirm, replace layout/machines). Adoption is skipped while a local save is
  pending or a reload is in progress.
- **Push**: after every successful local save, `workspace_push(host, text)`
  writes the file to each online peer (`mkdir -p ~/.swarmz && cat >
  ~/.swarmz/workspace.json.sync && mv -f … workspace.json`, contents on
  stdin). Best effort; failures show in the sync line and do not block.
- **External change**: every 5 s the store calls `workspace_stat()` (local
  file mtime). If the mtime differs from the last one the app wrote or saw,
  the file is loaded and adopted when its `revision` is newer. This is how a
  push from another Mac is noticed within seconds.
- **Bumping**: `scheduleSave` sets `sync = { revision: prev + 1, updatedAt:
  now, updatedBy: self }` before writing. Adopting never bumps.
- Requires: Remote Login on each Mac and your key in each `authorized_keys`.
  Without key access to a peer, pull/push to it fail quietly and the sync
  line says so.

## 5. UI

Sidebar header gains a one-line sync status under the title:
- `Synced · 2 machines · 12 s ago` (click: pull now)
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
  the newer `updatedAt` wins; the loser's change is overwritten (accepted).

## 7. Testing

Rust: pull/push command strings (pure), push feeds stdin, pull maps "No such
file" to `None`, stat returns mtime.

Frontend: `pickNewest`, `isNewer`, `openingFor(def, self, machines, user)`
(three rules), `toWorkspace` writes a foreign local back unchanged and writes
`origin`/`sync`; store: origin stamping on create and load, save bumps
revision and pushes, adopt when a pulled copy is newer (opens/closes/relayouts,
no confirm), skip adopt while a save is pending, stat poll adopts an external
newer file and ignores our own write, sync line states.

Manual: run swarmz on both desk minis; add a tile on one, see it on the other
within seconds; a local tile from A shows on B as A's colour and connects to A;
quit A, relaunch: A's layout equals B's.
