import { describe, expect, it } from "vitest";
import { OFFLINE, type AgentState } from "./agentState";
import { groupRows, triage, loadGroupBy, needsLabel, relativeActivity, rowInfo, rowStatus, saveGroupBy, type RowContext, type RowSource } from "./sidebarGroups";

const ctx: RowContext = {
  selfMachine: "mini",
  machines: { mini: { alias: "desk", color: "#3b82f6", lastUsed: "t" }, box: { alias: "", color: "#f59e0b", lastUsed: "t" } },
  online: { box: false },
};
const agent = (status: AgentState["status"], since: string, unseen = false): AgentState => ({ ...OFFLINE, status, since, unseen, lastEvent: "x" });
const local = (id: string, extra: Partial<RowSource> = {}): RowSource => ({ id, name: id, cwd: `/p/${id}`, exited: null, ssh: null, foreign: null, sessions: undefined, agent: undefined, ...extra });
const remote = (id: string, machine: string | null, extra: Partial<RowSource> = {}): RowSource =>
  local(id, { ssh: { host: machine ? `me@${machine}` : "me@elsewhere.local", cwd: `/r/${id}`, machine }, ...extra });

describe("row info", () => {
  it("names the machine for local, remote, aliased and unknown tiles", () => {
    // The chip is the machine's name; an alias (usually also the tile's name) goes in the tooltip.
    expect(rowInfo(local("a"), ctx).machine).toEqual({ key: "mini", glyph: "M", label: "mini", alias: "desk", color: "#3b82f6", self: true, online: true });
    expect(rowInfo(local("a"), { ...ctx, selfMachine: null }).machine).toEqual({ key: "this-mac", glyph: "⌂", label: "this Mac", alias: null, color: null, self: true, online: true });
    expect(rowInfo(remote("b", "box"), ctx).machine).toEqual({ key: "box", glyph: "B", label: "box", alias: null, color: "#f59e0b", self: false, online: false });
    expect(rowInfo(remote("c", null), ctx).machine).toEqual({ key: "elsewhere", glyph: "E", label: "elsewhere", alias: null, color: null, self: false, online: null });
    // A chosen icon replaces the monogram.
    const iconCtx = { ...ctx, machines: { ...ctx.machines, box: { ...ctx.machines.box, icon: "🦊" } } };
    expect(rowInfo(remote("b", "box"), iconCtx).machine.glyph).toBe("🦊");
  });

  it("takes the folder from the remote or foreign folder before the local one", () => {
    expect(rowInfo(local("a"), ctx).folder).toBe("a");
    expect(rowInfo(remote("b", "box"), ctx).folder).toBe("b");
    expect(rowInfo(local("c", { foreign: { cwd: "/f/deep/er" } }), ctx).folder).toBe("er");
  });

  it("ranks status: exit code, then board questions or a waiting permission, then working, idle, stopped", () => {
    expect(rowStatus(agent("working", "t"), 1)).toBe("exited 1");
    expect(rowStatus(agent("working", "t"), 0)).toBe("stopped");
    const permission = { ...agent("blocked", "t"), lastEvent: "PermissionRequest" };
    expect(rowStatus(permission, null)).toBe("needs you");
    // Board questions need you whatever the agent is doing.
    expect(rowStatus(agent("working", "t"), null, 2)).toBe("needs you");
    expect(rowStatus(undefined, null, 1)).toBe("needs you");
    // A finished turn, or Claude's idle nudge, is not a reason to flag the tile.
    expect(rowStatus(agent("idle", "t", true), null)).toBe("idle");
    expect(rowStatus({ ...agent("blocked", "t"), lastEvent: "Notification" }, null)).toBe("idle");
    expect(rowStatus(agent("working", "t"), null)).toBe("working");
    expect(rowStatus(agent("idle", "t"), null)).toBe("idle");
    expect(rowStatus(agent("offline", "t"), null)).toBe("stopped");
    expect(rowStatus(undefined, null)).toBe("stopped");
  });

  it("takes the last activity from the agent, else the newest session", () => {
    expect(rowInfo(local("a", { agent: agent("idle", "2026-09-23T10:00:00Z") }), ctx).since).toBe("2026-09-23T10:00:00Z");
    const s = { sessionId: "s", cwd: "/p/a", skipPermissions: false, startedAt: "t0", lastActiveAt: "2026-09-22T09:00:00Z" };
    expect(rowInfo(local("a", { sessions: [s] }), ctx).since).toBe("2026-09-22T09:00:00Z");
    expect(rowInfo(local("a"), ctx).since).toBeNull();
  });

  it("counts the questions in the status word", () => {
    expect(rowInfo(local("a", { questions: 3 }), ctx).questions).toBe(3);
    expect(needsLabel(1)).toBe("1 question");
    expect(needsLabel(3)).toBe("3 questions");
    expect(needsLabel(0)).toBe("permission");
  });

  it("renders relative activity like the phone", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(relativeActivity(null, now)).toBe("");
    expect(relativeActivity("2026-09-23T11:59:30Z", now)).toBe("now");
    expect(relativeActivity("2026-09-23T11:57:00Z", now)).toBe("3m");
    expect(relativeActivity("2026-09-23T09:30:00Z", now)).toBe("2h");
    expect(relativeActivity("2026-09-21T12:00:00Z", now)).toBe("2d");
    expect(relativeActivity("2026-09-23T13:00:00Z", now)).toBe("now");
  });
});

describe("grouping", () => {
  const rows: RowSource[] = [
    remote("r1", "box", { agent: agent("working", "2026-09-23T10:00:00Z") }),
    local("l1", { agent: agent("idle", "2026-09-23T11:00:00Z"), questions: 2 }),
    local("l2", { agent: agent("idle", "2026-09-23T09:00:00Z") }),
    remote("r2", "box", { exited: 0 }),
    local("l3"),
  ];
  const infos = new Map(rows.map((r) => [r.id, rowInfo(r, ctx)]));
  const order = rows.map((r) => r.id);

  it("triage splits needs you, working and the rest, each newest first", () => {
    expect(triage(order, infos)).toEqual({ needs: ["l1"], working: ["r1"], quiet: ["l2", "r2", "l3"], exited: 0 });
    expect(groupRows(order, infos, "triage")).toEqual([]);
  });

  it("time buckets by last activity", () => {
    const now = Date.parse("2026-09-23T11:30:00Z");
    const g = groupRows(order, infos, "time", now);
    expect(g.map((x) => [x.title, x.ids])).toEqual([
      ["Last hour", ["l1"]],
      ["Today", ["r1", "l2"]],
      ["Older", ["r2", "l3"]],
    ]);
  });

  it("machine puts this Mac first and sorts each group by activity", () => {
    const g = groupRows(order, infos, "machine");
    expect(g.map((x) => [x.title, x.ids, x.online])).toEqual([
      ["mini (desk)", ["l1", "l2", "l3"], null],
      ["box", ["r1", "r2"], false],
    ]);
    expect(g[0].color).toBe("#3b82f6");
    expect(g.map((x) => x.glyph)).toEqual(["M", "B"]);
  });

  it("folder groups by basename, by name", () => {
    const g = groupRows(order, infos, "folder");
    expect(g.map((x) => x.title)).toEqual(["l1", "l2", "l3", "r1", "r2"]);
  });

  it("the preference round-trips and defaults", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadGroupBy(storage)).toBe("triage");
    saveGroupBy("machine", storage);
    expect(loadGroupBy(storage)).toBe("machine");
    // The old groupings, and anything unknown, open on Triage.
    for (const old of ["workspace", "status", "junk"]) {
      store.set("swarmz.sidebarGroupBy", old);
      expect(loadGroupBy(storage)).toBe("triage");
    }
    expect(loadGroupBy(null)).toBe("triage");
  });
});
