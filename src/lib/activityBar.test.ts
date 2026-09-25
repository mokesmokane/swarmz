import { describe, expect, it } from "vitest";
import { bytesText, clickView, loadFoldedSections, loadSideFolded, loadSideView, saveFoldedSections, saveSideFolded, saveSideView, uptimeText } from "./activityBar";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("the activity bar", () => {
  it("switches views, folds the side bar on a second click, and brings it back", () => {
    expect(clickView({ view: "terminals", folded: false }, "machines")).toEqual({ view: "machines", folded: false });
    expect(clickView({ view: "machines", folded: false }, "machines")).toEqual({ view: "machines", folded: true });
    expect(clickView({ view: "machines", folded: true }, "machines")).toEqual({ view: "machines", folded: false });
    expect(clickView({ view: "machines", folded: true }, "phones")).toEqual({ view: "phones", folded: false });
  });

  it("remembers the view, the fold and the folded sections, with Machines under the list folded at first", () => {
    const s = mem();
    expect(loadSideView(s)).toBe("terminals");
    saveSideView("machines", s);
    expect(loadSideView(s)).toBe("machines");
    s.setItem("swarmz.sideView", "bogus");
    expect(loadSideView(s)).toBe("terminals");
    expect(loadSideFolded(s)).toBe(false);
    saveSideFolded(true, s);
    expect(loadSideFolded(s)).toBe(true);
    expect(Array.from(loadFoldedSections(s))).toEqual(["terminals.machines"]);
    saveFoldedSections(new Set(), s);
    expect(loadFoldedSections(s).size).toBe(0);
    s.setItem("swarmz.foldedSections", "{junk");
    expect(Array.from(loadFoldedSections(s))).toEqual(["terminals.machines"]);
    expect(loadSideView(null)).toBe("terminals");
  });

  it("writes sizes and uptimes the way people read them", () => {
    expect(bytesText(512)).toBe("512 B");
    expect(bytesText(8589934592)).toBe("8.0 GB");
    expect(bytesText(20298100736)).toBe("18.9 GB");
    expect(bytesText(null)).toBe("–");
    expect(uptimeText(45 * 60)).toBe("45m");
    expect(uptimeText(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(uptimeText(4 * 86400 + 2 * 3600)).toBe("4d 2h");
    expect(uptimeText(undefined)).toBe("–");
  });
});
