# Jump to your messages (design)

Date: 2026-10-02. In a Claude or Codex tile, step through your own messages in the conversation.

## 1. What the user sees

- Two small round buttons, ↑ and ↓, at the bottom-right of an agent tile's pane, shown while the
  pointer is over the pane (the same in Claude and Codex tiles; none in a plain shell).
- ↑ scrolls to your previous message above the top of the pane; ↓ to the next one below it, and
  past your last one back to the live bottom. ⌘↑ and ⌘↓ do the same (Terminal.app's "jump to
  previous/next prompt").
- The message you land on sits at the top of the pane and is highlighted for a moment.

## 2. How messages are found

The pane scans its own scrollback; the agent is not asked and nothing is stored.

- Claude Code echoes a message you sent as a line starting `❯` (older versions `>`) on a shaded
  background; its live input box has the same prompt on the default background.
- Codex echoes one as a line starting `›` drawn dim; its input box's `›` is not dim.

A line is a message when its first non-blank character is one of those prompts, followed by a
space, and the prompt cell is shaded (Claude) or dim (Codex). Only the first line of a wrapped
message matches, which is where a jump should land.

## 3. Limits

Only what the pane's scrollback (5000 lines) still holds: a long conversation, or one joined from
another Mac, may start partway, and a `/clear` or compaction leaves nothing above.
