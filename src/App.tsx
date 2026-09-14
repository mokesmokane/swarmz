import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { splitShortcut } from "./lib/shortcuts";
import { findGroup } from "./lib/layout";
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

  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <Workbench />
      </main>
    </div>
  );
}
