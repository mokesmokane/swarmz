# Sidebar redesign, direction 2a (design)

Date: 2026-09-25. Replaces the look of the sidebar list (sidebar groups spec), the activity bar
(activity bar and machines spec) and the selection bar (windows and layouts spec §8). The
designer's source is in `assets/2026-09-25-sidebar-redesign/` (`Sidebar Redesign.dc.html`,
direction 2a "Refined + Triage", with `TileRow.dc.html` and `SelectionTray.dc.html`); its markup
and script are the reference for sizes, colours and states.

## What changes

- **Activity bar:** Terminals on top; Conductors (opens the dialog), Phones, Notifications at
  the bottom, with the design's line icons. The Machines view is reached from the sidebar's
  Machines footer.
- **Header:** TERMINALS, then icon buttons for Arrange conductors, Reload workspace and New
  terminal (the Local / Remote / Conductor menu).
- **Notices:** one 26 px line summarising sync ("Synced · 2/3 Macs · 12 s ago", or the sync error
  in amber) with a count of notices; a click opens the list (sync, update, save and hook errors,
  sessions outside the workspace), each with its action (Retry, Restart, Dismiss, Close…).
- **Views:** a segmented control Mac · Triage · Folder · Tree · Time, Triage by default; the old
  Workspace and Status groupings map to Triage.
  - **Triage:** NEEDS YOU (amber count) as cards: a pending conductor claim (dashed, Deny /
    Approve), then each tile needing the user with its title, age, recap (two lines), Mac chip,
    folder and actions: Deny / Allow for a permission (`swarmz answer <tile> no|yes`, on the
    tile's Mac; the tool refuses unless the dialog is live), Answer (opens the tile) otherwise.
    Then WORKING, then QUIET (idle, stopped, exited; folded state kept per Mac, with the exited
    count in red).
  - **Mac, Folder:** a header per group (Mac chip, name, count, needs badge, select-all).
  - **Tree:** the conductor tree as indented rows with guide lines and a caret on conductors;
    folded conductors summarise "N under" and "N need you".
  - **Time:** Last hour, Today, This week, Older by last activity.
- **The row** (`TileRow`): a 14 px dot column (filled by state, hollow when stopped, an amber glow
  when it needs you, a ring when unseen) that becomes a checkbox on hover or while any row is
  picked; title (600 when it needs you, grey when not open in a window) with the conductor icon;
  on the right the status word only when it matters (needs you, exited N) and the age, replaced
  on hover by the actions (conductor role, previous sessions, settings ⋯, stop ×); second line:
  Mac chip, folder, the tile's name in mono when a title replaced it, and a "no-prompt" chip when
  Claude skips permissions. A 2 px left edge in amber (needs you) or blue (picked); backgrounds
  for picked, focused, hovered and needs-you. The hover card, inline rename and title edit,
  drag, identify marks and the settings menu stay.
- **Selection tray:** "N selected" and Clear, an Open in New window / Main window switch, a
  four-column grid of layout thumbnails (the ones with that many slots lit), and a hint.
- **Machines footer:** always shown: MACHINES and the app version (click: check for updates),
  then a line per Mac with its status dot, chip, alias, CPU bar, ping and needs count; a click
  opens the Machines view.

## Amendment: what needs you (2026-09-26)

"Needs you" was too eager: every finished turn you had not looked at, and Claude's "waiting for
input" nudge, flagged the tile. A tile now needs you only when its board asks questions (tile
board spec) or a permission prompt is waiting. The status word says which: "2 questions", or
"permission"; a Needs card shows the board's first question, and a permission keeps Deny/Allow.
The dot is amber only for a waiting permission. The activity bar badge, group and Tree counts and
the Machines footer's count (`swarmz stats`) follow the same rule. Every tile's board is fetched
once so the count is known for tiles not open in a pane.
