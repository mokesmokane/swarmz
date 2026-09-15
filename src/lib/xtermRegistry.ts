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
}

const entries = new Map<string, Entry>();

function localTileAlive(id: string): boolean {
  const s = useStore.getState();
  return !!s.terminals[id] && s.terminals[id].exited === null && !s.settings[id]?.ssh;
}

async function pollCwd(id: string): Promise<void> {
  if (!localTileAlive(id)) return;
  try {
    const cwd = await ipc.terminalCwd(id);
    if (cwd) await useStore.getState().setTerminalCwd(id, cwd, "poll");
  } catch {
    // lsof missing or the tile is gone; the next poll or OSC 7 will catch up
  }
}

function scheduleEnterPoll(id: string, entry: Entry): void {
  if (entry.enterTimer) clearTimeout(entry.enterTimer);
  entry.enterTimer = setTimeout(() => {
    entry.enterTimer = null;
    void pollCwd(id);
  }, CWD_POLL_AFTER_ENTER_MS);
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
  };

  term.onData((data) => {
    // Writes to an already-exited pane are expected to fail; ignore.
    void ipc.writeTerminal(id, data).catch(() => {});
    if (data.includes("\r")) scheduleEnterPoll(id, entry);
  });
  term.onResize(({ cols, rows }) => {
    void ipc.resizeTerminal(id, cols, rows).catch(() => {});
  });
  term.parser.registerOscHandler(7, (data) => {
    const path = decodeOsc7(data);
    if (path) void useStore.getState().setTerminalCwd(id, path, "osc7");
    return true;
  });

  entry.ready = Promise.all([
    ipc.onData(id, (bytes) => term.write(bytes)),
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
    entry.pollTimer = setInterval(() => void pollCwd(id), CWD_POLL_INTERVAL_MS);
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
