import { describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ ipc: {} }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { useStore } from "../store";
import { mirrorChanged, mirrorFor, openTileSet, windowNames, zoneAt } from "./windowMirror";

describe("window mirrors", () => {
  it("gives a window its own tree, focus, zoom and notice, plus what is open anywhere", () => {
    const t = (id: string) => ({ id, name: id, cwd: "/", exited: null, error: null });
    useStore.setState({
      terminals: { a: t("a"), b: t("b") },
      layout: { kind: "group", id: "g1", tabs: ["a"], active: "a" },
      windows: { "win-abcd": { layout: { kind: "group", id: "g2", tabs: ["b"], active: "b" }, focusedGroupId: "g2" } },
      zoomed: { "win-abcd": "g2", main: "g1" },
      closedNotice: { window: "win-abcd", ids: ["x"], at: 1, undo: { kind: "tiles", places: [] } },
    });
    const s = useStore.getState();
    const m = mirrorFor(s, "win-abcd")!;
    expect(m.layout).toEqual({ kind: "group", id: "g2", tabs: ["b"], active: "b" });
    expect(m.focusedTerminalId).toBe("b");
    expect(m.zoomed).toEqual({ "win-abcd": "g2" });
    expect(m.closedNotice?.ids).toEqual(["x"]);
    expect(m.openTileIds.sort()).toEqual(["a", "b"]);
    expect(mirrorFor(s, "win-none")).toBeNull();
    expect(openTileSet(s)).toEqual(new Set(["a", "b"]));
    expect(openTileSet({ ...s, windowLabel: "win-abcd", openTileIds: ["q"] })).toEqual(new Set(["q"]));
    expect(mirrorChanged(s, s)).toBe(false);
    expect(mirrorChanged({ ...s, agentState: {} }, s)).toBe(true);
    expect(windowNames(s)).toEqual([{ label: "main", name: "Main window" }, { label: "win-abcd", name: "b" }]);
  });

  it("finds the drop zone under a point by the drag-over geometry", () => {
    const r = { left: 0, top: 0, width: 100, height: 100 };
    expect(zoneAt(r, 10, 50)).toBe("left");
    expect(zoneAt(r, 90, 50)).toBe("right");
    expect(zoneAt(r, 50, 10)).toBe("top");
    expect(zoneAt(r, 50, 90)).toBe("bottom");
    expect(zoneAt(r, 50, 50)).toBe("center");
  });
});
