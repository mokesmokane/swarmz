# swarmz: Tailscale machines replace SSH host entry

Date: 2026-09-14
Status: approved design, not yet implemented
Amends: `2026-09-11-ssh-remote-browse-design.md` (§5 form, §5.1 history) and
`2026-09-11-workspace-persistence-design.md` (§2 file).

## 1. Purpose

Remote terminals are created by picking a machine on the user's Tailscale
network, not by typing an SSH host. Each machine can carry an alias, a
username, and a colour so every tile and sidebar row for that machine is
recognisable at a glance. The connect → pick folder → show terminal flow and
everything underneath (shared socket, liveness, folder picker) stay as they
are.

Non-goals: non-Tailscale hosts (existing terminals with a plain `ssh.host`
keep restoring and working, but the creation form offers only tailnet
machines); Tailscale SSH (the tailnet only provides the route; plain `ssh`
over it does the login); editing the Tailscale account from the app.

## 2. Data

### 2.1 Tailscale status (runtime, not persisted)

The core runs `tailscale status --json` and returns:

```ts
interface TailscaleMachine { name: string; hostName: string; ip: string | null; os: string; online: boolean }
interface TailscaleStatus { running: boolean; message: string | null; user: string; self: TailscaleMachine | null; peers: TailscaleMachine[] }
```

- `name` is the short MagicDNS name (`DNSName` up to the first dot, e.g.
  `martins-mac-mini`); it is the machine key everywhere.
- `user` is the local `$USER`, the default SSH username.
- `running: false` with a `message` when the CLI is not found
  (`/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`,
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale` are tried in order),
  when `BackendState` is not `Running`, or when the command fails.
- `self` is excluded from `peers`.

### 2.2 Machine configuration (persisted)

`workspace.json` gains a top-level `machines` map keyed by machine name and
drops `sshHistory` (ignored on load if present):

```json
"machines": {
  "martins-mac-mini": { "alias": "desk mini", "user": "mokes", "color": "#f59e0b", "cwd": "/Users/mokes/projects/x", "lastUsed": "2026-09-14T10:00:00Z" }
}
```

- `alias`, `user`, `color`, `cwd` are optional / nullable. `lastUsed` is set
  whenever a terminal is created on the machine or its folder chosen.
- `color` is one of eight palette values (hex) or `null`:
  `#f59e0b #ef4444 #ec4899 #8b5cf6 #3b82f6 #06b6d4 #22c55e #a3e635`.
- Entries are capped at 50, oldest `lastUsed` dropped.

### 2.3 Terminal settings

`ssh` gains `machine?: string | null` (the machine key) so rows and tiles can
find alias and colour. `host` remains `user@name` and is what the startup
line uses. Terminals restored from older files have `machine` absent and are
shown uncoloured with their host, as today.

## 3. Core (Rust)

New module `tailscale.rs`:
- `status() -> Result<TailscaleStatus, String>`: locate the CLI, run
  `status --json` with a 5 s timeout, parse `Self`, `Peer`, `BackendState`,
  map to §2.1. Parsing is a pure function with tests (short name from
  `DNSName`, online flag, IPv4 preferred from `TailscaleIPs`, self excluded).
- `open_app() -> Result<(), String>`: runs `open -a Tailscale` so the form can
  offer "Open Tailscale".
- Commands `tailscale_status` and `tailscale_open`, async via `spawn_blocking`.

## 4. Frontend

### 4.1 `workspace.ts`

```ts
export const MACHINE_COLORS: readonly string[];
export interface MachineConfig { alias?: string | null; user?: string | null; color?: string | null; cwd?: string | null; lastUsed: string }
export type Machines = Record<string, MachineConfig>;
export function machineLabel(name: string, cfg?: MachineConfig): string;           // alias or name
export function machineHost(name: string, cfg: MachineConfig | undefined, defaultUser: string): string; // `${user}@${name}`
export function touchMachine(m: Machines, name: string, patch: Partial<MachineConfig>, now?: string): Machines; // merge + lastUsed + cap
export function validateAlias(alias: string): string | null;                        // registry name rules
export function isMachineColor(c: string | null | undefined): boolean;
export function tintBackground(base: string, color: string | null): string;         // base mixed 10% toward color
```
`SshConfig` gains `machine?: string | null`. `Workspace` gains `machines?`;
`toWorkspace` writes it when non-empty. `sshHistory` helpers are removed.

### 4.2 Store

State: `machines: Machines`, `tailscale: TailscaleStatus | null`,
`tailscaleError: string | null`.

- `refreshTailscale()`: calls the command; on error sets `tailscaleError`.
  Called when the remote form opens and every 30 s while any remote terminal
  exists (for the online dots).
- `updateMachine(name, patch)`: validates alias and colour, merges via
  `touchMachine` (without bumping `lastUsed` for pure edits), and renames
  open terminals whose current name equals the old alias/name to the new
  alias.
- `createRemoteTerminal({ machine, cwd, claude }, placement?)`: resolves host
  via `machineHost`, names the terminal after the alias, sets
  `ssh.machine`, bumps `lastUsed`, then follows the existing
  `createSshTerminal` path (which stays as the lower-level primitive used by
  tile splits).
- `chooseRemoteDir` also records `machines[name].cwd` when the terminal has a
  machine.
- `machineFor(id)` selector: the machine config for a terminal, or `undefined`.
- Load/save: `machines` read and written like `sshHistory` was; `sshHistory`
  ignored.

### 4.3 UI

- **Sidebar `+` menu**: "Local terminal…" and "Remote terminal…".
- **`NewRemoteTerminal`** replaces `NewSshTerminal`:
  - Not running: message, Retry, Open Tailscale.
  - Running: list of peers, online first (offline dimmed but selectable),
    each row: colour dot, alias, name in grey when aliased, last folder,
    gear. Selecting a row highlights it and reveals Run Claude / Skip
    permissions and Connect (defaults remembered per machine are not needed;
    toggles start off).
  - Gear opens `MachineSettings` inline: alias, username (placeholder = local
    user), colour swatches (plus "none"), Save/Cancel.
  - Connect runs the existing headless-connect → folder picker → create flow
    with `createRemoteTerminal`.
- **Colour everywhere**: a `machineColor(id)` hook returns the colour;
  sidebar rows use it for the status dot (online green/grey stays as a small
  inner dot) and a 2 px left border; tabs use it for the dot; the tile gets a
  2 px top bar; xterm's background is `tintBackground("#0f1115", color)`,
  applied on attach and whenever the machine's colour changes (registry
  subscribes to the store).
- **Tailscale online state**: sidebar rows for machine terminals show a
  tooltip "online on Tailscale" / "offline" from the latest status.
- Amendment (2026-09-14, later): the per-terminal settings panel and the
  sidebar row gear are removed entirely. Renaming stays inline (double-click),
  machine alias/username/colour live in the Remote terminal list's gear, and
  folder / Claude choices are made at creation. `command` remains a
  hand-editable field in the file with no UI.

## 5. Errors

- CLI missing / logged out: the remote form shows the message; nothing else
  changes.
- Machine offline: still selectable; connect will time out with the existing
  note.
- Invalid alias (registry rules) or colour not in the palette: inline error /
  ignored.
- `machines` in a hand-edited file with junk: entries failing validation are
  dropped with a persistError note.

## 6. Testing

Rust: `parse_status` (short name, online, IPv4 preference, self excluded,
BackendState not Running → running false), CLI lookup falls back through the
candidates.

Frontend: `machineLabel`, `machineHost`, `touchMachine` cap and lastUsed,
`tintBackground`, `validateAlias`; store: `refreshTailscale` success/error,
`updateMachine` renames open terminals, `createRemoteTerminal` names and tags
the terminal and bumps `lastUsed`, `chooseRemoteDir` records the folder on the
machine, load/save round trip of `machines`; components: remote form lists
peers online-first and reaches the folder picker via the headless path; gear
saves alias and colour; sidebar row and tab render the colour.

Manual: open Remote terminal…, see both minis, set an alias and a colour on
the desk mini, connect, pick a folder, confirm the tile, tab, and row carry
the colour; quit and relaunch; the alias and colour persist.
