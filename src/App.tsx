import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth, SIDEBAR_DEFAULT } from "./lib/sidebarWidth";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { FileViewer } from "./components/FileViewer";
import { ConductorsPanel } from "./components/ConductorsPanel";
import { ActivityBar } from "./components/ActivityBar";
import { MachinesView } from "./components/Machines";
import { HistoryPanel } from "./components/sidebar/HistoryView";
import { PhonesPanel } from "./components/PhonesPanel";
import { NotificationsPanel } from "./components/NotificationsPanel";
import { clickView, loadSideFolded, loadSideView, saveSideFolded, saveSideView, type SideView } from "./lib/activityBar";
import { useWorkbenchShortcuts } from "./lib/useWorkbenchShortcuts";
import { ipc } from "./lib/ipc";
import { SYNC_PULL_MS, SYNC_STAT_MS, useStore } from "./store";
import { ClosedNoticeBar } from "./components/ClosedNoticeBar";
import "./lib/xtermRegistry";
import "./lib/windows";

export default function App() {
  useEffect(() => {
    void useStore
      .getState()
      .loadWorkspace()
      .then(async () => {
        await useStore.getState().refreshTailscale();
        await useStore.getState().pullWorkspace();
        await useStore.getState().refreshOutsideSessions();
        // The windows this Mac had last time, once their tiles are open (windows and layouts spec §4).
        await useStore.getState().restoreWindows();
      });
  }, []);

  // One background check, on its own: the updater has nothing to do with the workspace, must not
  // wait for it, and `checkForUpdates` never rejects whatever the endpoint does.
  useEffect(() => {
    void useStore.getState().checkForUpdates();
    // Whether Telegram is set up decides if the conductor's follower runs here (conductor spec §5).
    ipc.telegramGet().then(
      (i) => useStore.getState().setTelegramConfigured(i.configured),
      () => {},
    );
  }, []);

  useEffect(() => {
    const pullTimer = setInterval(() => {
      void useStore
        .getState()
        .refreshTailscale()
        .then(() => useStore.getState().pullWorkspace());
    }, SYNC_PULL_MS);
    const statTimer = setInterval(() => {
      void useStore.getState().checkExternalChange();
      // The Telegram file can change under the app: pushed from another Mac's Notifications
      // panel, or written by hand. The follower must follow it (conductor spec §5).
      ipc.telegramGet().then(
        (i) => useStore.getState().setTelegramConfigured(i.configured),
        () => {},
      );
    }, SYNC_STAT_MS);
    const onFocus = () => {
      void useStore.getState().pullWorkspace();
      void useStore.getState().refreshOutsideSessions();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(pullTimer);
      clearInterval(statTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useWorkbenchShortcuts();

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    void ipc.onAgentEvent((p) => useStore.getState().applyAgentEvent(p)).then((fn) => unlisten.push(fn));
    void ipc.onAgentWatchEnded((p) => void useStore.getState().agentWatchEnded(p)).then((fn) => unlisten.push(fn));
    const onFocus = () => useStore.getState().setWindowFocused(true);
    const onBlur = () => useStore.getState().setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      unlisten.forEach((fn) => fn());
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // The sidebar's width: dragged on the handle, kept per machine, double-click to reset.
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const onHandleDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: sidebarWidth };
    const onMove = (ev: MouseEvent) => {
      const d = dragging.current;
      if (!d) return;
      setSidebarWidth(clampSidebarWidth(d.startWidth + ev.clientX - d.startX));
    };
    const onUp = () => {
      dragging.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSidebarWidth((w) => {
        saveSidebarWidth(w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // The activity bar's view and whether the side bar is folded away (activity bar spec §2).
  const [side, setSide] = useState<{ view: SideView; folded: boolean }>(() => ({ view: loadSideView(), folded: loadSideFolded() }));
  const pick = (v: SideView) =>
    setSide((cur) => {
      const next = clickView(cur, v);
      saveSideView(next.view);
      saveSideFolded(next.folded);
      return next;
    });
  const backToTerminals = () => pick("terminals");

  return (
    <div className="flex h-full w-full">
      <ActivityBar view={side.view} folded={side.folded} onPick={pick} />
      {!side.folded && side.view === "terminals" && <Sidebar width={sidebarWidth} onShowMachines={() => pick("machines")} />}
      {!side.folded && side.view !== "terminals" && (
        <aside className="flex h-full shrink-0 flex-col overflow-y-auto border-r border-line bg-panel" style={{ width: sidebarWidth }} data-testid={`side-${side.view}`}>
          {side.view === "machines" && <MachinesView />}
          {side.view === "history" && <HistoryPanel />}
          {side.view === "phones" && <PhonesPanel onClose={backToTerminals} />}
          {side.view === "notifications" && <NotificationsPanel onClose={backToTerminals} />}
        </aside>
      )}
      {!side.folded && (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        title="Drag to resize · double-click to reset"
        className="w-1 shrink-0 cursor-col-resize bg-neutral-900 transition-colors hover:bg-blue-500 active:bg-blue-500"
        onMouseDown={onHandleDown}
        onDoubleClick={() => {
          setSidebarWidth(SIDEBAR_DEFAULT);
          saveSidebarWidth(SIDEBAR_DEFAULT);
        }}
      />
      )}
      <main className="relative min-w-0 flex-1">
        <Workbench />
        <ClosedNoticeBar />
        <FileViewer />
        <ConductorsPanel />
      </main>
    </div>
  );
}
