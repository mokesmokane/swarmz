import { describe, expect, it } from "vitest";
import { clampRect, defaultRect, isScratchId, MIN_H, MIN_W, oneLine, scratchEventIsLive, scratchIdFor, scratchParent, SCRATCH_LIVE_MS } from "./scratch";

describe("scratch ids", () => {
  it("round-trip between a tile and its scratch shell", () => {
    const id = scratchIdFor("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(id).toBe("scratch-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(id.length).toBeLessThanOrEqual(64);
    expect(isScratchId(id)).toBe(true);
    expect(scratchParent(id)).toBe("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
    expect(isScratchId("t1")).toBe(false);
    expect(scratchParent("t1")).toBeNull();
  });
});

describe("window geometry", () => {
  it("starts bottom-right at about half the width and 40% of the height", () => {
    expect(defaultRect({ w: 1000, h: 600 })).toEqual({ x: 1000 - 500 - 12, y: 600 - 240 - 12, w: 500, h: 240 });
  });
  it("never smaller than the minimum, never outside the tile", () => {
    expect(clampRect({ x: -50, y: -10, w: 100, h: 50 }, { w: 800, h: 500 })).toEqual({ x: 0, y: 0, w: MIN_W, h: MIN_H });
    expect(clampRect({ x: 700, y: 450, w: 300, h: 200 }, { w: 800, h: 500 })).toEqual({ x: 500, y: 300, w: 300, h: 200 });
    // A tile smaller than the window: the window shrinks to the tile.
    expect(clampRect({ x: 0, y: 0, w: 400, h: 300 }, { w: 200, h: 100 })).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });
});

describe("liveness", () => {
  const launched = "2026-10-10T10:00:00.000Z";
  const now = Date.parse("2026-10-10T10:05:00.000Z");
  it("only recent events after launch open a window", () => {
    expect(scratchEventIsLive("2026-10-10T10:04:59.000Z", now, launched)).toBe(true);
    expect(scratchEventIsLive(new Date(now - SCRATCH_LIVE_MS - 1).toISOString(), now, launched)).toBe(false);
    expect(scratchEventIsLive("2026-10-10T09:59:59.000Z", Date.parse("2026-10-10T10:00:01.000Z"), launched)).toBe(false);
    expect(scratchEventIsLive("garbage", now, launched)).toBe(false);
  });
});

describe("oneLine", () => {
  it("drops every control character", () => {
    expect(oneLine("gh auth login\r\n\x1b[31m\x7f")).toBe("gh auth login[31m");
  });
});
