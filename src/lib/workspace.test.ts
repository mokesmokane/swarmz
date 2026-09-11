import { describe, expect, it } from "vitest";
import { addTab, splitWith, type GroupNode, type SplitNode } from "./layout";
import {
  EMPTY_SETTINGS,
  claudeLine,
  hostLabel,
  isLayoutNode,
  isSafeSessionId,
  reconcileLayout,
  sanitizeLayout,
  shellQuote,
  startupLine,
  startupUsesClaude,
  toWorkspace,
  validateHost,
  type ClaudeConfig,
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
    expect(startupLine({ ...EMPTY_SETTINGS, ssh: { host: "me@host" } })).toBe("ssh -t me@host");
  });

  it("claude only", () => {
    expect(startupLine({ ...EMPTY_SETTINGS, claude })).toBe(`claude --session-id ${claude.sessionId}`);
  });

  it("ssh and claude with a remote cwd", () => {
    const line = startupLine({ ssh: { host: "me@host", cwd: "/proj" }, claude, command: null });
    const inner = `cd ${shellQuote("/proj")} && claude --session-id ${claude.sessionId}`;
    expect(line).toBe(`ssh -t me@host ${shellQuote(`exec $SHELL -lic ${shellQuote(inner)}`)}`);
  });

  it("ssh and claude without a remote cwd", () => {
    const line = startupLine({ ssh: { host: "me@host" }, claude, command: null });
    const inner = `claude --session-id ${claude.sessionId}`;
    expect(line).toBe(`ssh -t me@host ${shellQuote(`exec $SHELL -lic ${shellQuote(inner)}`)}`);
  });

  it("free-form command wins and is trimmed", () => {
    expect(startupLine({ ssh: { host: "me@host" }, claude, command: "  npm run dev  " })).toBe("npm run dev");
    expect(startupLine({ ...EMPTY_SETTINGS, command: "   " })).toBeNull();
  });

  it("treats an unsafe claude session id as disabled", () => {
    const unsafeClaude = { ...claude, sessionId: "x'y" };
    expect(startupLine({ ssh: { host: "h" }, claude: unsafeClaude, command: null })).toBe("ssh -t h");
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
    });
    expect(ws.version).toBe(1);
    expect(ws.terminals.map((t) => t.id)).toEqual(["b", "a"]);
    expect(ws.terminals[1].ssh).toEqual({ host: "h" });
    expect(ws.terminals[0].ssh).toBeNull();
    expect(ws.terminals[0].claude).toBeNull();
    expect(ws.terminals[0].command).toBeNull();
    expect(ws.layout).toBeNull();
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
