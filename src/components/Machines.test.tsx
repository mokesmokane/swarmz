// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stats = (over: Record<string, unknown> = {}) => ({
  cpu: { percent: 42.5, load1: 3.2, cores: 8 },
  memory: { usedPercent: 71.2, totalBytes: 8589934592 },
  disk: { freePercent: 8.3, freeBytes: 20298100736 },
  uptimeSeconds: 4 * 86400 + 7200,
  claude: { working: 2, needsYou: 1, idle: 3, stopped: 1 },
  app: "0.8.0",
  tool: "0.1.0",
  build: 1,
  ...over,
});

vi.mock("../lib/ipc", () => ({
  ipc: {
    machineStats: vi.fn(async (host: string | null) => (host === "mokes@old" ? Promise.reject("old_tool") : stats())),
    tailscalePing: vi.fn(async (name: string) => (name === "far" ? { ms: 28, direct: false, relay: "lhr" } : { ms: 7, direct: true, relay: null })),
  },
}));

import { ipc } from "../lib/ipc";
import { useStore, machineList } from "../store";
import { MachinesSection, MachinesView, MACHINES_POLL_MS } from "./Machines";
import { ActivityBar } from "./ActivityBar";

const peer = (name: string, online = true, os = "macOS") => ({ name, hostName: name, ip: null, os, online });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    selfMachine: "mini",
    machines: { far: { alias: "Studio", color: "#f59e0b", lastUsed: "t" } },
    tailscale: { running: true, message: null, user: "mokes", self: peer("mini"), peers: [peer("far"), peer("old"), peer("gone", false), peer("phone", true, "android")] },
    machineStats: {},
    windowFocused: true,
    order: [],
    terminals: {},
    agentState: {},
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("machines", () => {
  it("lists this Mac first and every macOS peer with its ssh destination", () => {
    expect(machineList(useStore.getState())).toEqual([
      { name: "mini", self: true, online: true, host: null },
      { name: "far", self: false, online: true, host: "mokes@far" },
      { name: "old", self: false, online: true, host: "mokes@old" },
      { name: "gone", self: false, online: false, host: "mokes@gone" },
    ]);
  });

  it("asks every online Mac, pings the others, and records offline and old tools", async () => {
    await useStore.getState().refreshMachineStats();
    const m = useStore.getState().machineStats;
    expect(ipc.machineStats).toHaveBeenCalledWith(null);
    expect(ipc.machineStats).toHaveBeenCalledWith("mokes@far");
    expect(ipc.tailscalePing).not.toHaveBeenCalledWith("mini");
    expect(m.mini.stats?.cpu.percent).toBe(42.5);
    expect(m.far.ping).toEqual({ ms: 28, direct: false, relay: "lhr" });
    expect(m.old.error).toBe("old_tool");
    expect(m.gone.online).toBe(false);
    expect(ipc.machineStats).not.toHaveBeenCalledWith("mokes@gone");
  });

  it("shows a card per Mac with its numbers, a relayed ping, an old tool and an offline Mac", async () => {
    await act(async () => {
      render(<MachinesView />);
    });
    const far = screen.getByTestId("machine-card-far");
    expect(far.textContent).toContain("Studio");
    expect(far.textContent).toContain("28ms via lhr");
    expect(far.textContent).toContain("42.5% · load 3.2 / 8 cores");
    expect(far.textContent).toContain("71.2% of 8.0 GB");
    expect(far.textContent).toContain("18.9 GB free (8.3%)");
    expect(far.textContent).toContain("2 working · 1 need you · 3 idle · 1 stopped");
    expect(far.textContent).toContain("4d 2h");
    expect(far.textContent).toContain("app 0.8.0 · tool 0.1.0");
    expect(screen.getByTestId("machine-card-mini").textContent).toContain("this Mac");
    expect(screen.getByTestId("machine-card-old").textContent).toContain("update swarmz there");
    expect(screen.getByTestId("machine-card-gone").textContent).toContain("offline");
    expect(screen.queryByTestId("machine-card-phone")).toBeNull();
  });

  it("sets a Mac's colour and theme from its card, Automatic by default", async () => {
    await act(async () => {
      render(<MachinesView />);
    });
    fireEvent.click(screen.getByTestId("theme-row-mini"));
    expect(screen.getByRole("radio", { name: "Automatic colour" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Colour #ef4444" }));
    });
    expect(useStore.getState().machines.mini?.color).toBe("#ef4444");
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Automatic colour" }));
    });
    expect(useStore.getState().machines.mini?.color).toBeNull();
    expect(screen.getByTestId("theme-picker-mini")).toBeTruthy();
  });

  it("shows one line per Mac in the section, and polls every 30 s only while focused", async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(<MachinesSection active />);
    });
    expect(screen.getByTestId("machine-line-far").textContent).toContain("28ms ↯");
    expect(screen.getByTestId("machine-line-far").textContent).toContain("6 Claude1 needs you");
    expect(screen.getByTestId("machine-line-gone").textContent).toContain("offline");
    const asked = vi.mocked(ipc.machineStats).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MACHINES_POLL_MS - 1);
    });
    expect(vi.mocked(ipc.machineStats).mock.calls.length).toBe(asked);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(vi.mocked(ipc.machineStats).mock.calls.length).toBeGreaterThan(asked);
    act(() => useStore.setState({ windowFocused: false }));
    const paused = vi.mocked(ipc.machineStats).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MACHINES_POLL_MS * 3);
    });
    expect(vi.mocked(ipc.machineStats).mock.calls.length).toBe(paused);
  });
});

describe("ActivityBar", () => {
  it("lights the active view, picks views, opens the conductors, and badges what needs attention", () => {
    const pick = vi.fn();
    useStore.setState({
      order: ["t1"],
      terminals: { t1: { id: "t1", name: "t", cwd: "/", exited: null, error: null } },
      agentState: { t1: { status: "blocked", sessionId: "s", since: "t", lastEvent: "Notification", unseen: false, title: null, firstPrompt: null } },
      machineStats: { gone: { name: "gone", self: false, online: false, stats: null, error: null, ping: null, at: "t" } },
      conductorsPanel: false,
    });
    const { rerender } = render(<ActivityBar view="terminals" folded={false} onPick={pick} />);
    expect(screen.getByLabelText("Terminals").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("badge-needs")).toBeNull();
    expect(screen.getByTestId("badge-machines")).toBeTruthy();
    // Machines opens from the sidebar's footer now (sidebar redesign spec), not the bar.
    expect(screen.queryByLabelText("Machines")).toBeNull();
    fireEvent.click(screen.getByLabelText("Conductors"));
    expect(useStore.getState().conductorsPanel).toBe(true);
    rerender(<ActivityBar view="machines" folded={false} onPick={pick} />);
    expect(screen.getByTestId("badge-needs").textContent).toBe("1");
    rerender(<ActivityBar view="terminals" folded onPick={pick} />);
    expect(screen.getByTestId("badge-needs").textContent).toBe("1");
    expect(screen.getByLabelText("Terminals").getAttribute("aria-pressed")).toBe("false");
    useStore.setState({ conductorsPanel: false });
  });
});
