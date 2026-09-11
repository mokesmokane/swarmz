import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo } from "./lib/ipc";

vi.mock("./lib/ipc", () => {
  const info = (id: string, cwd: string, name?: string): TerminalInfo => ({
    id,
    name: name ?? cwd.split("/").pop() ?? "shell",
    cwd,
    exited: null,
    error: null,
  });
  return {
    ipc: {
      createTerminal: vi.fn(async (id: string, cwd: string) => info(id, cwd)),
      listTerminals: vi.fn(async () => []),
      writeTerminal: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}),
      renameTerminal: vi.fn(async (id: string, name: string) => {
        if (name === "dupe") throw 'a terminal named "dupe" already exists';
        return info(id, "/tmp/x", name);
      }),
      closeTerminal: vi.fn(async () => {}),
      restartTerminal: vi.fn(async (id: string) => info(id, "/tmp/x")),
      onData: vi.fn(async () => () => {}),
      onExit: vi.fn(async () => () => {}),
      loadWorkspace: vi.fn(async () => null),
      saveWorkspace: vi.fn(async () => {}),
    },
  };
});

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { ipc } from "./lib/ipc";
import { __resetLoadGuard, beforeSpawn, SAVE_DEBOUNCE_MS, useStore } from "./store";
import { findGroup, findGroupOf, type GroupNode, type SplitNode } from "./lib/layout";
import { EMPTY_SETTINGS, type Workspace } from "./lib/workspace";

beforeEach(() => {
  __resetLoadGuard();
  useStore.setState({
    terminals: {},
    order: [],
    layout: null,
    focusedGroupId: null,
    focusedTerminalId: null,
    draggingTerminalId: null,
    lastCwd: null,
    settings: {},
    startupPending: {},
    startupNotes: {},
    persistError: null,
    persistenceReady: true,
  });
  beforeSpawn.hook = async () => {};
  beforeSpawn.size = () => null;
  vi.mocked(ipc.saveWorkspace).mockClear();
  vi.mocked(ipc.loadWorkspace).mockResolvedValue(null);
  vi.mocked(ipc.createTerminal).mockClear();
});

describe("createTerminal", () => {
  it("adds the terminal, places it in the focused group, and focuses it", async () => {
    const id1 = await useStore.getState().createTerminal("/tmp/a");
    const s1 = useStore.getState();
    expect(s1.order).toEqual([id1]);
    expect(s1.terminals[id1].cwd).toBe("/tmp/a");
    expect(s1.layout?.kind).toBe("group");
    expect(s1.focusedTerminalId).toBe(id1);
    expect(s1.focusedGroupId).toBe((s1.layout as GroupNode).id);
    expect(s1.lastCwd).toBe("/tmp/a");

    const id2 = await useStore.getState().createTerminal("/tmp/b");
    const s2 = useStore.getState();
    expect((s2.layout as GroupNode).tabs).toEqual([id1, id2]);
    expect(s2.focusedTerminalId).toBe(id2);
  });

  it("runs the beforeSpawn hook with the id before spawning", async () => {
    const seen: string[] = [];
    beforeSpawn.hook = async (id) => {
      seen.push(id);
    };
    const id = await useStore.getState().createTerminal("/tmp/a");
    expect(seen).toEqual([id]);
  });

  it("uses beforeSpawn.size for dimensions when creating and restarting", async () => {
    beforeSpawn.size = () => ({ cols: 120, rows: 40 });
    const id = await useStore.getState().createTerminal("/tmp/a");
    const createCalls = vi.mocked(ipc.createTerminal).mock.calls;
    const createCall = createCalls[createCalls.length - 1];
    expect(createCall[2]).toBe(120);
    expect(createCall[3]).toBe(40);

    useStore.getState().markExited(id, 1);
    await useStore.getState().restartTerminal(id);
    const restartCalls = vi.mocked(ipc.restartTerminal).mock.calls;
    const restartCall = restartCalls[restartCalls.length - 1];
    expect(restartCall[1]).toBe(120);
    expect(restartCall[2]).toBe(40);
    const resizeCalls = vi.mocked(ipc.resizeTerminal).mock.calls;
    const resizeCall = resizeCalls[resizeCalls.length - 1];
    expect(resizeCall).toEqual([id, 120, 40]);
  });
});

describe("createTerminal placement", () => {
  it("adds a tab into the named tile", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const g1 = (useStore.getState().layout as GroupNode).id;
    useStore.getState().splitTerminal(b, g1, "right");
    const g2 = findGroupOf(useStore.getState().layout, b)!.id;
    useStore.getState().focusTerminal(a);
    const c = await useStore.getState().createTerminal("/tmp/c", { kind: "tab", groupId: g2 });
    const s = useStore.getState();
    expect(findGroup(s.layout, g2)?.tabs).toEqual([b, c]);
    expect(s.focusedGroupId).toBe(g2);
    expect(s.focusedTerminalId).toBe(c);
  });

  it("opens a new tile beside the named one for a split placement", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const g1 = (useStore.getState().layout as GroupNode).id;
    const b = await useStore.getState().createTerminal("/tmp/a", { kind: "split", groupId: g1, side: "bottom" });
    const s = useStore.getState();
    const root = s.layout as SplitNode;
    expect(root.kind).toBe("split");
    expect(root.dir).toBe("col");
    expect((root.children[0] as GroupNode).tabs).toEqual([a]);
    expect((root.children[1] as GroupNode).tabs).toEqual([b]);
    expect(s.focusedTerminalId).toBe(b);
    expect(s.focusedGroupId).toBe((root.children[1] as GroupNode).id);
  });
});

describe("closeTerminal and markExited", () => {
  it("removes the terminal from state and layout", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    await useStore.getState().closeTerminal(id);
    const s = useStore.getState();
    expect(s.order).toEqual([]);
    expect(s.layout).toBeNull();
    expect(s.focusedTerminalId).toBeNull();
  });

  it("markExited records the exit code", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().markExited(id, 2);
    expect(useStore.getState().terminals[id].exited).toBe(2);
    await useStore.getState().restartTerminal(id);
    expect(useStore.getState().terminals[id].exited).toBeNull();
  });

  it("closing a focused tab keeps focus in the same group", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const c = await useStore.getState().createTerminal("/tmp/c");
    const g1 = findGroupOf(useStore.getState().layout, b)!.id;
    useStore.getState().splitTerminal(a, g1, "right");
    useStore.getState().focusTerminal(b);
    await useStore.getState().closeTerminal(b);
    const s = useStore.getState();
    expect(s.focusedTerminalId).toBe(c);
    expect(s.focusedGroupId).toBe(g1);
  });
});

describe("renameTerminal", () => {
  it("returns null on success and the error message on failure", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    expect(await useStore.getState().renameTerminal(id, "api")).toBeNull();
    expect(useStore.getState().terminals[id].name).toBe("api");
    expect(await useStore.getState().renameTerminal(id, "dupe")).toContain("already exists");
    expect(useStore.getState().terminals[id].name).toBe("api");
  });
});

describe("layout actions", () => {
  it("splitTerminal, moveTerminal and focusTerminal keep focus consistent", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const g1 = (useStore.getState().layout as GroupNode).id;
    useStore.getState().splitTerminal(b, g1, "right");
    let s = useStore.getState();
    expect(s.layout?.kind).toBe("split");
    const g2 = findGroupOf(s.layout, b)!.id;
    expect(s.focusedGroupId).toBe(g2);
    expect(s.focusedTerminalId).toBe(b);

    useStore.getState().focusTerminal(a);
    s = useStore.getState();
    expect(s.focusedGroupId).toBe(g1);
    expect(s.focusedTerminalId).toBe(a);

    useStore.getState().moveTerminal(a, g2);
    s = useStore.getState();
    expect(s.layout?.kind).toBe("group");
    expect(findGroup(s.layout, g2)?.tabs).toEqual([b, a]);
    expect(s.focusedGroupId).toBe(g2);
    expect(s.focusedTerminalId).toBe(a);
  });

  it("resizeSplit updates sizes", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    void a;
    const g1 = (useStore.getState().layout as GroupNode).id;
    useStore.getState().splitTerminal(b, g1, "right");
    const sid = (useStore.getState().layout as SplitNode).id;
    useStore.getState().resizeSplit(sid, [70, 30]);
    expect((useStore.getState().layout as SplitNode).sizes).toEqual([70, 30]);
  });
});

describe("persistence", () => {
  it("saves the workspace, debounced, after a change", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createTerminal("/tmp/a");
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ipc.saveWorkspace).toHaveBeenCalledTimes(1);
      const ws = vi.mocked(ipc.saveWorkspace).mock.calls[0][0] as Workspace;
      expect(ws.terminals.map((t) => t.id)).toEqual([id]);
      expect(ws.terminals[0].ssh).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not save before persistenceReady", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ persistenceReady: false });
      await useStore.getState().createTerminal("/tmp/a");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a save failure as persistError", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.saveWorkspace).mockRejectedValueOnce("disk full");
      await useStore.getState().createTerminal("/tmp/a");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      expect(useStore.getState().persistError).toContain("disk full");
      useStore.getState().dismissPersistError();
      expect(useStore.getState().persistError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadWorkspace", () => {
  const ws: Workspace = {
    version: 1,
    terminals: [
      { id: "t1", name: "one", cwd: "/tmp/one", ssh: null, claude: null, command: null },
      {
        id: "t2",
        name: "two",
        cwd: "/tmp/two",
        ssh: { host: "me@host", cwd: "/remote" },
        claude: { enabled: true, sessionId: "s2", skipPermissions: true, started: true },
        command: null,
      },
    ],
    layout: { kind: "split", id: "s", dir: "row", sizes: [50, 50], children: [
      { kind: "group", id: "g1", tabs: ["t1"], active: "t1" },
      { kind: "group", id: "g2", tabs: ["t2", "ghost"], active: "t2" },
    ] },
  };

  it("restores terminals with saved ids, settings, layout, and pending flags", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce(ws);
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.order).toEqual(["t1", "t2"]);
    expect(vi.mocked(ipc.createTerminal).mock.calls.map((c) => [c[0], c[1], c[4]])).toEqual([
      ["t1", "/tmp/one", "one"],
      ["t2", "/tmp/two", "two"],
    ]);
    expect(s.settings.t2.claude?.sessionId).toBe("s2");
    expect(s.startupPending).toEqual({ t1: false, t2: true });
    expect(s.layout?.kind).toBe("split");
    expect(findGroup(s.layout, "g2")?.tabs).toEqual(["t2"]);
    expect(s.persistenceReady).toBe(true);
    expect(s.focusedTerminalId).toBe("t1");
  });

  it("falls back to the home directory when a saved cwd is rejected", async () => {
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: "t1", name: "gone", cwd: "/no/such", ssh: null, claude: null, command: null }],
      layout: null,
    });
    vi.mocked(ipc.createTerminal).mockImplementationOnce(async () => {
      throw "/no/such is not a directory";
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.terminals.t1.cwd).toBe("/home/me");
    expect(s.startupNotes.t1).toContain("/no/such");
  });

  it("surfaces a load error and still becomes ready", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockRejectedValueOnce("workspace file was invalid and was moved to x");
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().persistError).toContain("moved to x");
    expect(useStore.getState().persistenceReady).toBe(true);
  });

  it("regenerates an unsafe claude session id on restore", async () => {
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [
        {
          id: "t1",
          name: "one",
          cwd: "/tmp/one",
          ssh: null,
          claude: { enabled: true, sessionId: "bad'id", skipPermissions: false, started: true },
          command: null,
        },
      ],
      layout: null,
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.settings.t1.claude?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.settings.t1.claude?.started).toBe(false);
    expect(s.startupPending.t1).toBe(true);
    expect(s.startupNotes.t1).toBe("claude session id in workspace.json was invalid; a new session was created");
  });
});

describe("settings and startup", () => {
  it("updateSettings generates a session id when claude is enabled and marks pending", () => {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: EMPTY_SETTINGS },
      startupPending: { a: false },
    });
    useStore.getState().updateSettings("a", { claude: { enabled: true, sessionId: "", skipPermissions: false, started: false } });
    const s = useStore.getState();
    expect(s.settings.a.claude?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.startupPending.a).toBe(true);
    useStore.getState().updateSettings("a", { claude: null });
    expect(useStore.getState().startupPending.a).toBe(false);
  });

  it("runStartup writes the line, marks claude started, and clears pending", async () => {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: { ssh: null, claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false }, command: null } },
      startupPending: { a: true },
    });
    await useStore.getState().runStartup("a");
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", "claude --session-id sid\r");
    const s = useStore.getState();
    expect(s.settings.a.claude?.started).toBe(true);
    expect(s.startupPending.a).toBe(false);
    useStore.getState().skipStartup("a");
    expect(useStore.getState().startupPending.a).toBe(false);
  });

  it("runStartup does not resurrect settings/pending if the terminal was closed mid-await", async () => {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: { ssh: null, claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false }, command: null } },
      startupPending: { a: true },
    });
    vi.mocked(ipc.writeTerminal).mockImplementationOnce(async () => {
      useStore.setState((s) => {
        const terminals = { ...s.terminals };
        delete terminals.a;
        const settings = { ...s.settings };
        delete settings.a;
        const startupPending = { ...s.startupPending };
        delete startupPending.a;
        return { terminals, order: s.order.filter((id) => id !== "a"), settings, startupPending };
      });
    });
    await useStore.getState().runStartup("a");
    expect(useStore.getState().settings.a).toBeUndefined();
    expect(useStore.getState().startupPending.a).toBeUndefined();
  });

  it("restartTerminal re-marks pending when a startup line exists", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { ssh: { host: "h" } });
    useStore.getState().skipStartup(id);
    useStore.getState().markExited(id, 0);
    await useStore.getState().restartTerminal(id);
    expect(useStore.getState().startupPending[id]).toBe(true);
  });

  it("closeTerminal drops settings and pending entries", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { ssh: { host: "h" } });
    await useStore.getState().closeTerminal(id);
    expect(useStore.getState().settings[id]).toBeUndefined();
    expect(useStore.getState().startupPending[id]).toBeUndefined();
  });
});

describe("reloadWorkspace", () => {
  it("opens defs missing from the app and closes terminals missing from the file", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: "n1", name: "new", cwd: "/tmp/n", ssh: null, claude: null, command: null }],
      layout: null,
    });
    await useStore.getState().reloadWorkspace();
    const s = useStore.getState();
    expect(s.order).toEqual(["n1"]);
    expect(s.terminals[a]).toBeUndefined();
    expect(ipc.closeTerminal).toHaveBeenCalledWith(a);
  });

  it("regenerates an unsafe claude session id for an already-open terminal", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [
        {
          id: a,
          name: "a",
          cwd: "/tmp/a",
          ssh: null,
          claude: { enabled: true, sessionId: "bad'id", skipPermissions: false, started: true },
          command: null,
        },
      ],
      layout: null,
    });
    await useStore.getState().reloadWorkspace();
    const s = useStore.getState();
    expect(s.settings[a].claude?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.settings[a].claude?.started).toBe(false);
    expect(s.startupNotes[a]).toContain("invalid");
  });

  it("keeps the current focus on a no-op reload", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    useStore.getState().focusTerminal(b);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [
        { id: a, name: "a", cwd: "/tmp/a", ssh: null, claude: null, command: null },
        { id: b, name: "b", cwd: "/tmp/b", ssh: null, claude: null, command: null },
      ],
      layout: null,
    });
    await useStore.getState().reloadWorkspace();
    expect(useStore.getState().focusedTerminalId).toBe(b);
  });
});
