import { describe, expect, it } from "vitest";
import { addTab, splitWith, type GroupNode, type SplitNode } from "./layout";
import {
  EMPTY_SETTINGS,
  bumpSync,
  claudeLine,
  hostLabel,
  isLayoutNode,
  isMachineColor,
  isNewer,
  isSafeRemotePath,
  isSafeSessionId,
  machineHost,
  machineLabel,
  mergeForFirstSync,
  sameWorkspaceContent,
  needsRemoteFolder,
  openingFor,
  pickNewest,
  reconcileLayout,
  sanitizeLayout,
  shellQuote,
  sshLine,
  startupIsSsh,
  startupLine,
  startupSummary,
  startupSteps,
  startupUsesClaude,
  tintBackground,
  toWorkspace,
  touchMachine,
  validateAlias,
  validateHost,
  validateUser,
  type ClaudeConfig,
  type Machines,
  type SyncMeta,
  type TerminalDef,
  type Workspace,
} from "./workspace";

const claude: ClaudeConfig = { enabled: true, sessionId: "11111111-2222-3333-4444-555555555555", skipPermissions: false, started: false };

describe("shellQuote", () => {
  it("wraps in single quotes and escapes embedded single quotes", () => {
    expect(shellQuote("/proj")).toBe("'/proj'");
    expect(shellQuote("/a'b")).toBe("'/a'\\''b'");
  });
});

describe("claudeLine", () => {
  it("uses --session-id before the first run and --resume after", () => {
    expect(claudeLine(claude)).toBe(`claude --session-id ${claude.sessionId}`);
    expect(claudeLine({ ...claude, started: true })).toBe(`claude --resume ${claude.sessionId}`);
  });

  it("adds the skip-permissions flag before the session flag", () => {
    expect(claudeLine({ ...claude, skipPermissions: true })).toBe(
      `claude --dangerously-skip-permissions --session-id ${claude.sessionId}`,
    );
  });
});

describe("startupSummary", () => {
  it("is null with no startup", () => {
    expect(startupSummary(EMPTY_SETTINGS, {})).toBeNull();
  });
  it("describes an ssh connection by machine alias, folder and claude", () => {
    const s = { ssh: { host: "root@desk", cwd: "/proj", machine: "desk" }, claude: { ...claude, started: true }, command: null };
    expect(startupSummary(s, { desk: { alias: "Desk Mac", lastUsed: "t" } })).toBe("Connect to Desk Mac, open /proj, resume Claude");
  });
  it("falls back to the host label and says when Claude is new or skips permissions", () => {
    const s = { ssh: { host: "me@host.example.com" }, claude: { ...claude, skipPermissions: true }, command: null };
    expect(startupSummary(s, {})).toBe("Connect to host, start Claude (permissions skipped)");
  });
  it("describes a local claude session and a custom command", () => {
    expect(startupSummary({ ...EMPTY_SETTINGS, claude: { ...claude, started: true } }, {})).toBe("Resume Claude");
    expect(startupSummary({ ...EMPTY_SETTINGS, command: " npm run dev " }, {})).toBe("Run npm run dev");
  });
});

describe("startupLine", () => {
  it("is null with no settings", () => {
    expect(startupLine(EMPTY_SETTINGS)).toBeNull();
    expect(startupLine({ ssh: null, claude: { ...claude, enabled: false }, command: null })).toBeNull();
  });

  it("ssh only", () => {
    expect(startupLine({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toBe(sshLine("me@host"));
  });

  it("claude only", () => {
    expect(startupLine({ ...EMPTY_SETTINGS, claude })).toBe(`claude --session-id ${claude.sessionId}`);
  });

  it("ssh and claude with a remote cwd is two steps", () => {
    const steps = startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null });
    expect(steps).toEqual([
      { via: "local", line: sshLine("me@host") },
      { via: "remote", line: `cd ${shellQuote("/proj")} && claude --session-id ${claude.sessionId}` },
    ]);
    expect(startupLine({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null })).toBe(
      `${sshLine("me@host")} ⏎ cd '/proj' && claude --session-id ${claude.sessionId}`,
    );
  });

  it("ssh and claude without a remote cwd is only the ssh step and needs a folder", () => {
    const s = { ssh: { host: "me@host" }, claude, command: null };
    expect(startupSteps(s)).toEqual([{ via: "local", line: sshLine("me@host") }]);
    expect(needsRemoteFolder(s)).toBe(true);
    expect(needsRemoteFolder({ ssh: { host: "me@host", cwd: "/p" }, claude, command: null })).toBe(false);
    expect(needsRemoteFolder({ ssh: { host: "me@host" }, claude, command: "ls" })).toBe(false);
  });

  it("every remote terminal with a folder gets a cd step, even without Claude", () => {
    expect(needsRemoteFolder({ ssh: { host: "me@host" }, claude: null, command: null })).toBe(true);
    expect(startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude: null, command: null })).toEqual([
      { via: "local", line: sshLine("me@host") },
      { via: "remote", line: `cd ${shellQuote("/proj")}` },
    ]);
  });

  it("sshLine carries the multiplexing options", () => {
    expect(sshLine("me@host")).toBe("ssh -t -o ControlMaster=auto -o ControlPath=~/.swarmz/ssh/%C -o ControlPersist=10m me@host");
    expect(startupSteps({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toEqual([{ via: "local", line: sshLine("me@host") }]);
    expect(startupIsSsh({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toBe(true);
    expect(startupIsSsh({ ...EMPTY_SETTINGS, ssh: { host: "me@host" }, command: "ls" })).toBe(false);
    expect(startupIsSsh({ ...EMPTY_SETTINGS, ssh: { host: "h; ls" } })).toBe(false);
  });

  it("free-form command wins and is trimmed", () => {
    expect(startupLine({ ssh: { host: "me@host" }, claude, command: "  npm run dev  " })).toBe("npm run dev");
    expect(startupLine({ ...EMPTY_SETTINGS, command: "   " })).toBeNull();
  });

  it("treats an unsafe claude session id as disabled", () => {
    const unsafeClaude = { ...claude, sessionId: "x'y" };
    expect(startupLine({ ssh: { host: "h" }, claude: unsafeClaude, command: null })).toBe(sshLine("h"));
    expect(startupLine({ ssh: null, claude: unsafeClaude, command: null })).toBeNull();
  });

  it("ignores an ssh host that fails validation", () => {
    expect(startupLine({ ssh: { host: "h; ls" }, claude, command: null })).toBe(`claude --session-id ${claude.sessionId}`);
    expect(startupLine({ ssh: { host: "h; ls" }, claude: null, command: null })).toBeNull();
  });

  it("prefixes the remote line with the terminal id when Claude runs there", () => {
    const steps = startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null }, "11111111-2222-3333-4444-555555555555");
    expect(steps[1]).toEqual({
      via: "remote",
      line: `cd ${shellQuote("/proj")} && SWARMZ_TERMINAL_ID=11111111-2222-3333-4444-555555555555 claude --session-id ${claude.sessionId}`,
    });
    // No Claude on the remote: nothing to identify, no prefix.
    expect(startupSteps({ ssh: { host: "me@host", cwd: "/proj" }, claude: null, command: null }, "t1")[1].line).toBe(`cd ${shellQuote("/proj")}`);
    // Local Claude already inherits the env var from the spawn.
    expect(startupSteps({ ...EMPTY_SETTINGS, claude }, "t1")[0].line).toBe(`claude --session-id ${claude.sessionId}`);
    // Without an id the line is unchanged (display-only callers).
    expect(startupLine({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null })).not.toContain("SWARMZ_TERMINAL_ID");
  });
});

describe("startupUsesClaude", () => {
  it("is true only when the claude branch produced the line", () => {
    expect(startupUsesClaude({ ...EMPTY_SETTINGS, claude })).toBe(true);
    expect(startupUsesClaude({ ssh: { host: "h" }, claude, command: null })).toBe(true);
    expect(startupUsesClaude({ ssh: { host: "h" }, claude, command: "ls" })).toBe(false);
    expect(startupUsesClaude({ ...EMPTY_SETTINGS, ssh: { host: "h" } })).toBe(false);
    expect(startupUsesClaude({ ssh: { host: "h" }, claude: { ...claude, sessionId: "x'y" }, command: null })).toBe(false);
  });
});

describe("validateHost", () => {
  it("rejects whitespace, quotes and empty", () => {
    expect(validateHost("me@host")).toBeNull();
    expect(validateHost("host.local")).toBeNull();
    expect(validateHost("")).not.toBeNull();
    expect(validateHost("me@host x")).not.toBeNull();
    expect(validateHost("me@'host'")).not.toBeNull();
  });

  it("rejects shell-injection-shaped hosts and accepts plain ones", () => {
    expect(validateHost("-oProxyCommand=x")).not.toBeNull();
    expect(validateHost("host;ls")).not.toBeNull();
    expect(validateHost("a|b")).not.toBeNull();
    expect(validateHost("a&b")).not.toBeNull();
    expect(validateHost("me@host.local")).toBeNull();
    expect(validateHost("10.0.0.5")).toBeNull();
  });
});

describe("isSafeSessionId", () => {
  it("accepts a UUID and rejects unsafe ids", () => {
    expect(isSafeSessionId("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isSafeSessionId("abc'def")).toBe(false);
    expect(isSafeSessionId("a b")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
  });
});

describe("isSafeRemotePath", () => {
  it("accepts ordinary paths and rejects empty or control characters", () => {
    expect(isSafeRemotePath("/Users/me/projects")).toBe(true);
    expect(isSafeRemotePath("")).toBe(false);
    expect(isSafeRemotePath("/a\nb")).toBe(false);
    expect(isSafeRemotePath("/a\x1bb")).toBe(false);
    expect(isSafeRemotePath("/a\x7fb")).toBe(false);
  });
});

describe("reconcileLayout", () => {
  it("drops unknown ids, adds missing ids to the first group, and collapses", () => {
    let l = addTab(null, "a", null);
    l = addTab(l, "b", null);
    const g1 = (l as GroupNode).id;
    l = splitWith(l, g1, "b", "right", "g2");
    const out = reconcileLayout(l, ["a", "c"]);
    expect(out?.kind).toBe("group");
    expect((out as GroupNode).tabs).toEqual(["a", "c"]);
  });

  it("returns null when there are no ids and builds a root when the layout is null", () => {
    expect(reconcileLayout(addTab(null, "a", null), [])).toBeNull();
    const out = reconcileLayout(null, ["x", "y"]);
    expect((out as GroupNode).tabs).toEqual(["x", "y"]);
  });

  it("keeps a valid layout untouched", () => {
    let l = addTab(null, "a", null);
    l = addTab(l, "b", null);
    l = splitWith(l, (l as GroupNode).id, "b", "bottom", "g2");
    const out = reconcileLayout(l, ["a", "b"]);
    expect((out as SplitNode).children.length).toBe(2);
  });
});

describe("isLayoutNode", () => {
  it("accepts a valid group and a valid split", () => {
    const group: GroupNode = { kind: "group", id: "g1", tabs: ["a", "b"], active: "a" };
    expect(isLayoutNode(group)).toBe(true);
    const split: SplitNode = {
      kind: "split",
      id: "s1",
      dir: "row",
      children: [group, { kind: "group", id: "g2", tabs: ["c"], active: "c" }],
      sizes: [50, 50],
    };
    expect(isLayoutNode(split)).toBe(true);
  });

  it("rejects shapes that are not a valid group or split", () => {
    expect(isLayoutNode({})).toBe(false);
    expect(isLayoutNode("x")).toBe(false);
    expect(isLayoutNode(null)).toBe(false);
    expect(isLayoutNode({ kind: "split", id: "s1", dir: "row", sizes: [50, 50] })).toBe(false); // missing children
    expect(isLayoutNode({ kind: "group", id: "g1", active: "a" })).toBe(false); // missing tabs
    expect(
      isLayoutNode({
        kind: "split",
        id: "s1",
        dir: "row",
        children: [{ kind: "group", id: "g1", tabs: ["a"], active: "a" }],
        sizes: [50, 50], // length mismatch with children
      }),
    ).toBe(false);
  });
});

describe("sanitizeLayout", () => {
  it("passes through null and valid layouts, and rejects invalid ones", () => {
    expect(sanitizeLayout(null)).toBeNull();
    const group: GroupNode = { kind: "group", id: "g1", tabs: ["a"], active: "a" };
    expect(sanitizeLayout(group)).toEqual(group);
    expect(sanitizeLayout({})).toBeNull();
    expect(sanitizeLayout("not a layout")).toBeNull();
  });
});

describe("toWorkspace", () => {
  it("emits terminals in order with their settings", () => {
    const ws = toWorkspace({
      order: ["b", "a"],
      terminals: {
        a: { id: "a", name: "A", cwd: "/a" },
        b: { id: "b", name: "B", cwd: "/b" },
      },
      settings: { a: { ...EMPTY_SETTINGS, ssh: { host: "h" } } },
      layout: null,
      machines: { m1: { alias: "a", lastUsed: "t" } },
    });
    expect(ws.version).toBe(1);
    expect(ws.terminals.map((t) => t.id)).toEqual(["b", "a"]);
    expect(ws.terminals[1].ssh).toEqual({ host: "h" });
    expect(ws.terminals[0].ssh).toBeNull();
    expect(ws.terminals[0].claude).toBeNull();
    expect(ws.terminals[0].command).toBeNull();
    expect(ws.layout).toBeNull();
    expect(ws.machines).toEqual({ m1: { alias: "a", lastUsed: "t" } });
  });

  it("omits machines when empty", () => {
    const ws = toWorkspace({
      order: ["a"],
      terminals: { a: { id: "a", name: "A", cwd: "/a" } },
      settings: {},
      layout: null,
      machines: {},
    });
    expect("machines" in ws).toBe(false);
  });
});

describe("machines", () => {
  it("label and host", () => {
    expect(machineLabel("martins-mac-mini", undefined)).toBe("martins-mac-mini");
    expect(machineLabel("martins-mac-mini", { alias: " desk mini ", lastUsed: "t" })).toBe("desk mini");
    expect(machineLabel("martins-mac-mini", { alias: "", lastUsed: "t" })).toBe("martins-mac-mini");
    expect(machineHost("martins-mac-mini", undefined, "mokes")).toBe("mokes@martins-mac-mini");
    expect(machineHost("martins-mac-mini", { user: "root", lastUsed: "t" }, "mokes")).toBe("root@martins-mac-mini");
    expect(machineHost("martins-mac-mini", { user: " ", lastUsed: "t" }, "mokes")).toBe("mokes@martins-mac-mini");
  });

  it("touchMachine merges, stamps lastUsed unless told not to, and caps at 50", () => {
    let m = touchMachine({}, "a", { cwd: "/x" }, "2026-01-01T00:00:00Z");
    expect(m.a).toEqual({ cwd: "/x", lastUsed: "2026-01-01T00:00:00Z" });
    m = touchMachine(m, "a", { alias: "A" }, "2026-01-02T00:00:00Z", { bump: false });
    expect(m.a).toEqual({ cwd: "/x", alias: "A", lastUsed: "2026-01-01T00:00:00Z" });
    for (let i = 0; i < 60; i++) m = touchMachine(m, `h${i}`, {}, new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString());
    expect(Object.keys(m).length).toBe(50);
    expect(m.a).toBeUndefined();
    expect(m.h59).toBeDefined();
  });

  it("validateAlias follows the name rules", () => {
    expect(validateAlias("desk mini")).toBeNull();
    expect(validateAlias("")).not.toBeNull();
    expect(validateAlias("a\"b")).not.toBeNull();
    expect(validateAlias("x".repeat(65))).not.toBeNull();
  });

  it("validateUser: empty means use the default, otherwise a strict allowlist", () => {
    expect(validateUser("")).toBeNull();
    expect(validateUser("   ")).toBeNull();
    expect(validateUser("mokes")).toBeNull();
    expect(validateUser("root_1.2-3")).toBeNull();
    expect(validateUser("a b")).not.toBeNull();
    expect(validateUser("me@x")).not.toBeNull();
    expect(validateUser("x".repeat(33))).not.toBeNull();
    expect(validateUser("x".repeat(32))).toBeNull();
  });

  it("colours", () => {
    expect(isMachineColor(null)).toBe(true);
    expect(isMachineColor("#f59e0b")).toBe(true);
    expect(isMachineColor("#123456")).toBe(false);
    expect(tintBackground("#0f1115", null)).toBe("#0f1115");
    expect(tintBackground("#000000", "#ffffff")).toBe("#1a1a1a");
    expect(tintBackground("#0f1115", "#f59e0b")).toBe("#261f14");
  });
});

describe("hostLabel", () => {
  it("strips the user and takes the first host label", () => {
    expect(hostLabel("mokes@other-mac.local")).toBe("other-mac");
    expect(hostLabel("other-mac.local")).toBe("other-mac");
    expect(hostLabel("10.0.0.5")).toBe("10.0.0.5");
    expect(hostLabel("me@box")).toBe("box");
  });
});

describe("sync meta", () => {
  const a = { revision: 3, updatedAt: "2026-01-02T00:00:00Z", updatedBy: "a" };
  const b = { revision: 3, updatedAt: "2026-01-01T00:00:00Z", updatedBy: "b" };
  it("isNewer compares revision then updatedAt and treats missing as oldest", () => {
    expect(isNewer(a, b)).toBe(true);
    expect(isNewer(b, a)).toBe(false);
    expect(isNewer({ ...b, revision: 4 }, a)).toBe(true);
    expect(isNewer(a, undefined)).toBe(true);
    expect(isNewer(undefined, a)).toBe(false);
    expect(isNewer(a, a)).toBe(false);
  });
  it("breaks an exact revision+timestamp tie on the machine name, the same way on both machines", () => {
    const x = { revision: 3, updatedAt: "2026-01-02T00:00:00Z", updatedBy: "a" };
    const y = { revision: 3, updatedAt: "2026-01-02T00:00:00Z", updatedBy: "b" };
    expect(isNewer(y, x)).toBe(true);
    expect(isNewer(x, y)).toBe(false);
    expect(isNewer(x, { ...x })).toBe(false);
  });
  it("pickNewest returns the newest candidate or null", () => {
    const w = (sync: SyncMeta | undefined): Workspace => ({ version: 1, terminals: [], layout: null, ...(sync ? { sync } : {}) });
    expect(pickNewest([])).toBeNull();
    expect(pickNewest([w(b), w(a), w(undefined)])?.sync).toEqual(a);
  });
  it("bumpSync increments and stamps", () => {
    expect(bumpSync(undefined, "me", "t1")).toEqual({ revision: 1, updatedAt: "t1", updatedBy: "me" });
    expect(bumpSync(a, "me", "t2")).toEqual({ revision: 4, updatedAt: "t2", updatedBy: "me" });
  });
});

describe("openingFor", () => {
  const machines: Machines = { desk: { user: "root", color: "#ef4444", lastUsed: "t" } };
  const known = new Set(["desk"]);
  const base = { id: "t", name: "n", cwd: "/proj", ssh: null, claude: null, command: null };
  it("remote defs open unchanged", () => {
    const def = { ...base, ssh: { host: "me@x", cwd: "/r", machine: "x" }, origin: "elsewhere" };
    const o = openingFor(def, "here", machines, "mokes", known);
    expect(o.cwd).toBeNull();
    expect(o.settings.ssh).toEqual(def.ssh);
    expect(o.settings.foreign).toBeUndefined();
    expect(o.note).toBeNull();
  });
  it("locals from here or without origin open locally", () => {
    expect(openingFor({ ...base, origin: "here" }, "here", machines, "mokes", known).cwd).toBe("/proj");
    expect(openingFor(base, "here", machines, "mokes", known).cwd).toBe("/proj");
    expect(openingFor({ ...base, origin: "desk" }, null, machines, "mokes", known).cwd).toBe("/proj");
  });
  it("locals from another machine open as foreign remotes", () => {
    const o = openingFor({ ...base, origin: "desk", claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true } }, "here", machines, "mokes", known);
    expect(o.cwd).toBeNull();
    expect(o.settings.ssh).toEqual({ host: "root@desk", cwd: "/proj", machine: "desk" });
    expect(o.settings.foreign).toEqual({ cwd: "/proj" });
    expect(o.settings.origin).toBe("desk");
    expect(o.settings.claude?.sessionId).toBe("s");
    expect(o.note).toBeNull();
  });
  it("a remote whose target machine is this one opens as a local in the remote folder", () => {
    const claude = { enabled: true, sessionId: "s", skipPermissions: true, started: true };
    const def = { ...base, cwd: "/home", ssh: { host: "mokes@here", cwd: "/proj", machine: "here" }, claude, origin: "desk" };
    const o = openingFor(def, "here", machines, "mokes", known);
    expect(o.cwd).toBe("/proj");
    expect(o.settings.ssh).toBeNull();
    expect(o.settings.foreign).toBeUndefined();
    expect(o.settings.origin).toBe("here");
    expect(o.settings.claude).toEqual(claude);
    expect(o.note).toBeNull();
  });
  it("a remote targeting this machine with no folder opens in home", () => {
    const def = { ...base, cwd: "/home", ssh: { host: "mokes@here", cwd: null, machine: "here" }, origin: "desk" };
    const o = openingFor(def, "here", machines, "mokes", known);
    expect(o.cwd).toBeNull();
    expect(o.settings.ssh).toBeNull();
    expect(o.settings.origin).toBe("here");
  });
  it("a remote by raw host with no machine stays remote even on the target", () => {
    const def = { ...base, ssh: { host: "mokes@here", cwd: "/proj" }, origin: "desk" };
    const o = openingFor(def, "here", machines, "mokes", known);
    expect(o.cwd).toBeNull();
    expect(o.settings.ssh).toEqual(def.ssh);
  });
  it("a local from a machine we do not know opens locally with a note", () => {
    const o = openingFor({ ...base, origin: "gone" }, "here", machines, "mokes", known);
    expect(o.cwd).toBe("/proj");
    expect(o.settings.ssh).toBeNull();
    expect(o.settings.foreign).toBeUndefined();
    expect(o.settings.origin).toBe("gone");
    expect(o.note).toBe("origin machine gone is not on your tailnet; opened locally");
  });
});

describe("sameWorkspaceContent", () => {
  const t = (id: string, name = id): TerminalDef => ({ id, name, cwd: `/${id}`, ssh: null, claude: null, command: null });
  const ws = (terminals: TerminalDef[], extra: Partial<Workspace> = {}): Workspace => ({
    version: 1, terminals, layout: { kind: "group", id: "g", tabs: terminals.map((x) => x.id), active: terminals[0]?.id ?? "" }, ...extra,
  });
  it("ignores the order terminals are listed in, and `sync` entirely", () => {
    const a = ws([t("a"), t("b")]);
    const b = { ...ws([t("b"), t("a")]), layout: a.layout, sync: { revision: 9, updatedAt: "t", updatedBy: "x" } };
    expect(sameWorkspaceContent(a, b)).toBe(true);
    expect(sameWorkspaceContent(a, ws([t("a"), t("b")], { machines: {} }))).toBe(true);
  });
  it("sees a changed name, cwd, ssh, claude, command, origin, layout, machine set or terminal set", () => {
    const base = ws([t("a"), t("b")]);
    expect(sameWorkspaceContent(base, ws([t("a"), t("b", "renamed")]))).toBe(false);
    expect(sameWorkspaceContent(base, ws([t("a"), { ...t("b"), cwd: "/elsewhere" }]))).toBe(false);
    expect(sameWorkspaceContent(base, ws([t("a"), { ...t("b"), ssh: { host: "me@x", cwd: null } }]))).toBe(false);
    expect(sameWorkspaceContent(base, ws([t("a"), { ...t("b"), command: "ls" }]))).toBe(false);
    expect(sameWorkspaceContent(base, ws([t("a"), { ...t("b"), origin: "desk" }]))).toBe(false);
    expect(sameWorkspaceContent(base, ws([t("a")]))).toBe(false);
    expect(sameWorkspaceContent(base, { ...base, layout: null })).toBe(false);
    expect(sameWorkspaceContent(base, { ...base, machines: { desk: { lastUsed: "t" } } })).toBe(false);
  });
});

describe("mergeForFirstSync", () => {
  const def = (id: string): TerminalDef => ({ id, name: id, cwd: `/${id}`, ssh: null, claude: null, command: null });
  it("keeps local terminals the peer does not have, with the peer's sync and layout", () => {
    const local: Workspace = {
      version: 1,
      terminals: [def("mine"), def("both")],
      layout: { kind: "group", id: "lg", tabs: ["mine", "both"], active: "mine" },
      machines: { old: { lastUsed: "t0" }, desk: { alias: "stale", lastUsed: "t0" } },
    };
    const peer: Workspace = {
      version: 1,
      terminals: [def("both"), def("theirs")],
      layout: { kind: "group", id: "pg", tabs: ["both", "theirs"], active: "theirs" },
      machines: { desk: { alias: "Desk", lastUsed: "t1" } },
      sync: { revision: 4, updatedAt: "t", updatedBy: "desk" },
    };
    const merged = mergeForFirstSync(local, peer);
    expect(merged.terminals.map((t) => t.id)).toEqual(["both", "theirs", "mine"]);
    expect(merged.sync).toEqual(peer.sync);
    expect(merged.machines).toEqual({ old: { lastUsed: "t0" }, desk: { alias: "Desk", lastUsed: "t1" } });
    // The peer's layout, with the extra local terminal placed into it.
    const tabs = (merged.layout as GroupNode).tabs;
    expect(tabs).toContain("mine");
    expect([...tabs].sort()).toEqual(["both", "mine", "theirs"]);
  });
  it("is the peer's workspace when the local one is empty", () => {
    const peer: Workspace = { version: 1, terminals: [def("a")], layout: null, sync: { revision: 1, updatedAt: "t", updatedBy: "desk" } };
    const merged = mergeForFirstSync({ version: 1, terminals: [], layout: null }, peer);
    expect(merged.terminals.map((t) => t.id)).toEqual(["a"]);
    expect(merged.machines).toBeUndefined();
  });
});

describe("toWorkspace with sync and foreign locals", () => {
  it("writes origin and sync, and writes a foreign local back unchanged", () => {
    const ws = toWorkspace({
      order: ["f", "l"],
      terminals: { f: { id: "f", name: "F", cwd: "/home/me" }, l: { id: "l", name: "L", cwd: "/here" } },
      settings: {
        f: { ...EMPTY_SETTINGS, origin: "desk", foreign: { cwd: "/proj" }, ssh: { host: "root@desk", cwd: "/proj", machine: "desk" } },
        l: { ...EMPTY_SETTINGS, origin: "here" },
      },
      layout: null,
      machines: {},
      sync: { revision: 7, updatedAt: "t", updatedBy: "here" },
    });
    expect(ws.sync).toEqual({ revision: 7, updatedAt: "t", updatedBy: "here" });
    expect(ws.terminals[0]).toMatchObject({ id: "f", cwd: "/proj", ssh: null, origin: "desk" });
    expect("foreign" in ws.terminals[0]).toBe(false);
    expect(ws.terminals[1]).toMatchObject({ id: "l", cwd: "/here", origin: "here" });
  });
});

describe("sessions in the workspace file", () => {
  const sess = [{ sessionId: "s1", cwd: "/p", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }];
  it("toWorkspace writes sessions and sameWorkspaceContent compares them", () => {
    const base = {
      order: ["a"],
      terminals: { a: { id: "a", name: "A", cwd: "/p" } },
      settings: { a: { ...EMPTY_SETTINGS, sessions: sess } },
      layout: { kind: "group" as const, id: "g", tabs: ["a"], active: "a" },
      machines: {},
    };
    const ws = toWorkspace(base);
    expect(ws.terminals[0].sessions).toEqual(sess);
    const without = toWorkspace({ ...base, settings: { a: EMPTY_SETTINGS } });
    expect(sameWorkspaceContent(ws, without)).toBe(false);
    expect(sameWorkspaceContent(ws, toWorkspace(base))).toBe(true);
  });
  it("omits the key when there are no sessions", () => {
    const ws = toWorkspace({ order: ["a"], terminals: { a: { id: "a", name: "A", cwd: "/p" } }, settings: { a: EMPTY_SETTINGS }, layout: null, machines: {} });
    expect("sessions" in ws.terminals[0]).toBe(false);
  });
});
