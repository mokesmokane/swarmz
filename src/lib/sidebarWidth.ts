/** The sidebar's width, a per-machine preference kept in localStorage (never in the shared workspace). */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 640;
export const SIDEBAR_DEFAULT = 256;
const KEY = "swarmz.sidebarWidth";

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

export function loadSidebarWidth(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): number {
  const raw = storage?.getItem(KEY);
  return raw === null || raw === undefined ? SIDEBAR_DEFAULT : clampSidebarWidth(Number(raw));
}

export function saveSidebarWidth(px: number, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(KEY, String(clampSidebarWidth(px)));
  } catch {
    // storage full or unavailable: the width still applies for this run
  }
}
