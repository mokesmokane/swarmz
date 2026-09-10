import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import { beforeSpawn, useStore } from "../store";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  ready: Promise<void>;
  unlisten: UnlistenFn[];
  opened: boolean;
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
    void ipc.writeTerminal(id, data);
  });
  term.onResize(({ cols, rows }) => {
    void ipc.resizeTerminal(id, cols, rows);
  });

  const entry: Entry = { term, fit, ready: Promise.resolve(), unlisten: [], opened: false };
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

export function attach(id: string, container: HTMLElement): { term: Terminal; fit: FitAddon } {
  const entry = entries.get(id) ?? createEntry(id);
  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
  } else if (entry.term.element && entry.term.element.parentElement !== container) {
    container.appendChild(entry.term.element);
  }
  return { term: entry.term, fit: entry.fit };
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
  entry.term.dispose();
  entries.delete(id);
}

beforeSpawn.hook = prepare;

useStore.subscribe((state, prev) => {
  if (state.terminals === prev.terminals) return;
  for (const id of Array.from(entries.keys())) {
    if (!(id in state.terminals)) dispose(id);
  }
});
