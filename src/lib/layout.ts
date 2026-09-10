export type TerminalId = string;
export type SplitDir = "row" | "col";
export type Side = "left" | "right" | "top" | "bottom";

export interface GroupNode {
  kind: "group";
  id: string;
  tabs: TerminalId[];
  active: TerminalId;
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: SplitDir;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = GroupNode | SplitNode;
export type Layout = LayoutNode | null;

let counter = 0;
export function newNodeId(prefix = "n"): string {
  counter += 1;
  return `${prefix}${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function findGroup(layout: Layout, groupId: string): GroupNode | null {
  return allGroups(layout).find((g) => g.id === groupId) ?? null;
}

export function findGroupOf(layout: Layout, termId: TerminalId): GroupNode | null {
  return allGroups(layout).find((g) => g.tabs.includes(termId)) ?? null;
}

export function allGroups(layout: Layout): GroupNode[] {
  if (!layout) return [];
  if (layout.kind === "group") return [layout];
  return layout.children.flatMap((c) => allGroups(c));
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 100 / sizes.length);
  return sizes.map((s) => (s / total) * 100);
}

function normalize(node: LayoutNode): LayoutNode | null {
  if (node.kind === "group") return node.tabs.length === 0 ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const n = normalize(child);
    if (n) {
      kept.push(n);
      sizes.push(node.sizes[i] ?? 0);
    }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept, sizes: normalizeSizes(sizes) };
}

function updateGroup(node: LayoutNode, groupId: string, f: (g: GroupNode) => GroupNode): LayoutNode {
  if (node.kind === "group") return node.id === groupId ? f(node) : node;
  return { ...node, children: node.children.map((c) => updateGroup(c, groupId, f)) };
}

export function addTab(layout: Layout, termId: TerminalId, groupId: string | null): Layout {
  if (!layout) return { kind: "group", id: newNodeId("g"), tabs: [termId], active: termId };
  const existing = findGroupOf(layout, termId);
  if (existing) return setActive(layout, existing.id, termId);
  const target = (groupId && findGroup(layout, groupId)) || allGroups(layout)[0];
  return updateGroup(layout, target.id, (g) => ({ ...g, tabs: [...g.tabs, termId], active: termId }));
}

export function setActive(layout: Layout, groupId: string, termId: TerminalId): Layout {
  if (!layout) return layout;
  return updateGroup(layout, groupId, (g) => (g.tabs.includes(termId) ? { ...g, active: termId } : g));
}

export function removeTerminal(layout: Layout, termId: TerminalId): Layout {
  if (!layout) return null;
  const strip = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      const idx = node.tabs.indexOf(termId);
      if (idx === -1) return node;
      const tabs = node.tabs.filter((t) => t !== termId);
      const active = node.active === termId ? (tabs[Math.min(idx, tabs.length - 1)] ?? "") : node.active;
      return { ...node, tabs, active };
    }
    return { ...node, children: node.children.map(strip) };
  };
  return normalize(strip(layout));
}

export function moveToGroup(layout: Layout, termId: TerminalId, groupId: string): Layout {
  const target = findGroup(layout, groupId);
  if (!layout || !target) return layout;
  const current = findGroupOf(layout, termId);
  if (current?.id === groupId) return setActive(layout, groupId, termId);
  const without = removeTerminal(layout, termId);
  return addTab(without, termId, groupId);
}

function insertBeside(node: LayoutNode, targetId: string, fresh: GroupNode, dir: SplitDir, before: boolean): LayoutNode {
  if (node.kind === "group") {
    if (node.id !== targetId) return node;
    const children = before ? [fresh, node] : [node, fresh];
    return { kind: "split", id: newNodeId("s"), dir, children, sizes: [50, 50] };
  }
  const idx = node.children.findIndex((c) => c.kind === "group" && c.id === targetId);
  if (idx !== -1 && node.dir === dir) {
    const children = [...node.children];
    const sizes = [...node.sizes];
    const half = sizes[idx] / 2;
    sizes[idx] = half;
    const insertAt = before ? idx : idx + 1;
    children.splice(insertAt, 0, fresh);
    sizes.splice(insertAt, 0, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, targetId, fresh, dir, before)) };
}

export function splitWith(
  layout: Layout,
  targetGroupId: string,
  termId: TerminalId,
  side: Side,
  newGroupId: string = newNodeId("g"),
): Layout {
  if (!layout) return addTab(layout, termId, null);
  const target = findGroup(layout, targetGroupId);
  if (!target) return layout;
  if (target.tabs.length === 1 && target.tabs[0] === termId) return layout;
  const without = removeTerminal(layout, termId);
  if (!without) return addTab(null, termId, null);
  const fresh: GroupNode = { kind: "group", id: newGroupId, tabs: [termId], active: termId };
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  return insertBeside(without, targetGroupId, fresh, dir, before);
}

export function resizeSplit(layout: Layout, splitId: string, sizes: number[]): Layout {
  if (!layout) return layout;
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") return node;
    if (node.id === splitId && sizes.length === node.children.length) {
      return { ...node, sizes: normalizeSizes(sizes) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(layout);
}
