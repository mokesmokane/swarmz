import { describe, expect, it } from "vitest";
import { OFFLINE, type AgentState } from "./agentState";
import { groupByConductor, groupRows, loadGroupBy, relativeActivity, rowInfo, rowStatus, saveGroupBy, type RowContext, type RowSource } from "./sidebarGroups";

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

  it("ranks status: exit code, then blocked or unseen, then working, idle, stopped", () => {
    expect(rowStatus(agent("working", "t"), 1)).toBe("exited 1");
    expect(rowStatus(agent("working", "t"), 0)).toBe("stopped");
    expect(rowStatus(agent("blocked", "t"), null)).toBe("needs you");
    expect(rowStatus(agent("idle", "t", true), null)).toBe("needs you");
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
    local("l1", { agent: agent("blocked", "2026-09-23T11:00:00Z") }),
    local("l2", { agent: agent("idle", "2026-09-23T09:00:00Z") }),
    remote("r2", "box", { exited: 0 }),
    local("l3"),
  ];
  const infos = new Map(rows.map((r) => [r.id, rowInfo(r, ctx)]));
  const order = rows.map((r) => r.id);

  it("workspace keeps the order in one untitled group", () => {
    expect(groupRows(order, infos, "workspace")).toEqual([{ key: "all", title: "", ids: order }]);
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

  it("status orders needs you, working, idle, stopped and hides empty groups", () => {
    const g = groupRows(order, infos, "status");
    expect(g.map((x) => [x.title, x.ids])).toEqual([
      ["needs you", ["l1"]],
      ["working", ["r1"]],
      ["idle", ["l2"]],
      ["stopped", ["r2", "l3"]],
    ]);
  });

  it("folder groups by basename, by name", () => {
    const g = groupRows(order, infos, "folder");
    expect(g.map((x) => x.title)).toEqual(["l1", "l2", "l3", "r1", "r2"]);
  });

  it("the preference round-trips and defaults", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadGroupBy(storage)).toBe("workspace");
    saveGroupBy("machine", storage);
    expect(loadGroupBy(storage)).toBe("machine");
    store.set("swarmz.sidebarGroupBy", "junk");
    expect(loadGroupBy(storage)).toBe("workspace");
    expect(loadGroupBy(null)).toBe("workspace");
  });
});

describe("groupByConductor", () => {
  const info = (id: string, since: string | null = null) =>
    [id, { id, machine: { key: "m", glyph: "M", label: "m", alias: null, color: null, self: true, online: null }, folder: "f", status: "idle" as const, since }] as const;
  const infos = new Map([info("top"), info("s1"), info("s2"), info("a", "2026-01-01T00:00:00Z"), info("b", "2026-01-02T00:00:00Z"), info("o")]);
  const order = ["a", "top", "s1", "b", "s2", "o"];
  const subs = { s1: { parent: "top", tiles: ["a", "b"] }, s2: { parent: "s1", tiles: [] } };
  const title = (id: string) => id.toUpperCase();

  it("makes one group per conductor, in tree order, headed by the conductor", () => {
    const g = groupByConductor(order, infos, "top", subs, title);
    expect(g.map((x) => [x.title, x.ids])).toEqual([
      ["🎛 TOP", ["top", "o"]],
      ["· 🎛 S1", ["s1", "b", "a"]],
      ["· · 🎛 S2", ["s2"]],
    ]);
  });

  it("is one group with no top conductor", () => {
    expect(groupByConductor(order, infos, null, subs, title)).toEqual([{ key: "none", title: "No conductor", ids: order }]);
  });
});

