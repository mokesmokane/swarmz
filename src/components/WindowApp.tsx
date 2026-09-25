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
    void (async () => {
      unlisten.push(
        await ipc.onWindowState(label, (m) => {
          applyMirror(m);
          setReady(true);
        }),
      );
      unlisten.push(await ipc.onWindowDrop(label, (d) => void resolveDrop(d.id, { x: d.x, y: d.y })));
      if (cancelled) return;
      stopViewers = manageViewers();
      await ipc.windowHello(label);
      // The user closing this window closes its tabs; the tiles keep running (spec §3).
      unlisten.push(await getCurrentWindow().onCloseRequested(() => void useStore.getState().closeWindow(label)));
    })();
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
