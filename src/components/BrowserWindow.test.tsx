// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  ipc: { browserShow: vi.fn(async () => {}), browserGo: vi.fn(async () => {}), browserClose: vi.fn(async () => {}) },
}));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { useBrowserBlock } from "../lib/browserBlock";
import { emptyBrowser } from "../lib/browser";
import { BrowserWindow } from "./BrowserWindow";

class RO {
  observe() {}
  disconnect() {}
}

const lastShow = () => vi.mocked(ipc.browserShow).mock.lastCall;

describe("BrowserWindow", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", RO);
    vi.mocked(ipc.browserShow).mockClear();
    useBrowserBlock.setState({ count: 0 });
    // A real agent tile: the store closes browsers whose tile is gone or not an agent.
    useStore.setState({
      terminals: { t1: { id: "t1", name: "t1", cwd: "/tmp", exited: null, error: null } },
      settings: { t1: { ssh: null, claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true }, command: null, extra: {} } },
    });
    useStore.setState({ windowLabel: "main", draggingTerminalId: null, browser: { t1: { ...emptyBrowser(), open: true, url: "https://example.com/", title: "Example" } } });
  });
  afterEach(cleanup);

  it("shows the page in this window, and hides it for a drag, an overlay, a blocked pane and on unmount", async () => {
    const view = render(<div style={{ width: 900, height: 600 }}><BrowserWindow tileId="t1" blocked={false} /></div>);
    await vi.waitFor(() => expect(lastShow()).toEqual(["t1", "main", "https://example.com/", expect.any(Object), true]));
    act(() => useStore.setState({ draggingTerminalId: "t2" }));
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
    act(() => useStore.setState({ draggingTerminalId: null }));
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(true));
    act(() => useBrowserBlock.setState({ count: 1 }));
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
    act(() => useBrowserBlock.setState({ count: 0 }));
    view.rerender(<div><BrowserWindow tileId="t1" blocked /></div>);
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
    view.rerender(<div><BrowserWindow tileId="t1" blocked={false} /></div>);
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(true));
    view.unmount();
    await vi.waitFor(() => expect(lastShow()?.[4]).toBe(false));
  });

  it("the address bar loads typed text and refuses other schemes", () => {
    const navigate = vi.spyOn(useStore.getState(), "navigateBrowser");
    render(<BrowserWindow tileId="t1" blocked={false} />);
    const bar = screen.getByRole("textbox", { name: "Address" });
    fireEvent.change(bar, { target: { value: "localhost:1420" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("t1", "http://localhost:1420");
    fireEvent.change(bar, { target: { value: "file:///etc/passwd" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByText(/only opens http and https/)).toBeTruthy();
  });

  it("shows the agent's note with Go there, and the stalled-load strip", () => {
    useStore.setState({ browser: { t1: { ...emptyBrowser(), open: true, url: "https://news.example.com/", request: { url: "https://appstoreconnect.apple.com/apps", note: "Create the app", agent: "Claude", at: "x" }, loading: true, loadingSince: Date.now() - 30_000 } } });
    const navigate = vi.spyOn(useStore.getState(), "navigateBrowser");
    render(<BrowserWindow tileId="t1" blocked={false} />);
    expect(screen.getByText("Claude asks:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go there" }));
    expect(navigate).toHaveBeenCalledWith("t1", "https://appstoreconnect.apple.com/apps");
    expect(screen.getByText("This page hasn't finished loading")).toBeTruthy();
  });

  it("renders nothing visible when the browser is hidden", () => {
    useStore.setState({ browser: { t1: { ...emptyBrowser(), open: false } } });
    render(<BrowserWindow tileId="t1" blocked={false} />);
    expect(screen.queryByTestId("browser-window")).toBeNull();
  });
});
