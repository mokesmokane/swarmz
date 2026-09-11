// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    createTerminal: vi.fn(async (id: string, cwd: string, _c: number, _r: number, name?: string) => ({
      id,
      name: name ?? "x",
      cwd,
      exited: null,
      error: null,
    })),
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
    sshListDir: vi.fn(async () => ({ path: "/", parent: null, dirs: [] })),
    terminalForegroundBusy: vi.fn(async () => false),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { useStore } from "../store";
import { NewSshTerminal } from "./NewSshTerminal";

beforeEach(() => {
  useStore.setState({
    sshHistory: {
      "mokes@172.16.82.70": { cwd: "/Users/mokes/projects/certifyIP-desktop", lastUsed: "2026-09-11T14:30:44.496Z" },
      "me@other": { cwd: null, lastUsed: "2026-09-10T00:00:00Z" },
    },
  });
});
afterEach(() => cleanup());

describe("NewSshTerminal", () => {
  it("shows recent hosts as soon as the form opens, newest first, with their last folder", () => {
    render(<NewSshTerminal onClose={() => {}} />);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "mokes@172.16.82.70/Users/mokes/projects/certifyIP-desktop×",
      "me@other×",
    ]);
  });

  it("filters as you type and fills the field when a recent host is chosen", () => {
    render(<NewSshTerminal onClose={() => {}} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "other" } });
    expect(screen.getAllByRole("option").length).toBe(1);
    fireEvent.click(screen.getByText("me@other"));
    expect(input.value).toBe("me@other");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reopens the list on focus and forgets a host with ×", () => {
    render(<NewSshTerminal onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input);
    expect(screen.getAllByRole("option").length).toBe(2);
    act(() => {
      fireEvent.click(screen.getAllByTitle("Forget this host")[1]);
    });
    expect(screen.getAllByRole("option").length).toBe(1);
    expect(useStore.getState().sshHistory["me@other"]).toBeUndefined();
  });
});
