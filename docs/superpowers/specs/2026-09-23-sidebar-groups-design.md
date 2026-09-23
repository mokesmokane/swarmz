# swarmz: a more informative terminal list

Date: 2026-09-23
Status: approved design, implemented 2026-09-23
Amends: `2026-09-10-swarmz-design.md` §4.1 (sidebar rows), `2026-09-21-conversation-cards-design.md` §5 (the row's second line).

## 1. Purpose

The sidebar lists tiles in workspace order with a name and a folder. With
tiles spread over three Macs it does not say, at a glance, where each one
runs, what it is doing, or when it last did anything. This adds a
**group-by** control, a **machine chip** on every row, and a **last
activity** time.

Non-goals: reordering tiles by drag within the list (drag still moves a tile
into the workbench); grouping on the phone (its list already groups by Mac).

## 2. Rows

Each row keeps its title line (card title, else first prompt, else name;
conversation cards spec §5) and gets a second line built from:

- **Machine chip.** A dot in the machine's colour and the machine's
  Tailscale name (a remote's, or this Mac's; "this Mac" when that is not
  known). The alias is not the label, since it is usually the tile's own
  name already; it goes in the chip's tooltip and, in brackets, in a Machine
  group's header. Offline remotes get a hollow dot. The chip is always
  shown, so local and remote rows read alike.
- **Folder.** The basename of the tile's folder (`ssh.cwd` or `foreign.cwd`
  for a remote, `cwd` for a local).
- **Status.** From the agent state and exit code: `needs you` (blocked, or
  idle and unseen), `working`, `idle`, `stopped` (exited 0 or no session),
  `exited N` (a failing exit).
- **Last activity.** The time of the tile's last hook event
  (`agentState.since`), else its newest session's `lastActiveAt`, as a
  relative time (`now`, `3m`, `2h`, `1d`), refreshed every 30 s. Absent when
  neither exists.

Rendered as `⬤ mini2 · certifyIP · working · 2m`, always in that order,
truncated from the right; the status word is amber for `needs you`, green
for `working`, red for a failing exit, muted otherwise. The tile's **name**
is not on this line (amended 2026-09-23: it was prepended when a title was
shown, which pushed the machine off the front): when the title has taken
the name's place and the folder does not already say it, the name is a
small mono tag at the end of the title line.

## 3. Grouping

A control at the top of the list, kept per machine in `localStorage`
(`swarmz.sidebarGroupBy`), with four settings:

| Setting | Groups | Order within a group |
|---|---|---|
| **Workspace** (default) | none | workspace order |
| **Machine** | one per machine, this Mac first, then by label; the header carries the dot and, for a remote, `online` / `offline` | last activity, newest first |
| **Status** | Needs you, Working, Idle, Stopped, in that order; empty groups hidden | last activity, newest first |
| **Folder** | one per folder basename, by name | last activity, newest first |

A group header is a small uppercase line with the group's name and its
count. Rows are the same component whatever the grouping, so drag, rename,
title edit, history and the hover card are unchanged.

## 4. Testing

- `sidebarGroups.test.ts`: the row info (chip label for local, remote,
  aliased and unknown-origin tiles; status precedence; last activity
  fallbacks), each grouping's membership and order, the preference's
  round-trip and default.
- `Sidebar.test.tsx`: the control changes the grouping; a Machine group
  header shows the label and state; the second line reads
  `<chip> · <folder> · <status> · <time>`.
