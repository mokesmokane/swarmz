// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
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
    onExit: vi.fn(async () => () => {}),
    loadWorkspace: vi.fn(async () => null),
    saveWorkspace: vi.fn(async () => {}),
    sshCheck: vi.fn(async () => false),
    sshOpenMaster: vi.fn(async () => false),
    sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),
    terminalForegroundBusy: vi.fn(async () => false),
    tailscaleStatus: vi.fn(async () => ({ running: true, message: null, user: "mokes", self: null, peers: [] })),
    tailscaleOpen: vi.fn(async () => {}),
    agentsInstallLocal: vi.fn(async () => false),
    agentsInstallRemote: vi.fn(async () => false),
    agentsWatch: vi.fn(async () => {}),
    agentsUnwatch: vi.fn(async () => {}),
    onAgentEvent: vi.fn(async () => () => {}),
    onAgentWatchEnded: vi.fn(async () => () => {}),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true), open: vi.fn(async () => null) }));

import { __stopAllPolling, useStore } from "../store";
import { Sidebar } from "./Sidebar";

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
  });
});

afterEach(() => {
  __stopAllPolling();
  cleanup();
});

describe("Sidebar", () => {
  it("renders a machine row once, with its colour, online tooltip, and machine name, without a getSnapshot warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Sidebar />);

      // The row shows the raw machine name (not the alias, which is already the tile's name).
      const machineLine = screen.getByText("box");
      expect(machineLine).toBeTruthy();

      const row = machineLine.closest("[title]") as HTMLElement;
      expect(row).toBeTruthy();
      // jsdom normalizes the hex colour in the shorthand to rgb() when it parses the inline style.
      expect(row.style.borderLeft).toContain("rgb(245, 158, 11)");
      expect(row.title).toContain("online");
      expect(row.title).toContain("/home/mokes/projects");

      const dot = row.querySelector("span") as HTMLElement;
      expect(dot.style.backgroundColor).toBe("rgb(245, 158, 11)");

      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).not.toContain("getSnapshot");
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("shows a synced status line when sync is enabled and tailscale is running", () => {
    useStore.setState({
      sync: {
        enabled: true,
        lastPullAt: new Date().toISOString(),
        lastPushAt: null,
        peersOk: 1,
        peersTotal: 2,
        error: null,
        adopting: false,
      },
      tailscale: {
        running: true,
        message: null,
        user: "mokes",
        self: { name: "here", hostName: "h", ip: null, os: "macOS", online: true },
        peers: [],
      },
    });

    render(<Sidebar />);

    expect(screen.getByRole("button", { name: /Synced · 1\/2 machines/ }).textContent).toContain("Synced · 1/2 machines");
  });

  it("shows sync off when tailscale is not available", () => {
    useStore.setState({ tailscale: null });

    render(<Sidebar />);

    expect(screen.getByRole("button", { name: /Sync off/ }).textContent).toContain("Sync off");
  });
});

describe("agent status dot", () => {
  it("uses the agent colour and ring, keeps exited grey, and shows the hooks error with retry", () => {
    useStore.setState({
      settings: { [ID]: { ssh: null, claude: null, command: null, extra: {} } },
      machines: {},
      agentState: { [ID]: { status: "blocked", sessionId: "s", since: "2026-09-15T10:00:00Z", lastEvent: "Notification", unseen: true } },
      agentHooksError: "could not install Claude hooks: nope",
    });
    render(<Sidebar />);
    const dot = screen.getByTestId(`agent-dot-${ID}`);
    expect(dot.className).toContain("bg-red-500");
    expect(dot.className).toContain("ring-2");
    expect(dot.title).toContain("blocked");
    expect(dot.title).toContain("Notification");
    expect(screen.getByText("could not install Claude hooks: nope")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    act(() => {
      useStore.setState({ terminals: { [ID]: { ...useStore.getState().terminals[ID], exited: 1 } } });
    });
    expect(screen.getByTestId(`agent-dot-${ID}`).className).toContain("bg-neutral-600");
  });

  it("shows the machine colour when there is no agent state", () => {
    render(<Sidebar />);
    const dot = screen.getByTestId(`agent-dot-${ID}`);
    expect(dot.style.backgroundColor).toBe("rgb(245, 158, 11)");
  });
});
