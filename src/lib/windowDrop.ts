/**
 * Resolving a drop at a screen point in this window (windows and layouts spec §4): the drag of a
 * tile that no webview took ended over this window, so the tile goes where the pointer was: a
 * tab strip makes it a tab of that group, a pane the zone under the pointer, anything else the
 * focused group.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { zoneAt } from "./windowMirror";

export function resolveDropAtClient(id: string, cx: number, cy: number, doc: Document = document): void {
  const s = useStore.getState();
  const hit = doc.elementFromPoint(cx, cy);
  const group = hit?.closest("[data-drop-group]");
  const gid = group?.getAttribute("data-drop-group") ?? null;
  if (!gid) {
    void s.moveToWindow(id, s.windowLabel);
    return;
  }
  if (hit?.closest("[data-drop-strip]")) {
    s.moveTerminal(id, gid);
    return;
  }
  const pane = group?.querySelector("[data-drop-pane]")?.getBoundingClientRect();
  const zone = pane ? zoneAt(pane, cx, cy) : "center";
  if (zone === "center") s.moveTerminal(id, gid);
  else s.splitTerminal(id, gid, zone);
}

export async function resolveDrop(id: string, p: { x: number; y: number }): Promise<void> {
  const w = getCurrentWindow();
  const [pos, scale] = await Promise.all([w.innerPosition(), w.scaleFactor()]);
  resolveDropAtClient(id, p.x - pos.x / scale, p.y - pos.y / scale);
  void w.setFocus().catch(() => {});
}
