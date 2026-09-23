/**
 * The main window's side of breakout windows (breakout windows spec §2, §4, §5): opens a
 * `tile-<id>` window for a tile, keeps it fed with the tile's state, acts on what it asks
 * (return, restart), returns the tile when the window closes, and restores the windows this
 * Mac had last time. Imported for its side effects by `App.tsx`; the store reaches it through
 * `breakoutHooks`.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { breakoutHooks, useStore } from "../store";
import { ipc } from "./ipc";
import { breakoutLabel, loadBreakouts, saveBreakouts, windowAt, type Bounds, type TileState } from "./breakouts";
import { rowInfo } from "./sidebarGroups";
import { displayTitle } from "./card";
import { EMPTY_SETTINGS } from "./workspace";

/** The main window's bounds in logical pixels, for the drag-out check; null when not in Tauri. */
async function mainBounds(): Promise<Bounds | null> {
  try {
    const w = getCurrentWindow();
    const [pos, size, scale] = await Promise.all([w.outerPosition(), w.outerSize(), w.scaleFactor()]);
    return { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
  } catch {
    return null;
  }
}

function tileState(id: string): TileState | null {
  const s = useStore.getState();
  const t = s.terminals[id];
  if (!t) return null;
  const settings = s.settings[id] ?? EMPTY_SETTINGS;
  const agent = s.agentState[id];
  const online: Record<string, boolean> = {};
  for (const p of s.tailscale?.peers ?? []) online[p.name] = p.online;
  const info = rowInfo(
    { id, name: t.name, cwd: t.cwd, exited: t.exited, ssh: settings.ssh ?? null, foreign: settings.foreign ?? null, sessions: settings.sessions, agent },
    { selfMachine: s.selfMachine, machines: s.machines, online },
  );
  return {
    terminal: { id: t.id, name: t.name, cwd: t.cwd, exited: t.exited, error: t.error },
    settings,
    agent,
    machines: s.machines,
    selfMachine: s.selfMachine,
    line: { glyph: info.machine.glyph, machine: info.machine.label, color: info.machine.color, folder: info.folder, status: info.status, since: info.since },
    title: displayTitle(settings.card, agent, t.name),
  };
}

function sendState(id: string): void {
  const state = tileState(id);
  if (state) void ipc.sendTileState(breakoutLabel(id), state).catch(() => {});
}

async function open(id: string, at: { x: number; y: number } | null): Promise<void> {
  const label = breakoutLabel(id);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const saved = loadBreakouts()[id]?.bounds ?? null;
  const bounds = windowAt(at) ?? saved;
  const state = tileState(id);
  const win = new WebviewWindow(label, {
    url: `breakout.html?tile=${encodeURIComponent(id)}`,
    title: `${state?.title ?? id} · swarmz`,
    width: bounds?.width ?? 900,
    height: bounds?.height ?? 600,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 480,
    minHeight: 320,
    dragDropEnabled: false,
  });
  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (e) => reject(e.payload));
  });
  // The window closing returns the tile; its last bounds are kept for next time.
  void win.once("tauri://destroyed", () => {
    if (useStore.getState().breakouts[id]) useStore.getState().returnTerminal(id);
  });
  void win.onMoved(() => void remember(id, win));
  void win.onResized(() => void remember(id, win));
}

async function remember(id: string, win: WebviewWindow): Promise<void> {
  try {
    const [pos, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
    const saved = loadBreakouts();
    if (!saved[id]) return;
    saved[id] = { bounds: { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale } };
    saveBreakouts(saved);
  } catch {
    // the window is gone
  }
}

function focus(id: string): void {
  void WebviewWindow.getByLabel(breakoutLabel(id)).then((w) => w?.setFocus());
}

function close(id: string): void {
  void WebviewWindow.getByLabel(breakoutLabel(id)).then((w) => w?.close());
}

breakoutHooks.open = open;
breakoutHooks.focus = focus;
breakoutHooks.close = close;
breakoutHooks.mainBounds = mainBounds;

// A breakout window asks for its state on load, and asks for things the store owns.
void ipc.onBreakoutHello((id) => sendState(id));
void ipc.onBreakoutAction((a) => {
  const s = useStore.getState();
  if (a.action === "return") s.returnTerminal(a.id);
  else if (a.action === "restart") void s.restartTerminal(a.id);
  else if (a.action === "focus-main") void getCurrentWindow().setFocus();
});

// Every change to what a breakout window shows is pushed to it.
useStore.subscribe((s, prev) => {
  const ids = Object.keys(s.breakouts);
  if (ids.length === 0) return;
  if (s.terminals === prev.terminals && s.settings === prev.settings && s.agentState === prev.agentState && s.machines === prev.machines && s.selfMachine === prev.selfMachine && s.tailscale === prev.tailscale) return;
  for (const id of ids) sendState(id);
});
