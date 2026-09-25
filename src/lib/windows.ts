/**
 * The main window's side of the other windows (windows and layouts spec §4, §5): creates each
 * `win-<id>` window, tracks every window's bounds and focus order (for a drop between windows),
 * keeps each window's mirror fed, applies the actions they send, remembers where every window
 * was, and puts the main window back where it was. Imported for its side effects by `App.tsx`;
 * the store reaches it through `windowHooks`. Tests never load it.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { availableMonitors, getCurrentWindow, LogicalPosition, LogicalSize, type Window } from "@tauri-apps/api/window";
import { useStore, windowHooks } from "../store";
import { ipc } from "./ipc";
import { contains, isWindowLabel, loadBounds, MAIN, onSomeDisplay, saveBounds, windowAt, type Bounds } from "./windowLayouts";
import { mirrorChanged, mirrorFor, PROXIED_ACTIONS, type ProxiedAction } from "./windowMirror";
import { resolveDrop } from "./windowDrop";

/** Every window's last known bounds (logical px) and the order windows last had focus, newest first. */
const bounds = new Map<string, Bounds>();
let focusOrder: string[] = [MAIN];
/** Set while the main window closes: its windows go with it and keep their trees for next time. */
let quitting = false;

async function readBounds(w: Window): Promise<Bounds | null> {
  try {
    const [pos, size, scale] = await Promise.all([w.outerPosition(), w.outerSize(), w.scaleFactor()]);
    return { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
  } catch {
    return null;
  }
}

async function displays(): Promise<Bounds[]> {
  try {
    return (await availableMonitors()).map((m) => ({
      x: m.position.x / m.scaleFactor,
      y: m.position.y / m.scaleFactor,
      width: m.size.width / m.scaleFactor,
      height: m.size.height / m.scaleFactor,
    }));
  } catch {
    return [];
  }
}

function track(label: string, w: Window): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const remember = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const b = await readBounds(w);
      if (!b) return;
      bounds.set(label, b);
      if (label === MAIN || useStore.getState().windows[label]) saveBounds(label, b);
    }, 250);
  };
  void readBounds(w).then((b) => b && bounds.set(label, b));
  void w.onMoved(remember);
  void w.onResized(remember);
  void w.onFocusChanged(({ payload: focused }) => {
    if (focused) focusOrder = [label, ...focusOrder.filter((l) => l !== label)];
  });
}

async function open(label: string, at: { x: number; y: number } | null, given: Bounds | null = null): Promise<void> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  let b: Bounds | null = windowAt(at) ?? given ?? loadBounds()[label] ?? null;
  if (b && !at) {
    const ds = await displays();
    if (ds.length > 0 && !onSomeDisplay(b, ds)) b = null;
  }
  const win = new WebviewWindow(label, {
    url: `window.html?window=${encodeURIComponent(label)}`,
    title: "swarmz",
    width: b?.width ?? 900,
    height: b?.height ?? 600,
    ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: 480,
    minHeight: 320,
    dragDropEnabled: false,
  });
  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (e) => reject(e.payload));
  });
  focusOrder = [label, ...focusOrder.filter((l) => l !== label)];
  track(label, win);
  void win.once("tauri://destroyed", () => {
    bounds.delete(label);
    focusOrder = focusOrder.filter((l) => l !== label);
  });
}

function close(label: string): void {
  saveBounds(label, null);
  void WebviewWindow.getByLabel(label).then((w) => w?.destroy());
}

windowHooks.open = open;
windowHooks.focus = (label) => {
  if (label === MAIN) void getCurrentWindow().setFocus();
  else void WebviewWindow.getByLabel(label).then((w) => w?.setFocus());
};
windowHooks.close = close;
windowHooks.boundsOf = async (label) => bounds.get(label) ?? null;
windowHooks.windowAt = async (p) => {
  // Fresh bounds for the windows on screen, then the most recently focused one containing the point.
  for (const label of focusOrder) if (bounds.has(label) && contains(bounds.get(label)!, p)) return label;
  return null;
};
windowHooks.dropAt = (label, id, p) => {
  if (label === MAIN) void resolveDrop(id, p);
  else void ipc.sendWindowDrop(label, { id, x: p.x, y: p.y });
};

// The main window: back where it was (spec §5), tracked like the others.
void (async () => {
  const main = getCurrentWindow();
  const saved = loadBounds()[MAIN];
  if (saved) {
    const ds = await displays();
    if (ds.length === 0 || onSomeDisplay(saved, ds)) {
      await main.setSize(new LogicalSize(saved.width, saved.height)).catch(() => {});
      await main.setPosition(new LogicalPosition(saved.x, saved.y)).catch(() => {});
    }
  }
  track(MAIN, main);
  // The main window closing takes the others with it, keeping their trees for the next launch.
  void main.onCloseRequested(async () => {
    quitting = true;
    for (const label of Object.keys(useStore.getState().windows)) {
      await WebviewWindow.getByLabel(label).then((w) => w?.destroy()).catch(() => {});
    }
  });
})();

// Each window's mirror: on hello, and after every change that shows (batched per tick).
function send(label: string): void {
  const m = mirrorFor(useStore.getState(), label);
  if (m) void ipc.sendWindowState(label, m).catch(() => {});
}
let pending: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (Object.keys(s.windows).length === 0 || !mirrorChanged(s, prev)) return;
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    for (const label of Object.keys(useStore.getState().windows)) send(label);
  }, 0);
});
void ipc.onWindowHello((label) => send(label));

// What the other windows ask for: only the allow-listed actions, only from a window label.
const ALLOWED = new Set<string>(PROXIED_ACTIONS);
void ipc.onWindowAction((a) => {
  if (!isWindowLabel(a.label) || !ALLOWED.has(a.name) || !Array.isArray(a.args)) return;
  if (a.name === "closeWindow" && quitting) return;
  const fn = useStore.getState()[a.name as ProxiedAction] as (...args: unknown[]) => unknown;
  try {
    const r = fn(...a.args);
    if (r instanceof Promise) r.catch(() => {});
  } catch {
    // a stale action (the tile or group went meanwhile)
  }
});
