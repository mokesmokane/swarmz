# Telegram for every conductor (design)

Date: 2026-09-25. Amends the conductor spec (§5, Telegram) and the conductor tree spec (§3:
`notify` was the top conductor's alone).

## What changes

- **Any conductor may message the user.** `swarmz notify` is allowed for the top conductor and
  every sub-conductor (and the user, as before); an ordinary tile still may not.
- **Who is talking.** A message sent from a tile is headed with that tile's title (bold, first
  line), unless `--tile` names another.
- **Sent from its own Mac.** `notify` uses the calling Mac's `~/.swarmz/telegram.json`. When the
  file is missing there, it relays the message through the top conductor's home Mac
  (`swarmz notify --tile <caller>` over ssh); if that fails too, `not_configured` says to save
  Telegram again in Notifications.
- **Setup reaches every Mac.** Saving (or removing) Telegram in the desktop's Notifications panel
  copies it to every Mac with a connected tile and every other macOS Mac online on the tailnet.
- **Replies find their conductor.** The follower still runs on the top conductor's Mac only (one
  getUpdates consumer per bot). A message that replies to a bot message whose first line is
  exactly one conductor's title goes to that conductor as `[telegram] …`; anything else goes to
  the top, as before. `approve`/`deny` still answer a pending claim.
- **Briefing.** A sub-conductor's section tells it to use `notify` for what cannot wait for its
  parent, and that the user's replies come back to it; the top's says its conductors can message
  the user too.
