/**
 * The activity bar's per-Mac preferences (activity bar and machines spec §2–§3): which view the
 * side bar shows, whether the side bar is folded away, and which sections are folded. Kept in
 * `localStorage` like the side bar's width, never in the shared workspace.
 */

export type SideView = "terminals" | "history" | "machines" | "phones" | "notifications";
export const SIDE_VIEWS: SideView[] = ["terminals", "history", "machines", "phones", "notifications"];

const VIEW_KEY = "swarmz.sideView";
const FOLDED_KEY = "swarmz.sideFolded";
const SECTIONS_KEY = "swarmz.foldedSections";
/** Sections folded until the user opens them: the compact Machines list under the terminals. */
const FOLDED_BY_DEFAULT = ["terminals.machines"];

type Get = Pick<Storage, "getItem"> | null;
type Set_ = Pick<Storage, "setItem"> | null;
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

function read(storage: Get, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Set_, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    // storage unavailable: the choice still applies for this run
  }
}

export function loadSideView(storage: Get = local()): SideView {
  const v = read(storage, VIEW_KEY);
  return SIDE_VIEWS.includes(v as SideView) ? (v as SideView) : "terminals";
}

export function saveSideView(v: SideView, storage: Set_ = local()) {
  write(storage, VIEW_KEY, v);
}

export function loadSideFolded(storage: Get = local()): boolean {
  return read(storage, FOLDED_KEY) === "1";
}

export function saveSideFolded(folded: boolean, storage: Set_ = local()) {
  write(storage, FOLDED_KEY, folded ? "1" : "0");
}

export function loadFoldedSections(storage: Get = local()): Set<string> {
  const raw = read(storage, SECTIONS_KEY);
  if (raw === null) return new Set(FOLDED_BY_DEFAULT);
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : FOLDED_BY_DEFAULT);
  } catch {
    return new Set(FOLDED_BY_DEFAULT);
  }
}

export function saveFoldedSections(s: Set<string>, storage: Set_ = local()) {
  write(storage, SECTIONS_KEY, JSON.stringify(Array.from(s)));
}

/**
 * The activity bar's icon click (spec §2): another view shows that view (and unfolds the side
 * bar); the active view folds the side bar away, or brings it back.
 */
export function clickView(current: { view: SideView; folded: boolean }, clicked: SideView): { view: SideView; folded: boolean } {
  if (clicked !== current.view) return { view: clicked, folded: false };
  return { view: clicked, folded: !current.folded };
}

/** A byte count as a person reads it: `512 MB`, `8.1 GB`. */
export function bytesText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** An uptime as `45m`, `3h 12m`, `4d 2h`. */
export function uptimeText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
