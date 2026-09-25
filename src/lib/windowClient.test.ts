import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ ipc: { openView: vi.fn(async () => {}), closeView: vi.fn(async () => {}), windowAction: vi.fn(async () => {}) } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("./xtermRegistry", () => ({ prepare: vi.fn(async () => {}), dispose: vi.fn() }));

import { useStore } from "../store";
import { dispose, prepare } from "./xtermRegistry";
import { installMirror, labelFromLocation, manageViewers } from "./windowClient";

const t = (id: string, exited: number | null = null) => ({ id, name: id, cwd: "/", exited, error: null });

describe("another window's store", () => {
  it("reads its label from the address", () => {
    expect(labelFromLocation("?window=win-ab12cd")).toBe("win-ab12cd");
    expect(labelFromLocation("?window=main")).toBeNull();
    expect(labelFromLocation("")).toBeNull();
  });

  it("sends allow-listed actions to the main window and ignores main-only ones", async () => {
    const sent: unknown[] = [];
    installMirror("win-abcd", async (a) => void sent.push(a));
    const s = useStore.getState();
    expect(s.windowLabel).toBe("win-abcd");
    s.moveTerminal("a", "g1");
    await s.createTerminal("/tmp", { kind: "tab", groupId: "g1" });
    s.setDragging("a");
    expect(useStore.getState().draggingTerminalId).toBe("a");
    await s.setTerminalCwd("a", "/x", "osc7");
    s.flashCopied("a");
    expect(sent).toEqual([
      { label: "win-abcd", name: "moveTerminal", args: ["a", "g1"] },
      { label: "win-abcd", name: "createTerminal", args: ["/tmp", { kind: "tab", groupId: "g1" }] },
      { label: "win-abcd", name: "setDragging", args: ["a"] },
    ]);
  });

  it("opens a viewer per tile shown, again after a restart, and closes it when the tile leaves", async () => {
    const api = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    useStore.setState({ terminals: { a: t("a"), b: t("b", 1) }, layout: { kind: "group", id: "g", tabs: ["a", "b"], active: "a" } });
    const stop = manageViewers(api);
    await vi.waitFor(() => expect(api.open).toHaveBeenCalledWith("a"));
    expect(api.open).not.toHaveBeenCalledWith("b");
    // b restarts: its viewer opens now.
    useStore.setState({ terminals: { a: t("a"), b: t("b") } });
    await vi.waitFor(() => expect(api.open).toHaveBeenCalledWith("b"));
    // a leaves this window: its viewer and pane go.
    useStore.setState({ layout: { kind: "group", id: "g", tabs: ["b"], active: "b" } });
    expect(api.close).toHaveBeenCalledWith("a");
    expect(dispose).toHaveBeenCalledWith("a");
    expect(prepare).toHaveBeenCalledWith("a");
    stop();
  });
});
