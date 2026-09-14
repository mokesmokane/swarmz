// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
});
