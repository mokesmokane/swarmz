import { describe, expect, it } from "vitest";
import { addTab, splitWith, type GroupNode, type SplitNode } from "./layout";
import {
  EMPTY_SETTINGS,
  claudeLine,
  hostLabel,
  isLayoutNode,
  isSafeRemotePath,
  isSafeSessionId,
  needsRemoteFolder,
  reconcileLayout,
  recentSshHosts,
  sanitizeLayout,
  shellQuote,
  sshLine,
  startupIsSsh,
  startupLine,
  startupSteps,
  startupUsesClaude,
  toWorkspace,
  touchSshHistory,
  validateHost,
  type ClaudeConfig,
  type SshHistory,
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
    expect(needsRemoteFolder({ ssh: { host: "me@host" }, claude: null, command: null })).toBe(false);
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
      sshHistory: { "a@x": { cwd: null, lastUsed: "t" } },
    });
    expect(ws.version).toBe(1);
    expect(ws.terminals.map((t) => t.id)).toEqual(["b", "a"]);
    expect(ws.terminals[1].ssh).toEqual({ host: "h" });
    expect(ws.terminals[0].ssh).toBeNull();
    expect(ws.terminals[0].claude).toBeNull();
    expect(ws.terminals[0].command).toBeNull();
    expect(ws.layout).toBeNull();
    expect(ws.sshHistory).toEqual({ "a@x": { cwd: null, lastUsed: "t" } });
  });

  it("omits sshHistory when empty", () => {
    const ws = toWorkspace({
      order: ["a"],
      terminals: { a: { id: "a", name: "A", cwd: "/a" } },
      settings: {},
      layout: null,
      sshHistory: {},
    });
    expect("sshHistory" in ws).toBe(false);
  });
});

describe("ssh history", () => {
  it("touch adds or refreshes an entry and keeps an existing cwd when none is given", () => {
    let h = touchSshHistory({}, "a@x", "/p", "2026-01-01T00:00:00Z");
    expect(h["a@x"]).toEqual({ cwd: "/p", lastUsed: "2026-01-01T00:00:00Z" });
    h = touchSshHistory(h, "a@x", undefined, "2026-01-02T00:00:00Z");
    expect(h["a@x"]).toEqual({ cwd: "/p", lastUsed: "2026-01-02T00:00:00Z" });
    h = touchSshHistory(h, "a@x", null, "2026-01-03T00:00:00Z");
    expect(h["a@x"].cwd).toBeNull();
  });

  it("caps at the most recent entries and lists them newest first", () => {
    let h: SshHistory = {};
    for (let i = 0; i < 25; i++) h = touchSshHistory(h, `h${i}`, null, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
    expect(Object.keys(h).length).toBe(20);
    expect(h["h0"]).toBeUndefined();
    const recent = recentSshHosts(h, 3).map((e) => e.host);
    expect(recent).toEqual(["h24", "h23", "h22"]);
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
