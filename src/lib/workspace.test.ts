import { describe, expect, it } from "vitest";
import { addTab, splitWith, type GroupNode, type SplitNode } from "./layout";
import {
  EMPTY_SETTINGS,
  claudeLine,
  isSafeSessionId,
  reconcileLayout,
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
    expect(line).toBe(`ssh -t me@host ${shellQuote(`cd ${shellQuote("/proj")} && claude --session-id ${claude.sessionId}`)}`);
  });

  it("ssh and claude without a remote cwd", () => {
    const line = startupLine({ ssh: { host: "me@host" }, claude, command: null });
    expect(line).toBe(`ssh -t me@host ${shellQuote(`claude --session-id ${claude.sessionId}`)}`);
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
