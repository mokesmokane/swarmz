import { describe, expect, it } from "vitest";
import { allGroups, type GroupNode, type Layout } from "./layout";
import {
  dedupeLayouts,
  isWindowLabel,
  loadBounds,
  loadLayouts,
  migrateLayouts,
  onSomeDisplay,
  openTiles,
  placeTile,
  pruneLayouts,
  removeEverywhere,
  saveBounds,
  saveLayouts,
  windowAt,
  windowOfGroup,
  windowOfNode,
  windowOfTile,
  type Layouts,
} from "./windowLayouts";

const g = (id: string, tabs: string[], active = tabs[0] ?? ""): GroupNode => ({ kind: "group", id, tabs, active });
const fakeStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const tabsOf = (l: Layout) => allGroups(l).map((x) => x.tabs);

describe("window layouts", () => {
  const ls: Layouts = {
    main: { kind: "split", id: "s1", dir: "row", sizes: [50, 50], children: [g("g1", ["a", "b"]), g("g2", ["c"])] },
    "win-abcd": g("g3", ["d"]),
  };

  it("finds which window shows a tile, a group or a split", () => {
    expect(windowOfTile(ls, "d")).toBe("win-abcd");
    expect(windowOfTile(ls, "a")).toBe("main");
    expect(windowOfTile(ls, "x")).toBeNull();
    expect(windowOfGroup(ls, "g3")).toBe("win-abcd");
    expect(windowOfNode(ls, "s1")).toBe("main");
    expect([...openTiles(ls)].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("places a tile in another window, taking its space from the one it left", () => {
    const moved = placeTile(ls, "c", "g3");
    expect(tabsOf(moved.main)).toEqual([["a", "b"]]);
    expect(tabsOf(moved["win-abcd"])).toEqual([["d", "c"]]);
    const split = placeTile(ls, "a", "g3", "bottom");
    expect(tabsOf(split["win-abcd"])).toEqual([["d"], ["a"]]);
    expect(tabsOf(split.main)).toEqual([["b"], ["c"]]);
    // Not open anywhere: simply placed. An unknown group changes nothing.
    expect(tabsOf(placeTile(ls, "new", "g2").main)).toEqual([["a", "b"], ["c", "new"]]);
    expect(placeTile(ls, "a", "nope")).toBe(ls);
    // Within one window it is an ordinary move.
    expect(tabsOf(placeTile(ls, "c", "g1").main)).toEqual([["a", "b", "c"]]);
  });

  it("removes, prunes and dedupes across windows", () => {
    expect(removeEverywhere(ls, "d")["win-abcd"]).toBeNull();
    expect(tabsOf(pruneLayouts(ls, ["a", "d"]).main)).toEqual([["a"]]);
    const twice = dedupeLayouts({ main: g("g1", ["a"]), "win-abcd": g("g2", ["a", "b"]) });
    expect(tabsOf(twice["win-abcd"])).toEqual([["b"]]);
  });

  it("saves and loads this Mac's trees, dropping bad labels and trees", () => {
    const st = fakeStorage();
    expect(loadLayouts(st)).toBeNull();
    saveLayouts({ ...ls, "win-gone": null }, st);
    expect(loadLayouts(st)).toEqual(ls);
    st.setItem("swarmz.layouts", JSON.stringify({ main: null, "../x": g("g", ["a"]), "win-bad1": { kind: "nope" } }));
    expect(loadLayouts(st)).toEqual({ main: null });
    st.setItem("swarmz.layouts", "{");
    expect(loadLayouts(st)).toBeNull();
    expect(isWindowLabel("win-ab12")).toBe(true);
    expect(isWindowLabel("tile-x")).toBe(false);
  });

  it("keeps bounds per window", () => {
    const st = fakeStorage();
    saveBounds("main", { x: 1, y: 2, width: 3, height: 4 }, st);
    saveBounds("win-abcd", { x: 5, y: 6, width: 7, height: 8 }, st);
    saveBounds("win-abcd", null, st);
    expect(loadBounds(st)).toEqual({ main: { x: 1, y: 2, width: 3, height: 4 } });
  });

  it("migrates the file's layout and old breakouts on the first run", () => {
    const st = fakeStorage();
    st.setItem("swarmz.breakouts", JSON.stringify({ b: { bounds: { x: 1, y: 1, width: 400, height: 300 } }, gone: { bounds: null } }));
    const out = migrateLayouts(g("g1", ["a", "b"]), ["a", "b", "c"], st);
    expect(tabsOf(out.main)).toEqual([["a", "c"]]);
    const [w] = Object.keys(out).filter((l) => l !== "main");
    expect(tabsOf(out[w])).toEqual([["b"]]);
    expect(st.getItem("swarmz.breakouts")).toBeNull();
    expect(loadBounds(st)[w]).toEqual({ x: 1, y: 1, width: 400, height: 300 });
  });

  it("knows whether saved bounds are still on a display, and where a new window goes", () => {
    const displays = [{ x: 0, y: 0, width: 1440, height: 900 }];
    expect(onSomeDisplay({ x: 100, y: 100, width: 800, height: 600 }, displays)).toBe(true);
    expect(onSomeDisplay({ x: 2000, y: 100, width: 800, height: 600 }, displays)).toBe(false);
    expect(windowAt({ x: 10, y: 10 })).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    expect(windowAt(null)).toBeNull();
  });
});
