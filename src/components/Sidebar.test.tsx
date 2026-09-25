// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    createTerminal: vi.fn(async (id: string, cwd: string, _c: number, _r: number, name?: string) => ({
      id,
      name: name ?? "x",
      cwd,
      exited: null,
      error: null,
    })),
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
    machineStats: vi.fn(async () => ({ cpu: { percent: 12, load1: 1, cores: 8 }, memory: { usedPercent: 50, totalBytes: 8 }, disk: { freePercent: 40, freeBytes: 4 }, uptimeSeconds: 60, claude: { working: 1, needsYou: 0, idle: 0, stopped: 0 }, app: "0.8.0", tool: "0.1.0", build: 1 })),
    tailscalePing: vi.fn(async () => null),
    conductorAction: vi.fn(async () => ({ conductor: null, claim: null })),
    tileAnswer: vi.fn(async () => ({ v: 1, answered: true })),
    conductorDir: vi.fn(async () => "/home/me/.swarmz/conductor"),
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true), open: vi.fn(async () => null) }));

import { __stopAllPolling, useStore } from "../store";
import { ipc } from "../lib/ipc";
import { HOVER_CARD_MS, Sidebar } from "./Sidebar";

const ID = "t1";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/mokes/projects", exited: null, error: null } },
    order: [ID],
    layout: { kind: "group", id: "g1", tabs: [ID], active: ID },
    focusedGroupId: "g1",
    focusedTerminalId: ID,
    settings: { [ID]: { ssh: { host: "mokes@box", cwd: null, machine: "box" }, claude: null, command: null, extra: {} } },
    startupPending: {},
    startupNotes: {},
    persistError: null,
    machines: { box: { alias: "desk", color: "#f59e0b", lastUsed: "t" } },
    agentState: {},
    agentHooksError: null,
    tailscale: {
      running: true,
      message: null,
      user: "mokes",
      self: null,
      peers: [{ name: "box", hostName: "box", ip: "100.1.1.2", os: "macOS", online: true }],
    },
    tailscaleError: null,
    outsideSessions: [],
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

describe("Sidebar", () => {
  it("renders a machine row once, with its Mac chip in its colour, online tooltip, and no getSnapshot warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Sidebar />);
      const row = screen.getByTestId(`row-${ID}`);
      expect(row.dataset.machineState).toBe("online");
      const chip = within(row).getByTestId("machine-glyph");
      // jsdom normalizes the hex colour to rgb() when it parses the inline style.
      expect(chip.style.backgroundColor).toBe("rgb(245, 158, 11)");
      expect(chip.title).toBe("desk · box · online");
      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).not.toContain("getSnapshot");
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
  it("shows the card's title, then the first prompt, then the name, and the name moves to the second line", () => {
    render(<Sidebar />);
    // No card, no prompt: the name.
    expect(screen.getByTestId(`title-${ID}`).textContent).toBe("desk");
    // A first prompt names it; the name moves to the second line, in mono, beside the folder.
    act(() => {
      useStore.setState({ agentState: { [ID]: { ...useStore.getState().agentState[ID], status: "working", sessionId: "s", since: "t", lastEvent: "UserPromptSubmit", unseen: false, title: "fix the build", firstPrompt: "fix the build please" } } });
    });
    expect(screen.getByTestId(`title-${ID}`).textContent).toBe("fix the build");
    expect(screen.getByTestId(`line2-${ID}`).textContent).toBe("Bprojectsdesk");
    expect(screen.getByTitle("Tile name").textContent).toBe("desk");
    // The agent's card wins over the prompt.
    act(() => {
      const s = useStore.getState();
      useStore.setState({ settings: { [ID]: { ...s.settings[ID], card: { title: "Phone: answer questions", recap: "Parsed the dialog.\nNext: the card.", updatedAt: new Date().toISOString(), by: "agent" } } } });
    });
    expect(screen.getByTestId(`title-${ID}`).textContent).toBe("Phone: answer questions");
  });
  it("opens a hover card with the recap after a pause, and closes it on leave", () => {
    vi.useFakeTimers();
    try {
      act(() => {
        const s = useStore.getState();
        useStore.setState({ settings: { [ID]: { ...s.settings[ID], card: { title: "Phone keys", recap: "Parsed the dialog.\nNext: the card.", updatedAt: new Date().toISOString(), by: "agent" } } } });
      });
      render(<Sidebar />);
      const row = screen.getByTestId(`title-${ID}`).closest("[data-machine-state]") as HTMLElement;
      fireEvent.mouseEnter(row);
      expect(screen.queryByTestId(`hover-card-${ID}`)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const card = screen.getByTestId(`hover-card-${ID}`);
      expect(card.textContent).toContain("Phone keys");
      expect(card.textContent).toContain("desk · box · online");
      expect(card.textContent).toContain("Parsed the dialog.");
      expect(card.textContent).toContain("by Claude");
      fireEvent.mouseLeave(row);
      expect(screen.queryByTestId(`hover-card-${ID}`)).toBeNull();
      // Without a card the first prompt fills the body; without either it says so.
      act(() => {
        const s = useStore.getState();
        useStore.setState({ settings: { [ID]: { ...s.settings[ID], card: null } }, agentState: { [ID]: { status: "idle", sessionId: "s", since: "t", lastEvent: "Stop", unseen: false, title: "fix the build", firstPrompt: "fix the build please, all of it" } } });
      });
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId(`hover-card-${ID}`).textContent).toContain("fix the build please, all of it");
      fireEvent.mouseLeave(row);
      act(() => {
        useStore.setState({ agentState: {} });
      });
      fireEvent.mouseEnter(row);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId(`hover-card-${ID}`).textContent).toContain("No recap yet");
    } finally {
      vi.useRealTimers();
    }
  });

  it("double-clicking the title edits the card's title as the user's, and an empty one hands it back", () => {
    render(<Sidebar />);
    fireEvent.doubleClick(screen.getByTestId(`title-${ID}`));
    const input = screen.getByLabelText("Title") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "  Mine  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useStore.getState().settings[ID].card).toMatchObject({ title: "Mine", by: "user" });
    expect(screen.getByTestId(`title-${ID}`).textContent).toBe("Mine");
    // The name is still edited from the rest of the row.
    fireEvent.doubleClick(screen.getByTestId(`line2-${ID}`));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("desk");
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    fireEvent.doubleClick(screen.getByTestId(`title-${ID}`));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.keyDown(screen.getByLabelText("Title"), { key: "Enter" });
    expect(useStore.getState().settings[ID].card).toBeNull();
    expect(screen.getByTestId(`title-${ID}`).textContent).toBe("desk");
  });

  it("opens on Triage (needs you as cards, the rest as rows) and switches views, remembered per Mac", () => {
    localStorage.removeItem("swarmz.sidebarGroupBy");
    act(() => {
      const s = useStore.getState();
      useStore.setState({
        terminals: { ...s.terminals, local: { id: "local", name: "here", cwd: "/home/mokes/other", exited: null, error: null } },
        order: [ID, "local"],
        settings: { ...s.settings, local: { ssh: null, claude: null, command: null, extra: {} } },
        selfMachine: "mini",
        agentState: { [ID]: { status: "blocked", sessionId: "s", since: "2026-09-15T10:00:00Z", lastEvent: "PermissionRequest", unseen: true, title: null, firstPrompt: null } },
      });
    });
    render(<Sidebar />);
    expect(screen.getByRole("radio", { name: "Triage" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("triage-needs").textContent).toContain("NEEDS YOU");
    expect(screen.getByTestId(`needs-card-${ID}`).textContent).toContain("desk");
    expect(screen.getByTestId("triage-quiet").textContent).toContain("QUIET");
    expect(screen.getByTestId("line2-local").textContent).toBe("Mother");
    fireEvent.click(screen.getByRole("radio", { name: "Mac" }));
    // This Mac's group comes first; a row in the Mac view says "needs you".
    expect(screen.getAllByTestId(/^group-/).map((h) => h.getAttribute("data-testid"))).toEqual(["group-mini", "group-box"]);
    expect(screen.getByTestId(`status-${ID}`).textContent).toBe("needs you");
    expect(screen.getByTestId("group-box").textContent).toContain("1");
    fireEvent.click(screen.getByRole("radio", { name: "Time" }));
    expect(screen.getAllByTestId(/^group-/).length).toBeGreaterThan(0);
    expect(localStorage.getItem("swarmz.sidebarGroupBy")).toBe("time");
    localStorage.removeItem("swarmz.sidebarGroupBy");
  });
  it("sums up sync in the notices line when sync is enabled and tailscale is running", () => {
    useStore.setState({
      sync: { enabled: true, lastPullAt: new Date().toISOString(), lastPushAt: null, peersOk: 1, peersTotal: 2, error: null, adopting: false },
      tailscale: { running: true, message: null, user: "mokes", self: { name: "here", hostName: "h", ip: null, os: "macOS", online: true }, peers: [] },
    });
    render(<Sidebar />);
    expect(screen.getByTestId("notices").textContent).toContain("Synced · 1/2 Macs");
  });
  it("shows sync off when tailscale is not available", () => {
    useStore.setState({ tailscale: null });

    render(<Sidebar />);

    expect(screen.getByRole("button", { name: /Sync off/ }).textContent).toContain("Sync off");
  });
});

describe("the conductor", () => {
  it("marks the conductor's row and hover card, and the role button sets or clears it through the tool", async () => {
    useStore.setState({ settings: { [ID]: { ...useStore.getState().settings[ID], claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true } } } });
    render(<Sidebar />);
    expect(screen.queryByLabelText("Conductor")).toBeNull();
    // Make conductor on a Claude tile runs the tool; the reply stands in when no newer file exists.
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: ID, claim: null });
    fireEvent.click(screen.getByLabelText("Conductor role"));
    // With no top conductor yet there is nothing to be a sub-conductor under.
    expect(screen.queryByText("Make sub-conductor…")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Make conductor"));
    });
    expect(ipc.conductorAction).toHaveBeenCalledWith("set", ID);
    expect(useStore.getState().conductor).toBe(ID);
    expect(screen.getByTestId(`row-${ID}`).querySelector("[aria-label='Conductor']")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Conductor role"));
    expect(screen.getByText("Not the conductor")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Conductor role"));
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(screen.getByTestId(`title-${ID}`).closest("[data-machine-state]") as HTMLElement);
      act(() => {
        vi.advanceTimersByTime(HOVER_CARD_MS);
      });
      expect(screen.getByTestId(`hover-card-${ID}`).textContent).toContain("Conductor");
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a tile under a conductor, makes one where it stands, and says whom tiles answer to", async () => {
    const claude = { enabled: true, sessionId: "s", skipPermissions: false, started: true };
    useStore.setState({
      terminals: {
        [ID]: { id: ID, name: "desk", cwd: "/home/mokes/projects", exited: null, error: null },
        top: { id: "top", name: "ops", cwd: "/home/mokes/ops", exited: null, error: null },
        a: { id: "a", name: "alpha", cwd: "/v/a", exited: null, error: null },
      },
      order: [ID, "top", "a"],
      layout: { kind: "group", id: "g1", tabs: [ID, "top", "a"], active: ID },
      settings: {
        [ID]: { ssh: { host: "mokes@box", cwd: "/v/d", machine: "box" }, claude, command: null, extra: {} },
        top: { ssh: null, claude, command: null, extra: {} },
        a: { ssh: null, claude, command: null, extra: {} },
      },
      conductor: "top",
      conductors: {},
    });
    render(<Sidebar />);
    fireEvent.click(screen.getAllByLabelText("Conductor role")[0]);
    expect(screen.getByText("Make top conductor (instead of ops)")).toBeTruthy();
    expect((screen.getByLabelText("Answers to") as HTMLSelectElement).value).toBe("top");
    // Make it a conductor where it stands: under the conductor it answers to now.
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: "top", conductors: { [ID]: { parent: "top", tiles: [] } }, claim: null });
    await act(async () => {
      fireEvent.click(screen.getByText("Make it a conductor here"));
    });
    expect(ipc.conductorAction).toHaveBeenCalledWith("sub", ID, "top");
    expect(screen.getByTestId(`row-${ID}`).querySelector("[aria-label='Conductor']")).toBeTruthy();
    // alpha's menu offers desk now; choosing it assigns alpha.
    fireEvent.click(screen.getAllByLabelText("Conductor role")[2]);
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: "top", conductors: { [ID]: { parent: "top", tiles: ["a"] } }, claim: null });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Answers to"), { target: { value: ID } });
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("assign", "a", ID);
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(screen.getByTestId("title-a").closest("[draggable]") as HTMLElement);
      act(() => {
        vi.advanceTimersByTime(HOVER_CARD_MS);
      });
      expect(screen.getByTestId("hover-card-a").textContent).toContain("Answers to 🎛 desk");
    } finally {
      vi.useRealTimers();
    }
    // The conductor's menu undoes it, and opens the full tree.
    fireEvent.click(screen.getAllByLabelText("Conductor role")[0]);
    expect(screen.getByText("🎛 A conductor with 1 tile")).toBeTruthy();
    fireEvent.click(screen.getByText("Arrange conductors…"));
    expect(useStore.getState().conductorsPanel).toBe(true);
    useStore.setState({ conductorsPanel: false });
    fireEvent.click(screen.getAllByLabelText("Conductor role")[0]);
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: "top", conductors: {}, claim: null });
    await act(async () => {
      fireEvent.click(screen.getByText("Not a conductor (its tiles go up a level)"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("remove", ID);
    expect(useStore.getState().conductors).toEqual({});
  });

  it("names a sub claim's conductor in the bar, and opens the tree from the header", () => {
    useStore.setState({
      terminals: { ...useStore.getState().terminals, top: { id: "top", name: "ops", cwd: "/o", exited: null, error: null } },
      conductorClaim: { tile: ID, title: "certify", at: "t", sub: true, parent: "top" },
    });
    render(<Sidebar />);
    expect(screen.getByTestId("claim-bar").textContent).toContain("certify asks to be a sub-conductor under ops");
    fireEvent.click(screen.getByLabelText("Conductors"));
    expect(useStore.getState().conductorsPanel).toBe(true);
    useStore.setState({ conductorsPanel: false });
  });

  it("says plainly when a claim would replace the top conductor", () => {
    useStore.setState({
      terminals: { ...useStore.getState().terminals, top: { id: "top", name: "ops", cwd: "/o", exited: null, error: null } },
      conductor: "top",
      conductorClaim: { tile: ID, title: "setup", at: "t" },
    });
    render(<Sidebar />);
    expect(screen.getByTestId("claim-bar").textContent).toContain("setup asks to replace ops as the top conductor");
  });

  it("draws the Tree view with the sidebar's own rows nested under their conductor", () => {
    const claude = { enabled: true, sessionId: "s", skipPermissions: false, started: true };
    useStore.setState({
      terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/mokes/projects", exited: null, error: null }, top: { id: "top", name: "ops", cwd: "/o", exited: null, error: null } },
      order: ["top", ID],
      layout: { kind: "group", id: "g1", tabs: ["top", ID], active: "top" },
      settings: { [ID]: { ...useStore.getState().settings[ID], claude }, top: { ssh: null, claude, command: null, extra: {} } },
      conductor: "top",
      conductors: {},
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("radio", { name: "Tree" }));
    expect(screen.getByTestId("conductor-tree")).toBeTruthy();
    expect(screen.getByTestId("tree-node-top").contains(screen.getByTestId(`title-${ID}`))).toBe(true);
    // Nested one level: indented with a guide line.
    expect(screen.getByTestId(`row-${ID}`).style.paddingLeft).toBe("24px");
    fireEvent.click(screen.getByRole("radio", { name: "Triage" }));
    localStorage.removeItem("swarmz.sidebarGroupBy");
  });

  it("shows a pending claim as a bar whose Approve and Deny answer through the tool", async () => {
    useStore.setState({ conductorClaim: { tile: ID, title: "Fix the build", at: "2026-09-23T10:00:00Z" } });
    render(<Sidebar />);
    const bar = screen.getByTestId("claim-bar");
    expect(bar.textContent).toContain("Fix the build");
    expect(bar.textContent).toContain("asks to be the conductor");
    vi.mocked(ipc.conductorAction).mockResolvedValueOnce({ conductor: ID, claim: null });
    await act(async () => {
      fireEvent.click(screen.getByText("Approve"));
    });
    expect(ipc.conductorAction).toHaveBeenCalledWith("set", ID);
    expect(useStore.getState().conductor).toBe(ID);
    expect(screen.queryByTestId("claim-bar")).toBeNull();
    // A claim with no title names the tile as the sidebar does; Deny clears it.
    act(() => {
      useStore.setState({ conductorClaim: { tile: ID, title: null, at: "t" } });
    });
    expect(screen.getByTestId("claim-bar").textContent).toContain("desk");
    await act(async () => {
      fireEvent.click(screen.getByText("Deny"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("deny", undefined);
    expect(screen.queryByTestId("claim-bar")).toBeNull();
  });

  it("offers Conductor… in the + menu, which picks a folder from the conductor's default", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValueOnce(null);
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("New terminal"));
    await act(async () => {
      fireEvent.click(screen.getByText("Conductor…"));
    });
    expect(ipc.conductorDir).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, defaultPath: "/home/me/.swarmz/conductor" }));
  });
});

describe("agent status dot", () => {
  it("colours the dot by state, glows when it needs you, and lists the hooks error with Retry", () => {
    useStore.setState({
      settings: { [ID]: { ssh: null, claude: null, command: null, extra: {} } },
      machines: {},
      agentState: { [ID]: { status: "blocked", sessionId: "s", since: "2026-09-15T10:00:00Z", lastEvent: "Notification", unseen: true, title: null, firstPrompt: null } },
      agentHooksError: "could not install Claude hooks: nope",
    });
    localStorage.setItem("swarmz.sidebarGroupBy", "machine");
    render(<Sidebar />);
    const dot = screen.getByTestId(`agent-dot-${ID}`);
    expect(dot.style.backgroundColor).toBe("var(--color-needs)");
    expect(dot.style.boxShadow).toContain("--color-needs");
    expect(screen.getByTestId(`row-${ID}`).title).toContain("Needs you");
    fireEvent.click(screen.getByTestId("notices"));
    expect(screen.getByText("could not install Claude hooks: nope")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    act(() => {
      useStore.setState({ terminals: { [ID]: { ...useStore.getState().terminals[ID], exited: 1 } } });
    });
    expect(screen.getByTestId(`agent-dot-${ID}`).style.backgroundColor).toBe("var(--color-exited)");
    expect(screen.getByTestId(`status-${ID}`).textContent).toBe("exited 1");
    act(() => {
      useStore.setState({ terminals: { [ID]: { ...useStore.getState().terminals[ID], exited: 0 } } });
    });
    // Stopped: a hollow dot.
    expect(screen.getByTestId(`agent-dot-${ID}`).style.backgroundColor).toBe("transparent");
    localStorage.removeItem("swarmz.sidebarGroupBy");
  });
  it("rings the dot of a tile that finished while nobody looked", () => {
    useStore.setState({ agentState: { [ID]: { status: "working", sessionId: "s", since: "t", lastEvent: "UserPromptSubmit", unseen: true, title: null, firstPrompt: null } } });
    render(<Sidebar />);
    expect(screen.getByTestId(`agent-dot-${ID}`).style.boxShadow).toContain("--color-working");
  });
});

describe("session history popover", () => {
  it("shows a history button when the tile has previous sessions and opens the list", () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, [ID]: { ...s.settings[ID], claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [{ sessionId: "cur", cwd: "/a", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }, { sessionId: "old", cwd: "/b", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Previous sessions" }));
    expect(screen.getByTestId("session-row-old")).toBeTruthy();
  });
  it("hides the history button without previous sessions", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Previous sessions" })).toBeNull();
  });
  it("hides the history button for a tile with a custom command", () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, [ID]: { ...s.settings[ID], command: "npm run dev", claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, sessions: [{ sessionId: "old", cwd: "/b", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: "Previous sessions" })).toBeNull();
  });
});

describe("sessions outside the workspace", () => {
  const outside = (...ids: string[]) =>
    ids.map((id) => ({ id, name: id, running: true, pid: 1, startedAt: "2020-01-01T00:00:00Z", exitedAt: null, exitCode: null, known: false }));

  it("lists them in the notices and closes them after confirming", async () => {
    useStore.setState({ outsideSessions: ["o1", "o2"] });
    vi.mocked(ipc.localSessions).mockImplementation(async () => outside("o1", "o2"));
    render(<Sidebar />);
    expect(screen.getByTestId("notices-count").textContent).toBe("1");
    fireEvent.click(screen.getByTestId("notices"));
    expect(screen.getByText("2 sessions running outside this workspace")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close…" }));
    });
    expect(ipc.closeSession).toHaveBeenCalledTimes(2);
  });
  it("keeps the Machines footer under the list, whose click opens the Machines view", async () => {
    useStore.setState({ selfMachine: "mini", machineStats: {} });
    const onShow = vi.fn();
    await act(async () => {
      render(<Sidebar onShowMachines={onShow} />);
    });
    expect(screen.getByTestId("machines-footer").textContent).toContain("MACHINES");
    expect(ipc.machineStats).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByTestId("machine-line-mini"));
    expect(onShow).toHaveBeenCalled();
  });
  it("dismisses a stale close error", async () => {
    useStore.setState({ outsideSessions: ["o1"] });
    vi.mocked(ipc.localSessions).mockResolvedValueOnce(outside("o1"));
    vi.mocked(ipc.closeSession).mockRejectedValueOnce("nope");
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("notices"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close…" }));
    });
    expect(screen.getByText("could not close o1: nope")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("could not close o1: nope")).toBeNull();
  });
});

describe("picking tiles and not-open tiles (windows and layouts spec §3, §8)", () => {
  const three = () => {
    const t = (id: string) => ({ id, name: id, cwd: `/p/${id}`, exited: null, error: null });
    const st = { ssh: null, claude: null, command: null, extra: {} };
    useStore.setState({
      terminals: { a: t("a"), b: t("b"), c: t("c") },
      order: ["a", "b", "c"],
      settings: { a: st, b: st, c: st },
      layout: { kind: "group", id: "g1", tabs: ["a", "b"], active: "a" },
      focusedGroupId: "g1",
      focusedTerminalId: "a",
    });
  };

  it("greys a tile no window shows, says it still runs, and × says it stops the tile", () => {
    three();
    localStorage.setItem("swarmz.sidebarGroupBy", "folder");
    render(<Sidebar />);
    expect(screen.getByTestId("row-c").dataset.open).toBe("false");
    expect(screen.getByTestId("row-c").title).toContain("running, not open in any window");
    expect(screen.getByTestId("row-a").dataset.open).toBe("true");
    expect(screen.getAllByLabelText("Stop and remove")[0].title).toBe("Stop and remove from the workspace");
    localStorage.removeItem("swarmz.sidebarGroupBy");
  });
  it("Cmd-click and Shift-click pick rows, and the bar arranges them in a new window", async () => {
    const { windowHooks } = await import("../store");
    const opened: string[] = [];
    windowHooks.open = async (label) => void opened.push(label);
    three();
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("row-a"), { metaKey: true });
    fireEvent.click(screen.getByTestId("row-c"), { shiftKey: true });
    expect(useStore.getState().selectedTiles).toEqual(["a", "b", "c"]);
    expect(screen.getByTestId("selection-bar").textContent).toContain("3 selected");
    expect(screen.getByTestId("preset-three-columns").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByTestId("preset-three-columns"));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const s = useStore.getState();
    expect(s.layout).toBeNull();
    expect(s.selectedTiles).toEqual([]);
    expect(screen.queryByTestId("selection-bar")).toBeNull();
    windowHooks.open = async () => {};
  });

  it("a plain click on a tile that is not open opens it", () => {
    three();
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("row-c"));
    expect(useStore.getState().layout).toMatchObject({ tabs: ["a", "b", "c"], active: "c" });
    expect(screen.queryByTestId("not-open-c")).toBeNull();
  });
});

describe("tile settings menu (identify)", () => {
  it("Identify labels the tile; Identify all numbers the rows in list order", () => {
    const t = (id: string) => ({ id, name: id, cwd: `/p/${id}`, exited: null, error: null });
    const st = { ssh: null, claude: null, command: null, extra: {} };
    useStore.setState({
      terminals: { a: t("a"), b: t("b") },
      order: ["a", "b"],
      settings: { a: st, b: st },
      layout: { kind: "group", id: "g1", tabs: ["a", "b"], active: "a" },
      identify: null,
    });
    render(<Sidebar />);
    fireEvent.click(screen.getAllByLabelText("Tile settings")[1]);
    expect(screen.getByTestId("tile-menu-b")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Identify" }));
    expect(useStore.getState().identify).toMatchObject({ ids: ["b"], numbered: false });
    expect(useStore.getState().layout).toMatchObject({ active: "b" });
    expect(screen.queryByTestId("tile-menu-b")).toBeNull();
    fireEvent.click(screen.getAllByLabelText("Tile settings")[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Identify all tiles" }));
    expect(screen.getByTestId("row-mark-a").textContent).toBe("1");
    expect(screen.getByTestId("row-mark-b").textContent).toBe("2");
    act(() => useStore.setState({ identify: null }));
  });
});

describe("triage (sidebar redesign spec)", () => {
  it("answers a permission from its card on the tile's Mac, opens a question, and folds Quiet", async () => {
    localStorage.removeItem("swarmz.sidebarGroupBy");
    localStorage.removeItem("swarmz.foldedSections");
    const t = (id: string) => ({ id, name: id, cwd: `/p/${id}`, exited: null, error: null });
    useStore.setState({
      terminals: { p: t("p"), q: t("q"), z: t("z") },
      order: ["p", "q", "z"],
      settings: {
        p: { ssh: { host: "mokes@box", cwd: "/p", machine: "box" }, claude: null, command: null, extra: {}, card: { title: "Deploy", recap: "Wants to run the deploy script.", updatedAt: "t", by: "agent" } },
        q: { ssh: null, claude: null, command: null, extra: {} },
        z: { ssh: null, claude: null, command: null, extra: {} },
      },
      layout: { kind: "group", id: "g1", tabs: ["p", "q", "z"], active: "z" },
      agentState: {
        p: { status: "blocked", sessionId: "s", since: "2026-09-15T10:00:00Z", lastEvent: "PermissionRequest", unseen: false, title: null, firstPrompt: null },
        q: { status: "blocked", sessionId: "s", since: "2026-09-15T10:00:00Z", lastEvent: "Notification", unseen: false, title: null, firstPrompt: null },
      },
    });
    render(<Sidebar />);
    const card = screen.getByTestId("needs-card-p");
    expect(card.textContent).toContain("Deploy");
    expect(card.textContent).toContain("Wants to run the deploy script.");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    });
    expect(ipc.tileAnswer).toHaveBeenCalledWith("p", "yes", "box");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    });
    expect(ipc.tileAnswer).toHaveBeenLastCalledWith("p", "no", "box");
    // A question: Answer opens the tile.
    fireEvent.click(within(screen.getByTestId("needs-card-q")).getByRole("button", { name: "Answer" }));
    expect(useStore.getState().focusedTerminalId).toBe("q");
    // Quiet folds and stays folded.
    expect(screen.getByTestId("row-z")).toBeTruthy();
    fireEvent.click(screen.getByTestId("triage-quiet"));
    expect(screen.queryByTestId("row-z")).toBeNull();
    expect(localStorage.getItem("swarmz.foldedSections")).toContain("triage.quiet");
    localStorage.removeItem("swarmz.foldedSections");
  });

  it("turns the dot into a checkbox that picks the row", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId(`row-check-${ID}`));
    expect(useStore.getState().selectedTiles).toEqual([ID]);
    expect(screen.getByTestId(`row-check-${ID}`).getAttribute("aria-checked")).toBe("true");
    act(() => useStore.getState().clearSelection());
  });
});

describe("Mac chip colours", () => {
  it("colours a Mac with no colour picked from its terminal theme", () => {
    useStore.setState({ machines: { box: { lastUsed: "t" } } });
    render(<Sidebar />);
    const chip = within(screen.getByTestId(`row-${ID}`)).getByTestId("machine-glyph");
    expect(chip.style.backgroundColor).not.toBe("");
    expect(chip.style.backgroundColor).not.toBe("rgb(82, 82, 82)");
  });
});

describe("updates in the sidebar", () => {
  it("shows an available update as its own bar, and the footer says Check for updates", async () => {
    const before = useStore.getState().update;
    const checkForUpdates = vi.fn(async () => {});
    useStore.setState({ update: { ...before, status: "available", version: "9.9.9", dismissed: false }, checkForUpdates });
    render(<Sidebar />);
    expect(screen.getByTestId("update-notice").textContent).toContain("swarmz 9.9.9 is ready");
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeTruthy();
    const btn = screen.getByTestId("check-updates");
    expect(btn.textContent).toContain("Check for updates");
    fireEvent.click(btn);
    expect(checkForUpdates).toHaveBeenCalledWith({ manual: true });
    act(() => useStore.setState({ update: before }));
  });
});
