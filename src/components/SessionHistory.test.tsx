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
    agentsWatch: vi.fn(async () => 1),
    agentsUnwatch: vi.fn(async () => {}),
    onAgentEvent: vi.fn(async () => () => {}),
    onAgentWatchEnded: vi.fn(async () => () => {}),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { useStore } from "../store";
import { SessionHistory } from "./SessionHistory";

const ID = "t1";
const rec = (sid: string, cwd: string, t: string) => ({ sessionId: sid, cwd, skipPermissions: false, startedAt: t, lastActiveAt: t });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: null, error: null } },
    order: [ID],
    settings: { [ID]: { ssh: null, claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, command: null, extra: {}, sessions: [rec("cur", "/home/me/a", "2026-09-15T10:00:00Z"), rec("old", "/home/me/b", "2026-09-15T09:00:00Z"), rec("older", "/home/me/c", "2026-09-15T08:00:00Z")] } },
    startupPending: {},
    startupNotes: {},
  });
});
afterEach(cleanup);

describe("SessionHistory", () => {
  it("lists previous sessions newest first, excluding the current one, with folder basename and full path tooltip", () => {
    render(<SessionHistory id={ID} />);
    const rows = screen.getAllByRole("button", { name: /ago|just now/ });
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["session-row-old", "session-row-older"]);
    expect(screen.getByTestId("session-row-old").textContent).toContain("b");
    expect(screen.getByTestId("session-row-old").title).toBe("/home/me/b");
  });
  it("renders nothing when there are no previous sessions", () => {
    useStore.setState((s) => ({ settings: { ...s.settings, [ID]: { ...s.settings[ID], sessions: [rec("cur", "/x", "t")] } } }));
    const { container } = render(<SessionHistory id={ID} />);
    expect(container.textContent).toBe("");
  });
  it("clicking a row selects it with connect and calls onPick", async () => {
    const select = vi.fn(async () => {});
    useStore.setState({ selectSession: select });
    const onPick = vi.fn();
    render(<SessionHistory id={ID} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("session-row-old"));
    expect(select).toHaveBeenCalledWith(ID, "old", { connect: true });
    expect(onPick).toHaveBeenCalled();
  });
  it("caps at five rows", () => {
    const many = Array.from({ length: 8 }, (_, i) => rec(`s${i}`, `/p${i}`, `2026-09-15T0${i}:00:00Z`));
    useStore.setState((s) => ({ settings: { ...s.settings, [ID]: { ...s.settings[ID], sessions: many } } }));
    render(<SessionHistory id={ID} />);
    expect(screen.getAllByRole("button").length).toBe(5);
  });
});
