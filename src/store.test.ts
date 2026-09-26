import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      conductorAction: vi.fn(async () => ({ conductor: null, claim: null })),
      workspaceRoles: vi.fn(async () => null),
      conductorDir: vi.fn(async () => "/home/me/.swarmz/conductor"),
      telegramFollow: vi.fn(async (on: boolean) => on),
      restartTerminal: vi.fn(async (id: string) => info(id, "/tmp/x")),
      onData: vi.fn(async () => () => {}),
      onReplay: vi.fn(async () => () => {}),
      onExit: vi.fn(async () => () => {}),
      loadWorkspace: vi.fn(async () => null),
      saveWorkspace: vi.fn(async () => {}),
      sshCheck: vi.fn(async () => false),
      sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),
      terminalForegroundBusy: vi.fn(async () => false),
      terminalCwd: vi.fn(async () => null),
      setTerminalCwd: vi.fn(async (id: string, cwd: string) => ({ id, name: "x", cwd, exited: null, error: null })),
      tailscaleStatus: vi.fn(async () => ({ running: true, message: null, user: "mokes", self: null, peers: [] })),
      tailscaleOpen: vi.fn(async () => {}),
      workspacePull: vi.fn(async () => null),
      workspacePush: vi.fn(async () => {}),
      workspaceStat: vi.fn(async () => null),
      agentsInstallLocal: vi.fn(async () => false),
      agentsInstallRemote: vi.fn(async () => false),
      toolRemoteReady: vi.fn(async () => false),
      remoteTileInfo: vi.fn(async () => ({ running: false })),
      remoteTileClose: vi.fn(async () => false),
      localSessions: vi.fn(async () => []),
      closeSession: vi.fn(async () => true),
      phones: vi.fn(async () => []),
      revokePhone: vi.fn(async () => ({ removed: 1, machines: [] })),
      pasteImageToRemote: vi.fn(async () => null),
      agentsWatch: vi.fn(async () => 1),
      agentsUnwatch: vi.fn(async () => {}),
      onAgentEvent: vi.fn(async () => () => {}),
      onAgentWatchEnded: vi.fn(async () => () => {}),
    },
  };
});

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc } from "./lib/ipc";
import {
  __resetAgentWatchers,
  __resetAttachState,
  __resetLoadGuard,
  __resetSyncState,
  __setLaunchedAt,
  __stopAllPolling,
  AGENT_WATCH_BACKOFF_MS,
  AGENT_WATCH_UNAVAILABLE_AFTER,
  RESUME_WATCH_MS,
  SAVE_DEBOUNCE_MS,
  SSH_POLL_MS,
  SSH_POLL_TIMEOUT_MS,
  SSH_SETTLE_MS,
  SSH_WATCHDOG_MS,
  beforeSpawn,
  machineFor,
  terminalColor,
  useStore, windowHooks, telegramFollowWanted } from "./store";
import { allGroups, findGroup, findGroupOf, type GroupNode, type Layout, type SplitNode } from "./lib/layout";
import { EMPTY_SETTINGS, needsRemoteFolder, sshLine, sshMasterLine, shellQuote, toWorkspace, type TerminalDef, type Workspace } from "./lib/workspace";

const omitKey = <T,>(o: Record<string, T>, k: string): Record<string, T> => {
  const { [k]: _drop, ...rest } = o;
  void _drop;
  return rest;
};

beforeEach(async () => {
  __resetLoadGuard();
  __resetSyncState();
  __resetAgentWatchers();
  __stopAllPolling();
  __resetAttachState();
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
    sshDropped: {},
    toolReady: {},
    machines: {},
    conductor: null,
    conductorClaim: null,
    conductors: {},
    conductorAt: null,
    workspaceExtra: {},
    tailscale: null,
    tailscaleError: null,
    selfMachine: null,
    syncMeta: null,
    sync: { enabled: false, lastPullAt: null, lastPushAt: null, peersOk: 0, peersTotal: 0, error: null, adopting: false },
    agentState: {},
    agentHooksError: null,
    windowFocused: true,
    resumeWatch: {},
    windowLabel: "main",
    windows: {},
    zoomed: {},
    fileLayout: null,
    selectedTiles: [],
    closedNotice: null,
    focusedWindow: "main",
  });
  beforeSpawn.hook = async () => {};
  beforeSpawn.size = () => null;
  beforeSpawn.claimSize = () => {};
  beforeSpawn.resetModes = () => {};
  vi.mocked(ipc.saveWorkspace).mockClear();
  vi.mocked(ipc.loadWorkspace).mockClear().mockResolvedValue(null);
  vi.mocked(ipc.createTerminal)
    .mockReset()
    .mockImplementation(async (id: string, cwd: string, _cols?: number, _rows?: number, name?: string) => ({
      id,
      name: name ?? cwd.split("/").pop() ?? "shell",
      cwd,
      exited: null,
      error: null,
    }));
  vi.mocked(ipc.writeTerminal).mockClear();
  vi.mocked(ipc.sshCheck).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.terminalForegroundBusy).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.workspacePush).mockClear();
  vi.mocked(ipc.workspacePull).mockReset().mockResolvedValue(null);
  vi.mocked(ipc.workspaceStat).mockReset().mockResolvedValue(null);
  vi.mocked(confirm).mockClear();
  vi.mocked(ipc.agentsInstallLocal).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.agentsInstallRemote).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.agentsWatch).mockReset().mockResolvedValue(1);
  vi.mocked(ipc.toolRemoteReady).mockReset().mockResolvedValue(false);
  vi.mocked(ipc.remoteTileInfo).mockReset().mockResolvedValue({ running: false });
  __setLaunchedAt("2026-09-15T09:00:00Z");
  // Resetting the store above replaces `order`, which fires the store's watcher subscription:
  // let that call finish, then drop what it did so every test starts with no watcher at all.
  await new Promise((r) => setTimeout(r, 0));
  __resetAgentWatchers();
  vi.mocked(ipc.agentsWatch).mockClear();
  vi.mocked(ipc.agentsUnwatch).mockClear();
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
      // The save reads the roles on disk first (tree spec §7), one async step.
      await vi.advanceTimersByTimeAsync(0);
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

  it("loads the conductor and a claim, saves them, and clears the role when its tile closes", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ persistenceReady: false });
      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1,
        terminals: [
          { id: "c", name: "cond", cwd: "/tmp/c", ssh: null, claude: null, command: null },
          { id: "o", name: "other", cwd: "/tmp/o", ssh: null, claude: null, command: null },
        ],
        layout: null,
        conductor: "c",
        conductorClaim: { tile: "o", title: "Other", at: "2026-09-23T10:00:00Z" },
      });
      await useStore.getState().loadWorkspace();
      expect(useStore.getState().conductor).toBe("c");
      expect(useStore.getState().conductorClaim).toEqual({ tile: "o", title: "Other", at: "2026-09-23T10:00:00Z" });
      vi.mocked(ipc.saveWorkspace).mockClear();
      // A rename saves; the file carries both fields.
      await useStore.getState().renameTerminal("o", "other2");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      const saves = vi.mocked(ipc.saveWorkspace).mock.calls;
      const saved = saves[saves.length - 1][0] as Workspace;
      expect(saved.conductor).toBe("c");
      expect(saved.conductorClaim?.tile).toBe("o");
      // Closing the conductor's tile leaves nobody in the role, and the save says so.
      vi.mocked(ipc.saveWorkspace).mockClear();
      await useStore.getState().closeTerminal("c");
      expect(useStore.getState().conductor).toBeNull();
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      const later = vi.mocked(ipc.saveWorkspace).mock.calls;
      const after = later[later.length - 1][0] as Workspace;
      expect(after.conductor).toBeUndefined();
      expect(after.conductorClaim?.tile).toBe("o");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps sub-conductors and unknown top-level fields through load and save, and drops a closed sub-conductor", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ persistenceReady: false });
      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1,
        terminals: [
          { id: "c", name: "cond", cwd: "/tmp/c", ssh: null, claude: null, command: null },
          { id: "s", name: "sub", cwd: "/tmp/s", ssh: null, claude: null, command: null },
        ],
        layout: null,
        conductor: "c",
        conductors: { s: { parent: "c", tiles: [] } },
        someFutureField: { keep: true },
      } as unknown as Workspace);
      await useStore.getState().loadWorkspace();
      expect(useStore.getState().conductors).toEqual({ s: { parent: "c", tiles: [] } });
      vi.mocked(ipc.saveWorkspace).mockClear();
      await useStore.getState().renameTerminal("c", "cond2");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      const saves = vi.mocked(ipc.saveWorkspace).mock.calls;
      const saved = saves[saves.length - 1][0] as Workspace & { someFutureField?: unknown };
      expect(saved.conductors).toEqual({ s: { parent: "c", tiles: [] } });
      expect(saved.someFutureField).toEqual({ keep: true });
      await useStore.getState().closeTerminal("s");
      expect(useStore.getState().conductors).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes newer roles from disk before saving, so a save never writes older roles over them", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ conductor: "old", conductorAt: "2026-09-24T09:00:00.000Z" });
      await useStore.getState().createTerminal("/tmp/a");
      vi.mocked(ipc.workspaceRoles).mockResolvedValueOnce({ conductor: "tool-wrote-this", conductorClaim: null, conductors: {}, conductorAt: "2026-09-24T10:00:00.000Z" });
      vi.mocked(ipc.saveWorkspace).mockClear();
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      const saves = vi.mocked(ipc.saveWorkspace).mock.calls;
      expect(saves.length).toBe(1);
      expect((saves[0][0] as Workspace).conductor).toBe("tool-wrote-this");
      expect(useStore.getState().conductor).toBe("tool-wrote-this");
      // Older roles on disk are left there.
      vi.mocked(ipc.workspaceRoles).mockResolvedValueOnce({ conductor: "stale", conductorAt: "2026-09-24T08:00:00.000Z" });
      await useStore.getState().renameTerminal(useStore.getState().order[0], "renamed");
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      expect(useStore.getState().conductor).toBe("tool-wrote-this");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a role change survives a disk file a peer overwrote with older roles", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState({ conductor: "old", conductorAt: "2026-09-24T09:00:00.000Z", syncMeta: { revision: 5, updatedAt: "t", updatedBy: "here" } });
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: id, conductors: {}, claim: null, conductorAt: "2026-09-24T10:00:00.000Z" });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: useStore.getState().layout, conductor: "old", conductorAt: "2026-09-24T09:00:00.000Z",
      terminals: [{ id, name: useStore.getState().terminals[id].name, cwd: "/tmp/a", ssh: null, claude: null, command: null }],
      sync: { revision: 9, updatedAt: "2026-09-24T10:00:03.000Z", updatedBy: "peer" },
    } as Workspace);
    await useStore.getState().setConductor(id);
    expect(useStore.getState().syncMeta?.revision).toBe(9);
    expect(useStore.getState().conductor).toBe(id);
    expect(useStore.getState().conductorAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("setConductor and decideClaim go through the tool, then adopt the file it wrote", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    // The tool wrote a newer file: it is adopted, so the store's fields come from it.
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      terminals: [{ id, name: useStore.getState().terminals[id].name, cwd: "/tmp/a", ssh: null, claude: null, command: null }],
      layout: useStore.getState().layout,
      conductor: id,
      sync: { revision: 99, updatedAt: "t", updatedBy: "tool" },
    });
    await useStore.getState().setConductor(id);
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("set", id);
    expect(useStore.getState().conductor).toBe(id);
    expect(useStore.getState().syncMeta?.revision).toBe(99);
    // Written by "tool" on another name: not ours to announce (the test's file is a stand-in).
    expect(ipc.workspacePush).not.toHaveBeenCalled();
    // No readable file: the tool's reply stands in.
    vi.mocked(ipc.loadWorkspace).mockRejectedValueOnce("gone");
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: null, claim: null });
    await useStore.getState().setConductor(null);
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("clear", undefined);
    expect(useStore.getState().conductor).toBeNull();
    await expect(useStore.getState().setConductor("nope")).rejects.toMatch(/not an open tile/);
    // A claim: Deny tells the tool; with none there is nothing to do.
    useStore.setState({ conductorClaim: { tile: id, title: "A", at: "t" } });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce(null);
    await useStore.getState().decideClaim(false);
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("deny", undefined);
    expect(useStore.getState().conductorClaim).toBeNull();
    vi.mocked(ipc.conductorAction).mockClear();
    await useStore.getState().decideClaim(true);
    expect(ipc.conductorAction).not.toHaveBeenCalled();
  });

  it("runs the Telegram follower only while the conductor is a running local tile here and Telegram is set up", async () => {
    vi.mocked(ipc.loadWorkspace).mockResolvedValue(null);
    vi.mocked(ipc.conductorAction).mockImplementation(async (action, id) => ({ conductor: action === "set" ? (id ?? null) : null, claim: null }));
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true } });
    expect(telegramFollowWanted(useStore.getState())).toBe(false);
    await useStore.getState().setConductor(id);
    expect(ipc.telegramFollow).not.toHaveBeenCalled();
    useStore.getState().setTelegramConfigured(true);
    expect(telegramFollowWanted(useStore.getState())).toBe(true);
    expect(ipc.telegramFollow).toHaveBeenLastCalledWith(true);
    // The tile exits: the follower stops; a restart brings it back.
    useStore.getState().markExited(id, 0);
    expect(ipc.telegramFollow).toHaveBeenLastCalledWith(false);
    // An ssh conductor is another Mac's to follow.
    useStore.setState({ terminals: { ...useStore.getState().terminals, [id]: { ...useStore.getState().terminals[id], exited: null } } });
    expect(ipc.telegramFollow).toHaveBeenLastCalledWith(true);
    useStore.getState().updateSettings(id, { ssh: { host: "me@box", cwd: null, machine: "box" } });
    expect(telegramFollowWanted(useStore.getState())).toBe(false);
    expect(ipc.telegramFollow).toHaveBeenLastCalledWith(false);
    // No conductor at all: nothing to follow for.
    useStore.getState().updateSettings(id, { ssh: null });
    expect(ipc.telegramFollow).toHaveBeenLastCalledWith(true);
    await useStore.getState().setConductor(null);
    expect(ipc.telegramFollow).toHaveBeenLastCalledWith(false);
  });

  it("createConductorTerminal opens a local Claude tile, starts it and makes it the conductor", async () => {
    vi.mocked(ipc.loadWorkspace).mockResolvedValue(null);
    vi.mocked(ipc.conductorAction).mockImplementation(async (action, id) => ({ conductor: action === "set" ? (id ?? null) : null, claim: null }));
    const id = await useStore.getState().createConductorTerminal("/home/me/.swarmz/conductor");
    const s = useStore.getState();
    expect(s.settings[id].claude?.enabled).toBe(true);
    expect(s.settings[id].claude?.skipPermissions).toBe(false);
    expect(s.conductor).toBe(id);
    expect(ipc.conductorAction).toHaveBeenCalledWith("set", id);
    // Claude was started in the fresh shell.
    const typed = vi.mocked(ipc.writeTerminal).mock.calls.filter((c) => c[0] === id).map((c) => c[1]).join("");
    expect(typed).toContain("claude");
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

  it("runStartup writes the line, does not mark claude started, and clears pending and notes", async () => {
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
    expect(s.settings.a.claude?.started).toBe(false);
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

  it("does not re-arm the startup bar when only the tile's session history is in the file", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent({
      host: null,
      event: { ts: "2026-09-15T10:00:00Z", terminal: a, event: "SessionStart", sessionId: "s1", notificationType: null, source: null, cwd: "/tmp/a", permissionMode: null },
    });
    expect(useStore.getState().settings[a].sessions).toHaveLength(1);
    useStore.getState().skipStartup(a);
    expect(useStore.getState().startupPending[a]).toBe(false);
    const s = useStore.getState();
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce(
      toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout, machines: s.machines }),
    );
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
    // No master yet and the host's tool is unknown: log in first.
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith(id, `${sshMasterLine("mokes@other-mac.local")}\r`);
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
    expect(ipc.writeTerminal).toHaveBeenLastCalledWith(id, `${sshMasterLine("me@box")}\r`);
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
      // The host's tool was asked already (no swarmz there): plain ssh, no login step.
      toolReady: { "me@box": false },
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
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `export SWARMZ_TERMINAL_ID=a && cd ${shellQuote("/proj")} && claude --session-id sid\r`);
      const s = useStore.getState();
      expect(s.sshConnected.a).toBe(true);
      expect(s.sshConnecting.a).toBeUndefined();
      expect(s.settings.a.claude?.started).toBe(false);
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
      // Connected but no folder yet: the tile id is exported at once so a hand-started Claude
      // reports; the cd + claude line waits for the folder.
      expect(vi.mocked(ipc.writeTerminal).mock.calls.length).toBe(2);
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", "export SWARMZ_TERMINAL_ID=a\r");
      await useStore.getState().chooseRemoteDir("a", "/remote/proj");
      expect(ipc.writeTerminal).toHaveBeenLastCalledWith("a", `export SWARMZ_TERMINAL_ID=a && cd ${shellQuote("/remote/proj")} && claude --session-id sid\r`);
      const s = useStore.getState();
      expect(s.settings.a.ssh?.cwd).toBe("/remote/proj");
      expect(s.settings.a.claude?.started).toBe(false);
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
      `export SWARMZ_TERMINAL_ID=a && cd ${shellQuote("/proj")} && claude --session-id sid\r`,
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
      await vi.advanceTimersByTimeAsync(0);
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

  it("loadWorkspace opens a remote that targets this machine as a local and saves it as one", async () => {
    useStore.setState({ persistenceReady: false, selfMachine: "here", tailscale: ts(["desk"]), machines: { here: { lastUsed: "t" } } });
    const claude = { enabled: true, sessionId: "abc", skipPermissions: true, started: true };
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null, sync: { revision: 5, updatedAt: "t", updatedBy: "desk" },
      terminals: [{ id: "r", name: "here", cwd: "/home/desk", ssh: { host: "mokes@here", cwd: "/proj", machine: "here" }, claude, command: null, origin: "desk" }],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(vi.mocked(ipc.createTerminal).mock.calls.find((c) => c[0] === "r")?.[1]).toBe("/proj");
    expect(s.settings.r.ssh).toBeNull();
    expect(s.settings.r.origin).toBe("here");
    expect(s.settings.r.claude).toEqual(claude);
    expect(s.startupPending.r).toBe(true);
    const saved = toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout, machines: s.machines });
    expect(saved.terminals[0]).toMatchObject({ id: "r", cwd: "/proj", ssh: null, origin: "here", claude });
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

  it("keeps newer roles when adopting a file with older ones, and saves them back out", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), syncMeta: { revision: 10, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
      noPendingSave();
      await launchPull();
      useStore.setState({ conductor: "new-top", conductors: { s: { parent: "new-top", tiles: [] } }, conductorAt: "2026-09-24T10:00:05.000Z" });
      await vi.runAllTimersAsync();
      vi.mocked(ipc.saveWorkspace).mockClear();
      // A peer saved from an older copy: a higher revision, but roles stamped before ours.
      vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(1000);
      await useStore.getState().checkExternalChange();
      vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(2000);
      vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
        version: 1, layout: null, terminals: [], conductor: "old-top", conductorAt: "2026-09-24T10:00:00.000Z",
        sync: { revision: 20, updatedAt: "2026-09-24T10:00:09.000Z", updatedBy: "desk" },
      } as Workspace);
      await useStore.getState().checkExternalChange();
      expect(useStore.getState().syncMeta?.revision).toBe(20);
      expect(useStore.getState().conductor).toBe("new-top");
      expect(useStore.getState().conductors).toEqual({ s: { parent: "new-top", tiles: [] } });
      await vi.runAllTimersAsync();
      const saves = vi.mocked(ipc.saveWorkspace).mock.calls.map((c) => c[0] as Workspace);
      const last = saves[saves.length - 1];
      expect((last.sync?.revision ?? 0) > 20).toBe(true);
      expect(last.conductorAt).toBe("2026-09-24T10:00:05.000Z");
      expect(last.conductor).toBe("new-top");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkExternalChange adopts a newer file written by another machine and ignores our own write", async () => {
    useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), syncMeta: { revision: 2, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
    noPendingSave();
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(1000);
    await useStore.getState().checkExternalChange();
    expect(ipc.loadWorkspace).not.toHaveBeenCalled();
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(2000);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, layout: null, terminals: [], sync: { revision: 3, updatedAt: "t3", updatedBy: "desk" } });
    await useStore.getState().checkExternalChange();
    expect(useStore.getState().syncMeta?.revision).toBe(3);
    // A peer's copy is not pushed back at the peers.
    expect(ipc.workspacePush).not.toHaveBeenCalled();
  });

  it("checkExternalChange announces a file the tool wrote here to the peers at once", async () => {
    useStore.setState({ selfMachine: "here", tailscale: ts(["desk"]), syncMeta: { revision: 2, updatedAt: "t", updatedBy: "here" }, sync: { ...useStore.getState().sync, enabled: true } });
    noPendingSave();
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(1000);
    await useStore.getState().checkExternalChange();
    // `swarmz conductor --claim` wrote revision 3 as this machine: adopted, and pushed so a
    // peer's next save starts from it rather than overwriting it.
    vi.mocked(ipc.workspaceStat).mockResolvedValueOnce(2000);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: null, terminals: [], conductorClaim: { tile: "t", title: "T", at: "t3" },
      sync: { revision: 3, updatedAt: "t3", updatedBy: "here" },
    });
    await useStore.getState().checkExternalChange();
    expect(useStore.getState().conductorClaim?.tile).toBe("t");
    expect(ipc.workspacePush).toHaveBeenCalledTimes(1);
    expect(ipc.workspacePush).toHaveBeenCalledWith("mokes@desk", expect.stringContaining('"revision": 3'));
    expect(vi.mocked(ipc.workspacePush).mock.calls[0][1]).toContain('"conductorClaim"');
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
    // Its folder still belongs to the origin machine, so it stays protected from a home fallback.
    expect(s.settings.g.foreign).toEqual({ cwd: "/proj" });
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

  it("adoption applies a name another machine changed to a terminal that is already open", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
        terminals: { n1: { id: "n1", name: "swarmz", cwd: "/tmp/n", exited: null, error: null } },
        order: ["n1"],
        settings: { n1: { ...EMPTY_SETTINGS, origin: "here" } },
        layout: group(["n1"]),
      });
      noPendingSave();
      vi.mocked(ipc.renameTerminal).mockClear();
      // The real registry keeps the cwd; the shared mock does not, which would look like drift.
      vi.mocked(ipc.renameTerminal).mockImplementationOnce(async (id: string, name: string) => ({
        ...useStore.getState().terminals[id],
        name,
      }));
      const peer: Workspace = {
        version: 1, layout: group(["n1"]), sync: { revision: 4, updatedAt: "t4", updatedBy: "desk" },
        terminals: [{ id: "n1", name: "other", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      };
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(peer));
      await useStore.getState().pullWorkspace();
      expect(ipc.renameTerminal).toHaveBeenCalledWith("n1", "other");
      expect(useStore.getState().terminals.n1.name).toBe("other");
      // Nothing to write back: this machine now agrees with the file.
      const afterAdopt = vi.mocked(ipc.saveWorkspace).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBe(afterAdopt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the live name when the registry refuses the adopted one, without calling it drift", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        selfMachine: "here", tailscale: ts(["desk"]),
        syncMeta: { revision: 1, updatedAt: "t1", updatedBy: "here" },
        sync: { ...useStore.getState().sync, enabled: true },
        terminals: { n1: { id: "n1", name: "swarmz", cwd: "/tmp/n", exited: null, error: null } },
        order: ["n1"],
        settings: { n1: { ...EMPTY_SETTINGS, origin: "here" } },
        layout: group(["n1"]),
      });
      noPendingSave();
      vi.mocked(ipc.renameTerminal).mockClear();
      vi.mocked(ipc.renameTerminal).mockRejectedValueOnce('a terminal named "other" already exists');
      const peer: Workspace = {
        version: 1, layout: group(["n1"]), sync: { revision: 4, updatedAt: "t4", updatedBy: "desk" },
        terminals: [{ id: "n1", name: "other", cwd: "/tmp/n", ssh: null, claude: null, command: null, origin: "here" }],
      };
      vi.mocked(ipc.workspacePull).mockResolvedValueOnce(JSON.stringify(peer));
      await useStore.getState().pullWorkspace();
      expect(useStore.getState().terminals.n1.name).toBe("swarmz");
      const afterAdopt = vi.mocked(ipc.saveWorkspace).mock.calls.length;
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
      expect(vi.mocked(ipc.saveWorkspace).mock.calls.length).toBe(afterAdopt);
      // The name this machine could not use stays machine-local: the file keeps the adopted one.
      useStore.getState().updateSettings("n1", { command: "ls" });
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
      const calls = vi.mocked(ipc.saveWorkspace).mock.calls;
      expect((calls[calls.length - 1][0] as Workspace).terminals.find((t) => t.id === "n1")?.name).toBe("other");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a peer file whose terminal list holds something that is not a def", async () => {
    useStore.setState({
      selfMachine: "here", tailscale: ts(["desk"]),
      syncMeta: { revision: 2, updatedAt: "t2", updatedBy: "here" },
      sync: { ...useStore.getState().sync, enabled: true },
    });
    noPendingSave();
    vi.mocked(ipc.workspacePull).mockResolvedValueOnce('{"version":1,"terminals":[null],"sync":{"revision":9,"updatedAt":"t9","updatedBy":"desk"}}');
    await expect(useStore.getState().pullWorkspace()).resolves.toBeUndefined();
    const s = useStore.getState();
    expect(s.syncMeta?.revision).toBe(2);
    expect(s.order).toEqual([]);
    expect(s.sync.error).toContain("desk");
    expect(s.sync.error).toContain("malformed");
  });
});

describe("agent state", () => {
  const ev = (
    terminal: string,
    event: string,
    extra: Partial<import("./lib/agentState").AgentEvent> = {},
    host: string | null = null,
  ) => ({
    host,
    event: { ts: "2026-09-15T10:00:00Z", terminal, event, sessionId: "s1", notificationType: null, source: null, cwd: null, permissionMode: null, ...extra },
  });

  it("applies live events to known terminals and ignores unknown ones", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart"));
    expect(useStore.getState().agentState[id].status).toBe("idle");
    useStore.getState().applyAgentEvent(ev("nope", "SessionStart"));
    expect(useStore.getState().agentState.nope).toBeUndefined();
  });

  it("marks unseen only when the terminal is not focused in a focused window", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    useStore.getState().focusTerminal(b);
    useStore.getState().applyAgentEvent(ev(a, "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(ev(a, "Stop"));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().applyAgentEvent(ev(b, "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(ev(b, "Stop"));
    expect(useStore.getState().agentState[b].unseen).toBe(false);
    useStore.getState().setWindowFocused(false);
    useStore.getState().applyAgentEvent(ev(b, "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(ev(b, "Stop"));
    expect(useStore.getState().agentState[b].unseen).toBe(true);
  });

  it("focusing a terminal in a focused window clears unseen; window focus clears the focused one", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    useStore.getState().applyAgentEvent(ev(a, "Notification", { notificationType: "permission_prompt" }));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().focusTerminal(a);
    expect(useStore.getState().agentState[a].unseen).toBe(false);
    useStore.getState().setWindowFocused(false);
    useStore.getState().applyAgentEvent(ev(a, "Notification", { notificationType: "permission_prompt" }));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().setWindowFocused(true);
    expect(useStore.getState().agentState[a].unseen).toBe(false);
    expect(useStore.getState().focusedTerminalId).toBe(a);
    void b;
  });

  it("focusing a group clears unseen on its active terminal", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const group = findGroupOf(useStore.getState().layout, a)!;
    useStore.getState().splitTerminal(b, group.id, "right");
    useStore.getState().applyAgentEvent(ev(a, "Notification", { notificationType: "permission_prompt" }));
    expect(useStore.getState().agentState[a].unseen).toBe(true);
    useStore.getState().focusGroup(group.id);
    expect(useStore.getState().focusedTerminalId).toBe(a);
    expect(useStore.getState().agentState[a].unseen).toBe(false);
  });

  it("replayed events before launch apply only to ssh terminals", async () => {
    const local = await useStore.getState().createTerminal("/tmp/a");
    const remote = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    const old = { ts: "2026-09-15T08:00:00Z" };
    useStore.getState().applyAgentEvent(ev(local, "SessionStart", old));
    useStore.getState().applyAgentEvent(ev(remote, "SessionStart", old, "me@box"));
    expect(useStore.getState().agentState[local]).toBeUndefined();
    expect(useStore.getState().agentState[remote]?.status).toBe("idle");
  });

  it("ignores an event from a machine other than the one the tile runs on", async () => {
    const local = await useStore.getState().createTerminal("/tmp/a");
    const box = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    // Replay out of this Mac's own log: whatever it describes died with the app, and it was
    // never this tile's Claude anyway.
    useStore.getState().applyAgentEvent(ev(box, "SessionStart", { ts: "2026-09-15T08:00:00Z" }));
    expect(useStore.getState().agentState[box]).toBeUndefined();
    // Same terminal id seen on a third machine's log (ids travel in the shared workspace).
    useStore.getState().applyAgentEvent(ev(box, "SessionStart", {}, "me@other"));
    expect(useStore.getState().agentState[box]).toBeUndefined();
    useStore.getState().applyAgentEvent(ev(box, "SessionStart"));
    expect(useStore.getState().agentState[box]).toBeUndefined();
    useStore.getState().applyAgentEvent(ev(local, "SessionStart", {}, "me@box"));
    expect(useStore.getState().agentState[local]).toBeUndefined();
    // The logs that do describe these tiles still apply.
    useStore.getState().applyAgentEvent(ev(box, "SessionStart", {}, "me@box"));
    expect(useStore.getState().agentState[box]?.status).toBe("idle");
    useStore.getState().applyAgentEvent(ev(local, "SessionStart"));
    expect(useStore.getState().agentState[local]?.status).toBe("idle");
  });

  it("exit, restart and close reset the state", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit"));
    useStore.getState().markExited(id, 0);
    expect(useStore.getState().agentState[id].status).toBe("offline");
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit"));
    await useStore.getState().restartTerminal(id);
    expect(useStore.getState().agentState[id].status).toBe("offline");
    await useStore.getState().closeTerminal(id);
    expect(useStore.getState().agentState[id]).toBeUndefined();
  });

  it("loadWorkspace installs hooks locally, records a failure, and starts the local watcher", async () => {
    vi.mocked(ipc.agentsInstallLocal).mockRejectedValueOnce("no write access");
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    expect(ipc.agentsInstallLocal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useStore.getState().agentHooksError).toBe("could not install Claude hooks: no write access"));
    expect(ipc.agentsWatch).toHaveBeenCalledWith(null);
    await useStore.getState().installAgentHooks();
    expect(useStore.getState().agentHooksError).toBeNull();
  });

  it("watches a host when its tile connects, installs hooks there once, and unwatches when the tile closes", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    __stopAllPolling();
    vi.mocked(ipc.agentsWatch).mockClear();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsWatch).toHaveBeenCalledWith("me@box");
    expect(ipc.agentsInstallRemote).toHaveBeenCalledWith("me@box");
    expect(ipc.agentsInstallRemote).toHaveBeenCalledTimes(1);
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsInstallRemote).toHaveBeenCalledTimes(1);
    expect(ipc.agentsWatch).toHaveBeenCalledTimes(1);
    await useStore.getState().closeTerminal(id);
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsUnwatch).toHaveBeenCalledWith("me@box");
  });

  it("a remote install failure becomes a startup note on that tile and is retried on the next connect", async () => {
    vi.mocked(ipc.agentsInstallRemote).mockRejectedValueOnce("not reachable: x");
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    __stopAllPolling();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(useStore.getState().startupNotes[id]).toBe("could not install Claude hooks on box: not reachable: x");
    useStore.setState((s) => ({ sshConnected: omitKey(s.sshConnected, id) }));
    await useStore.getState().ensureAgentWatchers();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(ipc.agentsInstallRemote).toHaveBeenCalledTimes(2);
  });

  /** The tile a backoff test needs: one connected ssh terminal on "me@box" whose ssh is live,
   * with a watcher already running (generation 1, per the ipc fake). */
  async function connectedBoxTile(): Promise<string> {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    __stopAllPolling();
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    vi.mocked(ipc.agentsWatch).mockClear();
    return id;
  }

  it("escalates the re-watch backoff while each new watcher dies before its delay is up", async () => {
    vi.useFakeTimers();
    try {
      await connectedBoxTile();
      // Each hop: the watcher dies at once, so the next wait is the next step of the backoff.
      for (const delay of [1000, 2000, 4000]) {
        const before = vi.mocked(ipc.agentsWatch).mock.calls.length;
        useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(ipc.agentsWatch).toHaveBeenCalledTimes(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(ipc.agentsWatch).toHaveBeenCalledTimes(before + 1);
        expect(ipc.agentsWatch).toHaveBeenLastCalledWith("me@box");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a watcher that outlives its own backoff delay resets it", async () => {
    vi.useFakeTimers();
    try {
      await connectedBoxTile();
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(1);
      // This watcher runs for five seconds — far longer than the one second wait that started
      // it — so its death is a fresh failure, not the second hop of the old one.
      await vi.advanceTimersByTimeAsync(5000);
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an event from a host proves its watcher alive and resets the backoff", async () => {
    vi.useFakeTimers();
    try {
      const id = await connectedBoxTile();
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(2);
      useStore.getState().applyAgentEvent(ev(id, "SessionStart", {}, "me@box"));
      // Without that event the next wait would be the third hop (4s); the event puts it back
      // on the first.
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a watch-ended from a watcher that has already been replaced", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
      __stopAllPolling();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
      await useStore.getState().ensureAgentWatchers();
      vi.mocked(ipc.agentsWatch).mockClear();
      // gen 7 belongs to a watcher this store already replaced: its death says nothing about
      // the watcher that is running now.
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 7 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(ipc.agentsWatch).not.toHaveBeenCalled();
      useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledWith("me@box");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a later successful install clears the install note, leaving other notes alone", async () => {
    vi.mocked(ipc.agentsInstallRemote).mockRejectedValueOnce("not reachable: x");
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    const other = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/q", machine: "box" });
    __stopAllPolling();
    useStore.setState((s) => ({
      sshConnected: { ...s.sshConnected, [id]: true },
      startupNotes: { ...s.startupNotes, [other]: "connection not detected; click Run to try again" },
    }));
    await useStore.getState().ensureAgentWatchers();
    expect(useStore.getState().startupNotes[id]).toBe("could not install Claude hooks on box: not reachable: x");
    useStore.setState((s) => ({ sshConnected: omitKey(s.sshConnected, id) }));
    await useStore.getState().ensureAgentWatchers();
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().ensureAgentWatchers();
    expect(useStore.getState().startupNotes[id]).toBeUndefined();
    expect(useStore.getState().startupNotes[other]).toBe("connection not detected; click Run to try again");
  });

  it("a remote watcher that survives clears the unavailable note", async () => {
    vi.useFakeTimers();
    try {
      const id = await connectedBoxTile();
      for (let i = 0; i < AGENT_WATCH_UNAVAILABLE_AFTER; i++) {
        await useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
        await vi.advanceTimersByTimeAsync(AGENT_WATCH_BACKOFF_MS[Math.min(i, AGENT_WATCH_BACKOFF_MS.length - 1)]);
      }
      expect(useStore.getState().startupNotes[id]).toBe("agent state unavailable for box");
      useStore.setState((s) => ({ startupNotes: { ...s.startupNotes, keep: "something else entirely" } }));
      await vi.advanceTimersByTimeAsync(60_000);
      await useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      expect(useStore.getState().startupNotes[id]).toBeUndefined();
      expect(useStore.getState().startupNotes.keep).toBe("something else entirely");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a host whose ssh dropped instead of re-watching it forever", async () => {
    vi.useFakeTimers();
    try {
      const id = await connectedBoxTile();
      // The watcher died because the ssh under it did.
      vi.mocked(ipc.sshCheck).mockResolvedValue(false);
      vi.mocked(ipc.agentsUnwatch).mockClear();
      await useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      expect(useStore.getState().sshConnected[id]).toBeUndefined();
      expect(ipc.agentsUnwatch).toHaveBeenCalledWith("me@box");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ipc.agentsWatch).not.toHaveBeenCalledWith("me@box");
      // Same verdict as the connection watchdog: the tile offers Connect again.
      expect(useStore.getState().startupNotes[id]).toBe("Connection to box ended");
      expect(useStore.getState().startupPending[id]).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps re-watching a host whose ssh is still up", async () => {
    vi.useFakeTimers();
    try {
      const id = await connectedBoxTile();
      await useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
      expect(useStore.getState().sshConnected[id]).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledWith("me@box");
    } finally {
      vi.useRealTimers();
    }
  });

  it("notes on the tile once re-watching has failed for about 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      const id = await connectedBoxTile();
      // `agents_watch` resolving only means the core spawned ssh, not that it connected: an
      // unreachable host keeps handing back watchers that die on their own, and that is what
      // has to escalate into the note.
      for (let i = 0; i < AGENT_WATCH_UNAVAILABLE_AFTER; i++) {
        expect(useStore.getState().startupNotes[id]).toBeUndefined();
        useStore.getState().agentWatchEnded({ host: "me@box", gen: 1 });
        await vi.advanceTimersByTimeAsync(AGENT_WATCH_BACKOFF_MS[Math.min(i, AGENT_WATCH_BACKOFF_MS.length - 1)]);
      }
      expect(useStore.getState().startupNotes[id]).toBe("agent state unavailable for box");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-watch a host nobody wants any more", async () => {
    vi.useFakeTimers();
    try {
      useStore.getState().agentWatchEnded({ host: "me@nowhere", gen: 9 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(ipc.agentsWatch).not.toHaveBeenCalledWith("me@nowhere");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not watch a host whose tile closed while its hooks were installing", async () => {
    let resolveInstall!: (v: boolean) => void;
    const installPromise = new Promise<boolean>((resolve) => {
      resolveInstall = resolve;
    });
    vi.mocked(ipc.agentsInstallRemote).mockReturnValueOnce(installPromise);
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", machine: "box" });
    __stopAllPolling();
    // Marking connected fires the store's subscription, which starts ensureAgentWatchers() in the
    // background; it marks "me@box" installed and pauses on the controlled install promise above.
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    // The tile closes while that install call is still in flight. The reentrant call this
    // triggers finds nothing in `watching` yet to clean up — that's the bug: the stale `wanted`
    // snapshot captured by the still-paused call is the only thing that knows about this host.
    await useStore.getState().closeTerminal(id);
    resolveInstall(true);
    // Flush the resumed call's remaining awaits: a real macrotask boundary drains every pending
    // microtask, regardless of how many hops its continuation needs.
    await new Promise((r) => setTimeout(r, 0));
    const watchedBox = vi.mocked(ipc.agentsWatch).mock.calls.some(([h]) => h === "me@box");
    if (watchedBox) {
      expect(ipc.agentsUnwatch).toHaveBeenCalledWith("me@box");
    } else {
      expect(ipc.agentsWatch).not.toHaveBeenCalledWith("me@box");
    }
  });

  it("a second local watch-ended within a second schedules one re-watch", async () => {
    vi.useFakeTimers();
    try {
      await useStore.getState().ensureAgentWatchers();
      expect(ipc.agentsWatch).toHaveBeenCalledWith(null);
      vi.mocked(ipc.agentsWatch).mockClear();
      useStore.getState().agentWatchEnded({ host: null, gen: 1 });
      useStore.getState().agentWatchEnded({ host: null, gen: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ipc.agentsWatch).toHaveBeenCalledTimes(1);
      expect(ipc.agentsWatch).toHaveBeenCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates the local backoff too and reports the local watcher as unavailable", async () => {
    vi.useFakeTimers();
    try {
      await useStore.getState().ensureAgentWatchers();
      vi.mocked(ipc.agentsWatch).mockClear();
      for (let i = 0; i < AGENT_WATCH_UNAVAILABLE_AFTER; i++) {
        expect(useStore.getState().agentHooksError).toBeNull();
        useStore.getState().agentWatchEnded({ host: null, gen: 1 });
        const delay = AGENT_WATCH_BACKOFF_MS[Math.min(i, AGENT_WATCH_BACKOFF_MS.length - 1)];
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(ipc.agentsWatch).toHaveBeenCalledTimes(i);
        await vi.advanceTimersByTimeAsync(1);
        expect(ipc.agentsWatch).toHaveBeenLastCalledWith(null);
      }
      expect(useStore.getState().agentHooksError).toBe("agent state unavailable on this Mac");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a local watcher that survives clears the unavailable error", async () => {
    vi.useFakeTimers();
    try {
      await useStore.getState().ensureAgentWatchers();
      for (let i = 0; i < AGENT_WATCH_UNAVAILABLE_AFTER; i++) {
        useStore.getState().agentWatchEnded({ host: null, gen: 1 });
        await vi.advanceTimersByTimeAsync(AGENT_WATCH_BACKOFF_MS[Math.min(i, AGENT_WATCH_BACKOFF_MS.length - 1)]);
      }
      expect(useStore.getState().agentHooksError).toBe("agent state unavailable on this Mac");
      // The watcher started by the last retry runs for a minute before dying: that is a live
      // local log, not the same failure going round again.
      await vi.advanceTimersByTimeAsync(60_000);
      useStore.getState().agentWatchEnded({ host: null, gen: 1 });
      expect(useStore.getState().agentHooksError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("UserPromptSubmit with the tile's session id marks the Claude session started", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: false } });
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit", { sessionId: "other" }));
    expect(useStore.getState().settings[id].claude?.started).toBe(false);
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit", { sessionId: "s1" }));
    expect(useStore.getState().settings[id].claude?.started).toBe(true);
  });

  it("runStartup no longer marks the session started", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: false } });
    await useStore.getState().runStartup(id);
    expect(ipc.writeTerminal).toHaveBeenCalledWith(id, "claude --session-id s1\r");
    expect(useStore.getState().settings[id].claude?.started).toBe(false);
  });

  it("SessionStart with a new session id adopts it, records it, and applies its folder", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "new1", cwd: "/tmp/sub", permissionMode: "bypassPermissions" }));
    await vi.waitFor(() => expect(useStore.getState().terminals[id].cwd).toBe("/tmp/sub"));
    const s = useStore.getState().settings[id];
    expect(s.claude).toEqual({ enabled: true, sessionId: "new1", skipPermissions: true, started: false });
    expect(s.sessions?.[0]).toMatchObject({ sessionId: "new1", cwd: "/tmp/sub", skipPermissions: true });
  });

  it("SessionStart with the current session id only bumps the record", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true } });
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "cur", cwd: "/tmp/a", permissionMode: "default", ts: "2026-09-15T10:00:00Z" }));
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "cur", cwd: "/tmp/a", permissionMode: "default", ts: "2026-09-15T10:05:00Z" }));
    const s = useStore.getState().settings[id];
    expect(s.claude?.started).toBe(true);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions?.[0].lastActiveAt).toBe("2026-09-15T10:05:00Z");
    expect(s.sessions?.[0].startedAt).toBe("2026-09-15T10:00:00Z");
  });

  it("prompts bump lastActiveAt but leave the folder alone; stops and notifications leave settings alone", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "s", cwd: "/tmp/a", ts: "2026-09-15T10:00:00Z" }));
    // A prompt's cwd is Claude's own Bash shell, which moves as Claude `cd`s; the tile's shell has
    // not moved, and following it made the folder flip between the two (the holder's Info and
    // OSC 7 say one thing, the hook another) on every event.
    useStore.getState().applyAgentEvent(ev(id, "UserPromptSubmit", { sessionId: "s", cwd: "/tmp/moved", ts: "2026-09-15T10:01:00Z" }));
    await vi.waitFor(() => expect(useStore.getState().settings[id].sessions?.[0].lastActiveAt).toBe("2026-09-15T10:01:00Z"));
    expect(useStore.getState().terminals[id].cwd).toBe("/tmp/a");
    // Every new settings identity is a debounced save, a revision bump and an ssh push to
    // every peer; a Claude turn emits several of these, so they must not touch settings.
    const before = useStore.getState().settings[id];
    useStore.getState().applyAgentEvent(ev(id, "Stop", { sessionId: "s", ts: "2026-09-15T10:02:00Z" }));
    useStore.getState().applyAgentEvent(ev(id, "Notification", { sessionId: "s", ts: "2026-09-15T10:03:00Z" }));
    useStore.getState().applyAgentEvent(ev(id, "StopFailure", { sessionId: "s", ts: "2026-09-15T10:04:00Z" }));
    expect(useStore.getState().settings[id]).toBe(before);
    expect(useStore.getState().settings[id].sessions?.[0].lastActiveAt).toBe("2026-09-15T10:01:00Z");
  });

  it("an ssh tile's folder follows the hook's cwd into settings.ssh.cwd at session start only", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    useStore.getState().applyAgentEvent({ ...ev(id, "SessionStart", { sessionId: "r1", cwd: "/p/deeper" }), host: "me@box" });
    await vi.waitFor(() => expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper"));
    expect(useStore.getState().settings[id].sessions?.[0].cwd).toBe("/p/deeper");
    // Claude's Bash shell wandering into a subfolder does not move the tile, and so cannot fight
    // the remote holder's folder (which would re-arm the connect card and bump the workspace).
    useStore.getState().applyAgentEvent({ ...ev(id, "UserPromptSubmit", { sessionId: "r1", cwd: "/p/deeper/loadtest/.local/logs", ts: "2026-09-15T10:01:00Z" }), host: "me@box" });
    await vi.waitFor(() => expect(useStore.getState().settings[id].sessions?.[0].lastActiveAt).toBe("2026-09-15T10:01:00Z"));
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper");
  });

  it("a tile with a custom command is never adopted", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().updateSettings(id, { command: "npm run dev" });
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "x", cwd: "/tmp/z" }));
    expect(useStore.getState().settings[id].claude).toBeNull();
    expect(useStore.getState().settings[id].sessions).toBeUndefined();
  });

  it("SessionEnd changes nothing in history", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent(ev(id, "SessionStart", { sessionId: "s", cwd: "/tmp/a" }));
    const before = useStore.getState().settings[id].sessions;
    useStore.getState().applyAgentEvent(ev(id, "SessionEnd", { sessionId: "s" }));
    expect(useStore.getState().settings[id].sessions).toBe(before);
  });
});

describe("setTerminalCwd", () => {
  it("local tile: updates the registry then the store", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    await useStore.getState().setTerminalCwd(id, "/tmp/b", "poll");
    expect(ipc.setTerminalCwd).toHaveBeenCalledWith(id, "/tmp/b");
    expect(useStore.getState().terminals[id].cwd).toBe("/tmp/b");
  });
  it("ssh tile: updates settings.ssh.cwd and never calls the registry", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    vi.mocked(ipc.setTerminalCwd).mockClear();
    await useStore.getState().setTerminalCwd(id, "/q", "hook");
    expect(ipc.setTerminalCwd).not.toHaveBeenCalled();
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/q");
  });
  it("ssh tile: OSC 7 counts only once ssh is up, and a poll never counts", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    useStore.setState((s) => ({ sshConnected: omitKey(s.sshConnected, id) }));
    // Before the ssh line has connected, OSC 7 is the *local* shell announcing the local
    // home directory: it must not become the tile's remote folder.
    await useStore.getState().setTerminalCwd(id, "/Users/me", "osc7");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p");
    await useStore.getState().setTerminalCwd(id, "/Users/me", "poll");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p");
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().setTerminalCwd(id, "/p/deeper", "osc7");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper");
    await useStore.getState().setTerminalCwd(id, "/Users/me", "poll");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper");
  });
  it("foreign local: OSC 7 counts only once ssh is up", async () => {
    const id = await useStore.getState().createTerminal("/home/me");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], ssh: { host: "root@desk", cwd: "/proj", machine: "desk" }, foreign: { cwd: "/proj" }, origin: "desk" } },
      sshConnected: omitKey(s.sshConnected, id),
    }));
    await useStore.getState().setTerminalCwd(id, "/Users/me", "osc7");
    expect(useStore.getState().settings[id].foreign?.cwd).toBe("/proj");
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().setTerminalCwd(id, "/proj/sub", "osc7");
    expect(useStore.getState().settings[id].foreign?.cwd).toBe("/proj/sub");
  });
  it("foreign local: updates settings.foreign.cwd", async () => {
    const id = await useStore.getState().createTerminal("/home/me");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], ssh: { host: "root@desk", cwd: "/proj", machine: "desk" }, foreign: { cwd: "/proj" }, origin: "desk" } },
    }));
    await useStore.getState().setTerminalCwd(id, "/proj/sub", "hook");
    expect(useStore.getState().settings[id].foreign?.cwd).toBe("/proj/sub");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/proj/sub");
  });
  it("ignores unchanged, relative, and unsafe values, and unknown ids", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.setTerminalCwd).mockClear();
    await useStore.getState().setTerminalCwd(id, "/tmp/a", "poll");
    await useStore.getState().setTerminalCwd(id, "rel", "poll");
    await useStore.getState().setTerminalCwd(id, "/bad\x1b", "poll");
    await useStore.getState().setTerminalCwd("nope", "/x", "poll");
    expect(ipc.setTerminalCwd).not.toHaveBeenCalled();
  });
  it("a registry failure leaves the store untouched", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    vi.mocked(ipc.setTerminalCwd).mockRejectedValueOnce("no");
    await useStore.getState().setTerminalCwd(id, "/tmp/b", "poll");
    expect(useStore.getState().terminals[id].cwd).toBe("/tmp/a");
  });
});

describe("selectSession", () => {
  const rec = (sid: string, cwd: string, t: string) => ({ sessionId: sid, cwd, skipPermissions: sid === "old", startedAt: t, lastActiveAt: t });
  it("makes the record current, applies its folder, moves it to the head, and connects when asked", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [rec("cur", "/tmp/a", "t2"), rec("old", "/tmp/old", "t1")] } },
      startupPending: { ...s.startupPending, [id]: true },
    }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: true });
    const s = useStore.getState();
    expect(s.settings[id].claude).toEqual({ enabled: true, sessionId: "old", skipPermissions: true, started: true });
    expect(s.settings[id].sessions?.map((r) => r.sessionId)).toEqual(["old", "cur"]);
    expect(s.terminals[id].cwd).toBe("/tmp/old");
    expect(ipc.writeTerminal).toHaveBeenCalledWith(id, expect.stringMatching(/^cd '\/tmp\/old' && claude .*--resume old\r$/));
    expect(s.startupPending[id]).toBe(false);
  });
  it("without connect and with a busy shell it only becomes current and notes the switch", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], sessions: [rec("old", "/tmp/old", "t1")] } } }));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValueOnce(true);
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: false });
    expect(useStore.getState().settings[id].claude?.sessionId).toBe("old");
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().startupNotes[id]).toBe("switch takes effect on next Connect");
  });
  it("with connect and a busy local shell it only becomes current and notes the switch", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], sessions: [rec("old", "/tmp/old", "t1")] } } }));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValueOnce(true);
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: true });
    expect(useStore.getState().settings[id].claude?.sessionId).toBe("old");
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().startupNotes[id]).toBe("switch takes effect on next Connect");
  });
  it("without connect and an idle local shell it types the resume line", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], sessions: [rec("old", "/tmp/old", "t1")] } } }));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValueOnce(false);
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: false });
    expect(ipc.writeTerminal).toHaveBeenCalledWith(id, expect.stringMatching(/^cd '\/tmp\/old' && claude .*--resume old\r$/));
  });
  it("connects an ssh tile via runStartup, typing the ssh line and applying the record's remote folder", async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p" });
    __stopAllPolling();
    // __stopAllPolling only clears the interval; the poller startPolling kicked off during
    // creation already flipped sshConnecting, which would otherwise short-circuit runStartup.
    useStore.setState((s) => ({
      sshConnecting: omitKey(s.sshConnecting, id),
      toolReady: { "me@box": false },
      settings: { ...s.settings, [id]: { ...s.settings[id], sessions: [rec("old", "/p/old", "t1")] } },
    }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: true });
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(/^ssh -t /);
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/old");
  });
  it("a tile with a custom command never goes back", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], command: "npm run dev", sessions: [rec("old", "/tmp/old", "t1")] } } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().selectSession(id, "old", { connect: true });
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().settings[id].claude).toBeNull();
    expect(useStore.getState().settings[id].command).toBe("npm run dev");
  });
  it("unknown session ids are ignored", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    await useStore.getState().selectSession(id, "zz", { connect: true });
    expect(useStore.getState().settings[id].claude).toBeNull();
  });
});

describe("dead session detection", () => {
  it("typing a resume line arms a 10 s watch", async () => {
    vi.useFakeTimers();
    try {
      const id = await useStore.getState().createTerminal("/tmp/a");
      useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: "gone", skipPermissions: false, started: true } });
      await useStore.getState().runStartup(id);
      expect(useStore.getState().resumeWatch[id]).toMatchObject({ sessionId: "gone" });
      await vi.advanceTimersByTimeAsync(RESUME_WATCH_MS + 1);
      expect(useStore.getState().resumeWatch[id]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("noteResumeFailure removes the record, unstarts the session, and notes it", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "gone", skipPermissions: false, started: true }, sessions: [{ sessionId: "gone", cwd: "/tmp/a", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }, { sessionId: "keep", cwd: "/k", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
      resumeWatch: { [id]: { sessionId: "gone", until: Date.now() + 5000 } },
    }));
    useStore.getState().noteResumeFailure(id, "gone");
    const s = useStore.getState();
    expect(s.settings[id].sessions?.map((r) => r.sessionId)).toEqual(["keep"]);
    expect(s.settings[id].claude?.started).toBe(false);
    expect(s.startupNotes[id]).toBe("session gone is gone; Connect starts a new one");
    expect(s.startupPending[id]).toBe(true);
    expect(s.resumeWatch[id]).toBeUndefined();
  });
  it("a failure for a session that is not the current one only drops the record", async () => {
    const id = await useStore.getState().createTerminal("/tmp/a");
    useStore.setState((s) => ({
      settings: { ...s.settings, [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [{ sessionId: "other", cwd: "/o", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    useStore.getState().noteResumeFailure(id, "other");
    expect(useStore.getState().settings[id].claude?.started).toBe(true);
    // An empty list and no list are the same thing; `toWorkspace` omits both, so keep one shape.
    expect(useStore.getState().settings[id].sessions).toBeUndefined();
  });
});

describe("paste flash", () => {
  it("flashPasted stamps the tile so the pane can show its pill", () => {
    useStore.setState({ pastedAt: {} });
    const before = Date.now();
    useStore.getState().flashPasted("t1");
    const at = useStore.getState().pastedAt.t1;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(useStore.getState().pastedAt.t2).toBeUndefined();
  });
});

describe("reattaching to running sessions", () => {
  it("does not arm the connect card for a tile whose session was already running", async () => {
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: id === "live" }));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [
        { id: "live", name: "live", cwd: "/tmp/a", ssh: null, claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: true }, command: null },
        { id: "fresh", name: "fresh", cwd: "/tmp/b", ssh: null, claude: { enabled: true, sessionId: "s2", skipPermissions: false, started: true }, command: null },
      ],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().startupPending.live).toBe(false);
    expect(useStore.getState().startupPending.fresh).toBe(true);
  });

  it("offers Connect for an already-running ssh tile whose ssh has died", async () => {
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: true }));
    vi.mocked(ipc.sshCheck).mockResolvedValue(false);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [
        { id: "r2", name: "r2", cwd: "/home/me", ssh: { host: "me@box", cwd: "/p" }, claude: null, command: null },
        { id: "l2", name: "l2", cwd: "/tmp/a", ssh: null, claude: { enabled: true, sessionId: "s1", skipPermissions: false, started: true }, command: null },
      ],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    await vi.waitFor(() => expect(useStore.getState().startupPending.r2).toBe(true));
    expect(useStore.getState().sshConnected.r2).toBeUndefined();
    // A local tile's running session is never offered a card.
    expect(useStore.getState().startupPending.l2).toBe(false);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("applies agent events from before launch to tiles that rejoined a running session only", async () => {
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: id === "kept" }));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [
        { id: "kept", name: "kept", cwd: "/tmp/a", ssh: null, claude: null, command: null },
        { id: "anew", name: "anew", cwd: "/tmp/b", ssh: null, claude: null, command: null },
      ],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    const old = (terminal: string, event: string) => ({
      host: null,
      event: { ts: "2026-09-15T08:00:00Z", terminal, event, sessionId: "s1", notificationType: null, source: null, cwd: null, permissionMode: null },
    });
    useStore.getState().applyAgentEvent(old("kept", "UserPromptSubmit"));
    useStore.getState().applyAgentEvent(old("anew", "UserPromptSubmit"));
    expect(useStore.getState().agentState.kept?.status).toBe("working");
    expect(useStore.getState().agentState.anew).toBeUndefined();
    // Restarting into a new session makes its old history stale too.
    await useStore.getState().markExited("kept", 0);
    vi.mocked(ipc.restartTerminal).mockResolvedValueOnce({ id: "kept", name: "kept", cwd: "/tmp/a", exited: null, error: null, existed: false });
    await useStore.getState().restartTerminal("kept");
    useStore.setState((s) => ({ agentState: omitKey(s.agentState, "kept") }));
    useStore.getState().applyAgentEvent(old("kept", "UserPromptSubmit"));
    expect(useStore.getState().agentState.kept).toBeUndefined();
  });

  it("applies pre-launch events that arrive while the load is still opening tiles, from the holder's start on", async () => {
    // The local watcher replays the log's tail as soon as it starts, before any holder answers.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started: Record<string, string> = { kept: "2026-09-15T07:00:00Z", rebooted: "2026-09-15T08:30:00Z" };
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => {
      await gate;
      return { id, name: id, cwd, exited: null, error: null, existed: id !== "anew", startedAt: started[id] ?? "2026-09-15T09:00:05Z" };
    });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: ["kept", "rebooted", "anew"].map((id) => ({ id, name: id, cwd: `/tmp/${id}`, ssh: null, claude: null, command: null })),
    });
    useStore.setState({ persistenceReady: false });
    const ev = (terminal: string, event: string, ts: string, extra: Record<string, unknown> = {}) => ({
      host: null,
      event: { ts, terminal, event, sessionId: "s1", notificationType: null, source: null, cwd: null, permissionMode: null, ...extra },
    });
    const loading = useStore.getState().loadWorkspace();
    await vi.waitFor(() => expect(ipc.createTerminal).toHaveBeenCalled());
    // Before the holder started: an older generation's state, never applied.
    useStore.getState().applyAgentEvent(ev("kept", "Notification", "2026-09-15T06:00:00Z", { notificationType: "permission_prompt" }));
    useStore.getState().applyAgentEvent(ev("kept", "UserPromptSubmit", "2026-09-15T08:00:00Z"));
    useStore.getState().applyAgentEvent(ev("kept", "Notification", "2026-09-15T08:05:00Z", { notificationType: "permission_prompt" }));
    useStore.getState().applyAgentEvent(ev("rebooted", "UserPromptSubmit", "2026-09-15T08:00:00Z"));
    useStore.getState().applyAgentEvent(ev("anew", "UserPromptSubmit", "2026-09-15T08:00:00Z"));
    expect(useStore.getState().agentState).toEqual({});
    release();
    await loading;
    // Applied in order: working, then blocked on the permission prompt.
    expect(useStore.getState().agentState.kept?.status).toBe("blocked");
    expect(useStore.getState().agentState.rebooted).toBeUndefined();
    expect(useStore.getState().agentState.anew).toBeUndefined();
    // After the load, events are handled as they come, with the same rules.
    useStore.getState().applyAgentEvent(ev("kept", "UserPromptSubmit", "2026-09-15T08:10:00Z"));
    expect(useStore.getState().agentState.kept?.status).toBe("working");
    useStore.getState().applyAgentEvent(ev("rebooted", "UserPromptSubmit", "2026-09-15T08:20:00Z"));
    expect(useStore.getState().agentState.rebooted).toBeUndefined();
  });

  it("claims the pane size for rejoined sessions once they are recorded", async () => {
    const claimed: Array<[string, boolean]> = [];
    beforeSpawn.claimSize = (id) => claimed.push([id, !!useStore.getState().terminals[id]]);
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: id === "live" }));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [
        { id: "live", name: "live", cwd: "/tmp/a", ssh: null, claude: null, command: null },
        { id: "fresh", name: "fresh", cwd: "/tmp/b", ssh: null, claude: null, command: null },
      ],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    expect(claimed).toEqual([["live", true]]);

    // A restart that rejoins claims too; one that starts afresh sends its size directly.
    await useStore.getState().markExited("live", null);
    vi.mocked(ipc.resizeTerminal).mockClear();
    vi.mocked(ipc.restartTerminal).mockResolvedValueOnce({ id: "live", name: "live", cwd: "/tmp/a", exited: null, error: null, existed: true });
    await useStore.getState().restartTerminal("live");
    expect(claimed).toEqual([["live", true], ["live", true]]);
    expect(ipc.resizeTerminal).not.toHaveBeenCalled();
    await useStore.getState().markExited("fresh", 0);
    vi.mocked(ipc.restartTerminal).mockResolvedValueOnce({ id: "fresh", name: "fresh", cwd: "/tmp/b", exited: null, error: null, existed: false });
    await useStore.getState().restartTerminal("fresh");
    expect(claimed).toHaveLength(2);
    expect(ipc.resizeTerminal).toHaveBeenCalledWith("fresh", 80, 24);
  });

  it("marks an already-running ssh tile connected when its connection is live", async () => {
    vi.mocked(ipc.createTerminal).mockImplementation(async (id: string, cwd: string) => ({ id, name: id, cwd, exited: null, error: null, existed: true }));
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1,
      layout: null,
      terminals: [{ id: "r1", name: "r1", cwd: "/home/me", ssh: { host: "me@box", cwd: "/p" }, claude: null, command: null }],
    });
    useStore.setState({ persistenceReady: false });
    await useStore.getState().loadWorkspace();
    await vi.waitFor(() => expect(useStore.getState().sshConnected.r1).toBe(true));
    expect(useStore.getState().startupPending.r1).toBe(false);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });
});

describe("remote attach", () => {
  // Attach mode needs to know which Mac this is (it never attaches a tile to its own Mac). The
  // host's master is up (a key login, or one made earlier), so the tool is asked right away; the
  // login-first flow has its own tests.
  beforeEach(() => {
    useStore.setState({ selfMachine: "here" });
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
  });

  const sshTile = async () => {
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
    __stopAllPolling();
    return id;
  };

  it("types the attach line when the remote tool is ready", async () => {
    vi.mocked(ipc.writeTerminal).mockClear();
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
    __stopAllPolling();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toContain("~/.swarmz/bin/swarmz attach");
    expect(useStore.getState().toolReady["me@box"]).toBe(true);
    void id;
  });

  it("falls back to the plain ssh line when the remote tool is not ready", async () => {
    vi.mocked(ipc.writeTerminal).mockClear();
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(false);
    await sshTile();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(/^ssh -t .*me@box\r$/);
  });

  it("falls back to the plain ssh line when checking the remote tool fails, and asks again on the next Run", async () => {
    vi.mocked(ipc.writeTerminal).mockClear();
    vi.mocked(ipc.toolRemoteReady).mockRejectedValue("ssh: connect to host box: Operation timed out");
    await sshTile();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(/^ssh -t .*me@box\r$/);
    expect(useStore.getState().toolReady["me@box"]).toBeUndefined();
    // The failure was transient: the next Run checks again and attaches.
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    vi.mocked(ipc.writeTerminal).mockClear();
    await sshTile();
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toContain("~/.swarmz/bin/swarmz attach");
    expect(useStore.getState().toolReady["me@box"]).toBe(true);
  });

  it("remembers a definite no from the tool check", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(false);
    await sshTile();
    await sshTile();
    expect(useStore.getState().toolReady["me@box"]).toBe(false);
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
  });

  it("never attaches a tile to this Mac, or when this Mac's name is unknown", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    const plain = /^ssh -t .*\r$/;
    // The host is this Mac, by machine name.
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().createSshTerminal({ host: "me@here", cwd: "/p", machine: "here" });
    __stopAllPolling();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(plain);
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).not.toContain("swarmz attach");
    // By host name only (a MagicDNS FQDN, any case).
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().createSshTerminal({ host: "me@Here.tail1234.ts.net", cwd: "/p" });
    __stopAllPolling();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).not.toContain("swarmz attach");
    // Unknown self: no attach anywhere.
    useStore.setState({ selfMachine: null });
    vi.mocked(ipc.writeTerminal).mockClear();
    await sshTile();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(/^ssh -t .*me@box\r$/);
    // Another Mac, with the name known: attach.
    useStore.setState({ selfMachine: "here" });
    vi.mocked(ipc.writeTerminal).mockClear();
    await sshTile();
    expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toContain("~/.swarmz/bin/swarmz attach");
  });

  it("closing an attached tile also closes its session on the remote Mac, without waiting for it", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    const id = await sshTile();
    vi.mocked(ipc.remoteTileClose).mockClear().mockImplementation(() => new Promise(() => {}));
    await useStore.getState().closeTerminal(id);
    expect(useStore.getState().terminals[id]).toBeUndefined();
    expect(ipc.closeTerminal).toHaveBeenCalledWith(id);
    await vi.waitFor(() => expect(ipc.remoteTileClose).toHaveBeenCalledWith("me@box", id));
  });

  it("a failing remote close never stops the tile from closing", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    const id = await sshTile();
    await useStore.getState().remoteAttached(id, false);
    // The host's answer was forgotten since (a failed attach elsewhere): the attach still counts.
    useStore.setState({ toolReady: {} });
    vi.mocked(ipc.remoteTileClose).mockClear().mockRejectedValue("ssh: host is down");
    await useStore.getState().closeTerminal(id);
    expect(useStore.getState().terminals[id]).toBeUndefined();
    await vi.waitFor(() => expect(ipc.remoteTileClose).toHaveBeenCalledWith("me@box", id));
  });

  it("closing a local tile or a plain ssh tile closes nothing remote", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(false);
    const local = await useStore.getState().createTerminal("/tmp/x");
    const plain = await sshTile();
    vi.mocked(ipc.remoteTileClose).mockClear();
    await useStore.getState().closeTerminal(local);
    await useStore.getState().closeTerminal(plain);
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.remoteTileClose).not.toHaveBeenCalled();
  });

  it("a new remote session gets the startup step; an existing one is only marked connected", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    // Both tiles type their attach line (ssh not live yet), which is what lets a new=1 marker type.
    const id = await sshTile();
    const other = await sshTile();
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: true } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().remoteAttached(id, true);
    expect(useStore.getState().sshConnected[id]).toBe(true);
    expect(vi.mocked(ipc.writeTerminal).mock.calls.some((c) => String(c[1]).includes("claude --session-id"))).toBe(true);

    useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [other]: true } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().remoteAttached(other, false);
    expect(useStore.getState().sshConnected[other]).toBe(true);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("a marker for a tile that is not connecting never types anything", async () => {
    const id = await sshTile();
    useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: false } }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().remoteAttached(id, true);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(useStore.getState().sshConnected[id]).toBe(true);
  });

  it("a marker printed in a local tile is ignored", async () => {
    const id = await useStore.getState().createTerminal("/tmp/x");
    await useStore.getState().remoteAttached(id, true);
    expect(useStore.getState().sshConnected[id]).toBeUndefined();
  });

  it("in attach mode the poller never types the remote step", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 6 + SSH_SETTLE_MS);
      expect(vi.mocked(ipc.writeTerminal).mock.calls.some((c) => String(c[1]).includes("claude --session-id"))).toBe(false);
    } finally {
      __stopAllPolling();
      vi.useRealTimers();
    }
  });

  it("in attach mode the poller never types the remote step once ssh comes up", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      vi.mocked(ipc.writeTerminal).mockClear();
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 6 + SSH_SETTLE_MS);
      expect(vi.mocked(ipc.writeTerminal).mock.calls).toHaveLength(1);
      expect(useStore.getState().sshConnecting[id]).toBe(true);
    } finally {
      __stopAllPolling();
      vi.useRealTimers();
    }
  });

  it("in attach mode the marker, not the poller, connects the tile and stops the poller", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      expect(vi.mocked(ipc.writeTerminal).mock.lastCall?.[1]).toContain("~/.swarmz/bin/swarmz attach");
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
      expect(ipc.sshCheck).toHaveBeenCalled();
      expect(useStore.getState().sshConnecting[id]).toBe(true);
      expect(useStore.getState().sshConnected[id]).toBeUndefined();
      const p = useStore.getState().remoteAttached(id, true);
      await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
      await p;
      expect(useStore.getState().sshConnected[id]).toBe(true);
      expect(useStore.getState().sshConnecting[id]).toBeUndefined();
      expect(vi.mocked(ipc.writeTerminal).mock.calls.filter((c) => String(c[1]).includes("claude --session-id"))).toHaveLength(1);
      vi.mocked(ipc.sshCheck).mockClear();
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 4);
      expect(ipc.sshCheck).not.toHaveBeenCalled();
    } finally {
      __stopAllPolling();
      vi.useRealTimers();
    }
  });

  it("in attach mode a remote tool that exits without a marker ends in the exit note", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 2);
      expect(useStore.getState().sshConnecting[id]).toBe(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
      expect(useStore.getState().sshConnecting[id]).toBeUndefined();
      expect(useStore.getState().startupPending[id]).toBe(true);
      expect(useStore.getState().startupNotes[id]).toBe("the swarmz session on box could not start; see the terminal and click Run");
      // The next Run asks the tool again instead of retrying attach mode blindly.
      expect(useStore.getState().toolReady["me@box"]).toBeUndefined();
      // The failed attach logged in, so the master is still up: the tool is asked at once.
      vi.mocked(ipc.toolRemoteReady).mockClear().mockResolvedValue(false);
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().runStartup(id);
      expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toMatch(/^ssh -t .*me@box\r$/);
    } finally {
      __stopAllPolling();
      vi.useRealTimers();
    }
  });

  it("Run on an attached tile whose ssh is already live only marks it connected", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    const id = await sshTile();
    useStore.setState((s) => ({ sshConnecting: omitKey(s.sshConnecting, id) }));
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().runStartup(id);
    expect(useStore.getState().sshConnected[id]).toBe(true);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("records the tool as ready once the agent hooks are installed on a connected host", async () => {
    const id = await sshTile();
    expect(useStore.getState().toolReady["me@box"]).toBe(false);
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await vi.waitFor(() => expect(useStore.getState().toolReady["me@box"]).toBe(true));
  });

  it("setTerminalCwd accepts remote folder reports for connected ssh tiles only", async () => {
    const id = await sshTile();
    await useStore.getState().setTerminalCwd(id, "/p/deeper", "remote");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p");
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    await useStore.getState().setTerminalCwd(id, "/p/deeper", "remote");
    expect(useStore.getState().settings[id].ssh?.cwd).toBe("/p/deeper");
  });

  it("a second Run while the tool check is in flight types nothing, and one host is checked once", async () => {
    let resolve: (v: boolean) => void = () => {};
    vi.mocked(ipc.toolRemoteReady).mockImplementation(() => new Promise<boolean>((r) => (resolve = r)));
    vi.mocked(ipc.writeTerminal).mockClear();
    const first = useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
    await vi.waitFor(() => expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1));
    const id = useStore.getState().order[0];
    const again = useStore.getState().runStartup(id);
    const second = useStore.getState().createSshTerminal({ host: "me@box", cwd: "/q", claude: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
    resolve(true);
    await Promise.all([first, again, second]);
    __stopAllPolling();
    const lines = vi.mocked(ipc.writeTerminal).mock.calls.map((c) => String(c[1]));
    expect(lines.filter((l) => l.includes(`swarmz attach ${id}`))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("~/.swarmz/bin/swarmz attach"))).toHaveLength(2);
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
    // Once the first Run is done, a later one may run again.
    useStore.setState((s) => ({ sshConnecting: omitKey(s.sshConnecting, id) }));
    vi.mocked(ipc.writeTerminal).mockClear();
    await useStore.getState().runStartup(id);
    __stopAllPolling();
    expect(ipc.writeTerminal).toHaveBeenCalledTimes(1);
  });

  it("a new=1 marker after the connect timeout still types the startup line; cancel or a new Run forgets it", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      const id = await useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      // The attach never comes up (no master): the poller times out.
      vi.mocked(ipc.sshCheck).mockResolvedValue(false);
      await vi.advanceTimersByTimeAsync(SSH_POLL_TIMEOUT_MS + SSH_POLL_MS * 2);
      expect(useStore.getState().sshConnecting[id]).toBeUndefined();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.writeTerminal).mockClear();
      const p = useStore.getState().remoteAttached(id, true);
      await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
      await p;
      expect(vi.mocked(ipc.writeTerminal).mock.calls.some((c) => String(c[1]).includes("claude --session-id"))).toBe(true);
      // Used up: a second marker types nothing.
      vi.mocked(ipc.writeTerminal).mockClear();
      const p2 = useStore.getState().remoteAttached(id, true);
      await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
      await p2;
      expect(ipc.writeTerminal).not.toHaveBeenCalled();

      const other = await (async () => {
        vi.mocked(ipc.sshCheck).mockResolvedValue(false);
        return useStore.getState().createSshTerminal({ host: "me@box", cwd: "/p", claude: { skipPermissions: false } });
      })();
      useStore.getState().cancelConnecting(other);
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.writeTerminal).mockClear();
      const p3 = useStore.getState().remoteAttached(other, true);
      await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
      await p3;
      expect(ipc.writeTerminal).not.toHaveBeenCalled();
    } finally {
      __stopAllPolling();
      vi.useRealTimers();
    }
  });

  describe("switching sessions in an attached tile", () => {
    const rec = (sid: string, cwd: string, t: string) => ({ sessionId: sid, cwd, skipPermissions: false, startedAt: t, lastActiveAt: t });
    const attachedTile = async () => {
      vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
      const id = await sshTile();
      useStore.setState((s) => ({
        sshConnecting: omitKey(s.sshConnecting, id),
        settings: {
          ...s.settings,
          [id]: { ...s.settings[id], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [rec("cur", "/p", "t2"), rec("old", "/p/old", "t1")] },
        },
      }));
      return id;
    };
    const resumeOld = () => vi.mocked(ipc.writeTerminal).mock.calls.filter((c) => /cd '\/p\/old' && claude --resume old\r$/.test(String(c[1])));

    it("on a live tile, types the picked session when the remote shell is idle", async () => {
      const id = await attachedTile();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p", foregroundBusy: false });
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().selectSession(id, "old", { connect: true });
      expect(ipc.remoteTileInfo).toHaveBeenCalledWith("me@box", id);
      expect(resumeOld()).toHaveLength(1);
      expect(ipc.writeTerminal).toHaveBeenCalledTimes(1);
      expect(useStore.getState().startupNotes[id]).toBeUndefined();
    });

    it("on a live tile, only notes the switch while Claude is still running there", async () => {
      const id = await attachedTile();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p", foregroundBusy: true, foregroundCommand: "claude" });
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().selectSession(id, "old", { connect: false });
      expect(ipc.writeTerminal).not.toHaveBeenCalled();
      expect(useStore.getState().settings[id].claude?.sessionId).toBe("old");
      expect(useStore.getState().startupNotes[id]).toBe("Claude is still running in the session on box; exit it to switch");
      // The note used the pending switch up: a later reattach does not type it.
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p", foregroundBusy: false });
      await useStore.getState().remoteAttached(id, false);
      expect(ipc.writeTerminal).not.toHaveBeenCalled();
    });

    it("on a disconnected tile, connects and switches on the reattach if the shell is idle", async () => {
      const id = await attachedTile();
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().selectSession(id, "old", { connect: true });
      __stopAllPolling();
      expect(vi.mocked(ipc.writeTerminal).mock.calls[0][1]).toContain(`swarmz attach ${id} --cwd '\\''/p/old'\\''`);
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p", foregroundBusy: false });
      await useStore.getState().remoteAttached(id, false);
      expect(resumeOld()).toHaveLength(1);
      // Applied once only.
      await useStore.getState().remoteAttached(id, false);
      expect(resumeOld()).toHaveLength(1);
    });

    it("on a disconnected tile, a reattach to a busy session only notes it", async () => {
      const id = await attachedTile();
      await useStore.getState().selectSession(id, "old", { connect: true });
      __stopAllPolling();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p", foregroundBusy: true });
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().remoteAttached(id, false);
      expect(ipc.writeTerminal).not.toHaveBeenCalled();
      expect(useStore.getState().startupNotes[id]).toMatch(/^Claude is still running in the session on box/);
    });

    it("a failed check is reported, and a closed tile's pending switch is dropped", async () => {
      const id = await attachedTile();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.remoteTileInfo).mockRejectedValueOnce("tool error: boom");
      await useStore.getState().selectSession(id, "old", { connect: false });
      expect(useStore.getState().startupNotes[id]).toBe("could not check the session on box: tool error: boom");

      const other = await attachedTile();
      vi.mocked(ipc.sshCheck).mockResolvedValue(false);
      await useStore.getState().selectSession(other, "old", { connect: true });
      __stopAllPolling();
      await useStore.getState().closeTerminal(other);
      vi.mocked(ipc.remoteTileInfo).mockClear();
      await useStore.getState().remoteAttached(other, false);
      expect(ipc.remoteTileInfo).not.toHaveBeenCalled();
    });

    it("a pick during a new session's settle window types exactly one line, the picked one", async () => {
      vi.useFakeTimers();
      try {
        const id = await attachedTile();
        vi.mocked(ipc.sshCheck).mockResolvedValue(true);
        vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
        vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p", foregroundBusy: false });
        vi.mocked(ipc.writeTerminal).mockClear();
        const marker = useStore.getState().remoteAttached(id, true);
        await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS / 2);
        await useStore.getState().selectSession(id, "old", { connect: false });
        expect(ipc.writeTerminal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
        await marker;
        expect(ipc.writeTerminal).toHaveBeenCalledTimes(1);
        expect(resumeOld()).toHaveLength(1);
        // The pick was carried by that line, so a later reattach does not type it again.
        await useStore.getState().remoteAttached(id, false);
        expect(ipc.writeTerminal).toHaveBeenCalledTimes(1);
        // Run works again once the step is done.
        vi.mocked(ipc.remoteTileInfo).mockClear();
        await useStore.getState().selectSession(id, "cur", { connect: true });
        expect(ipc.remoteTileInfo).toHaveBeenCalledTimes(1);
      } finally {
        __stopAllPolling();
        vi.useRealTimers();
      }
    });

    it("a failed attach drops the pending switch", async () => {
      vi.useFakeTimers();
      try {
        const id = await attachedTile();
        await useStore.getState().selectSession(id, "old", { connect: true });
        expect(useStore.getState().sshConnecting[id]).toBe(true);
        vi.mocked(ipc.sshCheck).mockResolvedValue(true);
        vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
        await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
        expect(useStore.getState().startupNotes[id]).toMatch(/could not start/);
        vi.mocked(ipc.remoteTileInfo).mockClear();
        vi.mocked(ipc.writeTerminal).mockClear();
        await useStore.getState().remoteAttached(id, false);
        expect(ipc.remoteTileInfo).not.toHaveBeenCalled();
        expect(ipc.writeTerminal).not.toHaveBeenCalled();
      } finally {
        __stopAllPolling();
        vi.useRealTimers();
      }
    });

    it("a new session started for the attach line resumes the picked session directly", async () => {
      const id = await attachedTile();
      await useStore.getState().selectSession(id, "old", { connect: true });
      __stopAllPolling();
      vi.mocked(ipc.sshCheck).mockResolvedValue(true);
      vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
      vi.mocked(ipc.writeTerminal).mockClear();
      await useStore.getState().remoteAttached(id, true);
      expect(resumeOld()).toHaveLength(1);
      expect(ipc.remoteTileInfo).not.toHaveBeenCalled();
    });
  });
});

describe("login first, then attach", () => {
  const MASTER = `${sshMasterLine("me@box")}\r`;
  const ATTACH = "~/.swarmz/bin/swarmz attach a";
  const lines = () => vi.mocked(ipc.writeTerminal).mock.calls.map((c) => String(c[1]));

  function seed() {
    useStore.setState({
      selfMachine: "here",
      terminals: { a: { id: "a", name: "a", cwd: "/home/me", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: {
        a: { ssh: { host: "me@box", cwd: "/proj", machine: "box" }, claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: false }, command: null },
      },
      startupPending: { a: true },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    seed();
  });
  afterEach(() => {
    __stopAllPolling();
    vi.useRealTimers();
  });

  it("with no master, types the master line, asks the tool once the master is up, then types the attach line", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    await useStore.getState().runStartup("a");
    expect(lines()).toEqual([MASTER]);
    expect(ipc.toolRemoteReady).not.toHaveBeenCalled();
    expect(useStore.getState().sshConnecting.a).toBe(true);
    expect(useStore.getState().startupPending.a).toBe(false);
    // Logging in: the shell is busy with ssh, no master yet.
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 4);
    expect(lines()).toEqual([MASTER]);
    // Logged in: ssh went to the background, the master is up.
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toMatch(/^ssh -t .* me@box '/);
    expect(lines()[1]).toContain(ATTACH);
    expect(useStore.getState().toolReady["me@box"]).toBe(true);
    expect(useStore.getState().sshConnecting.a).toBe(true);
    // The attach marker connects it and types the startup step.
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    const p = useStore.getState().remoteAttached("a", true);
    await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
    await p;
    expect(lines()[2]).toBe(`export SWARMZ_TERMINAL_ID=a && cd ${shellQuote("/proj")} && claude --session-id sid\r`);
    expect(useStore.getState().sshConnected.a).toBe(true);
  });

  it("with no master and no usable tool, types the master line, then plain ssh, then the remote step", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(false);
    await useStore.getState().runStartup("a");
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    expect(lines()).toEqual([MASTER, `${sshLine("me@box")}\r`]);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS + SSH_SETTLE_MS + 10);
    expect(lines()).toEqual([MASTER, `${sshLine("me@box")}\r`, `export SWARMZ_TERMINAL_ID=a && cd ${shellQuote("/proj")} && claude --session-id sid\r`]);
    expect(useStore.getState().sshConnected.a).toBe(true);
    expect(useStore.getState().sshConnecting.a).toBeUndefined();
  });

  it("a tool check that fails after login falls back to plain ssh", async () => {
    vi.mocked(ipc.toolRemoteReady).mockRejectedValue("timed out");
    await useStore.getState().runStartup("a");
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    expect(lines()).toEqual([MASTER, `${sshLine("me@box")}\r`]);
    expect(useStore.getState().toolReady["me@box"]).toBeUndefined();
  });

  it("with the master already up, asks the tool first and types no master line", async () => {
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    await useStore.getState().runStartup("a");
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain(ATTACH);
  });

  it("with the host's tool already known, types the connect line directly", async () => {
    useStore.setState({ toolReady: { "me@box": true } });
    await useStore.getState().runStartup("a");
    expect(ipc.sshCheck).toHaveBeenCalledTimes(1); // only the liveness check
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain(ATTACH);
  });

  it("a login that fails (the shell is back, no master) shows the note and the card", async () => {
    await useStore.getState().runStartup("a");
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
    expect(useStore.getState().sshConnecting.a).toBe(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    expect(useStore.getState().sshConnecting.a).toBe(true); // one miss is not enough
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    const s = useStore.getState();
    expect(s.sshConnecting.a).toBeUndefined();
    expect(s.startupPending.a).toBe(true);
    expect(s.startupNotes.a).toBe("could not log in to box; see the terminal and click Connect");
    expect(lines()).toEqual([MASTER]);
    expect(ipc.toolRemoteReady).not.toHaveBeenCalled();
    // Connect again logs in again.
    await useStore.getState().runStartup("a");
    expect(lines()).toEqual([MASTER, MASTER]);
  });

  it("a login that never finishes times out with the usual note", async () => {
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await useStore.getState().runStartup("a");
    await vi.advanceTimersByTimeAsync(SSH_POLL_TIMEOUT_MS + SSH_POLL_MS * 2);
    const s = useStore.getState();
    expect(s.sshConnecting.a).toBeUndefined();
    expect(s.startupPending.a).toBe(true);
    expect(s.startupNotes.a).toContain("not detected");
    expect(lines()).toEqual([MASTER]);
  });

  it("a second Connect during the login or the tool check types nothing twice", async () => {
    let resolve: (v: boolean) => void = () => {};
    vi.mocked(ipc.toolRemoteReady).mockImplementation(() => new Promise<boolean>((r) => (resolve = r)));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await Promise.all([useStore.getState().runStartup("a"), useStore.getState().runStartup("a")]);
    await useStore.getState().runStartup("a");
    expect(lines()).toEqual([MASTER]);
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
    // The tool check is in flight: still connecting, and Connect does nothing.
    expect(useStore.getState().sshConnecting.a).toBe(true);
    await useStore.getState().runStartup("a");
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 3);
    expect(lines()).toEqual([MASTER]);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain(ATTACH);
    await useStore.getState().runStartup("a");
    expect(lines()).toHaveLength(2);
  });

  it("cancelling during the tool check types no connect line", async () => {
    let resolve: (v: boolean) => void = () => {};
    vi.mocked(ipc.toolRemoteReady).mockImplementation(() => new Promise<boolean>((r) => (resolve = r)));
    await useStore.getState().runStartup("a");
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    expect(ipc.toolRemoteReady).toHaveBeenCalledTimes(1);
    useStore.getState().cancelConnecting("a");
    resolve(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 2);
    expect(lines()).toEqual([MASTER]);
    expect(useStore.getState().sshConnecting.a).toBeUndefined();
    expect(useStore.getState().startupPending.a).toBe(true);
    // The answer is kept: the next Connect attaches straight away.
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    await useStore.getState().runStartup("a");
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain(ATTACH);
  });

  it("a tile closed during the tool check types nothing", async () => {
    let resolve: (v: boolean) => void = () => {};
    vi.mocked(ipc.toolRemoteReady).mockImplementation(() => new Promise<boolean>((r) => (resolve = r)));
    await useStore.getState().runStartup("a");
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS);
    await useStore.getState().closeTerminal("a");
    resolve(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS * 2);
    expect(lines()).toEqual([MASTER]);
  });
});

describe("connection watchdog", () => {
  const resetModes = vi.fn();

  function connectedTile(opts: { attached?: boolean } = {}) {
    useStore.setState({
      selfMachine: "here",
      terminals: { a: { id: "a", name: "a", cwd: "/home/me", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g", tabs: ["a"], active: "a" },
      settings: {
        a: { ssh: { host: "me@box", cwd: "/proj", machine: "box" }, claude: { enabled: true, sessionId: "sid", skipPermissions: false, started: true }, command: null },
      },
      toolReady: opts.attached ? { "me@box": true } : { "me@box": false },
      startupPending: { a: false },
      sshConnected: { a: true },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetModes.mockClear();
    beforeSpawn.resetModes = resetModes;
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
  });
  afterEach(() => {
    __stopAllPolling();
    vi.useRealTimers();
  });

  it("notices the local shell back in the foreground, offers Reconnect and resets the pane", async () => {
    connectedTile();
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 3);
    expect(ipc.terminalForegroundBusy).toHaveBeenCalledWith("a");
    expect(useStore.getState().sshConnected.a).toBe(true);
    expect(resetModes).not.toHaveBeenCalled();
    // Wi-Fi off: ssh printed "Shared connection to … closed." and exited.
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS);
    const s = useStore.getState();
    expect(s.sshConnected.a).toBeUndefined();
    expect(s.startupPending.a).toBe(true);
    expect(s.startupNotes.a).toBe("Connection to box ended");
    expect(s.sshDropped.a).toBe(true);
    expect(resetModes).toHaveBeenCalledTimes(1);
    expect(resetModes).toHaveBeenCalledWith("a");
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    // Not connected any more: no more checks.
    vi.mocked(ipc.terminalForegroundBusy).mockClear();
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 3);
    expect(ipc.terminalForegroundBusy).not.toHaveBeenCalled();
  });

  it("Reconnect types the connect line again, and connecting clears the dropped mark", async () => {
    connectedTile();
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS);
    expect(useStore.getState().sshDropped.a).toBe(true);
    await useStore.getState().runStartup("a");
    expect(vi.mocked(ipc.writeTerminal).mock.calls.map((c) => c[1])).toEqual([`${sshLine("me@box")}\r`]);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(SSH_POLL_MS + SSH_SETTLE_MS + 10);
    const s = useStore.getState();
    expect(s.sshConnected.a).toBe(true);
    expect(s.sshDropped.a).toBeUndefined();
    expect(s.startupNotes.a).toBeUndefined();
  });

  it("an attached tile says its session is still running, and Reconnect rejoins it", async () => {
    // Connecting installs the agent hooks, which asks the tool again.
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    connectedTile({ attached: true });
    await useStore.getState().remoteAttached("a", false);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS);
    expect(useStore.getState().startupNotes.a).toBe("Connection to box ended; the session is still running there, and Reconnect rejoins it");
    expect(useStore.getState().startupPending.a).toBe(true);
    vi.mocked(ipc.sshCheck).mockResolvedValue(false);
    await useStore.getState().runStartup("a");
    const typed = vi.mocked(ipc.writeTerminal).mock.calls.map((c) => String(c[1]));
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("~/.swarmz/bin/swarmz attach a");
    await useStore.getState().remoteAttached("a", false);
    expect(useStore.getState().sshConnected.a).toBe(true);
    expect(vi.mocked(ipc.writeTerminal).mock.calls).toHaveLength(1);
  });

  it("an attach that was still pending is forgotten when the connection ends", async () => {
    vi.mocked(ipc.toolRemoteReady).mockResolvedValue(true);
    connectedTile({ attached: true });
    useStore.setState({ sshConnected: {} });
    vi.mocked(ipc.sshCheck).mockResolvedValue(false);
    await useStore.getState().runStartup("a"); // types the attach line; not connected yet
    expect(vi.mocked(ipc.writeTerminal).mock.lastCall?.[1]).toContain("swarmz attach a");
    // The attach reported in, then the connection dropped before the step was typed.
    __stopAllPolling();
    useStore.setState((s) => ({ sshConnecting: omitKey(s.sshConnecting, "a"), sshConnected: { a: true } }));
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS);
    expect(useStore.getState().sshConnected.a).toBeUndefined();
    // A late marker from a later connection must not type the step for the old attach line.
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    vi.mocked(ipc.writeTerminal).mockClear();
    const p = useStore.getState().remoteAttached("a", true);
    await vi.advanceTimersByTimeAsync(SSH_SETTLE_MS);
    await p;
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("never judges a tile while it is connecting or logging in", async () => {
    connectedTile();
    useStore.setState({ toolReady: {} });
    vi.mocked(ipc.sshCheck).mockResolvedValue(false);
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(true);
    await useStore.getState().runStartup("a"); // master line; connecting
    expect(useStore.getState().sshConnecting.a).toBe(true);
    // Something marks it connected while the login is still polling: the watchdog keeps out.
    useStore.setState({ sshConnected: { a: true } });
    vi.mocked(ipc.terminalForegroundBusy).mockResolvedValue(false);
    vi.mocked(ipc.sshCheck).mockResolvedValue(true);
    vi.mocked(ipc.toolRemoteReady).mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 3);
    const s = useStore.getState();
    expect(s.startupNotes.a).toBeUndefined();
    expect(s.sshDropped.a).toBeUndefined();
    expect(resetModes).not.toHaveBeenCalled();
  });

  it("an unanswered check is not a disconnect, and only one check runs per tile", async () => {
    connectedTile();
    vi.mocked(ipc.terminalForegroundBusy).mockRejectedValueOnce("holder busy");
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS);
    expect(useStore.getState().sshConnected.a).toBe(true);
    vi.mocked(ipc.terminalForegroundBusy).mockClear().mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 4);
    expect(ipc.terminalForegroundBusy).toHaveBeenCalledTimes(1);
    expect(useStore.getState().sshConnected.a).toBe(true);
  });

  it("stops when the tile closes or exits", async () => {
    connectedTile();
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS);
    await useStore.getState().closeTerminal("a");
    vi.mocked(ipc.terminalForegroundBusy).mockClear().mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 3);
    expect(ipc.terminalForegroundBusy).not.toHaveBeenCalled();
    expect(resetModes).not.toHaveBeenCalled();

    connectedTile();
    useStore.getState().markExited("a", 0);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 3);
    expect(ipc.terminalForegroundBusy).not.toHaveBeenCalled();
    expect(useStore.getState().startupNotes.a).toBeUndefined();
  });

  it("never watches local tiles", async () => {
    const id = await useStore.getState().createTerminal("/tmp/x");
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true } }));
    vi.mocked(ipc.terminalForegroundBusy).mockClear().mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(SSH_WATCHDOG_MS * 2);
    expect(ipc.terminalForegroundBusy).not.toHaveBeenCalled();
  });
});

describe("sessions outside the workspace", () => {
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  const fresh = new Date().toISOString();
  const ninetySeconds = new Date(Date.now() - 90_000).toISOString();
  const row = (id: string, extra: Partial<import("./lib/ipc").SessionRow> = {}) => ({
    id, name: id, running: true, pid: 1, startedAt: old, exitedAt: null, exitCode: null, known: false, ...extra,
  });

  it("lists running, unknown, settled sessions that no tile shows", async () => {
    useStore.setState({ terminals: { open1: { id: "open1", name: "o", cwd: "/", exited: null, error: null } } });
    vi.mocked(ipc.localSessions).mockResolvedValueOnce([
      row("orphan"),
      row("known1", { known: true }),
      row("open1"),
      row("dead", { running: false }),
      row("new1", { startedAt: fresh }),
      row("new2", { startedAt: ninetySeconds }),
    ]);
    await useStore.getState().refreshOutsideSessions();
    expect(useStore.getState().outsideSessions).toEqual(["orphan"]);
  });

  it("closes them and reports the first failure", async () => {
    useStore.setState({ outsideSessions: ["a", "b"] });
    vi.mocked(ipc.closeSession).mockClear().mockRejectedValueOnce("nope").mockResolvedValueOnce(true);
    vi.mocked(ipc.localSessions).mockResolvedValueOnce([row("a"), row("b")]).mockResolvedValueOnce([]);
    const err = await useStore.getState().closeOutsideSessions();
    expect(ipc.closeSession).toHaveBeenCalledWith("a");
    expect(ipc.closeSession).toHaveBeenCalledWith("b");
    expect(err).toBe("could not close a: nope");
    expect(useStore.getState().outsideSessions).toEqual([]);
  });

  it("closes only sessions that are still outside when asked", async () => {
    useStore.setState({ outsideSessions: ["a", "b"] });
    vi.mocked(ipc.closeSession).mockClear().mockResolvedValue(true);
    // "a" became known meanwhile; "c" is new and was never shown.
    vi.mocked(ipc.localSessions).mockResolvedValueOnce([row("a", { known: true }), row("b"), row("c")]).mockResolvedValueOnce([row("c")]);
    const err = await useStore.getState().closeOutsideSessions();
    expect(err).toBeNull();
    expect(vi.mocked(ipc.closeSession).mock.calls).toEqual([["b"]]);
    expect(useStore.getState().outsideSessions).toEqual(["c"]);
  });

  it("closes nothing when the sessions cannot be read", async () => {
    useStore.setState({ outsideSessions: ["a"] });
    vi.mocked(ipc.closeSession).mockClear();
    vi.mocked(ipc.localSessions).mockRejectedValueOnce("broken").mockRejectedValueOnce("broken");
    expect(await useStore.getState().closeOutsideSessions()).toBeNull();
    expect(ipc.closeSession).not.toHaveBeenCalled();
    expect(useStore.getState().outsideSessions).toEqual([]);
  });

  it("keeps the list when the sessions cannot be read", async () => {
    useStore.setState({ outsideSessions: ["x"] });
    vi.mocked(ipc.localSessions).mockRejectedValueOnce("broken");
    await useStore.getState().refreshOutsideSessions();
    expect(useStore.getState().outsideSessions).toEqual(["x"]);
  });
});

describe("windows and layouts", () => {
  const calls: string[] = [];
  // The store suite runs in node: the per-Mac record needs a localStorage to land in.
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    calls.length = 0;
    windowHooks.open = async (label, at) => void calls.push(`open ${label} ${at ? `${at.x},${at.y}` : "-"}`);
    windowHooks.close = (label) => void calls.push(`close ${label}`);
    windowHooks.focus = (label) => void calls.push(`focus ${label}`);
    windowHooks.windowAt = async () => null;
    windowHooks.dropAt = (label, id) => void calls.push(`drop ${label} ${id}`);
    windowHooks.boundsOf = async () => null;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    windowHooks.open = async () => {};
    windowHooks.close = () => {};
    windowHooks.focus = () => {};
    windowHooks.windowAt = async () => null;
    windowHooks.dropAt = () => {};
    windowHooks.boundsOf = async () => null;
  });
  const labels = () => Object.keys(useStore.getState().windows);

  it("closing a tab keeps the tile running, not open, with a notice whose Undo puts it back", async () => {
    vi.mocked(ipc.closeTerminal).mockClear();
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const g = allGroups(useStore.getState().layout)[0].id;
    useStore.getState().closeTab(b);
    let s = useStore.getState();
    expect(s.order).toEqual([a, b]);
    expect(s.terminals[b]).toBeDefined();
    expect(ipc.closeTerminal).not.toHaveBeenCalled();
    expect(allGroups(s.layout)[0].tabs).toEqual([a]);
    expect(s.closedNotice).toMatchObject({ window: "main", ids: [b] });
    await useStore.getState().undoClosed();
    s = useStore.getState();
    expect(findGroup(s.layout, g)?.tabs).toEqual([a, b]);
    expect(s.closedNotice).toBeNull();
  });

  it("clicking a tile that is not open opens it in the main window's focused group", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    useStore.getState().closeTab(b);
    useStore.getState().focusTerminal(b);
    const s = useStore.getState();
    expect(allGroups(s.layout)[0].tabs).toEqual([a, b]);
    expect(s.focusedTerminalId).toBe(b);
  });

  it("a new window takes the tile's space with it, and closes when its last tile leaves", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    await useStore.getState().openInNewWindow([b], { x: 300, y: 200 });
    let s = useStore.getState();
    const [w] = labels();
    expect(w).toMatch(/^win-/);
    expect(allGroups(s.layout)[0].tabs).toEqual([a]);
    expect(allGroups(s.windows[w].layout)[0].tabs).toEqual([b]);
    expect(calls).toEqual([`open ${w} 300,200`]);
    // Dragged back onto the main window's group: the window is empty and closes.
    const g = allGroups(s.layout)[0].id;
    useStore.getState().moveTerminal(b, g);
    s = useStore.getState();
    expect(allGroups(s.layout)[0].tabs).toEqual([a, b]);
    expect(s.windows).toEqual({});
    expect(calls).toEqual([`open ${w} 300,200`, `close ${w}`]);
  });

  it("splits and moves work across windows, and focusing a tile in another window brings it forward", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const c = await useStore.getState().createTerminal("/tmp/c");
    await useStore.getState().openInNewWindow([c], null);
    const [w] = labels();
    const wg = allGroups(useStore.getState().windows[w].layout)[0].id;
    useStore.getState().splitTerminal(a, wg, "right");
    let s = useStore.getState();
    expect(allGroups(s.layout)[0].tabs).toEqual([b]);
    expect(allGroups(s.windows[w].layout).map((g) => g.tabs)).toEqual([[c], [a]]);
    expect(s.windows[w].focusedGroupId).toBe(findGroupOf(s.windows[w].layout, a)?.id);
    // A new tile made from that window's + lands there.
    const d = await useStore.getState().createTerminal("/tmp/d", { kind: "tab", groupId: wg });
    s = useStore.getState();
    expect(findGroup(s.windows[w].layout, wg)?.tabs).toEqual([c, d]);
    calls.length = 0;
    useStore.getState().focusTerminal(c);
    expect(calls).toEqual([`focus ${w}`]);
    expect(findGroup(useStore.getState().windows[w].layout, wg)?.active).toBe(c);
  });

  it("a whole group moves to a new window keeping the tab it showed", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const c = await useStore.getState().createTerminal("/tmp/c");
    const g = allGroups(useStore.getState().layout)[0].id;
    useStore.getState().splitTerminal(c, g, "right");
    useStore.getState().focusTerminal(a);
    await useStore.getState().moveGroupToNewWindow(g);
    const s = useStore.getState();
    const [w] = labels();
    expect(allGroups(s.layout).map((x) => x.tabs)).toEqual([[c]]);
    const moved = allGroups(s.windows[w].layout)[0];
    expect(moved.tabs.sort()).toEqual([a, b].sort());
    expect(moved.active).toBe(a);
  });

  it("closing a window closes its tabs; Undo brings the window back with its layout", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    await useStore.getState().openInNewWindow([b], null);
    const [w] = labels();
    await useStore.getState().closeWindow(w);
    let s = useStore.getState();
    expect(s.windows).toEqual({});
    expect(s.order).toEqual([a, b]);
    expect(s.closedNotice).toMatchObject({ window: "main", ids: [b] });
    await useStore.getState().undoClosed();
    s = useStore.getState();
    const [w2] = labels();
    expect(allGroups(s.windows[w2].layout)[0].tabs).toEqual([b]);
    expect(calls.filter((c) => c.startsWith("open"))).toHaveLength(2);
  });

  it("a drag no window took: over nothing a new window, over another window a drop there, over its own nothing", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    await useStore.getState().dropOutside(b, { x: 5, y: 6 }, "main");
    const [w] = labels();
    expect(calls).toEqual([`open ${w} 5,6`]);
    calls.length = 0;
    windowHooks.windowAt = async () => "main";
    await useStore.getState().dropOutside(a, { x: 1, y: 1 }, "main");
    expect(calls).toEqual([]);
    await useStore.getState().dropOutside(b, { x: 1, y: 1 }, w);
    expect(calls).toEqual([`drop main ${b}`]);
    // A drop another window's webview took just now is not placed twice.
    calls.length = 0;
    useStore.getState().moveTerminal(a, allGroups(useStore.getState().windows[w].layout)[0].id);
    await useStore.getState().dropOutside(a, { x: 1, y: 1 }, "main");
    expect(calls).toEqual([]);
  });

  it("a preset arranges the window's tiles, leaving empty slots, and a slot is filled or removed", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    const g = allGroups(useStore.getState().layout)[0].id;
    useStore.getState().toggleZoom(g);
    useStore.getState().applyPreset(g, "main-and-two");
    let s = useStore.getState();
    const groups = allGroups(s.layout);
    expect(groups.map((x) => x.tabs)).toEqual([[b], [a], []]);
    expect(groups[2].slot).toBe(true);
    expect(s.zoomed).toEqual({});
    const c = await useStore.getState().createTerminal("/tmp/c");
    useStore.getState().closeTab(c);
    useStore.getState().moveTerminal(c, groups[2].id);
    s = useStore.getState();
    expect(findGroup(s.layout, groups[2].id)?.tabs).toEqual([c]);
    expect(findGroup(s.layout, groups[2].id)?.slot).toBeUndefined();
    useStore.getState().applyPreset(allGroups(s.layout)[0].id, "grid");
    const empty = allGroups(useStore.getState().layout).find((x) => x.tabs.length === 0)!;
    useStore.getState().removeSlot(empty.id);
    expect(allGroups(useStore.getState().layout).map((x) => x.tabs.length)).toEqual([1, 1, 1]);
  });

  it("picking tiles toggles and ranges, and arranging them in the main window closes the rest there", async () => {
    const [a, b, c, d] = [await useStore.getState().createTerminal("/tmp/a"), await useStore.getState().createTerminal("/tmp/b"), await useStore.getState().createTerminal("/tmp/c"), await useStore.getState().createTerminal("/tmp/d")];
    const visible = [a, b, c, d];
    useStore.getState().selectTile(b, "toggle", visible);
    useStore.getState().selectTile(d, "range", visible);
    expect(useStore.getState().selectedTiles).toEqual([b, c, d]);
    useStore.getState().selectTile(c, "toggle", visible);
    expect(useStore.getState().selectedTiles).toEqual([b, d]);
    useStore.getState().selectTiles([a, b]);
    expect(useStore.getState().selectedTiles).toEqual([a, b]);
    useStore.getState().selectTiles([a, b]);
    expect(useStore.getState().selectedTiles).toEqual([]);
    useStore.getState().selectTiles([d, a]);
    await useStore.getState().arrangeSelection("side-by-side", "main");
    const s = useStore.getState();
    expect(allGroups(s.layout).map((x) => x.tabs)).toEqual([[d], [a]]);
    expect(s.selectedTiles).toEqual([]);
    expect(s.closedNotice?.ids.sort()).toEqual([b, c].sort());
    expect(s.order).toHaveLength(4);
    useStore.getState().selectTiles([b, c]);
    await useStore.getState().arrangeSelection("stacked", "new");
    const [w] = labels();
    expect(allGroups(useStore.getState().windows[w].layout).map((x) => x.tabs)).toEqual([[b], [c]]);
  });

  it("a tile in another window counts as seen when that window has focus", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    await useStore.getState().openInNewWindow([b], null);
    const [w] = labels();
    useStore.setState({ agentState: { [b]: { status: "idle", sessionId: "s", since: "t", lastEvent: "Stop", unseen: true, title: null, firstPrompt: null } } });
    useStore.getState().windowFocus("main", true);
    expect(useStore.getState().agentState[b].unseen).toBe(true);
    useStore.getState().windowFocus(w, true);
    expect(useStore.getState().agentState[b].unseen).toBe(false);
    // A late blur from the main window does not unfocus the app.
    useStore.getState().windowFocus("main", false);
    expect(useStore.getState().windowFocused).toBe(true);
    useStore.getState().windowFocus(w, false);
    expect(useStore.getState().windowFocused).toBe(false);
    void a;
  });

  it("closing the last tab of another window closes the window, with a window Undo in the main one", async () => {
    await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    await useStore.getState().openInNewWindow([b], null);
    const [w] = labels();
    useStore.getState().closeTab(b);
    await vi.waitFor(() => expect(useStore.getState().windows).toEqual({}));
    expect(useStore.getState().closedNotice).toMatchObject({ window: "main", ids: [b], undo: { kind: "window" } });
    expect(calls).toContain(`close ${w}`);
  });

  it("stopping a tile takes it out of every window and the selection", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    const b = await useStore.getState().createTerminal("/tmp/b");
    await useStore.getState().openInNewWindow([b], null);
    useStore.getState().selectTiles([a, b]);
    await useStore.getState().closeTerminal(b);
    const s = useStore.getState();
    expect(s.windows).toEqual({});
    expect(s.selectedTiles).toEqual([a]);
  });

  it("the layout is this Mac's: kept in localStorage, never saved to the file nor taken from it", async () => {
    useStore.setState({ persistenceReady: false });
    const peerLayout = { kind: "group" as const, id: "g-file", tabs: ["t1", "t2"], active: "t1" };
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: peerLayout,
      terminals: [
        { id: "t1", name: "one", cwd: "/tmp/1", ssh: null, claude: null, command: null },
        { id: "t2", name: "two", cwd: "/tmp/2", ssh: null, claude: null, command: null },
      ],
    });
    // This Mac shows only t2, and a window that shows t1.
    localStorage.setItem("swarmz.layouts", JSON.stringify({ main: { kind: "group", id: "g-here", tabs: ["t2", "gone"], active: "t2" }, "win-abcd": { kind: "group", id: "g-w", tabs: ["t1"], active: "t1" } }));
    await useStore.getState().loadWorkspace();
    let s = useStore.getState();
    expect(s.layout).toEqual({ kind: "group", id: "g-here", tabs: ["t2"], active: "t2" });
    expect(Object.keys(s.windows)).toEqual(["win-abcd"]);
    expect(s.fileLayout).toEqual(peerLayout);
    await useStore.getState().restoreWindows();
    expect(calls).toEqual(["open win-abcd -"]);
    // A layout change is saved here, not to the file; a save writes the file's layout back untouched.
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 50));
    vi.mocked(ipc.saveWorkspace).mockClear();
    useStore.getState().closeTab("t2");
    expect(JSON.parse(localStorage.getItem("swarmz.layouts")!).main).toBeNull();
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 50));
    expect(ipc.saveWorkspace).not.toHaveBeenCalled();
    s = useStore.getState();
    const ws = toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.fileLayout, machines: s.machines });
    expect(ws.layout).toEqual(peerLayout);
  });

  it("the first run takes the file's layout and turns old breakouts into windows", async () => {
    useStore.setState({ persistenceReady: false });
    localStorage.setItem("swarmz.breakouts", JSON.stringify({ t2: { bounds: { x: 1, y: 2, width: 300, height: 200 } } }));
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({
      version: 1, layout: { kind: "group", id: "g-file", tabs: ["t1", "t2"], active: "t1" },
      terminals: [
        { id: "t1", name: "one", cwd: "/tmp/1", ssh: null, claude: null, command: null },
        { id: "t2", name: "two", cwd: "/tmp/2", ssh: null, claude: null, command: null },
        { id: "t3", name: "three", cwd: "/tmp/3", ssh: null, claude: null, command: null },
      ],
    });
    await useStore.getState().loadWorkspace();
    const s = useStore.getState();
    expect(allGroups(s.layout)[0].tabs).toEqual(["t1", "t3"]);
    const [w] = labels();
    expect(allGroups(s.windows[w].layout)[0].tabs).toEqual(["t2"]);
    expect(localStorage.getItem("swarmz.breakouts")).toBeNull();
    expect(JSON.parse(localStorage.getItem("swarmz.windowBounds")!)[w]).toEqual({ x: 1, y: 2, width: 300, height: 200 });
  });
});

describe("machine themes", () => {
  it("a tile takes its Mac's theme: picked, else by place; plain keeps the colour tint", async () => {
    const { tileTheme, tileThemeId } = await import("./store");
    useStore.setState({
      selfMachine: "mini",
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [{ name: "mini-2", hostName: "m2", ip: "100.1.1.2", os: "macOS", online: true }] },
      machines: { "mini-2": { lastUsed: "t", color: "#22c55e" } },
      terminals: { l: { id: "l", name: "l", cwd: "/", exited: null, error: null }, r: { id: "r", name: "r", cwd: "/", exited: null, error: null } },
      settings: { l: { ...EMPTY_SETTINGS }, r: { ...EMPTY_SETTINGS, ssh: { host: "mokes@mini-2", cwd: null, machine: "mini-2" } } },
    });
    const s = () => useStore.getState();
    expect(tileThemeId(s(), "l")).not.toBe(tileThemeId(s(), "r"));
    expect(await s().updateMachine("mini-2", { theme: "bogus" })).toBe("unsupported theme");
    expect(await s().updateMachine("mini-2", { theme: "neon" })).toBeNull();
    expect(tileThemeId(s(), "r")).toBe("neon");
    expect(tileTheme(s(), "r").background).toBe("#0d0221");
    await s().updateMachine("mini-2", { theme: "plain" });
    expect(tileTheme(s(), "r").background).not.toBe("#0f1115");
    await s().updateMachine("mini-2", { theme: null });
    expect(s().machines["mini-2"].theme).toBeNull();
  });

  it("keeps a Mac's theme through the workspace and drops an unknown one without dropping the Mac", async () => {
    useStore.setState({ persistenceReady: false });
    vi.mocked(ipc.loadWorkspace).mockResolvedValueOnce({ version: 1, layout: null, terminals: [], machines: { a: { lastUsed: "t", theme: "daylight" }, b: { lastUsed: "t", theme: "from-the-future" } } });
    await useStore.getState().loadWorkspace();
    expect(useStore.getState().machines.a.theme).toBe("daylight");
    expect(useStore.getState().machines.b).toEqual({ lastUsed: "t" });
  });
});

describe("identify", () => {
  it("brings a tile forward and labels it for a moment; Identify all numbers them in list order", async () => {
    vi.useFakeTimers();
    try {
      const { IDENTIFY_MS } = await import("./store");
      const a = await useStore.getState().createTerminal("/tmp/a");
      const b = await useStore.getState().createTerminal("/tmp/b");
      useStore.getState().focusTerminal(a);
      useStore.getState().identifyTile(b);
      expect(useStore.getState().identify).toMatchObject({ ids: [b], numbered: false });
      expect(allGroups(useStore.getState().layout)[0].active).toBe(b);
      useStore.getState().identifyAll([b, a, "gone"]);
      expect(useStore.getState().identify).toMatchObject({ ids: [b, a], numbered: true });
      vi.advanceTimersByTime(IDENTIFY_MS + 10);
      expect(useStore.getState().identify).toBeNull();
      // A tile not open anywhere is labelled in the list only; it does not open.
      useStore.getState().closeTab(a);
      useStore.getState().identifyTile(a);
      expect(useStore.getState().identify?.ids).toEqual([a]);
      expect(allGroups(useStore.getState().layout)[0].tabs).toEqual([b]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tile boards", () => {
  it("a Board event replaces the tile's board, and clearing it leaves none", async () => {
    const a = await useStore.getState().createTerminal("/tmp/a");
    useStore.getState().applyAgentEvent({ host: null, event: { ts: new Date(Date.now() + 1000).toISOString(), terminal: a, event: "Board", sessionId: null, notificationType: null, source: null, cwd: null, permissionMode: null, board: { overview: { goal: "G" } } } });
    expect(useStore.getState().boards[a].board?.overview?.goal).toBe("G");
    // Its status is untouched.
    expect(useStore.getState().agentState[a]).toBeUndefined();
    useStore.getState().applyAgentEvent({ host: null, event: { ts: new Date(Date.now() + 2000).toISOString(), terminal: a, event: "Board", sessionId: null, notificationType: null, source: null, cwd: null, permissionMode: null, board: null } });
    expect(useStore.getState().boards[a].board).toBeNull();
  });

  it("hovering a row marks its tile until the pointer leaves", () => {
    useStore.getState().hoverTile("x");
    expect(useStore.getState().hoveredTile).toBe("x");
    useStore.getState().hoverTile(null);
    expect(useStore.getState().hoveredTile).toBeNull();
  });
});
