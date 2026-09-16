// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    pasteImageToRemote: vi.fn(async () => null),
    agentsWatch: vi.fn(async () => 1),
    agentsUnwatch: vi.fn(async () => {}),
    onAgentEvent: vi.fn(async () => () => {}),
    onAgentWatchEnded: vi.fn(async () => () => {}),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
// xterm needs a real canvas; the pane's terminal mount is not what these tests check.
vi.mock("../lib/xtermRegistry", () => ({
  attach: vi.fn(() => ({ term: {}, fit: { fit: vi.fn() } })),
  fitAndFocus: vi.fn(),
}));

import { ipc } from "../lib/ipc";
import { __stopAllPolling, useStore } from "../store";
import { TerminalPane } from "./TerminalPane";

const ID = "t1";

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: null, error: null } },
    order: [ID],
    layout: { kind: "group", id: "g1", tabs: [ID], active: ID },
    focusedGroupId: "g1",
    focusedTerminalId: ID,
    settings: {
      [ID]: {
        ssh: { host: "mokes@box", cwd: "/proj", machine: "box" },
        claude: { enabled: true, sessionId: "abc", skipPermissions: true, started: true },
        command: null,
        extra: {},
      },
    },
    startupPending: { [ID]: true },
    startupNotes: {},
    sshConnected: {},
    sshConnecting: {},
    sshDropped: {},
    machines: { box: { alias: "Desk Mac", color: "#f59e0b", lastUsed: "t" } },
    persistenceReady: true,
  });
});

afterEach(() => {
  __stopAllPolling();
  cleanup();
});

describe("TerminalPane connect card", () => {
  it("shows a centered card describing the startup and hides the terminal while pending", () => {
    render(<TerminalPane id={ID} />);
    const card = screen.getByRole("dialog", { name: /connect/i });
    expect(card.textContent).toContain("Connect to Desk Mac, open /proj, resume Claude (permissions skipped)");
    expect(card.textContent).toContain("ssh -t");
    expect(card.textContent).toContain("claude --dangerously-skip-permissions --resume abc");
    // The id only exists so the remote hook can name the tile; showing it in the card is noise.
    expect(card.textContent).not.toContain("SWARMZ_TERMINAL_ID");
    expect(screen.getByTestId("terminal-mount").className).toContain("invisible");
  });

  it("shows the startup note on the card", () => {
    useStore.setState({ startupNotes: { [ID]: "saved folder is gone; opened in home" } });
    render(<TerminalPane id={ID} />);
    expect(screen.getByRole("dialog", { name: /connect/i }).textContent).toContain("saved folder is gone");
  });

  it("Connect runs the startup and reveals the terminal", async () => {
    render(<TerminalPane id={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith(ID, expect.stringMatching(/^ssh -fN .*mokes@box\r$/)));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: /connect/i })).toBeNull());
    expect(screen.getByTestId("terminal-mount").className).not.toContain("invisible");
  });

  it("offers Reconnect with the note after a connection ended", async () => {
    useStore.setState({ sshDropped: { [ID]: true }, startupNotes: { [ID]: "Connection to Desk Mac ended" } });
    render(<TerminalPane id={ID} />);
    const card = screen.getByRole("dialog", { name: /connect/i });
    expect(card.textContent).toContain("Connection to Desk Mac ended");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith(ID, expect.stringMatching(/^ssh -fN .*mokes@box\r$/)));
  });

  it("Skip drops to the plain shell without running anything", () => {
    render(<TerminalPane id={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /connect/i })).toBeNull();
    expect(useStore.getState().startupPending[ID]).toBe(false);
  });

  it("Close removes the terminal", async () => {
    render(<TerminalPane id={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => expect(ipc.closeTerminal).toHaveBeenCalledWith(ID));
    await vi.waitFor(() => expect(useStore.getState().terminals[ID]).toBeUndefined());
  });

  it("shows a Copied pill for about a second after a copy", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ startupPending: { [ID]: false }, copiedAt: {} });
      render(<TerminalPane id={ID} />);
      expect(screen.queryByText("Copied")).toBeNull();
      act(() => {
        useStore.setState({ copiedAt: { [ID]: Date.now() } });
      });
      expect(screen.getByText("Copied")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(screen.queryByText("Copied")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an Image sent pill for about a second after a remote paste", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ startupPending: { [ID]: false }, copiedAt: {}, pastedAt: {} });
      render(<TerminalPane id={ID} />);
      expect(screen.queryByText("Image sent to remote")).toBeNull();
      act(() => {
        useStore.setState({ pastedAt: { [ID]: Date.now() } });
      });
      expect(screen.getByText("Image sent to remote")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(screen.queryByText("Image sent to remote")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not show the card when nothing is pending", () => {
    useStore.setState({ startupPending: { [ID]: false } });
    render(<TerminalPane id={ID} />);
    expect(screen.queryByRole("dialog", { name: /connect/i })).toBeNull();
    expect(screen.getByTestId("terminal-mount").className).not.toContain("invisible");
  });

  it("the connect card lists previous sessions", () => {
    useStore.setState((s) => ({
      settings: { ...s.settings, [ID]: { ...s.settings[ID], sessions: [{ sessionId: "abc", cwd: "/proj", skipPermissions: true, startedAt: "t", lastActiveAt: "t" }, { sessionId: "old", cwd: "/other", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    }));
    render(<TerminalPane id={ID} />);
    expect(screen.getByText("Previous sessions in this tile")).toBeTruthy();
    expect(screen.getByTestId("session-row-old")).toBeTruthy();
    expect(screen.queryByTestId("session-row-abc")).toBeNull();
  });
});
