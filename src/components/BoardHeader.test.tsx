// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    boardGet: vi.fn(async () => ({ board: null })),
    tileSend: vi.fn(async () => ({ sent: true })),
    boardHistory: vi.fn(async () => ({ history: [{ sessionId: "old", at: "2026-09-25T10:00:00Z", board: { overview: { goal: "Last week's fix", now: "Merged." } } }] })),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { BoardHeader } from "./BoardHeader";

const board = {
  scheme: "Ember",
  overview: { goal: "Ship the team flow", now: "Built and tested.", next: "Try it on mini-3.", needsYou: true },
  plan: { title: "Getting it onto staging", steps: [{ t: "Designed it", d: "New screens.", s: "done" as const }, { t: "Your turn", s: "current" as const }, { t: "Merge", s: "todo" as const }] },
  changes: { branch: "feat/team-flow", base: "on 5614aa2", flags: ["uncommitted"], rows: [{ p: "components/team", a: 40, r: 10 }], note: "3 new files." },
  questions: [{ q: "Happy with it?", o: ["Commit & push", "Needs changes"] }],
  swarm: { tiles: [{ n: "↑ ops", d: "Conductor." }], agents: [{ n: "tests", t: "5m", k: "20k" }] },
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useStore.setState({
    terminals: { t1: { id: "t1", name: "tf", cwd: "/p", exited: null, error: null } },
    settings: { t1: { ssh: { host: "mokes@mini-3", cwd: "/p", machine: "mini-3" }, claude: null, command: null, extra: {} } },
    agentState: {},
    machines: {},
    boards: { t1: { board, at: "t" } },
  });
});
afterEach(cleanup);

describe("BoardHeader", () => {
  it("shows a line that opens the tabs, on Questions first when there are some", () => {
    render(<BoardHeader id="t1" />);
    const head = screen.getByTestId("board-t1");
    expect(head.textContent).toContain("Ember");
    expect(head.textContent).toContain("Built and tested.");
    fireEvent.click(screen.getByLabelText("Open the board"));
    expect(screen.getByRole("tab", { name: /Questions/ }).getAttribute("aria-selected")).toBe("true");
    expect(head.textContent).toContain("Happy with it?");
    fireEvent.click(screen.getByRole("tab", { name: "Where we are" }));
    expect(head.textContent).toContain("NEXT · NEEDS YOU");
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(head.textContent).toContain("1 of 3 done");
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(head.textContent).toContain("+40 −10");
    fireEvent.click(screen.getByRole("tab", { name: "Swarm" }));
    expect(head.textContent).toContain("BACKGROUND AGENTS · 1");
    // Open and on Swarm, remembered for the tile.
    expect(JSON.parse(localStorage.getItem("swarmz.boards")!).t1).toMatchObject({ open: true, tab: "swarm" });
  });

  it("types an answer into the tile on its Mac, and ↻ swaps the scheme", () => {
    render(<BoardHeader id="t1" />);
    fireEvent.click(screen.getByLabelText("Open the board"));
    fireEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    expect(ipc.tileSend).toHaveBeenCalledWith("t1", "Commit & push", "mini-3");
    fireEvent.click(screen.getByLabelText("Swap colour scheme"));
    expect(screen.getByTestId("board-t1").textContent).toContain("Moss");
  });

  it("shows nothing for a tile with no board, and asks its Mac for one", () => {
    useStore.setState({ boards: {} });
    render(<BoardHeader id="t1" />);
    expect(screen.queryByTestId("board-t1")).toBeNull();
    expect(ipc.boardGet).toHaveBeenCalledWith("t1", "mini-3");
  });
});

describe("History tab", () => {
  it("lists the tile's conversations with their last activity; a click goes back to one", async () => {
    const selectSession = vi.fn(async () => {});
    useStore.setState({
      selectSession,
      settings: { t1: { ssh: { host: "mokes@mini-3", cwd: "/p", machine: "mini-3" }, claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, command: null, extra: {}, sessions: [{ sessionId: "cur", cwd: "/p/app", skipPermissions: false, startedAt: "t", lastActiveAt: new Date().toISOString() }] } },
    });
    render(<BoardHeader id="t1" />);
    fireEvent.click(screen.getByLabelText("Open the board"));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    await screen.findByTestId("history-old");
    expect(ipc.boardHistory).toHaveBeenCalledWith("t1", "mini-3");
    expect(screen.getByTestId("history-cur").textContent).toContain("now");
    expect(screen.getByTestId("history-old").textContent).toContain("Last week's fix");
    expect(screen.getByTestId("history-old").getAttribute("title")).toBe("Merged.");
    fireEvent.click(screen.getByTestId("history-old"));
    expect(selectSession).toHaveBeenCalledWith("t1", "old", { connect: true });
  });

  it("shows the header with only History for a Claude tile that has past conversations but no board yet", async () => {
    useStore.setState({
      boards: { t1: { board: null, at: null } },
      settings: { t1: { ssh: null, claude: { enabled: true, sessionId: "cur", skipPermissions: false, started: true }, command: null, extra: {}, sessions: [{ sessionId: "cur", cwd: "/p", skipPermissions: false, startedAt: "t", lastActiveAt: "t" }] } },
    });
    render(<BoardHeader id="t1" />);
    expect(screen.getByTestId("board-t1").textContent).toContain("no board yet");
    fireEvent.click(screen.getByLabelText("Open the board"));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["History"]);
    await screen.findByTestId("history-old");
  });
});
