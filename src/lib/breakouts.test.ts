import { describe, expect, it } from "vitest";
import { breakoutLabel, loadBreakouts, pointerOutside, saveBreakouts, tileOfLabel, windowAt } from "./breakouts";

describe("breakouts", () => {
  it("labels round-trip", () => {
    expect(breakoutLabel("abc-1")).toBe("tile-abc-1");
    expect(tileOfLabel("tile-abc-1")).toBe("abc-1");
    expect(tileOfLabel("main")).toBeNull();
  });

  it("the per-Mac record round-trips and drops junk", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadBreakouts(storage)).toEqual({});
    saveBreakouts({ a: { bounds: { x: 1, y: 2, width: 3, height: 4 } }, b: { bounds: null } }, storage);
    expect(loadBreakouts(storage)).toEqual({ a: { bounds: { x: 1, y: 2, width: 3, height: 4 } }, b: { bounds: null } });
    store.set("swarmz.breakouts", JSON.stringify({ "bad id!": { bounds: null }, c: { bounds: { x: "1" } }, d: 5 }));
    expect(loadBreakouts(storage)).toEqual({ c: { bounds: null }, d: { bounds: null } });
    store.set("swarmz.breakouts", "junk");
    expect(loadBreakouts(storage)).toEqual({});
    expect(loadBreakouts(null)).toEqual({});
  });

  it("a drag ending outside the window breaks out; inside does not", () => {
    const win = { x: 100, y: 100, width: 800, height: 600 };
    expect(pointerOutside({ x: 50, y: 300 }, win)).toBe(true);
    expect(pointerOutside({ x: 950, y: 300 }, win)).toBe(true);
    expect(pointerOutside({ x: 300, y: 50 }, win)).toBe(true);
    expect(pointerOutside({ x: 300, y: 750 }, win)).toBe(true);
    expect(pointerOutside({ x: 300, y: 300 }, win)).toBe(false);
    expect(pointerOutside({ x: 100, y: 100 }, win)).toBe(false);
  });

  it("a new window sits under the pointer, never off the top-left", () => {
    expect(windowAt({ x: 500, y: 300 })).toEqual({ x: 460, y: 260, width: 900, height: 600 });
    expect(windowAt({ x: 10, y: 10 })).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    expect(windowAt(null)).toBeNull();
  });
});
