import { describe, expect, it } from "vitest";
import { buildConductorTree, contains, descendants, dropAction, findNode, loadCollapsed, saveCollapsed, type TreeNode } from "./conductorTree";

const subs = { s1: { parent: "top", tiles: ["a", "b"] }, s2: { parent: "s1", tiles: ["c"] } };
const order = ["a", "o", "top", "s2", "c", "s1", "b"];
const shape = (n: TreeNode): unknown => (n.children.length ? { [n.id + (n.conductor ? "*" : "")]: n.children.map(shape) } : n.id + (n.conductor ? "*" : ""));

describe("buildConductorTree", () => {
  it("nests every tile under its conductor, conductors first, in workspace order", () => {
    const t = buildConductorTree(order, "top", subs)!;
    expect(shape(t)).toEqual({ "top*": [{ "s1*": [{ "s2*": ["c"] }, "a", "b"] }, "o"] });
    expect(descendants(t).sort()).toEqual(["a", "b", "c", "o", "s1", "s2"]);
    expect(contains(findNode(t, "s1")!, "c")).toBe(true);
    expect(contains(findNode(t, "s2")!, "a")).toBe(false);
  });

  it("is null with no top, or a top that is not open here; an empty conductor stays a conductor", () => {
    expect(buildConductorTree(order, null, subs)).toBeNull();
    expect(buildConductorTree(["a"], "top", subs)).toBeNull();
    const t = buildConductorTree(["top", "e"], "top", { e: { parent: "top", tiles: [] } })!;
    expect(shape(t)).toEqual({ "top*": ["e*"] });
  });
});

describe("dropAction", () => {
  const t = buildConductorTree(order, "top", subs)!;
  it("assigns a tile onto a conductor, moves a conductor, and refuses what makes no sense", () => {
    expect(dropAction(t, "o", "s1")).toBe("assign");
    expect(dropAction(t, "a", "s2")).toBe("assign");
    expect(dropAction(t, "a", "top")).toBe("assign");
    expect(dropAction(t, "s2", "top")).toBe("move");
    expect(dropAction(t, "a", "s1")).toBeNull();
    expect(dropAction(t, "s1", "s2")).toBeNull();
    expect(dropAction(t, "s1", "s1")).toBeNull();
    expect(dropAction(t, "top", "s1")).toBeNull();
    expect(dropAction(t, "a", "o")).toBeNull();
    expect(dropAction(t, "nope", "s1")).toBeNull();
  });
});

describe("collapsed conductors", () => {
  it("round-trips through storage and survives junk", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadCollapsed(store).size).toBe(0);
    saveCollapsed(new Set(["s1", "s2"]), store);
    expect(Array.from(loadCollapsed(store)).sort()).toEqual(["s1", "s2"]);
    mem.set("swarmz.treeCollapsed", "{not json");
    expect(loadCollapsed(store).size).toBe(0);
    expect(loadCollapsed(null).size).toBe(0);
  });
});
