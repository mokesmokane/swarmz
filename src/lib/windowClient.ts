/**
 * Another window's side (windows and layouts spec §4): its store becomes a mirror of the main
 * window's slice for this window, every allow-listed action is sent to the main window instead
 * of run here, and the actions only the main window acts on do nothing here. Each tile this
 * window shows gets its own viewer of the tile's holder while it is here.
 */
import { useStore, type WorkbenchState } from "../store";
import { ipc } from "./ipc";
import { tilesOf } from "./layout";
import { dispose, prepare } from "./xtermRegistry";
import { MAIN_ONLY_ACTIONS, PROXIED_ACTIONS, type WindowAction, type WindowMirror } from "./windowMirror";

export function labelFromLocation(search: string): string | null {
  const l = new URLSearchParams(search).get("window");
  return l && /^win-[a-z0-9]{4,32}$/.test(l) ? l : null;
}

/** Turns this window's store into a mirror for window `label`. */
export function installMirror(label: string, send: (a: WindowAction) => Promise<unknown> = ipc.windowAction): void {
  const patch: Record<string, unknown> = { windowLabel: label };
  for (const name of PROXIED_ACTIONS) {
    patch[name] = (...args: unknown[]) => {
      // The drag shows its drop zones here at once, without waiting for the round trip.
      if (name === "setDragging") useStore.setState({ draggingTerminalId: (args[0] as string | null) ?? null });
      void send({ label, name, args }).catch(() => {});
      return Promise.resolve(undefined);
    };
  }
  for (const name of MAIN_ONLY_ACTIONS) patch[name] = () => Promise.resolve();
  useStore.setState(patch as Partial<WorkbenchState>);
}

export function applyMirror(m: WindowMirror): void {
  useStore.setState(m as Partial<WorkbenchState>);
}

/**
 * Keeps one holder viewer per tile this window shows (spec §4): opened when a tile arrives, and
 * again after it restarts (the old holder is gone), closed when it leaves. The xterm goes too, so
 * a tile coming back replays its history afresh.
 */
export function manageViewers(api: { open: (id: string) => Promise<unknown>; close: (id: string) => Promise<unknown> } = { open: ipc.openView, close: ipc.closeView }): () => void {
  const shown = new Map<string, boolean>();
  const sync = (s: WorkbenchState) => {
    const now = new Set(tilesOf(s.layout));
    for (const [id] of shown) {
      if (!now.has(id) || !s.terminals[id]) {
        shown.delete(id);
        void api.close(id).catch(() => {});
        dispose(id);
      }
    }
    for (const id of now) {
      const t = s.terminals[id];
      if (!t) continue;
      const running = t.exited === null;
      const before = shown.get(id);
      if (before === running) continue;
      shown.set(id, running);
      if (!running) continue;
      void (async () => {
        if (before === false) await api.close(id).catch(() => {});
        await prepare(id);
        await api.open(id).catch(() => {});
      })();
    }
  };
  sync(useStore.getState());
  return useStore.subscribe((s, prev) => {
    if (s.layout !== prev.layout || s.terminals !== prev.terminals) sync(s);
  });
}
