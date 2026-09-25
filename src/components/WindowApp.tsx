import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { ipc } from "../lib/ipc";
import { applyMirror, installMirror, labelFromLocation, manageViewers } from "../lib/windowClient";
import { resolveDrop } from "../lib/windowDrop";
import { useWorkbenchShortcuts } from "../lib/useWorkbenchShortcuts";
import { Workbench } from "./Workbench";
import { FileViewer } from "./FileViewer";
import { ClosedNoticeBar } from "./ClosedNoticeBar";

/**
 * A window of tabs other than the main one (windows and layouts spec §4): the same workbench,
 * drawn from the main window's mirror of it, with every change sent back to the main window.
 */
export function WindowApp({ label = labelFromLocation(window.location.search) }: { label?: string | null } = {}) {
  const [ready, setReady] = useState(false);
  useWorkbenchShortcuts();

  useEffect(() => {
    if (!label) return;
    installMirror(label);
    const unlisten: Array<() => void> = [];
    let stopViewers: (() => void) | null = null;
    let cancelled = false;
    // Each listener is dropped at once if the effect was cleaned up while it registered.
    const keep = (f: () => void) => (cancelled ? f() : unlisten.push(f));
    void (async () => {
      keep(
        await ipc.onWindowState(label, (m) => {
          applyMirror(m);
          setReady(true);
        }),
      );
      keep(await ipc.onWindowDrop(label, (d) => void resolveDrop(d.id, { x: d.x, y: d.y })));
      if (cancelled) return;
      stopViewers = manageViewers();
      await ipc.windowHello(label);
      // The user closing this window closes its tabs; the tiles keep running (spec §3).
      keep(await getCurrentWindow().onCloseRequested(() => void useStore.getState().closeWindow(label)));
    })();
    // Which window has focus decides which tile the user is looking at (agent "unseen").
    const onFocus = () => useStore.getState().windowFocus(label, true);
    const onBlur = () => useStore.getState().windowFocus(label, false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    unlisten.push(() => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    });
    return () => {
      cancelled = true;
      unlisten.forEach((f) => f());
      stopViewers?.();
    };
  }, [label]);

  if (!label) return <div className="p-4 text-sm text-neutral-400">No window named in this window's address.</div>;
  return (
    <div className="flex h-full w-full flex-col" data-testid="window-app">
      <main className="relative min-h-0 flex-1">
        {ready ? <Workbench /> : <div className="flex h-full items-center justify-center text-sm text-neutral-500">Connecting to the main window…</div>}
        <ClosedNoticeBar />
        <FileViewer />
      </main>
    </div>
  );
}
