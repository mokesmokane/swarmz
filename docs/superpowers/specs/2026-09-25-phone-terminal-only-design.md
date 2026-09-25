# swarmz phone: the terminal is the tile

Date: 2026-09-25
Status: approved design
Amends: `2026-09-16-swarmz-phone-design.md` §6 (the tile screen: the conversation view, the
Screen/Conversation toggle and dictation are removed), §4.1 (the phone no longer calls
`transcript` or `image`; the tool keeps them).

## 1. What changes

- **Every tile shows its live terminal**, Claude tiles included: the screen the holder draws
  (`output --follow`), as shell tiles already do. The conversation view (the transcript as
  bubbles, paging older messages, inline images, the optimistic "sending" bubbles) and the toggle
  between the two are gone. Anything Claude draws (its dialogs, `/login`, `/model`, progress) is
  where it would be on the Mac.
- **Kept as they are:** the header (title, recap dialog, mode badge), the permission and question
  cards (from `pending`, which reads the screen), the Claude quick keys and slash commands,
  attachments, Restart, and the offline and error lines.
- **Sending** is typing into the tile (`send`), for Claude and shell tiles alike; a failed send
  puts the text back in the composer with a notice.
- **More scrollback:** the phone follows 3000 lines (was 300); the tool's cap for a followed
  screen rises to 5000 (was 1000) and a holder keeps 5000 lines of scrollback (was 2000; new
  holders only). The follow still sends only the lines that changed.
- **No microphone:** the mic button in the composer and on Home's reply cards, the dictation
  overlay, the dictation language setting and the `RECORD_AUDIO` permission are removed. The
  keyboard's own voice typing does the job better.

## 2. Testing

- The tile screen shows the terminal for a Claude tile, with the permission card, quick keys and
  composer; sending types into the tile and a failure restores the draft; no mic anywhere.
- The controller follows output for every kind and reopens it when it ends; restarted and
  offline-then-online tiles still recover.
- `Cmd.output` asks for 3000 lines; the tool accepts `--follow --lines 5000`.
