import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ipc } from "./ipc";
import { beforeSpawn, terminalColor, useStore } from "../store";
import { tintBackground } from "./workspace";

const BASE_BG = "#0f1115";

export const CWD_POLL_AFTER_ENTER_MS = 300;
export const CWD_POLL_INTERVAL_MS = 5000;

/** Ctrl+V. Claude Code reads it as "paste the image on my clipboard", which for an ssh tile is
 * the remote Mac's clipboard, not the one the user just copied into. */
/** What Shift+Enter sends: a line feed, which Claude Code reads as "insert newline". */
export const SHIFT_ENTER_SEQUENCE = "\n";

export const IMAGE_PASTE_KEY = "\x16";

/** Fallback for a remote tool that never writes the replay-end marker (no `end=1` in its attach
 * marker): the longest a rejoined session's output is treated as replay. */
export const REMOTE_REPLAY_MAX_MS = 10_000;
/** Safety cap for a tool that promised the end marker (`end=1`), should it never arrive. */
export const REMOTE_REPLAY_MARKED_MAX_MS = 60_000;

/** The fields of a `swarmz-attach` OSC 1337 payload (`swarmz-attach;new=<0|1>[;key=value]...`),
 * or null for any other payload. Unknown fields are ignored. */
export function parseAttachMarker(data: string): { isNew: boolean; endMarker: boolean } | null {
  const [tag, first, ...rest] = data.split(";");
  if (tag !== "swarmz-attach" || (first !== "new=0" && first !== "new=1")) return null;
  return { isNew: first === "new=1", endMarker: rest.includes("end=1") };
}

/** What the remote `swarmz attach` writes right after the replay (`REPLAY_END_MARKER` in the
 * tool's attach.rs), before any live byte. */
export const REPLAY_END_MARKER = "\x1b]1337;swarmz-replay-end\x07";

/** Largest OSC 52 payload honoured (base64 chars); anything bigger is dropped, not truncated. */
export const OSC52_MAX_CHARS = 1_000_000;

/**
 * The text a program asked to copy via OSC 52 (`Pc ; Pd`, Pd base64), or null for a clipboard
 * query (`?`, refused so a program can never read the clipboard), a malformed payload, or one
 * over `OSC52_MAX_CHARS`.
 */
export function decodeOsc52(data: string): string | null {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const payload = data.slice(semi + 1);
  if (!payload || payload === "?" || payload.length > OSC52_MAX_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The path inside an OSC 7 payload (`file://host/path`, `file:///path`, or a bare path). */
export function decodeOsc7(data: string): string | null {
  let path = data;
  if (data.startsWith("file://")) {
    const rest = data.slice("file://".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    path = rest.slice(slash);
  }
  if (!path.startsWith("/")) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

interface Entry {
  term: Terminal;
  fit: FitAddon;
  ready: Promise<void>;
  unlisten: UnlistenFn[];
  opened: boolean;
  onMouseUp: (() => void) | null;
  enterTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Recent decoded PTY output, kept while a resume watch is active, to scan for the "gone" phrase. */
  tail: string;
  /** True while a replay chunk's `term.write` is still draining, so side effects that must only
   * come from live output (OSC 52 clipboard writes, OSC 7 cwd updates, the resume-failure scan)
   * are suppressed. */
  replaying: boolean;
  /** Set from a remote `swarmz attach` marker for a rejoined session until xterm parses the
   * tool's replay-end marker (the replay arrives as ordinary `pty:data`). Suppresses the same side
   * effects as `replaying`. A tool that promised the end marker (`end=1`) is only capped at
   * `REMOTE_REPLAY_MARKED_MAX_MS`; an older one also ends at the first user input or after
   * `REMOTE_REPLAY_MAX_MS`. */
  remoteReplay: boolean;
  /** The current remote replay's tool promised the end marker. */
  remoteReplayMarked: boolean;
  remoteMaxTimer: ReturnType<typeof setTimeout> | null;
  /** Set by the OSC 1337 handlers while xterm parses a chunk that starts or ends a remote replay,
   * and read (then cleared) by that chunk's write callback. */
  replayBoundary: boolean;
  /** A remote folder poll is in flight (each is an ssh round trip). */
  remotePolling: boolean;
}

const entries = new Map<string, Entry>();

function localTileAlive(id: string): boolean {
  const s = useStore.getState();
  return !!s.terminals[id] && s.terminals[id].exited === null && !s.settings[id]?.ssh;
}

/** The host whose swarmz tool can report this tile's remote folder, or null. */
function remoteInfoHost(id: string): string | null {
  const s = useStore.getState();
  const host = s.settings[id]?.ssh?.host?.trim();
  if (!host || s.sshConnected[id] !== true || s.toolReady[host] !== true) return null;
  return s.terminals[id] && s.terminals[id].exited === null ? host : null;
}

async function pollRemoteCwd(id: string, host: string, entry: Entry): Promise<void> {
  if (entry.remotePolling) return;
  entry.remotePolling = true;
  try {
    const info = await ipc.remoteTileInfo(host, id);
    // setTerminalCwd re-checks that the tile is still a connected ssh tile.
    if (info.running && info.cwd) await useStore.getState().setTerminalCwd(id, info.cwd, "remote");
  } catch {
    // ssh down or the tool failed; the next poll will try again
  } finally {
    entry.remotePolling = false;
  }
}

async function pollCwd(id: string, entry: Entry): Promise<void> {
  const remoteHost = remoteInfoHost(id);
  if (remoteHost) return pollRemoteCwd(id, remoteHost, entry);
  if (!localTileAlive(id)) return;
  try {
    const cwd = await ipc.terminalCwd(id);
    // `lsof` takes ~16 ms; the tile may have exited or turned into an ssh tile meanwhile, and
    // this local path would then be the wrong Mac's.
    if (cwd && localTileAlive(id)) await useStore.getState().setTerminalCwd(id, cwd, "poll");
  } catch {
    // lsof missing or the tile is gone; the next poll or OSC 7 will catch up
  }
}

function scheduleEnterPoll(id: string, entry: Entry): void {
  if (entry.enterTimer) clearTimeout(entry.enterTimer);
  entry.enterTimer = setTimeout(() => {
    entry.enterTimer = null;
    void pollCwd(id, entry);
  }, CWD_POLL_AFTER_ENTER_MS);
}

/** The host of a tile whose ssh session is up, or null for a local or still-connecting tile. */
function connectedSshHost(id: string): string | null {
  const s = useStore.getState();
  const host = s.settings[id]?.ssh?.host;
  return host && s.sshConnected[id] === true ? host : null;
}

/** Tiles with a push in flight. A screenshot over a slow link takes seconds, and the user has no
 * feedback until the path appears, so an impatient second Ctrl+V is dropped rather than starting
 * a second upload or leaking a raw `\x16` into the prompt the first one is about to type into. */
const pasting = new Set<string>();

/** Pushes the clipboard image to `host` and types the remote path it landed at, so the user can
 * add their prompt and press Enter. With no image on the clipboard, or when the push fails,
 * Ctrl+V goes through to Claude, whose own paste handling then takes over. */
async function sendImageOrForward(id: string, host: string): Promise<void> {
  if (pasting.has(id)) return;
  pasting.add(id);
  let path: string | null = null;
  try {
    path = await ipc.pasteImageToRemote(host);
  } catch {
    // not reachable, no clipboard access, …
  } finally {
    pasting.delete(id);
  }
  if (path) {
    await ipc.writeTerminal(id, path).catch(() => {});
    useStore.getState().flashPasted(id);
  } else {
    await ipc.writeTerminal(id, IMAGE_PASTE_KEY).catch(() => {});
  }
}

function endRemoteReplay(entry: Entry): void {
  entry.remoteReplay = false;
  entry.remoteReplayMarked = false;
  if (entry.remoteMaxTimer) clearTimeout(entry.remoteMaxTimer);
  entry.remoteMaxTimer = null;
}

function startRemoteReplay(id: string, entry: Entry, marked: boolean): void {
  if (!useStore.getState().settings[id]?.ssh?.host) return;
  entry.replayBoundary = true;
  entry.tail = "";
  if (entry.remoteMaxTimer) clearTimeout(entry.remoteMaxTimer);
  entry.remoteReplay = true;
  entry.remoteReplayMarked = marked;
  entry.remoteMaxTimer = setTimeout(() => endRemoteReplay(entry), marked ? REMOTE_REPLAY_MARKED_MAX_MS : REMOTE_REPLAY_MAX_MS);
}

/** Fallback for an older tool: user input means its replay is on screen. */
function userInput(entry: Entry): void {
  if (entry.remoteReplay && !entry.remoteReplayMarked) endRemoteReplay(entry);
}

/** The resume-failure scan, run once xterm has parsed `bytes` so the replay state is exact. */
function scanLiveOutput(id: string, entry: Entry, bytes: Uint8Array): void {
  const boundary = entry.replayBoundary;
  entry.replayBoundary = false;
  if (entry.replaying || entry.remoteReplay) {
    entry.tail = "";
    return;
  }
  const watch = useStore.getState().resumeWatch[id];
  if (!watch) {
    entry.tail = "";
    return;
  }
  let text = new TextDecoder().decode(bytes);
  if (boundary) {
    // This chunk ended a remote replay: only what follows the end marker is live. The tool
    // writes the marker in one piece, but the byte stream may still split it; a split chunk is
    // then skipped whole, which can only miss a failure message, never invent one.
    const end = text.lastIndexOf(REPLAY_END_MARKER);
    entry.tail = "";
    if (end < 0) return;
    text = text.slice(end + REPLAY_END_MARKER.length);
  }
  entry.tail = (entry.tail + text).slice(-400);
  if (entry.tail.includes(`No conversation found with session ID ${watch.sessionId}`)) {
    entry.tail = "";
    useStore.getState().noteResumeFailure(id, watch.sessionId);
  }
}

function createEntry(id: string): Entry {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    fontSize: 13,
    scrollback: 5000,
    // Programs that track the mouse (herdr, vim, …) swallow drags; Option-drag still selects.
    macOptionClickForcesSelection: true,
    theme: {
      background: "#0f1115",
      foreground: "#d4d4d8",
      cursor: "#d4d4d8",
      selectionBackground: "#3b4252",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const entry: Entry = {
    term,
    fit,
    ready: Promise.resolve(),
    unlisten: [],
    opened: false,
    onMouseUp: null,
    enterTimer: null,
    pollTimer: null,
    tail: "",
    replaying: false,
    remoteReplay: false,
    remoteReplayMarked: false,
    remoteMaxTimer: null,
    replayBoundary: false,
    remotePolling: false,
  };

  term.onData((data) => {
    // Fallback for a tool without the end marker: input from the user (keys, pastes, mouse
    // reports) means the replay is on screen.
    userInput(entry);
    const host = data === IMAGE_PASTE_KEY ? connectedSshHost(id) : null;
    // Writes to an already-exited pane are expected to fail; ignore.
    if (host) void sendImageOrForward(id, host);
    else void ipc.writeTerminal(id, data).catch(() => {});
    if (data.includes("\r")) scheduleEnterPoll(id, entry);
  });
  // xterm.js sends CR for Shift+Enter, the same byte as Enter, so Claude Code submits. It does not
  // speak the kitty keyboard protocol Claude probes for, so send LF instead: Claude inserts a
  // newline for it, and a shell treats it exactly like Enter.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key !== "Enter" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true;
    if (e.type === "keydown") {
      userInput(entry);
      void ipc.writeTerminal(id, SHIFT_ENTER_SEQUENCE).catch(() => {});
      scheduleEnterPoll(id, entry);
    }
    return false;
  });
  term.onResize(({ cols, rows }) => {
    void ipc.resizeTerminal(id, cols, rows).catch(() => {});
  });
  // Programs in the terminal (Claude Code among them) copy their own selections by sending the
  // text base64-encoded in OSC 52; real terminals put it on the clipboard, xterm.js ignores it.
  term.parser.registerOscHandler(52, (data) => {
    if (entry.replaying || entry.remoteReplay) return true;
    const text = decodeOsc52(data);
    if (text !== null) {
      writeText(text)
        .then(() => useStore.getState().flashCopied(id))
        .catch(() => {});
    }
    return true;
  });
  term.parser.registerOscHandler(7, (data) => {
    if (entry.replaying || entry.remoteReplay) return true;
    const path = decodeOsc7(data);
    if (path) void useStore.getState().setTerminalCwd(id, path, "osc7");
    return true;
  });
  // The remote `swarmz attach` announces itself before its replay and marks the replay's end.
  // Markers inside a local replay are history, not a connection happening now.
  term.parser.registerOscHandler(1337, (data) => {
    if (data === "swarmz-replay-end") {
      if (!entry.replaying) {
        // Even when a fallback already ended the replay, what precedes the marker is history.
        entry.replayBoundary = true;
        endRemoteReplay(entry);
      }
      return true;
    }
    const m = parseAttachMarker(data);
    if (!m) return false;
    if (entry.replaying) return true;
    if (!m.isNew) startRemoteReplay(id, entry, m.endMarker);
    void useStore.getState().remoteAttached(id, m.isNew);
    return true;
  });

  entry.ready = Promise.all([
    ipc.onReplay(id, (bytes) => {
      entry.replaying = true;
      try {
        term.write(bytes, () => {
          entry.replaying = false;
        });
      } catch {
        // A malformed replay chunk must not leave the tile permanently suppressing live OSC 52
        // writes and the resume-failure scan.
        entry.replaying = false;
      }
    }),
    ipc.onData(id, (bytes) => {
      // xterm parses asynchronously and runs the OSC handlers during the parse, so the scan waits
      // for this chunk's write callback, when the replay state matches the chunk's end.
      term.write(bytes, () => scanLiveOutput(id, entry, bytes));
    }),
    ipc.onExit(id, (code) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code ?? "unknown"}]\x1b[0m\r\n`);
      useStore.getState().markExited(id, code);
    }),
  ]).then((fns) => {
    entry.unlisten = fns;
  });
  entries.set(id, entry);
  return entry;
}

export function prepare(id: string): Promise<void> {
  const entry = entries.get(id) ?? createEntry(id);
  return entry.ready;
}

export function size(id: string): { cols: number; rows: number } | null {
  const entry = entries.get(id);
  if (!entry) return null;
  return { cols: entry.term.cols, rows: entry.term.rows };
}

export function attach(id: string, container: HTMLElement): { term: Terminal; fit: FitAddon } {
  const entry = entries.get(id) ?? createEntry(id);
  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
    entry.onMouseUp = () => copySelection(id, entry.term);
    entry.term.element?.addEventListener("mouseup", entry.onMouseUp);
    // Background ticks are pure overhead while the user is in another app; an Enter in this
    // tile always polls (scheduleEnterPoll), focused or not.
    entry.pollTimer = setInterval(() => {
      if (useStore.getState().windowFocused === false) return;
      void pollCwd(id, entry);
    }, CWD_POLL_INTERVAL_MS);
  } else if (entry.term.element && entry.term.element.parentElement !== container) {
    container.appendChild(entry.term.element);
  }
  applyColor(id);
  return { term: entry.term, fit: entry.fit };
}

function copySelection(id: string, term: Terminal): void {
  if (!term.hasSelection()) return;
  const selection = term.getSelection();
  if (!selection) return;
  writeText(selection)
    .then(() => useStore.getState().flashCopied(id))
    .catch(() => {});
}

export function applyColor(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  const bg = tintBackground(BASE_BG, terminalColor(useStore.getState(), id));
  if (entry.term.options.theme?.background !== bg) entry.term.options.theme = { ...entry.term.options.theme, background: bg };
}

export function fitAndFocus(id: string): void {
  const entry = entries.get(id);
  if (!entry || !entry.opened) return;
  try {
    entry.fit.fit();
  } catch {
    // container not laid out yet; the ResizeObserver will retry
  }
  entry.term.focus();
}

export function dispose(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.unlisten.forEach((fn) => fn());
  if (entry.onMouseUp) entry.term.element?.removeEventListener("mouseup", entry.onMouseUp);
  if (entry.enterTimer) clearTimeout(entry.enterTimer);
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  endRemoteReplay(entry);
  entry.term.dispose();
  entries.delete(id);
}

beforeSpawn.hook = prepare;
beforeSpawn.size = size;

useStore.subscribe((state, prev) => {
  if (state.terminals === prev.terminals) return;
  for (const id of Object.keys(prev.terminals)) {
    if (!(id in state.terminals)) dispose(id);
  }
});

useStore.subscribe((s, prev) => {
  if (s.settings !== prev.settings || s.machines !== prev.machines) for (const id of entries.keys()) applyColor(id);
});
