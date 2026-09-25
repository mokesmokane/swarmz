/**
 * Preset layouts (windows and layouts spec §6): each is a tree of slots; `arrange` fills the
 * slots with tiles, and `drawing` turns any tree into the rectangles its thumbnail draws, so a
 * thumbnail always shows what choosing it builds.
 */
import { emptySlot, groupOf, newNodeId, type Layout, type LayoutNode, type SplitDir } from "./layout";

/** A preset's shape: a slot (numbered in reading order), or a split of shapes with sizes. */
type Shape = "slot" | { dir: SplitDir; sizes: number[]; children: Shape[] };

export interface Preset {
  id: string;
  name: string;
  shape: Shape;
}

const row = (sizes: number[], ...children: Shape[]): Shape => ({ dir: "row", sizes, children });
const col = (sizes: number[], ...children: Shape[]): Shape => ({ dir: "col", sizes, children });
const S: Shape = "slot";

export const PRESETS: Preset[] = [
  { id: "single", name: "Single", shape: S },
  { id: "side-by-side", name: "Side by side", shape: row([50, 50], S, S) },
  { id: "stacked", name: "Stacked", shape: col([50, 50], S, S) },
  { id: "main-and-two", name: "Main and two", shape: row([60, 40], S, col([50, 50], S, S)) },
  { id: "three-columns", name: "Three columns", shape: row([33.34, 33.33, 33.33], S, S, S) },
  { id: "top-and-two", name: "Top and two", shape: col([55, 45], S, row([50, 50], S, S)) },
  { id: "grid", name: "Grid", shape: col([50, 50], row([50, 50], S, S), row([50, 50], S, S)) },
  { id: "main-and-three", name: "Main and three", shape: row([60, 40], S, col([33.34, 33.33, 33.33], S, S, S)) },
  { id: "six-grid", name: "Six grid", shape: col([50, 50], row([33.34, 33.33, 33.33], S, S, S), row([33.34, 33.33, 33.33], S, S, S)) },
];

export function presetById(id: string): Preset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

function countSlots(shape: Shape): number {
  return shape === "slot" ? 1 : shape.children.reduce((n, c) => n + countSlots(c), 0);
}

export function slotCount(p: Preset): number {
  return countSlots(p.shape);
}

/**
 * The preset filled with `tiles` in order: one per slot, tiles beyond the slots as tabs of the
 * last slot, slots beyond the tiles left empty (spec §6, §7).
 */
export function arrange(p: Preset, tiles: string[]): Layout {
  const n = slotCount(p);
  const per: string[][] = Array.from({ length: n }, (_, i) => (tiles[i] ? [tiles[i]] : []));
  if (tiles.length > n) per[n - 1] = [tiles[n - 1], ...tiles.slice(n)];
  let next = 0;
  const build = (shape: Shape): LayoutNode => {
    if (shape === "slot") {
      const tabs = per[next++];
      return tabs.length ? groupOf(tabs) : emptySlot();
    }
    return { kind: "split", id: newNodeId("s"), dir: shape.dir, sizes: [...shape.sizes], children: shape.children.map(build) };
  };
  return build(p.shape);
}

/** A rectangle of a drawing, in 0..1 of the whole; `n` numbers the slots in reading order. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  n: number;
}

/** The rectangles a tree (or a preset's shape) draws as, for the gallery's thumbnails. */
export function drawing(tree: Layout | Shape): Rect[] {
  const out: Rect[] = [];
  const walk = (node: LayoutNode | Shape, x: number, y: number, w: number, h: number) => {
    const split = node === "slot" ? null : "kind" in node ? (node.kind === "split" ? node : null) : node;
    if (!split) {
      out.push({ x, y, w, h, n: out.length + 1 });
      return;
    }
    const total = split.sizes.reduce((a, b) => a + b, 0) || 1;
    let at = 0;
    split.children.forEach((c, i) => {
      const f = (split.sizes[i] ?? 0) / total;
      if (split.dir === "row") walk(c, x + w * at, y, w * f, h);
      else walk(c, x, y + h * at, w, h * f);
      at += f;
    });
  };
  if (tree) walk(tree, 0, 0, 1, 1);
  return out;
}

export function presetDrawing(p: Preset): Rect[] {
  return drawing(p.shape);
}
