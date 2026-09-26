import { describe, expect, it } from "vitest";
import { loadBoardPrefs, readBoard, saveBoardPrefs, schemeOf, SCHEMES } from "./board";

describe("boards", () => {
  it("reads a board defensively and drops what is empty", () => {
    const b = readBoard({ scheme: "Moss", overview: { goal: "G", needsYou: true }, plan: { steps: [{ t: "a", s: "done" }, { t: "", s: "x" }, { t: "b", s: "odd" }] }, questions: [{ q: "Go?", o: ["Yes", 3] }], junk: 1 });
    expect(b).toEqual({ scheme: "Moss", overview: { goal: "G", now: undefined, next: undefined, needsYou: true }, plan: { title: undefined, steps: [{ t: "a", d: undefined, s: "done" }, { t: "b", d: undefined, s: "todo" }] }, questions: [{ q: "Go?", o: ["Yes"] }] });
    expect(readBoard(null)).toBeNull();
    expect(readBoard({ nothing: true })).toBeNull();
    expect(readBoard("text")).toBeNull();
  });

  it("picks the user's scheme, else the agent's, else one from the tile id", () => {
    expect(schemeOf("t1", "Ember", undefined).name).toBe("Ember");
    expect(schemeOf("t1", "Ember", 0).name).toBe("Lagoon");
    expect(schemeOf("t1", "Ember", SCHEMES.length + 1).name).toBe("Heather");
    const a = schemeOf("abc", undefined, undefined);
    expect(schemeOf("abc", "not-a-scheme", undefined)).toEqual(a);
  });

  it("keeps per-tile preferences", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveBoardPrefs("t1", { open: true }, st);
    saveBoardPrefs("t1", { tab: "plan" }, st);
    expect(loadBoardPrefs(st)).toEqual({ t1: { open: true, tab: "plan" } });
  });
});
