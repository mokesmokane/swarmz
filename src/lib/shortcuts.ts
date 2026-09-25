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

/** Cmd+Shift+Enter (or Ctrl+Shift+Enter): zoom the focused group, or put it back (windows and layouts spec §9). */
export function zoomShortcut(e: KeyboardEvent): boolean {
  return e.key === "Enter" && e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey);
}
