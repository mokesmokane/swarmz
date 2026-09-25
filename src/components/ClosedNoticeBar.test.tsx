// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ ipc: {} }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { useStore } from "../store";
import { ClosedNoticeBar } from "./ClosedNoticeBar";

afterEach(cleanup);

describe("the still-running notice", () => {
  it("names the tile, and Undo opens it where it was", async () => {
    useStore.setState({
      windowLabel: "main",
      terminals: { a: { id: "a", name: "alpha", cwd: "/", exited: null, error: null } },
      order: ["a"],
      settings: {},
      agentState: {},
      layout: null,
      windows: {},
      closedNotice: { window: "main", ids: ["a"], at: 1, undo: { kind: "tiles", places: [{ id: "a", groupId: null }] } },
    });
    render(<ClosedNoticeBar />);
    expect(screen.getByTestId("closed-notice").textContent).toContain("“alpha” is still running. Remove it from the sidebar to stop it.");
    fireEvent.click(screen.getByText("Undo"));
    await vi.waitFor(() => expect(useStore.getState().layout).toMatchObject({ tabs: ["a"] }));
    expect(screen.queryByTestId("closed-notice")).toBeNull();
  });

  it("shows only in the window it is for", () => {
    useStore.setState({ windowLabel: "win-abcd", closedNotice: { window: "main", ids: ["a", "b"], at: 1, undo: { kind: "tiles", places: [] } } });
    render(<ClosedNoticeBar />);
    expect(screen.queryByTestId("closed-notice")).toBeNull();
  });
});
