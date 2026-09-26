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

import { __stopAllPolling, useStore } from "../store";
import { ipc } from "../lib/ipc";
import { NewRemoteTerminal } from "./NewRemoteTerminal";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ machines: {}, tailscale: null, tailscaleError: null });
});
afterEach(() => cleanup());

describe("NewRemoteTerminal", () => {
  it("lists tailnet machines online first with alias and colour, and connects headlessly then picks a folder", async () => {
    useStore.setState({
      machines: {
        "martins-mac-mini": { alias: "desk mini", color: "#f59e0b", cwd: "/Users/mokes/projects", lastUsed: "t" },
      },
    });
    vi.mocked(ipc.tailscaleStatus).mockResolvedValue({
      running: true,
      message: null,
      user: "mokes",
      self: null,
      peers: [
        { name: "martins-mac-mini", hostName: "martins-mac-mini", ip: "100.1.1.2", os: "macOS", online: true },
        { name: "home-mini", hostName: "home-mini", ip: "100.1.1.3", os: "macOS", online: false },
      ],
    });
    const onClose = vi.fn();
    render(<NewRemoteTerminal onClose={onClose} />);

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(within(options[0]).getByText("desk mini")).toBeTruthy();
    expect(within(options[1]).getByText("home-mini")).toBeTruthy();

    fireEvent.click(within(options[0]).getByText("desk mini"));

    vi.mocked(ipc.sshOpenMaster).mockResolvedValue(true);
    vi.mocked(ipc.sshListDir).mockResolvedValue({ path: "/Users/mokes/projects", parent: "/Users/mokes", dirs: ["swarmz"] });

    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });
    expect(await screen.findByText("Choose the folder on desk mini")).toBeTruthy();
    expect(await screen.findByText("swarmz/")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Use this folder"));
    });

    const id = useStore.getState().order[useStore.getState().order.length - 1];
    expect(useStore.getState().settings[id].ssh).toEqual({
      host: "mokes@martins-mac-mini",
      cwd: "/Users/mokes/projects",
      machine: "martins-mac-mini",
    });
    expect(useStore.getState().terminals[id].name).toBe("desk mini");
    expect(onClose).toHaveBeenCalled();
    __stopAllPolling();
  });

  it("offers None, Claude or Codex, with skip permissions for either agent", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValue({
      running: true,
      message: null,
      user: "mokes",
      self: null,
      peers: [{ name: "box", hostName: "box", ip: "100.1.1.2", os: "macOS", online: true }],
    });
    render(<NewRemoteTerminal onClose={vi.fn()} />);
    const options = await screen.findAllByRole("option");
    fireEvent.click(within(options[0]).getByText("box"));
    const skip = screen.getByLabelText(/Skip permissions/) as HTMLInputElement;
    expect(skip.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Codex"));
    expect(skip.disabled).toBe(false);
    fireEvent.click(skip);
    vi.mocked(ipc.sshOpenMaster).mockResolvedValue(true);
    vi.mocked(ipc.sshListDir).mockResolvedValue({ path: "/Users/mokes", parent: "/Users", dirs: [] });
    await act(async () => {
      fireEvent.click(screen.getByText("Connect"));
    });
    await screen.findByText("Use this folder");
    await act(async () => {
      fireEvent.click(screen.getByText("Use this folder"));
    });
    const id = useStore.getState().order[useStore.getState().order.length - 1];
    expect(useStore.getState().settings[id].claude).toEqual({ enabled: true, sessionId: "", skipPermissions: true, started: false, agent: "codex" });
    __stopAllPolling();
  });

  it("not running state offers Retry and Open Tailscale", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValue({
      running: false,
      message: "Tailscale is NeedsLogin",
      user: "",
      self: null,
      peers: [],
    });
    const onClose = vi.fn();
    render(<NewRemoteTerminal onClose={onClose} />);

    expect(await screen.findByText("Tailscale is NeedsLogin")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Open Tailscale"));
    });
    expect(ipc.tailscaleOpen).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText("Retry"));
    });
    expect(ipc.tailscaleStatus).toHaveBeenCalledTimes(2);
  });

  it("gear edits alias and colour", async () => {
    vi.mocked(ipc.tailscaleStatus).mockResolvedValue({
      running: true,
      message: null,
      user: "mokes",
      self: null,
      peers: [{ name: "test-mini", hostName: "test-mini", ip: null, os: "linux", online: true }],
    });
    const onClose = vi.fn();
    render(<NewRemoteTerminal onClose={onClose} />);

    await screen.findAllByRole("option");
    fireEvent.click(screen.getByTitle("Machine settings"));

    fireEvent.change(screen.getByPlaceholderText("test-mini"), { target: { value: "home" } });
    fireEvent.click(screen.getByLabelText("Colour #3b82f6"));

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(useStore.getState().machines["test-mini"]?.alias).toBe("home");
    expect(useStore.getState().machines["test-mini"]?.color).toBe("#3b82f6");
  });
});
