import type { Side } from "./layout";

/**
 * Maps a keyboard event to a split side, or null if it is not a split shortcut.
 * Cmd+\ (or Ctrl+\) splits right; adding Shift splits down.
 */
export function splitShortcut(e: KeyboardEvent): Side | null {
  if (e.key !== "\\" || e.altKey) return null;
  if (!e.metaKey && !e.ctrlKey) return null;
  return e.shiftKey ? "bottom" : "right";
}
