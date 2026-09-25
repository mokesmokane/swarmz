// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("../lib/xtermRegistry", () => ({ attach: vi.fn(() => ({ term: {}, fit: { fit: vi.fn() } })), fitAndFocus: vi.fn(), claimSize: vi.fn() }));

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
    windowLabel: "main",
    windows: {},
    zoomed: {},
    selectedTiles: [],
    closedNotice: null,
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

  it("marks the conductor's tab", () => {
    useStore.setState({ conductor: ID });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: [ID], active: ID }} />);
    expect(screen.getByTestId(`tab-${ID}`).querySelector("[aria-label='Conductor']")).toBeTruthy();
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

describe("windows and layouts", () => {
  const two = () =>
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
    });

  it("a tab's × closes the tab and keeps the tile; ↗ moves it to a new window", async () => {
    const { windowHooks } = await import("../store");
    const opened: string[] = [];
    windowHooks.open = async (label) => void opened.push(label);
    two();
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: ["a", "b"], active: "b" }} />);
    screen.getAllByLabelText("Close tab")[1].click();
    let s = useStore.getState();
    expect(s.terminals.b).toBeDefined();
    expect(s.layout).toEqual({ kind: "group", id: "g1", tabs: ["a"], active: "a" });
    expect(s.closedNotice?.ids).toEqual(["b"]);
    screen.getAllByLabelText("Move to a new window")[0].click();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    s = useStore.getState();
    expect(s.layout).toBeNull();
    expect(Object.values(s.windows)[0].layout).toMatchObject({ tabs: ["a"] });
    windowHooks.open = async () => {};
  });

  it("a tab's menu moves it to another window, or stops it", async () => {
    two();
    useStore.setState({
      terminals: { ...useStore.getState().terminals, c: { id: "c", name: "gamma", cwd: "/c", exited: null, error: null } },
      windows: { "win-abcd": { layout: { kind: "group", id: "g9", tabs: ["c"], active: "c" }, focusedGroupId: "g9" } },
    });
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: ["a", "b"], active: "b" }} />);
    fireEvent.contextMenu(screen.getByTestId("tab-a"));
    const menu = screen.getByTestId("tab-menu-a");
    expect(menu.textContent).toContain("New window");
    fireEvent.click(screen.getByRole("menuitem", { name: "gamma" }));
    const s = useStore.getState();
    expect(s.windows["win-abcd"].layout).toMatchObject({ tabs: ["c", "a"] });
    expect(s.layout).toMatchObject({ tabs: ["b"] });
  });

  it("the gallery arranges the window's tiles, and an empty slot picks a tile", async () => {
    two();
    useStore.setState({ order: ["a", "b", "c"], terminals: { ...useStore.getState().terminals, c: { id: "c", name: "gamma", cwd: "/c", exited: null, error: null } } });
    const { rerender } = render(<TabGroup group={useStore.getState().layout as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Layouts" }));
    expect(screen.getByTestId("preset-side-by-side").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("preset-three-columns"));
    const groups = (await import("../lib/layout")).allGroups(useStore.getState().layout);
    expect(groups.map((g) => g.tabs)).toEqual([["b"], ["a"], []]);
    rerender(<TabGroup group={groups[2]} />);
    expect(screen.getByTestId(`slot-tab-${groups[2].id}`).textContent).toContain("Empty slot");
    // c is not open anywhere, so it is listed first.
    const picks = screen.getAllByRole("option").map((o) => o.getAttribute("data-testid"));
    expect(picks[0]).toBe("slot-pick-c");
    screen.getByTestId("slot-pick-c").click();
    expect((await import("../lib/layout")).findGroup(useStore.getState().layout, groups[2].id)?.tabs).toEqual(["c"]);
  });

  it("zoom fills the window with the group and back", async () => {
    two();
    render(<TabGroup group={{ kind: "group", id: "g1", tabs: ["a", "b"], active: "b" }} />);
    screen.getByLabelText("Zoom").click();
    expect(useStore.getState().zoomed).toEqual({ main: "g1" });
  });

  it("a drag no drop zone took is handed to the store with the pointer's screen position", async () => {
    const { endTabDrag } = await import("./TabGroup");
    const { windowHooks } = await import("../store");
    const opened: string[] = [];
    windowHooks.open = async (label, at) => void opened.push(`${label.slice(0, 4)} ${at?.x},${at?.y}`);
    two();
    const drag = (dropEffect: string) => endTabDrag("a", { dataTransfer: { dropEffect } as DataTransfer, screenX: 2000, screenY: 300 });
    await drag("move");
    expect(opened).toEqual([]);
    await drag("none");
    expect(opened).toEqual(["win- 2000,300"]);
    windowHooks.open = async () => {};
  });
});
