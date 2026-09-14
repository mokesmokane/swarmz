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
      createTerminal: vi.fn(async (id: string, cwd: string, _cols?: number, _rows?: number, name?: string) => info(id, cwd, name)),
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
      sshCheck: vi.fn(async () => false),
      sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),
      terminalForegroundBusy: vi.fn(async () => false),
      tailscaleStatus: vi.fn(async () => ({ running: true, message: null, user: "mokes", self: null, peers: [] })),
      tailscaleOpen: vi.fn(async () => {}),
      workspacePull: vi.fn(async () => null),
      workspacePush: vi.fn(async () => {}),
      workspaceStat: vi.fn(async () => null),
    },
  };
});

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc } from "./lib/ipc";
import {
  __resetLoadGuard,
  __resetSyncState,
  __stopAllPolling,
  SAVE_DEBOUNCE_MS,
  SSH_POLL_MS,
  SSH_POLL_TIMEOUT_MS,
  SSH_SETTLE_MS,
  beforeSpawn,
  machineFor,
  terminalColor,
  useStore,
} from "./store";
import { findGroup, findGroupOf, type GroupNode, type Layout, type SplitNode } from "./lib/layout";
import { EMPTY_SETTINGS, needsRemoteFolder, sshLine, shellQuote, toWorkspace, type TerminalDef, type Workspace } from "./lib/workspace";

beforeEach(() => {
  __resetLoadGuard();
  __resetSyncState();
  __stopAllPolling();
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
    sshConnected: {},
    sshConnecting: {},
    machines: {},
    tailscale: null,
    tailscaleError: null,
    selfMachine: null,
    syncMeta: null,
    sync: { enabled: false, lastPullAt: null, lastPushAt: null, peersOk: 0, peersTotal: 0, error: null, adopting: false },
  });
  beforeSpawn.hook = async () => {};
  beforeSpawn.size = () => null;
  vi.mocked(ipc.saveWorkspace).mockClear();
  vi.mocked(ipc.loadWorkspace).mockClear().mockResolvedValue(null);
  vi.mocked(ipc.createTerminal).mockClear();
  vi.mocked(ipc.writeTerminal).mockClear();
  vi.mocked(ipc.sshCheck).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.terminalForegroundBusy).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.workspacePush).mockClear();
  vi.mocked(ipc.workspacePull).mockReset().mockResolvedValue(null);
  vi.mocked(ipc.workspaceStat).mockReset().mockResolvedValue(null);
  vi.mocked(confirm).mockClear();
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
      // t2 is an ssh terminal: its local pty now always opens at home (consistent with
      // createSshTerminal), since the saved local cwd is irrelevant once ssh takes over.
      ["t2", "/home/me", "two"],
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

  it("surfaces a load error and pauses persistence instead of becoming ready", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockRejectedValueOnce("workspace file was invalid and was moved to x");
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().persistError).toContain("moved to x");
    expect(useStore.getState().persistError).toContain("paused");
    expect(useStore.getState().persistenceReady).toBe(false);
  });

  it("pauses persistence when a terminal fails to open, and a subsequent clean reload resumes it", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: "t1", name: "one", cwd: "/tmp/one", ssh: null, claude: null, command: null }],
      layout: null,
    });
    vi.mocked(ipc.createTerminal).mockRejectedValueOnce("permission denied");
    await useStore.getState().loadWorkspace();
    let s = useStore.getState();
    expect(s.persistenceReady).toBe(false);
    expect(s.persistError).toContain("paused");

    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, terminals: [], layout: null });
    await useStore.getState().reloadWorkspace();
    s = useStore.getState();
    expect(s.persistenceReady).toBe(true);
  });

  it("rebuilds an invalid saved layout, reports it, and keeps terminals in one group", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [
        { id: "t1", name: "one", cwd: "/tmp/one", ssh: null, claude: null, command: null },
        { id: "t2", name: "two", cwd: "/tmp/two", ssh: null, claude: null, command: null },
      ],
      layout: {},
    } as unknown as Workspace);
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.layout?.kind).toBe("group");
    expect((s.layout as GroupNode).tabs).toEqual(["t1", "t2"]);
    expect(s.persistError).toContain("layout");
  });

  it("preserves unknown fields on a def through load and save", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: "t1", name: "one", cwd: "/tmp/one", ssh: null, claude: null, command: null, note: "keep" }],
      layout: null,
    } as unknown as Workspace);
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    const ws = toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout, machines: s.machines });
    expect((ws.terminals[0] as unknown as { note: string }).note).toBe("keep");
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

  it("drops an unsafe ssh.cwd on restore and flags it", async () => {
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [
        { id: "t1", name: "one", cwd: "/tmp/one", ssh: { host: "me@box", cwd: "/a\nb" }, claude: null, command: null },
      ],
      layout: null,
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.settings.t1.ssh).toEqual({ host: "me@box", cwd: null });
    expect(s.startupNotes.t1).toContain("unsupported characters");
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

  it("runStartup writes the line, marks claude started, and clears pending and notes", async () => {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: { ssh: null, claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false }, command: null } },
      startupPending: { a: true },
      startupNotes: { a: "some note" },
    });
    await useStore.getState().runStartup("a");
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", "claude --session-id sid\r");
    const s = useStore.getState();
    expect(s.settings.a.claude?.started).toBe(true);
    expect(s.startupPending.a).toBe(false);
    expect(s.startupNotes.a).toBeUndefined();
    useStore.setState({ startupNotes: { a: "another note" } });
    useStore.getState().skipStartup("a");
    expect(useStore.getState().startupNotes.a).toBeUndefined();
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

  it("does not re-arm the startup bar for an already-open terminal whose settings did not change", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(a, { ssh: { host: "h" } });
    useStore.getState().skipStartup(a);
    expect(useStore.getState().startupPending[a]).toBe(false);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id: a, name: "a", cwd: "/tmp/a", ssh: { host: "h" }, claude: null, command: null }],
      layout: null,
    });
    await useStore.getState().reloadWorkspace();
    expect(useStore.getState().startupPending[a]).toBe(false);
  });

  it("gates the debounced save during reload and persists the reconciled state after", async () => {
    vi.useFakeTimers();
    try {
      const a = await useStore.getState().createTerminal("/tmp/a");
      useStore.getState().updateSettings(a, { command: "npm run dev" });
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();

      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1,
        terminals: [{ id: a, name: "a", cwd: "/tmp/a", ssh: null, claude: null, command: "npm run dev" }],
        layout: null,
      });
      const reloadPromise = useStore.getState().reloadWorkspace();
      // The pending save scheduled by updateSettings must be cancelled synchronously.
      expect(useStore.getState().persistenceReady).toBe(false);

      await reloadPromise;
      // No macrotask timer has fired yet (fake time hasn't advanced), so nothing should
      // have saved while the reload was in flight and persistenceReady was false.
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
      expect(useStore.getState().persistenceReady).toBe(true);

      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      expect(ipc.saveWorkspace).toHaveBeenCalledTimes(1);
      const ws = vi.mocked(ipc.saveWorkspace).mock.calls[0][0] as Workspace;
      expect(ws.terminals.map((t) => t.id)).toEqual([a]);
      expect(ws.terminals[0].command).toBe("npm run dev");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes persistence when the user declines to close stale terminals", async () => {
    useStore.setState({ persistenceReady: true });
    const a = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, terminals: [], layout: null });
    await useStore.getState().reloadWorkspace();
    const s = useStore.getState();
    expect(s.terminals[a]).toBeDefined();
    expect(s.order).toEqual([a]);
    expect(s.persistenceReady).toBe(true);
  });
});

describe("createSshTerminal", () => {
  it("opens a home-directory shell named after the host, applies ssh settings, and connects immediately", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "mokes@other-mac.local", cwd: "/remote", claude: null });
    const s = useStore.getState();
    const createCalls = vi.mocked(ipc.createTerminal).mock.calls;
    const createCall = createCalls[createCalls.length - 1];
    expect(createCall[1]).toBe("/home/me");
    expect(createCall[4]).toBe("other-mac");
    expect(s.settings[id].ssh).toEqual({ host: "mokes@other-mac.local", cwd: "/remote" });
    expect(s.settings[id].claude).toBeNull();
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith(id, `${sshLine("mokes@other-mac.local")}\r`);
    expect(s.startupPending[id]).toBe(false);
    expect(s.focusedTerminalId).toBe(id);
  });

  it("enables claude with a fresh session id and marks it started after connecting", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: null, claude: { skipPermissions: true } });
    const c = useStore.getState().settings[id].claude!;
    expect(c.enabled).toBe(true);
    expect(c.skipPermissions).toBe(true);
    expect(c.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.started).toBe(false);
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith(id, `${sshLine("me@box")}\r`);
    expect(useStore.getState().sshConnecting[id]).toBe(true);
    expect(needsRemoteFolder(useStore.getState().settings[id])).toBe(true);
  });

  it("honours a split placement", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const g1 = (useStore.getState().layout as GroupNode).id;
    const b = await useStore.getState().createSshTerminal({ host: "h", cwd: null, claude: null }, { kind: "split", groupId: g1, side: "right" });
    const root = useStore.getState().layout as SplitNode;
    expect(root.kind).toBe("split");
    expect((root.children[0] as GroupNode).tabs).toEqual([a]);
    expect((root.children[1] as GroupNode).tabs).toEqual([b]);
  });
});

describe("ssh two-step startup", () => {
  const sshClaude = (cwd: string | null) => ({
    ssh: { host: "me@box", cwd },
    claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false },
    command: null,
  });

  function seed(cwd: string | null) {
    useStore.setState({
      terminals: { a: { id: "a", name: "a", cwd: "/home/me", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: { a: sshClaude(cwd) },
      startupPending: { a: true },
    });
  }

  it("types ssh, polls, then types the remote step once connected", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `${sshLine("me@box")}\r`);
      expect(useStore.getState().sshConnecting.a).toBe(true);
      expect(useStore.getState().settings.a.claude?.started).toBe(false);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
      expect(ipc.sshCheck).toHaveBeenCalledWith("me@box");
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS + SSH_SETTLE_MS + 10);
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `cd ${shellQuote("/proj")} && claude --session-id sid\r`);
      const s = useStore.getState();
      expect(s.sshConnected.a).toBe(true);
      expect(s.sshConnecting.a).toBeUndefined();
      expect(s.settings.a.claude?.started).toBe(true);
      expect(s.startupPending.a).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the timeout and re-arms the bar with a note", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      await vi.advanceTimersByTimeAsync(SSH_POLL_TIMEOUT_MS + SSH_POLL_MS * 2);
      const s = useStore.getState();
      expect(s.sshConnecting.a).toBeUndefined();
      expect(s.sshConnected.a).toBeUndefined();
      expect(s.startupPending.a).toBe(true);
      expect(s.startupNotes.a).toContain("not detected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when the terminal exits or is cancelled", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      useStore.getState().markExited("a", 255);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
      expect(useStore.getState().sshConnecting.a).toBeUndefined();
      const calls = vi.mocked(ipc.sshCheck).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
      expect(vi.mocked(ipc.sshCheck).mock.calls.length).toBe(calls);

      seed(null);
      await useStore.getState().runStartup("a");
      useStore.getState().cancelConnecting("a");
      expect(useStore.getState().sshConnecting.a).toBeUndefined();
      expect(useStore.getState().startupPending.a).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connected with no folder waits for a folder; chooseRemoteDir types the remote step and records history", async () => {
    vi.useFakeTimers();
    try {
      seed(null);
      await useStore.getState().runStartup("a");
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS + SSH_SETTLE_MS + 10);
      expect(useStore.getState().sshConnected.a).toBe(true);
      expect(vi.mocked(ipc.writeTerminal).mock.calls.length).toBe(1);
      await useStore.getState().chooseRemoteDir("a", "/remote/proj");
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `cd ${shellQuote("/remote/proj")} && claude --session-id sid\r`);
      const s = useStore.getState();
      expect(s.settings.a.ssh?.cwd).toBe("/remote/proj");
      expect(s.settings.a.claude?.started).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("chooseRemoteDir ignores a path containing control characters", async () => {
    seed("/old");
    await useStore.getState().chooseRemoteDir("a", "/a\nb");
    const s = useStore.getState();
    expect(s.settings.a.ssh?.cwd).toBe("/old");
    expect(s.startupNotes.a).toContain("unsupported characters");
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("changing the folder of a started Claude session resets the session", async () => {
    seed("/old");
    useStore.setState((s) => ({
      settings: { a: { ...s.settings.a, claude: { ...s.settings.a.claude!, started: true } } },
      sshConnected: { a: false },
    }));
    await useStore.getState().chooseRemoteDir("a", "/new");
    const c = useStore.getState().settings.a.claude!;
    expect(c.sessionId).not.toBe("sid");
    expect(c.started).toBe(false);
    expect(useStore.getState().startupNotes.a).toContain("folder changed");
    expect(useStore.getState().startupPending.a).toBe(true);

    useStore.getState().updateSettings("a", { ssh: { host: "me@box", cwd: "/newer" } });
    expect(useStore.getState().settings.a.claude?.sessionId).toBe(c.sessionId); // not started: keep id
  });

  it("restart stops an in-flight connection poll", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      await useStore.getState().restartTerminal("a");
      expect(useStore.getState().sshConnecting.a).toBeUndefined();

      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      const before = vi.mocked(ipc.writeTerminal).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 2 + SSH_SETTLE_MS + 10);
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `${sshLine("me@box")}\r`);
      expect(vi.mocked(ipc.writeTerminal).mock.calls.length).toBe(before);
      expect(useStore.getState().sshConnected.a).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second Run while connecting does not retype", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      await useStore.getState().runStartup("a");
      const before = vi.mocked(ipc.writeTerminal).mock.calls.length;
      await useStore.getState().runStartup("a");
      expect(vi.mocked(ipc.writeTerminal).mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("master already up at Run time does not type the remote step without tile liveness", async () => {
    vi.useFakeTimers();
    try {
      seed("/proj");
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
      await useStore.getState().runStartup("a");
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 2);
      const s = useStore.getState();
      expect(vi.mocked(ipc.writeTerminal).mock.calls.map((c) => c[1])).toEqual([`${sshLine("me@box")}\r`]);
      expect(s.sshConnected.a).toBeUndefined();
      expect(s.startupPending.a).toBe(true);
      expect(s.startupNotes.a).toContain("exited before connecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("chooseRemoteDir while the session is gone re-arms instead of typing", async () => {
    seed("/proj");
    useStore.setState({ sshConnected: { a: true }, startupPending: { a: false } });
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    const before = vi.mocked(ipc.writeTerminal).mock.calls.length;
    await useStore.getState().chooseRemoteDir("a", "/new/path");
    expect(vi.mocked(ipc.writeTerminal).mock.calls.length).toBe(before);
    const s = useStore.getState();
    expect(s.sshConnected.a).toBe(false);
    expect(s.startupPending.a).toBe(true);
  });

  it("Run on an already-connected tile skips to the remote step instead of retyping ssh", async () => {
    seed("/proj");
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await useStore.getState().runStartup("a");
    expect(vi.mocked(ipc.writeTerminal).mock.calls.map((c) => c[1])).toEqual([
      `cd ${shellQuote("/proj")} && claude --session-id sid\r`,
    ]);
    const s = useStore.getState();
    expect(s.sshConnected.a).toBe(true);
    expect(s.startupPending.a).toBe(false);
  });
});

describe("machines and tailscale", () => {
  it("refreshTailscale stores the status or the error", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValueOnce({
      running: true, message: null, user: "mokes", self: null,
      peers: [{ name: "martins-mac-mini", hostName: "Mini", ip: "100.1.1.1", os: "macOS", online: true }],
    });
    await useStore.getState().refreshTailscale();
    expect(useStore.getState().tailscale?.peers[0].name).toBe("martins-mac-mini");
    expect(useStore.getState().tailscaleError).toBeNull();
    vi.mocked(ipc.tailscaleStatus).mockRejectedValueOnce("boom");
    await useStore.getState().refreshTailscale();
    expect(useStore.getState().tailscaleError).toContain("boom");
  });

  it("createRemoteTerminal resolves user@name, names the tile after the alias, tags the machine, bumps lastUsed", async () => {
    useStore.setState({
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] },
      machines: { "martins-mac-mini": { alias: "desk mini", color: "#f59e0b", cwd: "/old", lastUsed: "2026-01-01T00:00:00Z" } },
    });
    const id = await useStore.getState().createRemoteTerminal({ machine: "martins-mac-mini", cwd: "/proj", claude: null });
    const s = useStore.getState();
    const calls = vi.mocked(ipc.createTerminal).mock.calls;
    expect(calls[calls.length - 1][4]).toBe("desk mini");
    expect(s.settings[id].ssh).toEqual({ host: "mokes@martins-mac-mini", cwd: "/proj", machine: "martins-mac-mini" });
    expect(s.machines["martins-mac-mini"].lastUsed > "2026-01-01T00:00:00Z").toBe(true);
    expect(s.machines["martins-mac-mini"].cwd).toBe("/proj");
    expect(terminalColor(s, id)).toBe("#f59e0b");
    expect(machineFor(s, id)?.name).toBe("martins-mac-mini");
  });

  it("createRemoteTerminal uses the machine's username and falls back to the remembered folder", async () => {
    useStore.setState({
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] },
      machines: { box: { user: "root", cwd: "/srv", lastUsed: "t" } },
    });
    const id = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    expect(useStore.getState().settings[id].ssh?.host).toBe("root@box");
    expect(useStore.getState().settings[id].ssh?.cwd).toBeNull();
    const id2 = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: undefined as unknown as null, claude: null });
    expect(useStore.getState().settings[id2].ssh?.cwd).toBe("/srv");
  });

  it("updateMachine validates and renames open terminals that carry the old label", async () => {
    useStore.setState({ tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] }, machines: {} });
    const id = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    expect(useStore.getState().terminals[id].name).toBe("box");
    expect(await useStore.getState().updateMachine("box", { alias: 'a"b' })).not.toBeNull();
    expect(await useStore.getState().updateMachine("box", { color: "#000000" })).not.toBeNull();
    expect(await useStore.getState().updateMachine("box", { alias: "home mini", color: "#3b82f6" })).toBeNull();
    expect(useStore.getState().machines.box.alias).toBe("home mini");
    expect(ipc.renameTerminal).toHaveBeenLastCalledWith(id, "home mini");
  });

  it("updateMachine rejects an invalid username", async () => {
    useStore.setState({ tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] }, machines: {} });
    await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    expect(await useStore.getState().updateMachine("box", { user: "a b" })).toContain("username");
    expect(await useStore.getState().updateMachine("box", { user: "me@x" })).toContain("username");
    expect(await useStore.getState().updateMachine("box", { user: "root" })).toBeNull();
    expect(useStore.getState().machines.box.user).toBe("root");
  });

  it("createRemoteTerminal rejects when the resolved host is invalid", async () => {
    useStore.setState({
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] },
      // Bypass updateMachine's own validation to simulate a bad value already on disk.
      machines: { box: { user: "a b", lastUsed: "t" } },
    });
    await expect(useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null })).rejects.toContain(
      "cannot connect",
    );
  });

  it("chooseRemoteDir records the folder on the machine", async () => {
    useStore.setState({ tailscale: { running: true, message: null, user: "mokes", self: null, peers: [] }, machines: {} });
    const id = await useStore.getState().createRemoteTerminal({ machine: "box", cwd: null, claude: null });
    await useStore.getState().chooseRemoteDir(id, "/picked");
    expect(useStore.getState().machines.box.cwd).toBe("/picked");
  });

  it("machines load from and save to the workspace; sshHistory is ignored", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ persistenceReady: false });
      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1, terminals: [], layout: null,
        machines: { box: { alias: "b", lastUsed: "t" } },
        ...({ sshHistory: { "x@y": { cwd: "/q", lastUsed: "t" } } } as object),
      });
      await useStore.getState().loadWorkspace();
      expect(useStore.getState().machines.box.alias).toBe("b");
      await useStore.getState().updateMachine("box", { color: "#22c55e" });
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const ws = calls[calls.length - 1][0] as Workspace;
      expect(ws.machines?.box.color).toBe("#22c55e");
      expect("sshHistory" in ws).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops invalid machine entries on load and notes the count", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [],
      layout: null,
      machines: {
        good: { lastUsed: "t" },
        "bad host!": { lastUsed: "t" },
        other: { lastUsed: "t", cwd: "bad\u0007cwd" },
      },
    } as unknown as Workspace);
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(Object.keys(s.machines)).toEqual(["good"]);
    expect(s.persistError).toContain("2 machine entries");
    expect(s.persistError).toContain("invalid");
  });

  it("caps machines loaded from workspace.json at 50, newest lastUsed first", async () => {
    useStore.setState({ persistenceReady: false });
    const machines: Record<string, { lastUsed: string }> = {};
    for (let i = 0; i < 60; i++) machines[`h${i}`] = { lastUsed: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() };
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [],
      layout: null,
      machines,
    } as unknown as Workspace);
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(Object.keys(s.machines).length).toBe(50);
    expect(s.machines.h59).toBeDefined();
    expect(s.machines.h0).toBeUndefined();
  });
});

describe("shared workspace", () => {
  const online = (name: string) => ({ name, hostName: name, ip: null, os: "macOS", online: true });
  const ts = (peers: string[]) => ({ running: true, message: null, user: "mokes", self: online("here"), peers: peers.map(online) });
  // A peer's file always carries the layout `toWorkspace` wrote, i.e. one that already places
  // every def; using `layout: null` here would make the adopted state differ from the file the
  // moment `reconcileLayout` rebuilt it, and the post-adoption diff would (correctly) save it.
  const group = (ids: string[]) => ({ kind: "group" as const, id: "g-adopted", tabs: ids, active: ids[0] });
  // The per-test `setState` in `beforeEach` replaces `terminals`/`order`/… and so arms the save
  // debounce through the store subscription. Tests that assert exactly which saves happen drop
  // that pre-armed timer first, so the only saves they see are the ones they caused.
  const noPendingSave = () => __resetSyncState();
  // Sync always starts with a pull (App runs one on launch): until one has completed, a machine
  // that has never synced saves locally but holds its file back, so that its first-sync union is
  // not pre-empted by its own push. Tests about pushing therefore start the way the app does.
  // A machine that has never synced, established the way the app does it: load a workspace file
  // with no `sync` block. The never-synced state is latched at load, not re-derived from
  // `syncMeta` (which this machine's own first save would fill in).
  const loadNeverSynced = async (terminals: TerminalDef[], layout: Layout) => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValueOnce(ts(["desk"]));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, layout, terminals });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
  };
  const launchPull = async () => {
    await useStore.getState().pullWorkspace();
    vi.mocked(ipc.workspacePull).mockClear();
    vi.mocked(ipc.workspacePush).mockClear();
  };

  it("refreshTailscale records self and enables sync", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValueOnce(ts(["desk"]));
    await useStore.getState().refreshTailscale();
    expect(useStore.getState().selfMachine).toBe("here");
    expect(useStore.getState().sync.enabled).toBe(true);
  });

  it("new terminals carry origin; saves bump the revision and push to online peers", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), sync: { ...useStore.getState().sync, enabled: true } });
      noPendingSave();
      await launchPull();
      const id = await useStore.getState().createTerminal("/tmp/a");
      expect(useStore.getState().settings[id].origin).toBe("here");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const ws = calls[calls.length - 1][0] as Workspace;
      expect(ws.sync?.revision).toBe(1);
      expect(ws.sync?.updatedBy).toBe("here");
      expect(ws.terminals[0].origin).toBe("here");
      expect(ipc.workspacePush).toHaveBeenCalledWith("mokes@desk", expect.stringContaining('"revision": 1'));
      expect(useStore.getState().syncMeta?.revision).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loadWorkspace opens a foreign local as a remote to its origin and stamps missing origins", async () => {
    useStore.setState({ persistenceReady: false, selfMachine: "here", tailscale: ts(["desk"]), machines: { desk: { user: "root", color: "#ef4444", lastUsed: "t" } } });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null, sync: { revision: 5, updatedAt: "t", updatedBy: "desk" },
      terminals: [
        { id: "f", name: "F", cwd: "/proj", ssh: null, claude: null, command: null, origin: "desk" },
        { id: "l", name: "L", cwd: "/tmp/l", ssh: null, claude: null, command: null },
      ],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    const calls = vi.mocked(ipc.createTerminal).mock.calls;
    expect(calls.find((c) => c[0] === "f")?.[1]).toBe("/home/me");
    expect(s.settings.f.ssh).toEqual({ host: "root@desk", cwd: "/proj", machine: "desk" });
    expect(s.settings.f.foreign).toEqual({ cwd: "/proj" });
    expect(s.startupPending.f).toBe(true);
    expect(s.settings.l.origin).toBe("here");
    expect(s.syncMeta?.revision).toBe(5);
  });

  it("pullWorkspace adopts a newer peer copy without confirming, and skips older or pending", async () => {
    useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), syncMeta: { revision: 2, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
    const a = await useStore.getState().createTerminal("/tmp/a");
    const newer: Workspace = {
      version: 1, layout: group(["n1"]), sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
      terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      machines: { desk: { alias: "Desk", lastUsed: "t" } },
    };
    vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(newer));
    await useStore.getState().pullWorkspace();
    let s = useStore.getState();
    expect(ipc.workspacePull).toHaveBeenCalledWith("mokes@desk");
    expect(ipc.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sync: newer.sync }));
    expect(confirm).not.toHaveBeenCalled();
    expect(s.order).toEqual(["n1"]);
    expect(s.terminals[a]).toBeUndefined();
    expect(s.syncMeta?.revision).toBe(9);
    expect(s.machines.desk.alias).toBe("Desk");
    expect(s.sync.peersOk).toBe(1);
    expect(s.persistError).toBe("1 terminal(s) closed by a workspace update from desk");

    vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify({ ...newer, sync: { revision: 4, updatedAt: "t", updatedBy: "desk" } }));
    await useStore.getState().pullWorkspace();
    expect(useStore.getState().syncMeta?.revision).toBe(9);
  });

  it("pullWorkspace reports unreachable peers without failing", async () => {
    useStore.setState({ selfMachine: "here", tailscale: ts(["desk", "home"]), sync: { ...useStore.getState().sync, enabled: true } });
    vi.mocked(ipc.workspacePull).mockRejectedValueOnce("not reachable: refused").mockResolvedValueOnce(null);
    await useStore.getState().pullWorkspace();
    const s = useStore.getState();
    expect(s.sync.peersTotal).toBe(2);
    expect(s.sync.peersOk).toBe(1);
    expect(s.sync.error).toContain("desk");
  });

  it("checkExternalChange adopts a newer file written by another machine and ignores our own write", async () => {
    useStore.setState({ selfMachine: "here", syncMeta: { revision: 2, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(1000);
    await useStore.getState().checkExternalChange();
    expect(ipc.loadWorkspace).not.toHaveBeenCalled();
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(2000);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, layout: null, terminals: [], sync: { revision: 3, updatedAt: "t3", updatedBy: "desk" } });
    await useStore.getState().checkExternalChange();
    expect(useStore.getState().syncMeta?.revision).toBe(3);
  });

  it("pull flushes a pending local save before adopting", async () => {
    // A machine that has synced before: the flush below is exactly what a never-synced one skips.
    useStore.setState({
      selfMachine: "here", tailscale: ts(["desk"]),
      syncMeta: { revision: 3, updatedAt: "t3", updatedBy: "here" },
      sync: { ...useStore.getState().sync, enabled: true },
    });
    // Arms the debounce (via the store subscription) without letting it fire.
    await useStore.getState().createTerminal("/tmp/a");
    const newer: Workspace = {
      version: 1, layout: group(["n1"]), sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
      terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
    };
    vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(newer));
    await useStore.getState().pullWorkspace();
    const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
    expect(calls.length).toBe(2);
    expect((calls[0][0] as Workspace).sync?.revision).toBe(4);
    expect((calls[0][0] as Workspace).sync?.updatedBy).toBe("here");
    expect((calls[1][0] as Workspace).sync).toEqual(newer.sync);
    expect(useStore.getState().syncMeta?.revision).toBe(9);
  });

  it("adoption does not schedule a resave", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), sync: { ...useStore.getState().sync, enabled: true } });
      const newer: Workspace = {
        version: 1, layout: group(["n1"]), sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
        terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      };
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(newer));
      await useStore.getState().pullWorkspace();
      const savesAfterAdopt = vi.mocked(ipc.saveWorkspace).mock.calls.length;
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
      await vi.runAllTimersAsync();
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBe(savesAfterAdopt);
      const pushedRevisions = vi.mocked(ipc.workspacePush).mock.calls.map((c) => (JSON.parse(c[1]) as Workspace).sync?.revision ?? 0);
      expect(pushedRevisions.every((r) => r <= 9)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("machines from the same file are applied before foreign locals open", async () => {
    useStore.setState({ persistenceReady: false, selfMachine: "here", machines: {} });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null,
      machines: { desk: { user: "root", lastUsed: "t" } },
      terminals: [{ id: "f", name: "F", cwd: "/proj", ssh: null, claude: null, command: null, origin: "desk" }],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.settings.f.ssh?.host).toBe("root@desk");
  });

  it("resolves this machine's identity before opening defs", async () => {
    // selfMachine is null at mount: without a Tailscale refresh first, a def from another Mac
    // would open as a local shell in that Mac's path, and a legacy def would never be stamped.
    useStore.setState({ persistenceReady: false, selfMachine: null, machines: { desk: { user: "root", lastUsed: "t" } } });
    vi.mocked(ipc.tailscaleStatus).mockResolvedValueOnce(ts(["desk"]));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null,
      terminals: [
        { id: "f", name: "F", cwd: "/proj", ssh: null, claude: null, command: null, origin: "desk" },
        { id: "l", name: "L", cwd: "/tmp/l", ssh: null, claude: null, command: null },
      ],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(s.selfMachine).toBe("here");
    expect(s.settings.f.ssh?.machine).toBe("desk");
    expect(vi.mocked(ipc.createTerminal).mock.calls.find((c) => c[0] === "f")?.[1]).toBe("/home/me");
    expect(s.settings.l.origin).toBe("here");
  });

  it("checkExternalChange rewrites our copy when the file on disk is older", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here",
        syncMeta: { revision: 5, updatedAt: "t5", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
      });
      noPendingSave();
      vi.mocked(ipc.workspaceStat).mockResolvedValue(1000);
      await useStore.getState().checkExternalChange();
      vi.mocked(ipc.workspaceStat).mockResolvedValue(2000);
      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1, layout: null, terminals: [], sync: { revision: 1, updatedAt: "t1", updatedBy: "desk" },
      });
      await useStore.getState().checkExternalChange();
      expect(useStore.getState().syncMeta?.revision).toBe(5);
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      expect((calls[calls.length - 1][0] as Workspace).sync?.revision).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pull and an external change racing each other never open a terminal twice", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
      });
      noPendingSave();
      const def = (id: string) => ({ id, name: id, cwd: `/tmp/${id}`, ssh: null, claude: null, command: null, origin: "here" });
      const fromPeer: Workspace = {
        version: 1, layout: group(["n1", "n2"]), sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
        terminals: [def("n1"), def("n2")],
      };
      const onDisk: Workspace = {
        version: 1, layout: group(["n1", "n2", "n3"]), sync: { revision: 10, updatedAt: "t10", updatedBy: "desk" },
        terminals: [def("n1"), def("n2"), def("n3")],
      };
      // Spawning takes long enough that a second adoption starting meanwhile would look at an
      // app with none of the terminals open yet and open them all over again.
      vi.mocked(ipc.createTerminal).mockImplementation(
        (id: string, cwd: string, _cols?: number, _rows?: number, name?: string) =>
          new Promise((r) => setTimeout(() => r({ id, name: name ?? id, cwd, exited: null, error: null }), 10)),
      );
      vi.mocked(ipc.workspaceStat).mockResolvedValue(1000);
      await useStore.getState().checkExternalChange();
      vi.mocked(ipc.workspaceStat).mockResolvedValue(2000);
      vi.mocked(ipc.loadWorkspace).mockImplementation(() => new Promise((r) => setTimeout(() => r(onDisk), 10)));
      vi.mocked(ipc.workspacePull).mockImplementationOnce(() => new Promise((r) => setTimeout(() => r(JSON.stringify(fromPeer)), 5)));
      // A peer's copy and a newer file on disk both arrive while the other is still being read.
      const pull = useStore.getState().pullWorkspace();
      const check = useStore.getState().checkExternalChange();
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([pull, check]);
      const s = useStore.getState();
      expect(new Set(s.order).size).toBe(s.order.length);
      for (const id of ["n1", "n2"]) {
        expect(vi.mocked(ipc.createTerminal).mock.calls.filter((c) => c[0] === id).length).toBe(1);
      }
      expect(s.order).toEqual(["n1", "n2"]);
      expect(s.sync.adopting).toBe(false);
    } finally {
      vi.mocked(ipc.loadWorkspace).mockReset().mockResolvedValue(null);
      vi.mocked(ipc.createTerminal).mockReset();
      vi.useRealTimers();
    }
  });

  it("saves an edit made while an adoption was running", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
        terminals: { n1: { id: "n1", name: "N", cwd: "/tmp/n", exited: null, error: null } },
        order: ["n1"],
        settings: { n1: { ...EMPTY_SETTINGS, origin: "here" } },
        layout: group(["n1"]),
      });
      const newer: Workspace = {
        version: 1, layout: group(["n1"]), sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
        terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      };
      noPendingSave();
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(newer));
      let release: () => void = () => {};
      vi.mocked(ipc.saveWorkspace).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
      const pull = useStore.getState().pullWorkspace();
      await vi.advanceTimersByTimeAsync(1);
      expect(useStore.getState().sync.adopting).toBe(true);
      await useStore.getState().renameTerminal("n1", "Renamed");
      release();
      await pull;
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const saved = calls[calls.length - 1][0] as Workspace;
      expect(saved.terminals[0].name).toBe("Renamed");
      expect(saved.sync?.revision).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes only to online macOS peers", async () => {
    vi.useFakeTimers();
    try {
      const linux = { name: "box", hostName: "box", ip: null, os: "linux", online: true };
      const offline = { name: "away", hostName: "away", ip: null, os: "macOS", online: false };
      useStore.setState({
        selfMachine: "here",
        tailscale: { running: true, message: null, user: "mokes", self: online("here"), peers: [online("desk"), linux, offline] },
        sync: { ...useStore.getState().sync, enabled: true },
      });
      await launchPull();
      await useStore.getState().createTerminal("/tmp/a");
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      expect(vi.mocked(ipc.workspacePush).mock.calls.map((c) => c[0])).toEqual(["mokes@desk"]);
      expect(useStore.getState().sync.peersTotal).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a local from an unknown machine here, with a note", async () => {
    useStore.setState({ persistenceReady: false, selfMachine: "here", tailscale: ts(["desk"]) });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null,
      terminals: [{ id: "g", name: "G", cwd: "/proj", ssh: null, claude: null, command: null, origin: "gone" }],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(vi.mocked(ipc.createTerminal).mock.calls.find((c) => c[0] === "g")?.[1]).toBe("/proj");
    expect(s.settings.g.ssh).toBeNull();
    expect(s.settings.g.foreign).toBeUndefined();
    expect(s.startupNotes.g).toBe("origin machine gone is not on your tailnet; opened locally");
  });

  it("skips a malformed peer copy and names the peer", async () => {
    useStore.setState({
      selfMachine: "here", tailscale: ts(["desk"]),
      syncMeta: { revision: 2, updatedAt: "t2", updatedBy: "here" },
      sync: { ...useStore.getState().sync, enabled: true },
    });
    noPendingSave();
    vi.mocked(ipc.workspacePull).mockResolvedValueOnce('{"sync":{}}');
    await useStore.getState().pullWorkspace();
    const s = useStore.getState();
    expect(ipc.saveWorkspace).not.toHaveBeenCalled();
    expect(s.syncMeta?.revision).toBe(2);
    expect(s.sync.peersOk).toBe(1);
    expect(s.sync.error).toContain("desk");
    expect(s.sync.error).toContain("malformed");
  });

  it("reports an adoption that fails, stops adopting and writes nothing", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
      });
      const newer: Workspace = {
        version: 1, layout: group(["n1"]), sync: { revision: 9, updatedAt: "t9", updatedBy: "desk" },
        terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      };
      noPendingSave();
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(newer));
      vi.mocked(ipc.saveWorkspace).mockRejectedValueOnce("disk full");
      await useStore.getState().pullWorkspace();
      const s = useStore.getState();
      expect(s.sync.adopting).toBe(false);
      expect(s.sync.error).toContain("disk full");
      expect(s.syncMeta?.revision).toBe(1);
      expect(s.order).toEqual([]);
      // The adoption never reconciled anything, so there is no drift worth writing back.
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a machine that has never synced pushes nothing until its first pull, however many saves it makes", async () => {
    vi.useFakeTimers();
    try {
      await loadNeverSynced([{ id: "mine", name: "mine", cwd: "/tmp/mine", ssh: null, claude: null, command: null }], group(["mine"]));
      // Two local saves in the pre-first-pull window: the first writes a `sync` block, which must
      // not be mistaken for "this machine has synced" by the second.
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      await useStore.getState().createTerminal("/tmp/other");
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(useStore.getState().syncMeta?.revision).toBeGreaterThanOrEqual(2);
      expect(ipc.workspacePush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a machine that has never synced unions its terminals on the first pull, even after a local save", async () => {
    vi.useFakeTimers();
    try {
      await loadNeverSynced([{ id: "mine", name: "mine", cwd: "/tmp/mine", ssh: null, claude: null, command: null }], group(["mine"]));
      // The launch debounce fires BEFORE the pull: it writes a `sync` block locally, which must
      // not turn this into "a machine with an older copy" (whose terminals adoption would close).
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      expect(useStore.getState().syncMeta?.revision).toBe(1);
      const peer: Workspace = {
        version: 1, layout: group(["n1"]), sync: { revision: 4, updatedAt: "t4", updatedBy: "desk" },
        terminals: [{ id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "desk" }],
      };
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(peer));
      await useStore.getState().pullWorkspace();
      const s = useStore.getState();
      expect(ipc.workspacePush).not.toHaveBeenCalled();
      expect(s.order).toEqual(["n1", "mine"]);
      expect(s.terminals.mine).toBeDefined();
      expect(s.syncMeta?.revision).toBe(4);
      // The union is bumped and pushed back, so the peer converges on it too.
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      const saved = calls[calls.length - 1][0] as Workspace;
      expect(saved.terminals.map((t) => t.id)).toEqual(["n1", "mine"]);
      expect(saved.sync?.revision).toBe(5);
      expect(vi.mocked(ipc.workspacePush).mock.calls.some((c) => (JSON.parse(c[1]) as Workspace).sync?.revision === 5)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adoption takes the file's terminal order, so two machines stop rewriting each other", async () => {
    vi.useFakeTimers();
    try {
      // This machine holds [mine]; the peer's copy lists [n1, mine]. Opening the missing def
      // appends it, so without taking the file's order this machine would end up [mine, n1],
      // write that back, and the peer would write [n1, mine] back at it, once per poll, forever.
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
        terminals: { mine: { id: "mine", name: "M", cwd: "/tmp/mine", exited: null, error: null } },
        order: ["mine"],
        settings: { mine: { ...EMPTY_SETTINGS, origin: "here" } },
        layout: group(["mine"]),
      });
      noPendingSave();
      const peer: Workspace = {
        version: 1, layout: group(["n1", "mine"]), sync: { revision: 4, updatedAt: "t4", updatedBy: "desk" },
        terminals: [
          { id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" },
          { id: "mine", name: "M", cwd: "/tmp/mine", ssh: null, claude: null, command: null, origin: "here" },
        ],
      };
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(peer));
      await useStore.getState().pullWorkspace();
      expect(useStore.getState().order).toEqual(["n1", "mine"]);
      const afterAdopt = vi.mocked(ipc.saveWorkspace).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBe(afterAdopt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a name the registry had to change is machine-local, and never counts as sync drift", async () => {
    vi.useFakeTimers();
    try {
      // The cross-machine case: the file legitimately holds two defs called "swarmz" (one is
      // this machine's, one the peer's). Opening the peer's next to ours forces a suffix here —
      // and would force one there too, so if each machine wrote its own spelling back they would
      // rewrite each other forever.
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
        terminals: { local: { id: "local", name: "swarmz", cwd: "/tmp/x", exited: null, error: null } },
        order: ["local"],
        settings: { local: { ...EMPTY_SETTINGS, origin: "here" } },
        layout: group(["local"]),
      });
      noPendingSave();
      vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string, _c?: number, _r?: number, name?: string) => {
        const taken = new Set(Object.values(useStore.getState().terminals).map((t) => t.name));
        const wanted = name ?? cwd.split("/").pop() ?? "shell";
        return { id, name: taken.has(wanted) ? `${wanted}-2` : wanted, cwd, exited: null, error: null };
      });
      const peer: Workspace = {
        version: 1, layout: group(["local", "n1"]), sync: { revision: 4, updatedAt: "t4", updatedBy: "desk" },
        terminals: [
          { id: "local", name: "swarmz", cwd: "/tmp/x", ssh: null, claude: null, command: null, origin: "here" },
          { id: "n1", name: "swarmz", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "desk" },
        ],
      };
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(peer));
      await useStore.getState().pullWorkspace();
      expect(useStore.getState().terminals.n1.name).toBe("swarmz-2");
      const afterAdopt = vi.mocked(ipc.saveWorkspace).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBe(afterAdopt);
      // A later save still writes the name the file asked for, not this machine's suffix.
      useStore.getState().updateSettings("n1", { command: "ls" });
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      let calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      expect((calls[calls.length - 1][0] as Workspace).terminals.find((t) => t.id === "n1")?.name).toBe("swarmz");
      // A rename by the user is a real change and replaces it.
      await useStore.getState().renameTerminal("n1", "other");
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      expect((calls[calls.length - 1][0] as Workspace).terminals.find((t) => t.id === "n1")?.name).toBe("other");
    } finally {
      vi.mocked(ipc.createTerminal).mockReset();
      vi.useRealTimers();
    }
  });

  it("opens a peer file that lists the same id twice only once", async () => {
    useStore.setState({
      selfMachine: "here", tailscale: ts(["desk"]),
      syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
      sync: { ...useStore.getState().sync, enabled: true },
    });
    noPendingSave();
    const def = { id: "n1", name: "N", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" };
    const peer: Workspace = {
      version: 1, layout: group(["n1"]), sync: { revision: 4, updatedAt: "t4", updatedBy: "desk" },
      terminals: [def, { ...def, name: "N again" }],
    };
    vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(peer));
    await useStore.getState().pullWorkspace();
    expect(useStore.getState().order).toEqual(["n1"]);
    expect(vi.mocked(ipc.createTerminal).mock.calls.filter((c) => c[0] === "n1").length).toBe(1);
    expect(useStore.getState().terminals.n1.name).toBe("N");
  });

  it("does not rewrite an older file while saving is paused", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here",
        persistenceReady: false,
        syncMeta: { revision: 5, updatedAt: "t5", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
      });
      noPendingSave();
      vi.mocked(ipc.workspaceStat).mockResolvedValue(1000);
      await useStore.getState().checkExternalChange();
      vi.mocked(ipc.workspaceStat).mockResolvedValue(2000);
      vi.mocked(ipc.loadWorkspace).mockResolvedValue({
        version: 1, layout: null, terminals: [], sync: { revision: 1, updatedAt: "t1", updatedBy: "desk" },
      });
      await useStore.getState().checkExternalChange();
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      expect(ipc.saveWorkspace).not.toHaveBeenCalled();
      // The baseline was not consumed either, so a later round (once a Reload has made saving
      // possible again) still sees the file as changed.
      useStore.setState({ persistenceReady: true });
      await useStore.getState().checkExternalChange();
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      expect((calls[calls.length - 1][0] as Workspace).sync?.revision).toBe(6);
    } finally {
      vi.mocked(ipc.loadWorkspace).mockReset().mockResolvedValue(null);
      vi.useRealTimers();
    }
  });
});
