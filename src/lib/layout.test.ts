import { describe, expect, it } from "vitest";
import {
  addTab,
  allGroups,
  findGroup,
  findGroupOf,
  moveToGroup,
  removeTerminal,
  resizeSplit,
  setActive,
  splitWith,
  type GroupNode,
  type Layout,
  type SplitNode,
} from "./layout";

function group(layout: Layout, termId: string): GroupNode {
  const g = findGroupOf(layout, termId);
  if (!g) throw new Error(`no group holds ${termId}`);
  return g;
}

describe("addTab", () => {
  it("creates a root group when the layout is empty", () => {
    const l = addTab(null, "t1", null);
    expect(l?.kind).toBe("group");
    expect((l as GroupNode).tabs).toEqual(["t1"]);
    expect((l as GroupNode).active).toBe("t1");
  });

  it("appends to the named group and activates the new tab", () => {
    let l = addTab(null, "t1", null);
    const gid = (l as GroupNode).id;
    l = addTab(l, "t2", gid);
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect((l as GroupNode).active).toBe("t2");
  });

  it("falls back to the first group when groupId is unknown", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", "nope");
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
  });

  it("only activates when the terminal is already placed", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t1", null);
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect((l as GroupNode).active).toBe("t1");
  });
});

describe("splitWith", () => {
  it("splits a group to the right into a row split with two halves", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g-new");
    const s = l as SplitNode;
    expect(s.kind).toBe("split");
    expect(s.dir).toBe("row");
    expect(s.sizes).toEqual([50, 50]);
    expect((s.children[0] as GroupNode).id).toBe(gid);
    expect((s.children[0] as GroupNode).tabs).toEqual(["t1"]);
    expect((s.children[1] as GroupNode).id).toBe("g-new");
    expect((s.children[1] as GroupNode).tabs).toEqual(["t2"]);
  });

  it("puts the new group first for left and top", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "top", "g-new");
    const s = l as SplitNode;
    expect(s.dir).toBe("col");
    expect((s.children[0] as GroupNode).id).toBe("g-new");
  });

  it("inserts as a sibling when the parent split already has that direction", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = splitWith(l, "g2", "t3", "right", "g3");
    const s = l as SplitNode;
    expect(s.children.map((c) => (c as GroupNode).id)).toEqual([gid, "g2", "g3"]);
    expect(s.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(s.sizes).toEqual([50, 25, 25]);
  });

  it("nests when the direction differs", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = splitWith(l, "g2", "t3", "bottom", "g3");
    const root = l as SplitNode;
    expect(root.dir).toBe("row");
    const inner = root.children[1] as SplitNode;
    expect(inner.kind).toBe("split");
    expect(inner.dir).toBe("col");
    expect(inner.children.map((c) => (c as GroupNode).id)).toEqual(["g2", "g3"]);
  });

  it("is a no-op when splitting a single-tab group with its own tab", () => {
    const l = addTab(null, "t1", null);
    const gid = (l as GroupNode).id;
    expect(splitWith(l, gid, "t1", "right", "g-new")).toBe(l);
  });

  it("moves a terminal out of another group, collapsing it if empty", () => {
    let l = addTab(null, "t1", null);
    const g1 = (l as GroupNode).id;
    l = splitWith(l, g1, "t1", "right", "g2"); // no-op
    l = addTab(l, "t2", g1);
    l = splitWith(l, g1, "t2", "right", "g2");
    l = splitWith(l, g1, "t2", "bottom", "g3"); // take t2 out of g2 (now empty) and split g1 vertically
    const root = l as SplitNode;
    expect(root.dir).toBe("col");
    expect(allGroups(l).map((g) => g.id)).toEqual([g1, "g3"]);
    expect(findGroup(l, "g2")).toBeNull();
  });
});

describe("removeTerminal", () => {
  it("removes a tab and picks a neighbour as active", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    l = setActive(l, (l as GroupNode).id, "t2");
    l = removeTerminal(l, "t2");
    expect((l as GroupNode).tabs).toEqual(["t1", "t3"]);
    expect((l as GroupNode).active).toBe("t3");
  });

  it("collapses an empty group and flattens a single-child split", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = removeTerminal(l, "t2");
    expect(l?.kind).toBe("group");
    expect((l as GroupNode).id).toBe(gid);
    expect((l as GroupNode).tabs).toEqual(["t1"]);
  });

  it("returns null when the last terminal is removed", () => {
    const l = addTab(null, "t1", null);
    expect(removeTerminal(l, "t1")).toBeNull();
  });

  it("renormalises sibling sizes after a collapse", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    l = splitWith(l, "g2", "t3", "right", "g3"); // sizes 50/25/25
    l = removeTerminal(l, "t3");
    const s = l as SplitNode;
    expect(s.children.length).toBe(2);
    expect(s.sizes[0]).toBeCloseTo(66.667, 2);
    expect(s.sizes[1]).toBeCloseTo(33.333, 2);
  });
});

describe("moveToGroup", () => {
  it("moves a tab between groups and activates it", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    l = addTab(l, "t3", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t3", "right", "g2");
    l = moveToGroup(l, "t2", "g2");
    expect(group(l, "t2").id).toBe("g2");
    expect(findGroup(l, "g2")?.tabs).toEqual(["t3", "t2"]);
    expect(findGroup(l, "g2")?.active).toBe("t2");
    expect(findGroup(l, gid)?.tabs).toEqual(["t1"]);
  });

  it("just activates when moving within the same group", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = moveToGroup(l, "t1", gid);
    expect((l as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect((l as GroupNode).active).toBe("t1");
  });

  it("ignores an unknown target group", () => {
    const l = addTab(null, "t1", null);
    expect(moveToGroup(l, "t1", "nope")).toBe(l);
  });
});

describe("resizeSplit", () => {
  it("replaces sizes and normalises them to 100", () => {
    let l = addTab(null, "t1", null);
    l = addTab(l, "t2", null);
    const gid = (l as GroupNode).id;
    l = splitWith(l, gid, "t2", "right", "g2");
    const sid = (l as SplitNode).id;
    l = resizeSplit(l, sid, [30, 90]);
    expect((l as SplitNode).sizes).toEqual([25, 75]);
  });
});
