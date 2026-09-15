import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ipc } from "./ipc";
import { beforeSpawn, terminalColor, useStore } from "../store";
import { tintBackground } from "./workspace";

const BASE_BG = "#0f1115";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  ready: Promise<void>;
  unlisten: UnlistenFn[];
  opened: boolean;
  onMouseUp: (() => void) | null;
}

const entries = new Map<string, Entry>();

function createEntry(id: string): Entry {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: "#0f1115",
      foreground: "#d4d4d8",
      cursor: "#d4d4d8",
      selectionBackground: "#3b4252",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((data) => {
    // Writes to an already-exited pane are expected to fail; ignore.
    void ipc.writeTerminal(id, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    void ipc.resizeTerminal(id, cols, rows).catch(() => {});
  });

  const entry: Entry = { term, fit, ready: Promise.resolve(), unlisten: [], opened: false, onMouseUp: null };
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
    entry.onMouseUp = () => copySelection(entry.term);
    entry.term.element?.addEventListener("mouseup", entry.onMouseUp);
  } else if (entry.term.element && entry.term.element.parentElement !== container) {
    container.appendChild(entry.term.element);
  }
  applyColor(id);
  return { term: entry.term, fit: entry.fit };
}

function copySelection(term: Terminal): void {
  if (!term.hasSelection()) return;
  const selection = term.getSelection();
  if (!selection) return;
  void writeText(selection).catch(() => {});
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
