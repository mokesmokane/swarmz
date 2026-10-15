/** Overlays that can cover a pane hide every browser view in their window while open (tile
 * browser spec §3): a native page is drawn above everything the window's own page draws. */
import { useEffect } from "react";
import { create } from "zustand";

export const useBrowserBlock = create<{ count: number }>(() => ({ count: 0 }));

export function useBlocksBrowsers(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    useBrowserBlock.setState((s) => ({ count: s.count + 1 }));
    return () => useBrowserBlock.setState((s) => ({ count: s.count - 1 }));
  }, [active]);
}
