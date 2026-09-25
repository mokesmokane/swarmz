/**
 * Every window's tree on this Mac (windows and layouts spec §2, §4): the main window's and each
 * other window's, by window label. Pure operations over the set, so a tile moves between windows
 * the same way it moves between groups, plus the per-Mac storage and the first-run migration.
 */
import {
  addTab,
  allGroups,
  findGroup,
  findGroupOf,
  moveToGroup,
  removeTerminal,
  splitWith,
  tilesOf,
  type Layout,
  type LayoutNode,
  type Side,
} from "./layout";
import { reconcileLayout, sanitizeLayout } from "./workspace";

export const MAIN = "main";
export const WINDOW_PREFIX = "win-";

/** Every window's tree, by label; `main` is always there (null when it shows nothing). */
export type Layouts = Record<string, Layout>;

export function isWindowLabel(label: string): boolean {
  return label === MAIN || /^win-[a-z0-9]{4,32}$/.test(label);
}

export function newWindowLabel(): string {
  return `${WINDOW_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
}

/** The window showing tile `id`, or null when it is not open here. */
export function windowOfTile(ls: Layouts, id: string): string | null {
  for (const [label, layout] of Object.entries(ls)) if (findGroupOf(layout, id)) return label;
  return null;
}

/** The window holding group `groupId`. */
export function windowOfGroup(ls: Layouts, groupId: string): string | null {
  for (const [label, layout] of Object.entries(ls)) if (findGroup(layout, groupId)) return label;
  return null;
}

function hasNode(node: LayoutNode | null, id: string): boolean {
  if (!node) return false;
  if (node.id === id) return true;
  return node.kind === "split" && node.children.some((c) => hasNode(c, id));
}

/** The window holding split `splitId`. */
export function windowOfNode(ls: Layouts, nodeId: string): string | null {
  for (const [label, layout] of Object.entries(ls)) if (hasNode(layout, nodeId)) return label;
  return null;
}

/** Every tile open in some window. */
export function openTiles(ls: Layouts): Set<string> {
  return new Set(Object.values(ls).flatMap((l) => tilesOf(l)));
}

/** Tile `id` taken out of every window. */
export function removeEverywhere(ls: Layouts, id: string): Layouts {
  const out: Layouts = {};
  for (const [label, layout] of Object.entries(ls)) out[label] = findGroupOf(layout, id) ? removeTerminal(layout, id) : layout;
  return out;
}

/**
 * Tile `id` put into group `groupId` (as a tab, or beside it on `side`), wherever it was: its
 * space leaves the window it came from (spec §4). A tile not open anywhere is simply placed.
 */
export function placeTile(ls: Layouts, id: string, groupId: string, side: Side | null = null): Layouts {
  const target = windowOfGroup(ls, groupId);
  if (!target) return ls;
  const source = windowOfTile(ls, id);
  if (source === target) {
    return { ...ls, [target]: side ? splitWith(ls[target], groupId, id, side) : moveToGroup(ls[target], id, groupId) };
  }
  const out = source ? { ...ls, [source]: removeTerminal(ls[source], id) } : { ...ls };
  out[target] = side ? splitWith(out[target], groupId, id, side) : addTab(out[target], id, groupId);
  return out;
}

/** Every window without the tiles not in `ids` (a tile gone from the workspace). */
export function pruneLayouts(ls: Layouts, ids: string[]): Layouts {
  const wanted = new Set(ids);
  const out: Layouts = {};
  for (const [label, layout] of Object.entries(ls)) {
    let l = layout;
    for (const t of tilesOf(layout)) if (!wanted.has(t)) l = removeTerminal(l, t);
    out[label] = l;
  }
  return out;
}

/** Keeps each tile in one window only (a hand-edited or raced store): the first mention wins. */
export function dedupeLayouts(ls: Layouts): Layouts {
  const seen = new Set<string>();
  const out: Layouts = {};
  for (const label of [MAIN, ...Object.keys(ls).filter((l) => l !== MAIN)]) {
    if (!(label in ls)) continue;
    let l = ls[label];
    for (const g of allGroups(ls[label])) {
      for (const t of g.tabs) {
        if (seen.has(t)) l = removeTerminal(l, t);
        else seen.add(t);
      }
    }
    out[label] = l;
  }
  return out;
}

// ---- per-Mac storage ------------------------------------------------------------------------

const LAYOUTS_KEY = "swarmz.layouts";
const BOUNDS_KEY = "swarmz.windowBounds";
const OLD_BREAKOUTS_KEY = "swarmz.breakouts";

type Get = Pick<Storage, "getItem"> | null;
type SetS = Pick<Storage, "setItem" | "removeItem"> | null;
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

/** A window's place on screen, in logical pixels. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isBounds(b: unknown): b is Bounds {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number)) && (o.width as number) > 0 && (o.height as number) > 0;
}

/** This Mac's saved trees, or null when it has none yet (the first run: migrate). */
export function loadLayouts(storage: Get = local()): Layouts | null {
  try {
    const raw = storage?.getItem(LAYOUTS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const out: Layouts = { [MAIN]: null };
    for (const [label, tree] of Object.entries(v as Record<string, unknown>)) {
      if (!isWindowLabel(label)) continue;
      const node = sanitizeLayout(tree ?? null);
      if (label === MAIN || node) out[label] = node;
    }
    return dedupeLayouts(out);
  } catch {
    return null;
  }
}

export function saveLayouts(ls: Layouts, storage: SetS = local()): void {
  try {
    const out: Record<string, Layout> = {};
    for (const [label, layout] of Object.entries(ls)) if (label === MAIN || layout) out[label] = layout;
    storage?.setItem(LAYOUTS_KEY, JSON.stringify(out));
  } catch {
    // storage unavailable: the layout still holds for this run
  }
}

export function loadBounds(storage: Get = local()): Record<string, Bounds> {
  try {
    const raw = storage?.getItem(BOUNDS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Record<string, Bounds> = {};
    for (const [label, b] of Object.entries(v as Record<string, unknown>)) if (isWindowLabel(label) && isBounds(b)) out[label] = b;
    return out;
  } catch {
    return {};
  }
}

export function saveBounds(label: string, b: Bounds | null, storage: Get & SetS = local()): void {
  try {
    const all = loadBounds(storage);
    if (b) all[label] = b;
    else delete all[label];
    storage?.setItem(BOUNDS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable
  }
}

/**
 * The first run of this version on a Mac (spec §2): the shared file's layout becomes the main
 * window's, with every tile placed as before, and each tile that was in a breakout window gets
 * a window of its own (keeping that window's place). Clears the old breakouts record.
 */
export function migrateLayouts(fileLayout: Layout, ids: string[], storage: Get & SetS = local()): Layouts {
  let main = reconcileLayout(fileLayout, ids);
  const out: Layouts = { [MAIN]: main };
  try {
    const raw = storage?.getItem(OLD_BREAKOUTS_KEY);
    const v = raw ? (JSON.parse(raw) as Record<string, { bounds?: unknown }>) : {};
    for (const [id, entry] of Object.entries(v ?? {})) {
      if (!ids.includes(id)) continue;
      main = removeTerminal(main, id);
      const label = newWindowLabel();
      out[label] = { kind: "group", id: `g-${label}`, tabs: [id], active: id };
      if (isBounds(entry?.bounds)) saveBounds(label, entry.bounds, storage);
    }
    storage?.removeItem(OLD_BREAKOUTS_KEY);
  } catch {
    // an unreadable old record: nothing to carry over
  }
  out[MAIN] = main;
  return out;
}

// ---- geometry --------------------------------------------------------------------------------

export function contains(b: Bounds, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height;
}

/** Whether a saved window rectangle still overlaps one of the displays (spec §5). */
export function onSomeDisplay(b: Bounds, displays: Bounds[]): boolean {
  return displays.some((d) => b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y);
}

/** Where a new window goes: its tab strip under the pointer, 40 px in from the top-left. */
export function windowAt(pointer: { x: number; y: number } | null, size = { width: 900, height: 600 }): Bounds | null {
  if (!pointer) return null;
  return { x: Math.max(0, Math.round(pointer.x - 40)), y: Math.max(0, Math.round(pointer.y - 20)), ...size };
}
