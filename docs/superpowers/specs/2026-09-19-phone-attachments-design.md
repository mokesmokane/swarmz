# swarmz on the phone: sharing images and files with a tile

Date: 2026-09-19
Status: approved design, implemented 2026-09-21 (tool, phone composer, share target)
Amends: `2026-09-16-swarmz-phone-design.md` §1 (the "image attachments from
the phone" non-goal is lifted), §4.1 (a new `upload` command), §4.7 (the
gate allows it), §5 (the tool's own files under `~/.swarmz/paste`), §6.6
(the composer gains an attach button), §7 (the app is a share target).

## 1. Purpose

Send a photo, a screenshot or any file from the phone to a Claude tile, the
way Ctrl+V already sends a clipboard image from the desktop: the file lands
on the tile's home Mac and its path is typed into the message, so Claude
opens it as part of the prompt.

Two ways in:

1. **Attach** from the tile's composer: pick from the gallery or the file
   picker, or take a photo.
2. **Share** from any app (Gallery, Files, a browser) with swarmz as the
   target, then pick the tile.

Non-goals: previews of what was sent inside the conversation beyond what the
transcript already shows (Claude's own image records, §4.3 of the phone
spec); editing or annotating before sending; files larger than 25 MiB;
sending to a shell tile (the path is typed there too, but nothing reads it
for you); the desktop app (unchanged: it already types paths).

## 2. How a file reaches the Mac

The phone already runs every tool command over ssh with the arguments on
the command line. A file cannot travel that way (argument limits, binary
bytes, the gate's word rules), so `upload` is the first command that reads
its **stdin**: the gate `exec`s the tool, so the ssh channel's stdin is the
tool's stdin, and the phone writes the bytes to the channel and closes it.

`upload` writes to `~/.swarmz/paste/`, the folder the desktop's Ctrl+V
already uses (`paste.rs`), with the same guarantee: the file is written to a
temp name, its size checked against what the caller announced, and only
then moved into place, so a dropped link never leaves a short file for
Claude to open.

## 3. Mac tool

### 3.1 `upload`

`swarmz upload --name <name> --size <bytes>` reads exactly `size` bytes from
stdin and prints `{"v":1, "path": "/Users/me/.swarmz/paste/paste-<ms>-<name>", "size": <bytes>}`.

- `name` is the file's display name from the phone. The tool keeps only
  `[A-Za-z0-9._-]`, replaces anything else with `_`, strips leading dots,
  and cuts it to 64 characters keeping the extension; an empty result
  becomes `file`. The stored name is `paste-<ms>-<name>`, where `<ms>` is
  the millisecond clock, so two uploads never collide and the desktop's
  `paste-<ms>.png` names sort beside them.
- `size` is required and at most 25 MiB (`too_large`, nothing read). The
  tool reads until it has `size` bytes or stdin ends; fewer bytes is a
  `short` error and the temp file is removed. Extra bytes after `size` are
  ignored.
- The folder is created 0700 if missing; the file is created with
  `create_new` and mode 0600, written to `<name>.tmp.<pid>` first, then
  renamed.
- Output is one JSON line on stdout, like every other command; the path is
  absolute and free of control characters (the same `usable_path` rule the
  desktop applies before typing a path).
- The command does not take a tile: the phone runs it on the Mac that
  homes the tile, which is where the path must exist.

### 3.2 Housekeeping

`~/.swarmz/paste` holds the tool's own files, not the user's (§5 of the
phone spec: the tool never deletes user files). `prune` (§4.1) gains a
second sweep: files under `~/.swarmz/paste` older than 7 days are removed,
and `upload` runs the same sweep after a successful write, so a phone that
sends a lot never fills the disk. `prune` reports both counts:
`{"removed": <sessions>, "pasteRemoved": <files>}`.

### 3.3 Gate

`upload` joins the gate's allow list (§4.7). What a phone key can now do
that it could not before: write a file of up to 25 MiB into one folder,
under a name the tool chooses, never overwriting. It still cannot read
files, name a path, or run anything else. The gate passes stdin through
unchanged (it already does, being an `exec`); nothing else reads stdin, so
no existing command changes behaviour.

## 4. Phone app

### 4.1 ssh

`SshConnection` gains `exec(command, input: ByteArray, timeoutMs)`: the
same as `exec` but writes `input` to the session's stdin on a thread of its
own and closes it (EOF) once written, and reports progress through a
callback (`bytesSent`) so the composer can show it. A cancelled upload
closes the channel, which is what makes the tool's size check fail on the
Mac and leave nothing behind.

The timeout scales with size: 20 s plus one second per 256 KiB, so a 25 MiB
file over a slow relay still completes.

### 4.2 Repository

`upload(mac, name, bytes, onProgress): String` runs `upload` on that Mac's
link and returns the path. Errors: the tool's `too_large` and `short`, the
link's `Unreachable`, and a Mac that is offline (refused before connecting,
"<Mac> is offline").

### 4.3 Composer (§6.6)

A paperclip button sits at the left of the text field on a Claude tile
(not on a shell tile). Tapping it offers **Photo or video** (the system
photo picker, `PickMultipleVisualMedia`, no permission needed), **File**
(`OpenMultipleDocuments`, any type) and **Take photo** (`TakePicture` into
a `FileProvider` cache file, camera permission already declared for QR
scanning).

For each chosen item, in order:

1. Read its display name and size from the `ContentResolver`. Over 25 MiB:
   an image is re-encoded as JPEG at quality 85, halving its long side
   until it fits; anything else is refused with "too large (limit 25 MiB)".
2. Show a chip above the composer: the name, a progress bar, and ✕ to
   cancel. Uploads run one at a time so the Mac's link is not shared
   between two stdin writers.
3. On success the chip turns into the file's name, and the returned path is
   inserted into the draft at the cursor, followed by a space, so words can
   be added before sending. Several attachments give several paths.
4. On failure the chip shows the error with **Retry**; the draft is
   untouched.

Sending works as today (`send` types the draft). Claude Code reads a path in
a message as a file to open, the same as the desktop's typed path. The draft,
its chips and an upload in flight survive folding and unfolding (they live
in the view model, §6.3).

### 4.4 Share target (§7)

The manifest registers `MainActivity` for `ACTION_SEND` and
`ACTION_SEND_MULTIPLE` with `image/*`, `video/*`, `application/*` and
`text/*`. Receiving a share:

- If the app is already on a Claude tile (folded or unfolded), the items
  attach there, as in §4.3.
- Otherwise a **Send to…** sheet lists the running Claude tiles grouped by
  Mac (the tile list of §6.5, offline Macs dimmed and not selectable),
  opens the chosen tile and attaches there.
- Shared text (a URL, a snippet) is not uploaded: it is inserted into the
  draft as text.
- If nothing is paired, the share opens the pairing screen and is dropped
  with a notice.

### 4.5 Errors and edge cases

- The tile's Mac goes offline mid-upload: the chip shows "<Mac> is offline"
  with Retry; nothing is typed.
- The tile stops running: attachments still upload (the path is useful once
  it restarts) but the composer stays disabled as today.
- Re-sharing the same photo twice gives two files and two paths; that is
  fine.
- A content URI the app can no longer read (permission expired after a
  process death): the chip shows "could not read <name>"; the user picks it
  again.

## 5. Desktop

Nothing changes. The paste folder and its naming already exist, and the
`prune` sweep runs on whichever Mac the phone or the desktop asks.

## 6. Testing

- **Tool (Rust, `cli.rs`):** `upload` round-trips bytes from stdin and
  prints a path that exists with the right size and mode; a short stdin
  leaves no file and reports `short`; a `size` over the cap is `too_large`
  with nothing read; names are sanitised (`../x`, spaces, unicode, a
  leading dot, a 200-character name) and stamped; two uploads in the same
  millisecond do not collide (`create_new` retries with the next
  millisecond); `prune` removes only paste files older than 7 days;
  `ssh-gate` allows `upload` and still refuses `hold`.
- **Phone (JVM):** `SshTest` exec with stdin against the embedded sshd
  (bytes arrive, EOF is seen, cancel closes the channel); `Repository.upload`
  on an offline Mac refuses without connecting; composer UI test with a fake
  picker (chip, progress, path inserted at the cursor, retry after a
  failure); share-intent routing (open tile → attach; no tile → sheet;
  text → draft; unpaired → pairing).
- **By hand on the Fold:** share a photo from Gallery to a running Claude
  tile and ask Claude what it shows; attach a PDF from Files; take a photo;
  cancel a large upload and confirm nothing is left in `~/.swarmz/paste`;
  fold mid-upload.

## 7. Build order

1. Tool: `upload`, the paste sweep in `prune`, the gate entry (one PR, with
   its CLI tests).
2. Phone: ssh stdin, `Repository.upload`, the composer button and chips.
3. Phone: the share target and the Send to… sheet.

Each step is usable on its own; a phone without step 2 simply lacks the
button, and a Mac whose tool predates step 1 answers `upload` with
`usage`, which the phone reports as "update swarmz on <Mac>" (the existing
tool-too-old banner, §6.10).
