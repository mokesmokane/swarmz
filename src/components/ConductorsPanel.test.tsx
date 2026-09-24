// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    conductorAction: vi.fn(async () => ({ conductor: "top", conductors: {}, claim: null })),
    loadWorkspace: vi.fn(async () => null),
    saveWorkspace: vi.fn(async () => {}),
    workspaceStat: vi.fn(async () => null),
  },
}));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { ConductorsPanel } from "./ConductorsPanel";

const claude = { enabled: true, sessionId: "s", skipPermissions: false, started: true };
const tile = (id: string, name: string) => ({ id, name, cwd: `/p/${name}`, exited: null, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  // The tool answers with the tree as it stands, so one action does not wipe it for the next.
  vi.mocked(ipc.conductorAction).mockImplementation(async () => ({ conductor: useStore.getState().conductor, conductors: useStore.getState().conductors, claim: null }));
  useStore.setState({
    terminals: { top: tile("top", "ops"), sub: tile("sub", "certify"), a: tile("a", "alpha"), b: tile("b", "bravo"), sh: tile("sh", "shell") },
    order: ["top", "sub", "a", "b", "sh"],
    settings: {
      top: { ssh: null, claude, command: null, extra: {} },
      sub: { ssh: null, claude, command: null, extra: {} },
      a: { ssh: null, claude, command: null, extra: {} },
      b: { ssh: { host: "me@box", cwd: "/r", machine: "box" }, claude, command: null, extra: {} },
      sh: { ssh: null, claude: null, command: null, extra: {} },
    },
    machines: { box: { alias: "Studio", color: null, lastUsed: "t" } },
    agentState: {},
    conductor: "top",
    conductors: { sub: { parent: "top", tiles: ["a"] } },
    conductorsPanel: true,
    persistenceReady: false,
  });
});

afterEach(cleanup);

const row = (id: string) => screen.getByTestId(`tree-row-${id}`);
const depth = (id: string) => Number(row(id).style.paddingLeft.replace("px", ""));

describe("ConductorsPanel", () => {
  it("shows the tree: the top, a conductor with its tiles, and the rest under the top", () => {
    render(<ConductorsPanel />);
    expect(screen.getByRole("dialog", { name: "Conductors" })).toBeTruthy();
    expect(depth("top")).toBe(8);
    expect(depth("sub")).toBe(28);
    expect(depth("a")).toBe(48);
    expect(depth("b")).toBe(28);
    expect(row("b").textContent).toContain("bravo · Studio");
    expect(row("top").getAttribute("draggable")).toBe("false");
    expect(row("sub").querySelector("[aria-label='Conductor']")).toBeTruthy();
    // Only Claude tiles can be made conductors; conductors can be turned back.
    expect(screen.queryByLabelText("Make sh a conductor")).toBeNull();
    expect(screen.getByLabelText("Make b a conductor")).toBeTruthy();
    expect(screen.getByLabelText("Not a conductor: sub")).toBeTruthy();
  });

  it("drags a tile onto a conductor to assign it, and a conductor onto another to move it", async () => {
    useStore.setState({ conductors: { sub: { parent: "top", tiles: ["a"] }, sub2: { parent: "top", tiles: [] } }, terminals: { ...useStore.getState().terminals, sub2: tile("sub2", "desk") }, order: [...useStore.getState().order, "sub2"] });
    render(<ConductorsPanel />);
    fireEvent.dragStart(row("b"));
    fireEvent.dragOver(row("sub"));
    expect(row("sub").className).toContain("ring-amber");
    await act(async () => {
      fireEvent.drop(row("sub"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("assign", "b", "sub");
    fireEvent.dragStart(row("sub2"));
    await act(async () => {
      fireEvent.dragOver(row("sub"));
      fireEvent.drop(row("sub"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("sub", "sub2", "sub");
    // A plain tile is no drop target, and nothing moves onto itself.
    vi.mocked(ipc.conductorAction).mockClear();
    fireEvent.dragStart(row("a"));
    fireEvent.drop(row("b"));
    fireEvent.drop(row("a"));
    expect(ipc.conductorAction).not.toHaveBeenCalled();
  });

  it("moves with the row's select, makes and unmakes conductors, and shows a refusal", async () => {
    render(<ConductorsPanel />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Move a under"), { target: { value: "top" } });
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("assign", "a", "top");
    // A conductor cannot be moved under itself: its own select leaves it out.
    const own = Array.from((screen.getByLabelText("Move sub under") as HTMLSelectElement).options).map((o) => o.value);
    expect(own).toEqual(["top"]);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Make b a conductor"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("sub", "b", "top");
    vi.mocked(ipc.conductorAction).mockRejectedValueOnce("the parent must be a conductor above it (usage)");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Not a conductor: sub"));
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("remove", "sub");
    expect(await screen.findByText("the parent must be a conductor above it (usage)")).toBeTruthy();
  });

  it("offers the Claude tiles as the top when there is none, and closes on Esc", async () => {
    useStore.setState({ conductor: null, conductors: {} });
    render(<ConductorsPanel />);
    expect(screen.getByText(/No conductor yet/)).toBeTruthy();
    expect(screen.getAllByText("Make conductor").length).toBe(4);
    await act(async () => {
      fireEvent.click(screen.getAllByText("Make conductor")[1]);
    });
    expect(ipc.conductorAction).toHaveBeenLastCalledWith("set", "sub");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().conductorsPanel).toBe(false);
  });
});
