/**
 * The conductor tree as the sidebar's Tree view draws it (conductor tree spec §6): the top, each
 * live sub-conductor under its parent, every other tile under the conductor it answers to.
 * Pure: the store's fields in, nodes out.
 */
import { conductorOwner, liveSubs, type SubConductors } from "./workspace";

export interface TreeNode {
  id: string;
  /** Whether this node is a conductor (it can hold children, and take drops). */
  conductor: boolean;
  children: TreeNode[];
}

/**
 * The tree for the tiles in `order` (the workspace's order, which the user controls): under each
 * conductor, its sub-conductors first, then its other tiles, each in `order`. Null with no top
 * conductor (or a top that is not open here).
 */
export function buildConductorTree(order: string[], top: string | null, subs: SubConductors): TreeNode | null {
  if (!top || !order.includes(top)) return null;
  const live = liveSubs(top, subs);
  const kids = new Map<string, string[]>();
  for (const id of order) {
    if (id === top) continue;
    const parent = live[id] ? live[id].parent : conductorOwner(top, subs, id);
    if (!parent) continue;
    kids.set(parent, [...(kids.get(parent) ?? []), id]);
  }
  const seen = new Set<string>();
  const node = (id: string): TreeNode => {
    seen.add(id);
    const mine = (kids.get(id) ?? []).filter((c) => !seen.has(c));
    const conductors = mine.filter((c) => live[c]);
    const tiles = mine.filter((c) => !live[c]);
    return { id, conductor: id === top || !!live[id], children: [...conductors, ...tiles].map(node) };
  };
  return node(top);
}

/** Every id below `node`. */
export function descendants(node: TreeNode): string[] {
  return node.children.flatMap((c) => [c.id, ...descendants(c)]);
}

/** Whether `id` is `node` itself or somewhere below it. */
export function contains(node: TreeNode, id: string): boolean {
  return node.id === id || node.children.some((c) => contains(c, id));
}

/** The node for `id`, anywhere in the tree. */
export function findNode(node: TreeNode, id: string): TreeNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * What dropping `dragged` on conductor `target` does: assign a tile, move a conductor, or
 * nothing (onto itself, the top anywhere, a conductor into its own subtree, or where it already
 * is).
 */
export function dropAction(tree: TreeNode, dragged: string, target: string): "assign" | "move" | null {
  if (dragged === target || dragged === tree.id) return null;
  const targetNode = findNode(tree, target);
  const draggedNode = findNode(tree, dragged);
  if (!targetNode?.conductor || !draggedNode) return null;
  if (targetNode.children.some((c) => c.id === dragged)) return null;
  if (draggedNode.conductor) return contains(draggedNode, target) ? null : "move";
  return "assign";
}

const COLLAPSED_KEY = "swarmz.treeCollapsed";

/** The conductors folded shut in the Tree view: a per-Mac preference. */
export function loadCollapsed(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): Set<string> {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(ids: Set<string>, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // storage unavailable: the fold still applies for this run
  }
}
