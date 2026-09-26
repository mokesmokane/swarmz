# Tile board (design)

Date: 2026-09-26. Adds to the conversation cards spec: the card stays the one-line title and
recap; the board is the richer, agent-written picture of a tile's work, shown in an expandable
header at the top of its pane. The designer's source is in `assets/2026-09-26-tile-board/`
(`Chat Header Ideas.dc.html`, turn 3, "3a": one header with tabs, a colour scheme per tile).

## 1. What the user sees

At the top of every tile that has a board, a 30 px line: a dot (amber when the board says it needs
the user), the title, the Mac, the tile's colour scheme (swatch and name) with ↻ to swap it, and a
caret. Opening it shows five tabs over the terminal; the tab and whether it is open are kept per
tile on this Mac.

- **Where we are:** the goal (large), where it is now, and what comes next, in the scheme's soft
  colour, labelled "Next · needs you" when it does.
- **Plan:** the plan's title, "N of M done", and up to eight step cards in a row: done steps under
  a bar in the scheme's colour, the current one filled, steps to do greyed; each with a title and,
  optionally, a sentence saying what was actually done.
- **Changes:** the branch, its base, flags (uncommitted, not pushed, …), up to eight changed paths
  with a bar of added versus removed lines, and a note.
- **Questions:** each question with its answer buttons; a button types that answer into the tile
  (as `swarmz send` does). The tab shows how many are waiting.
- **Swarm:** the tiles it is talking to (↑ its conductor, ↔ peers, ✕ a broken link) with what each
  is for, and its background agents with how long they have run and their tokens.

A tile with no board shows no header. Colour schemes: Lagoon, Heather, Ember, Moss, Harbor,
Rosewood (hues 185, 300, 55, 135, 240, 15); the agent picks one, the user's ↻ overrides it on this
Mac.

## 2. How the agent writes it

`swarmz board` reads the board as JSON on stdin and replaces the tile's board (the tile is
`SWARMZ_TERMINAL_ID`; `--tile` is for the user). `--get` prints it; `--clear` removes it. A tile
may only write its own board. Shape (every field optional; strings are cut at 400 characters and
lists at the counts above):

    {"scheme":"Lagoon",
     "overview":{"goal":"…","now":"…","next":"…","needsYou":false},
     "plan":{"title":"…","steps":[{"t":"…","d":"…","s":"done|current|todo"}]},
     "changes":{"branch":"…","base":"…","flags":["…"],"rows":[{"p":"path","a":12,"r":3}],"note":"…"},
     "questions":[{"q":"…","o":["…","…"]}],
     "swarm":{"tiles":[{"n":"↑ name","d":"…","bad":false}],"agents":[{"n":"…","t":"1h 0m","k":"303k"}]}}

The tool writes it to `~/.swarmz/boards/<tile>.json` on the tile's Mac and appends a `Board`
event carrying it to `events.log`, so the desktop's agent watchers (local and over ssh) deliver it
live; a pane with no board yet asks for the file (`board --get`, over ssh for another Mac's tile).
Sessions are allowed to run it without a prompt (`Bash(… swarmz board:*)`, beside the card's).

## 3. What the agent is told

The briefing (v5) tells every session to keep a board alongside its card: write it when the work
takes shape, after each plan step, when it asks the user something (Questions, and needsYou), and
when it finishes; plain language that describes the work, not tool output; pick a scheme once.

## 4. Out of scope

The phone, editing a board by hand, and history of boards.

## 5. Amendment: a board per conversation, and History (same day)

- The tool also keeps the latest board of each conversation in the tile,
  `~/.swarmz/boards/<tile>/<session>.json` (`{at, sessionId, board}`); the session is the tile's
  current Claude session as the hook log says (its last `SessionStart`). `board --history` lists
  them, newest first (at most 20). Clearing a board leaves its history.
- **History is a side bar view of its own** (an activity bar icon under Terminals; not a tab in
  the header, and not a Terminals grouping: boards are for the tiles themselves). Sessions of one
  tile with the same title (Claude starts a new session when a conversation is cleared,
  compacted or resumed) are one conversation and show once, the newest. It lists every conversation of every tile, from
  each tile's session records (the last 20 per tile, closed ones included) joined with the
  conversation boards (`board --history --all`, asked of this Mac and every Mac with a tile),
  newest activity first. A row is the conversation's title (its board's goal, else "Conversation
  in <folder>"), the tile it ran in with its Mac, and when it was last active; the live one is
  marked. Where it got to (its board's now and next) is only the row's tooltip. A click opens the
  tile, going back to that conversation when it is not the live one; hovering outlines the tile.

## 6. Amendment: the conductor sees every board (same day)

`swarmz ls`, and so `fleet`, carry each tile's board in brief (`board`: when it was written, goal,
now, next, needsYou, plan progress, branch, base, flags, open questions). A conductor may read the
whole board of any tile below it (`board --tile <id> --get`, the same rule as a glance at its
screen). The top conductor's briefing says to compare the boards, then the git state in the
tiles' folders, when the user asks how the work streams stand against each other.

## 7. Amendment: Refresh (same day)

The board's line has **Refresh**: it asks the tile's Claude to update its board now
(`board --request --tile <id>`, run on the tile's Mac, which types a short request with
`send`). It never types into a prompt on screen, over text in the input box, or into a tile
where Claude is not running; it says which instead, on the line, for a few seconds. For tiles it
is a conductor's act, like `send`. Text in the box counts only when it is a draft: Claude's
suggested next prompt (plain text with the cursor still right after `❯ `) and past messages
echo'd on a shaded background do not.
