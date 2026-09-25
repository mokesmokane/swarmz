import { describe, expect, it } from "vitest";
import { allGroups } from "./layout";
import { arrange, drawing, PRESETS, presetById, presetDrawing, slotCount } from "./presets";

describe("presets", () => {
  it("every preset draws as many rectangles as it has slots, covering the whole", () => {
    for (const p of PRESETS) {
      const rects = presetDrawing(p);
      expect(rects).toHaveLength(slotCount(p));
      const area = rects.reduce((a, r) => a + r.w * r.h, 0);
      expect(area).toBeCloseTo(1, 3);
      expect(rects.map((r) => r.n)).toEqual(rects.map((_, i) => i + 1));
    }
  });

  it("fills slots in order, extra tiles as tabs of the last slot, missing tiles as empty slots", () => {
    const grid = presetById("grid")!;
    expect(allGroups(arrange(grid, ["a", "b", "c", "d"])).map((g) => g.tabs)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(allGroups(arrange(grid, ["a", "b", "c", "d", "e", "f"])).map((g) => g.tabs)).toEqual([["a"], ["b"], ["c"], ["d", "e", "f"]]);
    const two = allGroups(arrange(grid, ["a", "b"]));
    expect(two.map((g) => g.tabs)).toEqual([["a"], ["b"], [], []]);
    expect(two[3].slot).toBe(true);
    expect(allGroups(arrange(presetById("single")!, ["a", "b"]))[0]).toMatchObject({ tabs: ["a", "b"], active: "a" });
  });

  it("draws a built tree the same as its preset", () => {
    const p = presetById("main-and-two")!;
    const built = drawing(arrange(p, ["a", "b", "c"]));
    expect(built.map((r) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100)))).toEqual(presetDrawing(p).map((r) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100))));
    expect(built[0]).toMatchObject({ x: 0, y: 0, w: 0.6, h: 1 });
    expect(drawing(null)).toEqual([]);
  });
});
