# Machine themes (design)

Date: 2026-09-25. Amends the machine colours of the shared workspace spec (a Mac's colour
tinted its panes).

## What changes

- **A theme per Mac.** Every tile's terminal takes the full theme (background, text, cursor,
  selection, the 16 ANSI colours) of the Mac its shell runs on: its ssh machine, else this Mac.
  The pane around the terminal takes the same background.
- **Five themes:** Midnight (dark indigo), Forest (moss green), Ember (warm brown), Daylight
  (light) and Neon (cyberpunk). Plain is swarmz's original look, still tinted by the Mac's colour.
- **Chosen for you until you choose.** A Mac with no theme picked gets one by its place among
  the known Macs sorted by name (this Mac, the tailnet's macOS peers, the workspace's machines),
  so up to five Macs all differ, and every Mac works out the same answer.
- **Shared.** The pick is the machine's `theme` in `workspace.json`'s `machines`, so a Mac looks
  the same on every Mac. An unknown theme (a newer app's) is ignored, never dropping the Mac.
- **Where to pick.** The Machines view's card for each Mac has a Theme row that opens the picker
  (Auto, the five, Plain), each drawn as a tiny terminal; the ssh Mac settings have it too.

## Amendment: a colour for every Mac (same day)

A Mac with no colour picked takes its theme's accent (Midnight blue, Forest green, Ember orange,
Daylight sky, Neon pink; a Mac on Plain takes the accent its place would give) for its chip and
badges in the sidebar, the Machines view and the remote picker, so every Mac is colourful and its
chip matches its panes. A picked colour still wins; the colour picker's first swatch is
"Automatic".
