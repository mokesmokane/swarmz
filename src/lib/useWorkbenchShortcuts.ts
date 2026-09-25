import { useEffect } from "react";
import { useStore } from "../store";
import { findGroup } from "./layout";
import { splitShortcut, zoomShortcut } from "./shortcuts";

/**
 * The workbench's keys in every window: Cmd+\ and Cmd+Shift+\ split the focused group with a new
 * terminal in the same folder, Cmd+Shift+Enter zooms it (windows and layouts spec §9). Caught in
 * the capture phase, before the terminal sees them.
 */
export function useWorkbenchShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { layout, focusedGroupId, terminals, createTerminal, toggleZoom } = useStore.getState();
      const group = focusedGroupId ? findGroup(layout, focusedGroupId) : null;
      if (!group) return;
      if (zoomShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleZoom(group.id);
        return;
      }
      const side = splitShortcut(e);
      if (!side) return;
      const cwd = terminals[group.active]?.cwd;
      if (!cwd) return;
      e.preventDefault();
      createTerminal(cwd, { kind: "split", groupId: group.id, side }).catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
