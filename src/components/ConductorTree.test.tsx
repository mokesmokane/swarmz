// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    conductorAction: vi.fn(async () => ({ conductor: "top", conductors: {}, claim: null })),
    loadWorkspace: vi.fn(async () => null),
    saveWorkspace: vi.fn(async () => {}),
    workspaceStat: vi.fn(async () => null),
    workspaceRoles: vi.fn(async () => null),
  },
}));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { ConductorTree } from "./ConductorTree";
import type { RowInfo } from "../lib/sidebarGroups";
import type { RowTree } from "./Sidebar";

const tile = (id: string) => ({ id, name: id, cwd: `/p/${id}`, exited: null, error: null });
const claude = { enabled: true, sessionId: "s", skipPermissions: false, started: true };
const order = ["top", "s1", "a", "b", "o"];
const info = (id: string, status: RowInfo["status"] = "idle"): RowInfo => ({ id, machine: { key: "m", glyph: "M", label: "m", alias: null, color: null, self: true, online: null }, folder: "f", status, questions: 0, since: null });
const infos = new Map<string, RowInfo>([["top", info("top")], ["s1", info("s1")], ["a", info("a", "needs you")], ["b", info("b")], ["o", info("o")]]);
// A stand-in for the sidebar's row: its fold caret and folded summary come from the tree.
const renderRow = (id: string, extra?: { depth?: number; tree?: RowTree }) => (
  <div data-testid={`row-${id}`} data-depth={extra?.depth ?? 0}>
    {id}
    {extra?.tree?.caret && <button aria-label={`${extra.tree.folded ? "Expand" : "Collapse"} ${id}`} onClick={extra.tree.onFold} />}
    {extra?.tree?.summary && <span data-testid={`summary-${id}`}>{`${extra.tree.summary}·${extra.tree.summaryNeeds ?? ""}`}</span>}
  </div>
);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(ipc.conductorAction).mockImplementation(async () => ({ conductor: useStore.getState().conductor, conductors: useStore.getState().conductors, claim: null }));
  useStore.setState({
    terminals: Object.fromEntries(order.map((id) => [id, tile(id)])),
    order,
    settings: Object.fromEntries(order.map((id) => [id, { ssh: null, claude, command: null, extra: {} }])),
    agentState: {},
    conductor: "top",
    conductors: { s1: { parent: "top", tiles: ["a", "b"] } },
    conductorAt: null,
    draggingTerminalId: null,
    persistenceReady: false,
  });
});

afterEach(cleanup);

const inside = (outer: string, inner: string) => screen.getByTestId(`tree-node-${outer}`).contains(screen.getByTestId(`row-${inner}`));

describe("ConductorTree", () => {
  it("nests the sidebar's own rows under their conductors", () => {
    render(<ConductorTree order={order} infos={infos} renderRow={renderRow} />);
    expect(inside("s1", "a") && inside("s1", "b")).toBe(true);
    expect(inside("top", "o") && inside("top", "s1")).toBe(true);
    expect(screen.queryByTestId("tree-node-o")?.querySelector("button[aria-label^='Collapse']")).toBeFalsy();
    // Each level down is one more step of indent.
    expect(screen.getByTestId("row-a").dataset.depth).toBe("2");
  });

  it("folds a conductor shut, says what needs you inside, and remembers the fold", () => {
    const { unmount } = render(<ConductorTree order={order} infos={infos} renderRow={renderRow} />);
    fireEvent.click(screen.getByLabelText("Collapse s1"));
    expect(screen.queryByTestId("row-a")).toBeNull();
    expect(screen.getByTestId("summary-s1").textContent).toBe("2 under·1 needs you");
    unmount();
    render(<ConductorTree order={order} infos={infos} renderRow={renderRow} />);
    expect(screen.queryByTestId("row-a")).toBeNull();
    fireEvent.click(screen.getByLabelText("Expand s1"));
    expect(screen.getByTestId("row-a")).toBeTruthy();
  });

  it("drops a tile onto a conductor to assign it, and a conductor onto another to move it", async () => {
    useStore.setState({ conductors: { s1: { parent: "top", tiles: ["a", "b"] }, s2: { parent: "top", tiles: [] } }, order: [...order, "s2"], terminals: { ...useStore.getState().terminals, s2: tile("s2") } });
    render(<ConductorTree order={[...order, "s2"]} infos={infos} renderRow={renderRow} />);
    expect(screen.getByTestId("tree-empty-s2").textContent).toBe("Drag tiles here");
    act(() => useStore.setState({ draggingTerminalId: "o" }));
    fireEvent.dragOver(screen.getByTestId("tree-node-s1"));
    expect(screen.getByTestId("tree-node-s1").className).toContain("ring-needs");
    await act(async () => {
      fireEvent.drop(screen.getByTestId("tree-node-s1"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("assign", "o", "s1");
    expect(useStore.getState().draggingTerminalId).toBeNull();
    act(() => useStore.setState({ draggingTerminalId: "s2" }));
    await act(async () => {
      fireEvent.drop(screen.getByTestId("tree-node-s1"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("sub", "s2", "s1");
  });

  it("ignores drops that make no sense, and shows a refusal from the tool", async () => {
    render(<ConductorTree order={order} infos={infos} renderRow={renderRow} />);
    act(() => useStore.setState({ draggingTerminalId: "a" }));
    fireEvent.dragOver(screen.getByTestId("tree-node-s1"));
    expect(screen.getByTestId("tree-node-s1").className).not.toContain("ring-needs");
    await act(async () => {
      fireEvent.drop(screen.getByTestId("tree-node-s1"));
    });
    expect(ipc.conductorAction).not.toHaveBeenCalled();
    act(() => useStore.setState({ draggingTerminalId: "s1" }));
    await act(async () => {
      fireEvent.drop(screen.getByTestId("tree-node-s1"));
    });
    expect(ipc.conductorAction).not.toHaveBeenCalled();
    vi.mocked(ipc.conductorAction).mockRejectedValueOnce("cannot be its parent (usage)");
    act(() => useStore.setState({ draggingTerminalId: "a" }));
    await act(async () => {
      fireEvent.drop(screen.getByTestId("tree-node-top"));
    });
    expect(await screen.findByText("cannot be its parent (usage)")).toBeTruthy();
  });

  it("shows the plain list and a hint with no conductor", () => {
    useStore.setState({ conductor: null, conductors: {} });
    render(<ConductorTree order={order} infos={infos} renderRow={renderRow} />);
    expect(screen.getByTestId("tree-no-conductor")).toBeTruthy();
    expect(order.every((id) => screen.getByTestId(`row-${id}`))).toBe(true);
  });
});
