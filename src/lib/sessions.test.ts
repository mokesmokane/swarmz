import { describe, expect, it } from "vitest";
import { bumpSession, isSafeFolder, promoteSession, removeSession, sanitizeSessions, SESSIONS_MAX, upsertSession, type SessionRecord } from "./sessions";

const rec = (id: string, t = "2026-09-15T10:00:00Z"): SessionRecord => ({ sessionId: id, cwd: `/${id}`, skipPermissions: false, startedAt: t, lastActiveAt: t });

describe("isSafeFolder", () => {
  it("accepts absolute paths and rejects relative or control-character ones", () => {
    expect(isSafeFolder("/Users/me/proj")).toBe(true);
    expect(isSafeFolder("proj")).toBe(false);
    expect(isSafeFolder("/a\x1bb")).toBe(false);
    expect(isSafeFolder("")).toBe(false);
  });
});

describe("upsertSession", () => {
  it("adds a new record at the head with startedAt = lastActiveAt = now", () => {
    const out = upsertSession([rec("a")], { sessionId: "b", cwd: "/b", skipPermissions: true }, "2026-09-15T11:00:00Z");
    expect(out.map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(out[0]).toEqual({ sessionId: "b", cwd: "/b", skipPermissions: true, startedAt: "2026-09-15T11:00:00Z", lastActiveAt: "2026-09-15T11:00:00Z" });
  });
  it("moves an existing record to the head, keeps startedAt, updates cwd and lastActiveAt", () => {
    const out = upsertSession([rec("a"), rec("b")], { sessionId: "b", cwd: "/b2", skipPermissions: false }, "2026-09-15T12:00:00Z");
    expect(out.map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(out[0].startedAt).toBe("2026-09-15T10:00:00Z");
    expect(out[0].lastActiveAt).toBe("2026-09-15T12:00:00Z");
    expect(out[0].cwd).toBe("/b2");
  });
  it("caps at SESSIONS_MAX dropping the oldest", () => {
    let list: SessionRecord[] = [];
    for (let i = 0; i < SESSIONS_MAX + 3; i++) list = upsertSession(list, { sessionId: `s${i}`, cwd: "/x", skipPermissions: false }, `2026-09-15T10:${String(i).padStart(2, "0")}:00Z`);
    expect(list).toHaveLength(SESSIONS_MAX);
    expect(list[0].sessionId).toBe(`s${SESSIONS_MAX + 2}`);
    expect(list[list.length - 1]?.sessionId).toBe("s3");
  });
  it("works from undefined", () => {
    expect(upsertSession(undefined, { sessionId: "a", cwd: "/a", skipPermissions: false }, "t")).toHaveLength(1);
  });
});

describe("bumpSession", () => {
  it("updates only the matching record's lastActiveAt and keeps order", () => {
    const out = bumpSession([rec("a"), rec("b")], "b", "2026-09-15T13:00:00Z")!;
    expect(out.map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(out[1].lastActiveAt).toBe("2026-09-15T13:00:00Z");
    expect(out[0].lastActiveAt).toBe("2026-09-15T10:00:00Z");
  });
  it("returns undefined when nothing matches", () => {
    expect(bumpSession([rec("a")], "zz", "t")).toBeUndefined();
    expect(bumpSession(undefined, "a", "t")).toBeUndefined();
  });
});

describe("promoteSession / removeSession", () => {
  it("promote moves to head and bumps lastActiveAt", () => {
    const out = promoteSession([rec("a"), rec("b")], "b", "2026-09-15T14:00:00Z");
    expect(out.map((r) => r.sessionId)).toEqual(["b", "a"]);
    expect(out[0].lastActiveAt).toBe("2026-09-15T14:00:00Z");
  });
  it("remove drops the record and tolerates undefined", () => {
    expect(removeSession([rec("a"), rec("b")], "a").map((r) => r.sessionId)).toEqual(["b"]);
    expect(removeSession(undefined, "a")).toEqual([]);
  });
});

describe("sanitizeSessions", () => {
  it("keeps well-formed records, drops malformed ones, and caps", () => {
    const good = rec("a");
    const out = sanitizeSessions([good, { sessionId: 1 }, "x", { ...rec("b"), cwd: "rel" }, null])!;
    expect(out).toEqual([good]);
    expect(sanitizeSessions(undefined)).toBeUndefined();
    expect(sanitizeSessions("nope")).toBeUndefined();
    expect(sanitizeSessions([])).toEqual([]);
  });
});
