import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { splitShortcut } from "./lib/shortcuts";
import { findGroup } from "./lib/layout";
import { useStore } from "./store";
import "./lib/xtermRegistry";

export default function App() {
  useEffect(() => {
    void useStore.getState().loadWorkspace();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const s = useStore.getState();
      const hasMachine = s.order.some((id) => s.settings[id]?.ssh?.machine);
      if (hasMachine) void s.refreshTailscale();
    }, 30_000);
    return () => clearInterval(timer);
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
