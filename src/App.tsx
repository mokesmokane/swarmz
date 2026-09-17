import { useEffect } from "react";
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
        // Last, and never awaited by anything: a slow or unreachable endpoint must not hold up
        // the workspace, and `checkForUpdates` never rejects.
        void useStore.getState().checkForUpdates();
      });
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

  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <Workbench />
      </main>
    </div>
  );
}
