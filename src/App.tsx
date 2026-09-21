import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth, SIDEBAR_DEFAULT } from "./lib/sidebarWidth";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { splitShortcut } from "./lib/shortcuts";
import { findGroup } from "./lib/layout";
import { ipc } from "./lib/ipc";
import { SYNC_PULL_MS, SYNC_STAT_MS, useStore } from "./store";
import "./lib/xtermRegistry";

export default function App() {
  useEffect(() => {
    void useStore
      .getState()
      .loadWorkspace()
      .then(async () => {
        await useStore.getState().refreshTailscale();
        await useStore.getState().pullWorkspace();
        await useStore.getState().refreshOutsideSessions();
      });
  }, []);

  // One background check, on its own: the updater has nothing to do with the workspace, must not
  // wait for it, and `checkForUpdates` never rejects whatever the endpoint does.
  useEffect(() => {
    void useStore.getState().checkForUpdates();
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const side = splitShortcut(e);
      if (!side) return;
      const { layout, focusedGroupId, terminals, createTerminal } = useStore.getState();
      const group = focusedGroupId ? findGroup(layout, focusedGroupId) : null;
      const cwd = group ? terminals[group.active]?.cwd : undefined;
      if (!group || !cwd) return;
      e.preventDefault();
      createTerminal(cwd, { kind: "split", groupId: group.id, side }).catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  return (
    <div className="flex h-full w-full">
      <Sidebar width={sidebarWidth} />
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
      <main className="min-w-0 flex-1">
        <Workbench />
      </main>
    </div>
  );
}
