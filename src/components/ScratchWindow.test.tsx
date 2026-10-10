// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ ipc: { writeTerminal: vi.fn(async () => {}), closeTerminal: vi.fn(async () => {}), resizeTerminal: vi.fn(async () => {}) } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../lib/xtermRegistry", () => ({ attach: vi.fn(() => ({ term: {}, fit: { fit: vi.fn() } })), fitAndFocus: vi.fn() }));

import { useStore } from "../store";
import { ScratchWindow } from "./ScratchWindow";
import { attach, fitAndFocus } from "../lib/xtermRegistry";

const ID = "t1";
class FakeResizeObserver { observe() {} disconnect() {} }
const base = { started: true, open: true, rect: null, request: null, focusToken: 1, pulse: false, inHome: false, label: "/tmp/proj" };

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  useStore.setState({ scratch: { [ID]: base } });
});
afterEach(() => cleanup());

describe("ScratchWindow", () => {
  it("mounts the scratch xterm and takes the keyboard when asked", () => {
    render(<ScratchWindow tileId={ID} />);
    expect(screen.getByTestId("scratch-window").textContent).toContain("scratch · /tmp/proj");
    expect(attach).toHaveBeenCalledWith("scratch-t1", screen.getByTestId("scratch-mount"));
    expect(fitAndFocus).toHaveBeenCalledWith("scratch-t1");
  });

  it("renders nothing while hidden", () => {
    useStore.setState({ scratch: { [ID]: { ...base, open: false } } });
    render(<ScratchWindow tileId={ID} />);
    expect(screen.queryByTestId("scratch-window")).toBeNull();
  });

  it("– hides, ✕ ends", () => {
    const hide = vi.fn();
    const end = vi.fn(async () => {});
    useStore.setState({ hideScratch: hide, endScratch: end });
    render(<ScratchWindow tileId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide scratch shell" }));
    expect(hide).toHaveBeenCalledWith(ID);
    fireEvent.click(screen.getByRole("button", { name: "End scratch shell" }));
    expect(end).toHaveBeenCalledWith(ID);
  });

  it("shows an agent's request with Type it", () => {
    const type = vi.fn();
    useStore.setState({ typeScratchCommand: type, scratch: { [ID]: { ...base, request: { note: "Log in to GitHub", command: "gh auth login --web", agent: "Claude", at: "t" } } } });
    render(<ScratchWindow tileId={ID} />);
    expect(screen.getByText(/Claude asks:/).parentElement?.textContent).toContain("Log in to GitHub");
    expect(screen.getByText("gh auth login --web")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Type it" }));
    expect(type).toHaveBeenCalledWith(ID);
  });

  it("says when it opened in the home folder", () => {
    useStore.setState({ scratch: { [ID]: { ...base, inHome: true, label: "~" } } });
    render(<ScratchWindow tileId={ID} />);
    expect(screen.getByTestId("scratch-window").textContent).toContain("folder missing, opened in ~");
  });
});
