// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    createTerminal: vi.fn(async () => ({})),
    writeTerminal: vi.fn(async () => {}),
    resizeTerminal: vi.fn(async () => {}),
    renameTerminal: vi.fn(async () => ({})),
    closeTerminal: vi.fn(async () => {}),
    restartTerminal: vi.fn(async () => ({})),
    listTerminals: vi.fn(async () => []),
    onData: vi.fn(async () => () => {}),
    onReplay: vi.fn(async () => () => {}),
    onExit: vi.fn(async () => () => {}),
    loadWorkspace: vi.fn(async () => null),
    saveWorkspace: vi.fn(async () => {}),
    sshCheck: vi.fn(async () => false),
    sshOpenMaster: vi.fn(async () => false),
    sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),
    terminalForegroundBusy: vi.fn(async () => false),
    terminalCwd: vi.fn(async () => null),
    setTerminalCwd: vi.fn(async (id: string, cwd: string) => ({ id, name: "x", cwd, exited: null, error: null })),
    tailscaleStatus: vi.fn(async () => ({ running: true, message: null, user: "mokes", self: null, peers: [] })),
    tailscaleOpen: vi.fn(async () => {}),
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
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../lib/xtermRegistry", () => ({ attach: vi.fn(() => ({ term: {}, fit: { fit: vi.fn() } })), fitAndFocus: vi.fn() }));

import { __stopAllPolling, useStore } from "../store";
import { TabGroup } from "./TabGroup";

const ID = "t1";
class FakeResizeObserver { observe() {} disconnect() {} }

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: null, error: null } },
    order: [ID],
    layout: { kind: "group", id: "g1", tabs: [ID], active: ID },
    focusedGroupId: "g1",
    focusedTerminalId: ID,
    settings: { [ID]: { ssh: null, claude: null, command: null, extra: {} } },
    startupPending: {},
    startupNotes: {},
    machines: {},
    agentState: {},
    windowFocused: true,
  });
});

afterEach(() => {
  __stopAllPolling();
  cleanup();
});

describe("tab dot", () => {
  it("shows the agent status colour and ring", () => {
    useStore.setState({ agentState: { [ID]: { status: "working", sessionId: "s", since: "t", lastEvent: "UserPromptSubmit", unseen: false, title: null, firstPrompt: null } } });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    const dot = screen.getByTestId(`tab-dot-${ID}`);
    expect(dot.style.backgroundColor).toBe("rgb(37, 191, 53)");
    expect(dot.className).not.toContain("ring-2");
    expect(dot.title).toBe("working · UserPromptSubmit");
  });

  it("keeps a clean exit grey even with agent state", () => {
    useStore.setState({
      terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: 0, error: null } },
      agentState: { [ID]: { status: "idle", sessionId: "s", since: "t", lastEvent: "Stop", unseen: true, title: null, firstPrompt: null } },
    });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    expect(screen.getByTestId(`tab-dot-${ID}`).className).toContain("bg-neutral-600");
  });
});

describe("breakout windows", () => {
  it("a broken-out tab is a placeholder that brings its window forward, and the pane stands in", async () => {
    const { breakoutHooks } = await import("../store");
    const { TabGroup } = await import("./TabGroup");
    const calls: string[] = [];
    breakoutHooks.open = async (id) => void calls.push(`open ${id}`);
    breakoutHooks.focus = (id) => void calls.push(`focus ${id}`);
    breakoutHooks.close = () => {};
    useStore.setState({
      terminals: {
        a: { id: "a", name: "alpha", cwd: "/a", exited: null, error: null },
        b: { id: "b", name: "beta", cwd: "/b", exited: null, error: null },
      },
      order: ["a", "b"],
      layout: { kind: "group", id: "g1", tabs: ["a", "b"], active: "b" },
      focusedGroupId: "g1",
      focusedTerminalId: "b",
      settings: {},
      agentState: {},
      breakouts: { b: true },
    });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: ["a", "b"], active: "b" }} />);
    expect(screen.getByTestId("placeholder-b").textContent).toContain("beta is in its own window");
    expect(screen.getByTestId("tab-b").dataset.breakout).toBe("true");
    // Clicking the placeholder tab focuses the window rather than the pane.
    screen.getByTestId("tab-b").click();
    await vi.waitFor(() => expect(calls).toEqual(["focus b"]));
    // The other tab's hover button breaks it out.
    screen.getByLabelText("Open in its own window").click();
    await vi.waitFor(() => expect(calls).toEqual(["focus b", "open a"]));
    expect(useStore.getState().breakouts).toEqual({ a: true, b: true });
    localStorage.removeItem("swarmz.breakouts");
    breakoutHooks.open = async () => {};
    breakoutHooks.focus = () => {};
  });

  it("a drag that ends outside the window breaks the tile out; inside does not", async () => {
    const { breakoutHooks } = await import("../store");
    const { endTabDrag } = await import("./TabGroup");
    const calls: string[] = [];
    breakoutHooks.open = async (id, at) => void calls.push(`open ${id} ${at?.x},${at?.y}`);
    breakoutHooks.mainBounds = async () => ({ x: 100, y: 100, width: 800, height: 600 });
    useStore.setState({
      terminals: { a: { id: "a", name: "alpha", cwd: "/a", exited: null, error: null } },
      order: ["a"],
      layout: { kind: "group", id: "g1", tabs: ["a"], active: "a" },
      breakouts: {},
    });
    const drag = (dropEffect: string, screenX: number, screenY: number) =>
      endTabDrag("a", { dataTransfer: { dropEffect } as DataTransfer, screenX, screenY });
    await drag("move", 2000, 300);
    expect(calls).toEqual([]);
    await drag("none", 300, 300);
    expect(calls).toEqual([]);
    await drag("none", 2000, 300);
    expect(calls).toEqual(["open a 2000,300"]);
    expect(useStore.getState().breakouts).toEqual({ a: true });
    localStorage.removeItem("swarmz.breakouts");
    breakoutHooks.open = async () => {};
    breakoutHooks.mainBounds = async () => null;
  });
});
