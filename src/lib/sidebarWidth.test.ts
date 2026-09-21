import { describe, expect, it } from "vitest";
import { clampSidebarWidth, loadSidebarWidth, saveSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebarWidth";

describe("sidebar width", () => {
  it("clamps to the allowed range and rounds", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(300.6)).toBe(301);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT);
  });

  it("round-trips through storage and defaults without one", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadSidebarWidth(storage)).toBe(SIDEBAR_DEFAULT);
    saveSidebarWidth(333, storage);
    expect(loadSidebarWidth(storage)).toBe(333);
    saveSidebarWidth(5, storage);
    expect(loadSidebarWidth(storage)).toBe(SIDEBAR_MIN);
    store.set("swarmz.sidebarWidth", "junk");
    expect(loadSidebarWidth(storage)).toBe(SIDEBAR_DEFAULT);
    expect(loadSidebarWidth(null)).toBe(SIDEBAR_DEFAULT);
  });
});
