# swarmz: an activity bar, and a view of every Mac

Date: 2026-09-25
Status: approved design
Amends: `2026-09-23-sidebar-groups-design.md` (the side bar gains views and sections; the
terminal list itself is unchanged), `2026-09-23-conductor-design.md` §6 (the 📱 and 🔔 buttons
move to the activity bar).

## 1. Purpose

The side bar is one column of terminals with a row of buttons on top, and nothing says how the
Macs themselves are doing. Make it work like VS Code's: an **activity bar** down the left edge
switches the side bar between views, and a view is a stack of **sections** that fold. Add a
**Machines** view, and a compact Machines section under the terminal list, with each Mac's CPU,
memory, disk, ping and Claude sessions.

Non-goals: history graphs (numbers now, not over time); alerts on thresholds; Macs that are not
on the tailnet; the phone (the tool command below would let it show the same later).

## 2. The activity bar

A 44 px column at the far left of the window, before the side bar:

- **Top:** Terminals (the terminal list, the default) and Machines. The active view's icon is
  lit, with a bar on its left edge like VS Code's; clicking the active view's icon again folds the
  side bar away (and clicking any icon brings it back), so the workbench can take the width.
- **Bottom:** Conductors (opens the Conductors dialog), Phones and Notifications (views holding
  today's panels, full height rather than squeezed above the list).
- A badge on Terminals counts the tiles that need you when the view is not showing; a badge on
  Machines marks a Mac that is offline or out of disk (under 5% free).
- The chosen view and whether the side bar is folded are per-Mac preferences (`localStorage`,
  like the side bar's width).

## 3. Sections

A view is a stack of sections, each with a header (a fold arrow, an upper-case title, its
buttons on the right showing on hover, as VS Code's). A folded section is its header alone.
Fold state is per Mac.

- **Terminals view:** **Terminals** (today's list, with Group by, reload and + in its header),
  then **Machines** (compact: one line per Mac: its chip, a status dot, ping, a small CPU bar,
  and its Claude sessions as `3 · 1 needs you`), folded to its header by default the first time.
  The terminals section takes the remaining height; the machines section sizes to its lines.
- **Machines view:** a card per Mac (this Mac first, then by name): online, ping and whether
  Tailscale reaches it directly or through a relay; CPU (%, and load over the core count),
  memory used, disk free on `/`, uptime; Claude sessions by state (working, needs you, idle,
  stopped); the swarmz app and tool versions it runs; when it last answered. A Mac that did not
  answer says why (offline, not reachable, the tool too old to report).
- **Phones** and **Notifications** views: today's panels.

## 4. Where the numbers come from

- **`swarmz stats`** (new, read-only, gated for the phone too): this Mac's numbers as JSON:
  `{cpu: {percent, load1, cores}, memory: {usedPercent, totalBytes}, disk: {freePercent,
  freeBytes}, uptimeSeconds, claude: {working, needsYou, idle, stopped}, tool, build}`. CPU is the
  sum of every process's `%cpu` over the core count (`ps`), load from `sysctl vm.loadavg`,
  memory from `vm_stat` and `hw.memsize` (used = active + wired + compressed), disk from
  `statfs("/")`, uptime from `kern.boottime`; the Claude counts are this Mac's tile rows (`ls`)
  by status. It takes well under a second.
- **The app** runs it here, and over ssh for every online Mac on the tailnet that runs macOS
  (the same peers and ssh options as the workspace sync, `BatchMode`, a 6 s timeout), every 30 s
  while the window is focused and either the Machines section is open or the Machines view is
  showing, and once when either opens. A Mac whose tool has no `stats` answers `usage`: shown as
  "update swarmz on this Mac".
- **Ping** is `tailscale ping -c 1 --timeout 2s <name>`: the round trip in ms and whether it went
  direct or through a DERP relay (and which). The app version of each Mac is read from its app
  bundle by the same ssh call.

## 5. Testing

- **Tool:** `stats` parses the `ps`, `vm_stat` and `sysctl` outputs from fixtures (a busy and an
  idle Mac), counts Claude rows by status, and prints the documented JSON; the CLI test runs it.
- **Core:** the `tailscale ping` output (direct, relayed, timed out) is parsed into `{ms, via}`.
- **Frontend:** the activity bar switches views, folds the side bar on a second click, shows the
  needs-you badge; sections fold and remember it; the Machines section and view render the
  numbers, a slow or failing Mac, and an old tool; polling starts when the section opens and
  stops when it folds or the window blurs.
- **By hand:** watch a Mac's CPU climb during a build; unplug a Mac from the tailnet and see it
  go offline; compare ping direct and relayed.

## 6. Build order

1. Tool `stats` and the core's `machine_stats`/`tailscale_ping`.
2. Activity bar and sections, with today's panels moved into views.
3. The Machines section and view, and polling.
