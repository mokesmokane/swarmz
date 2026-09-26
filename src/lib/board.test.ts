import { describe, expect, it } from "vitest";
import { historyRows, loadBoardPrefs, readBoard, saveBoardPrefs, schemeOf, SCHEMES } from "./board";

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

describe("History", () => {
  it("lists every conversation of every tile, closed ones too, titled by its board's goal, newest first", () => {
    const rows = historyRows(
      [
        { id: "t1", current: "s2", sessions: [{ sessionId: "s1", cwd: "/p/app", lastActiveAt: "2026-09-26T09:00:00Z" }, { sessionId: "s2", cwd: "/p/api", lastActiveAt: "2026-09-26T11:00:00Z" }] },
        { id: "t2", current: null, sessions: [{ sessionId: "x1", cwd: "/p/web", lastActiveAt: "2026-09-26T10:30:00Z" }] },
      ],
      {
        t1: [
          { sessionId: "s1", at: "2026-09-26T10:00:00Z", board: { overview: { goal: "Fix login", now: "Done.", next: "Merge it" } } },
          { sessionId: "s0", at: "2026-09-25T10:00:00Z", board: { overview: { goal: "Older, not in the records" } } },
        ],
      },
    );
    expect(rows.map((r) => [r.tile, r.sessionId, r.title, r.current])).toEqual([
      ["t1", "s2", "Conversation in api", true],
      ["t2", "x1", "Conversation in web", false],
      ["t1", "s1", "Fix login", false],
      ["t1", "s0", "Older, not in the records", false],
    ]);
    expect(rows[2].detail).toBe("Done.\nNext: Merge it");
    // Sessions of one tile with the same title are one conversation, shown once.
    const dup = historyRows([{ id: "t", current: "b", sessions: [{ sessionId: "a", cwd: "/p/x", lastActiveAt: "2026-09-26T08:00:00Z" }, { sessionId: "b", cwd: "/p/x", lastActiveAt: "2026-09-26T07:00:00Z" }] }], {});
    expect(dup.map((r) => [r.sessionId, r.current, r.lastActive])).toEqual([["b", true, "2026-09-26T08:00:00Z"]]);
  });
});
