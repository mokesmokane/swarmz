// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo } from "./ipc";

const { instances } = vi.hoisted(() => ({
  instances: [] as { disposed: boolean; selection: string; element: HTMLElement | null }[],
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    disposed = false;
    element: HTMLElement | null = null;
    selection = "";
    options: { theme?: Record<string, string>; macOptionClickForcesSelection?: boolean } = {};
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...(options as { theme?: Record<string, string>; macOptionClickForcesSelection?: boolean }) };
      instances.push(this);
    }
    dataHandler: ((d: string) => void) | null = null;
    oscHandlers: Record<number, (data: string) => boolean | Promise<boolean>> = {};
    parser = {
      registerOscHandler: (n: number, cb: (data: string) => boolean | Promise<boolean>) => {
        this.oscHandlers[n] = cb;
        return { dispose: () => {} };
      },
    };
    onData(cb: (d: string) => void) {
      this.dataHandler = cb;
    }
    onResize() {}
    write() {}
    loadAddon() {}
    open(container: HTMLElement) {
      this.element = document.createElement("div");
      container.appendChild(this.element);
    }
    focus() {}
    hasSelection() {
      return this.selection.length > 0;
    }
    getSelection() {
      return this.selection;
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit() {}
  }
  return { FitAddon };
});

vi.mock("./ipc", () => ({
  ipc: {
    writeTerminal: vi.fn(async () => {}),
    resizeTerminal: vi.fn(async () => {}),
    onData: vi.fn(async () => () => {}),
    onExit: vi.fn(async () => () => {}),
    terminalCwd: vi.fn(async () => null),
    setTerminalCwd: vi.fn(async (id: string, cwd: string) => ({ id, name: "x", cwd, exited: null, error: null })),
  },
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useStore } from "../store";
import { ipc } from "./ipc";
import { CWD_POLL_AFTER_ENTER_MS, CWD_POLL_INTERVAL_MS, attach, decodeOsc7, dispose, prepare } from "./xtermRegistry";

function info(id: string, name = id): TerminalInfo {
  return { id, name, cwd: "/tmp/x", exited: null, error: null };
}

beforeEach(() => {
  useStore.setState({ terminals: {} });
  vi.mocked(writeText).mockClear();
});

describe("xtermRegistry dispose-on-removal subscription", () => {
  it("only disposes ids that were present in terminals and are now gone, leaving in-flight entries alone", async () => {
    // "a" completed spawning and is tracked in the store; "b" was prepared (e.g. as part of
    // an in-flight createTerminal awaiting its IPC round trip) but never made it into
    // state.terminals.
    await prepare("a");
    await prepare("b");
    useStore.setState({ terminals: { a: info("a") } });

    const [termA, termB] = instances;

    // An unrelated store update (e.g. another terminal being renamed elsewhere) replaces the
    // terminals object but keeps "a" and never included "b". Neither should be disposed.
    useStore.setState({ terminals: { a: info("a", "renamed") } });
    expect(termA.disposed).toBe(false);
    expect(termB.disposed).toBe(false);

    // "a" is now actually removed from the store (closed) - it should be disposed. "b" was
    // never in a previous terminals snapshot, so it must still survive.
    useStore.setState({ terminals: {} });
    expect(termA.disposed).toBe(true);
    expect(termB.disposed).toBe(false);
  });
});

describe("copy selection to clipboard on mouse-up", () => {
  it("copies the selected text when the mouse is released over the terminal", () => {
    const container = document.createElement("div");
    const { term } = attach("c", container);
    (term as unknown as { selection: string }).selection = "hello world";

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello world");
  });

  it("flashes the pane once the clipboard write succeeds", async () => {
    const container = document.createElement("div");
    const { term } = attach("c2", container);
    (term as unknown as { selection: string }).selection = "copied text";
    useStore.setState({ copiedAt: {} });

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(useStore.getState().copiedAt.c2).toBeUndefined();
    await vi.waitFor(() => expect(typeof useStore.getState().copiedAt.c2).toBe("number"));
  });

  it("does not flash when the clipboard write fails", async () => {
    vi.mocked(writeText).mockRejectedValueOnce(new Error("denied"));
    const container = document.createElement("div");
    const { term } = attach("c3", container);
    (term as unknown as { selection: string }).selection = "x";
    useStore.setState({ copiedAt: {} });
    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().copiedAt.c3).toBeUndefined();
  });

  it("lets Option-drag select inside programs that track the mouse", () => {
    const container = document.createElement("div");
    const { term } = attach("c4", container);
    expect((term as unknown as { options: { macOptionClickForcesSelection?: boolean } }).options.macOptionClickForcesSelection).toBe(true);
  });

  it("does not copy when there is no selection", () => {
    const container = document.createElement("div");
    const { term } = attach("d", container);

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).not.toHaveBeenCalled();
  });

  it("stops copying once the terminal is disposed", () => {
    const container = document.createElement("div");
    const { term } = attach("e", container);
    (term as unknown as { selection: string }).selection = "goodbye";
    const element = term.element!;

    dispose("e");
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps copying, once per mouse-up, after being re-parented into another container", () => {
    const container1 = document.createElement("div");
    const container2 = document.createElement("div");
    const { term } = attach("f", container1);
    (term as unknown as { selection: string }).selection = "reparented";

    attach("f", container2);
    expect(term.element!.parentElement).toBe(container2);

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("reparented");
  });
});

describe("folder tracking", () => {
  beforeEach(() => {
    useStore.setState({
      terminals: { f: { id: "f", name: "f", cwd: "/a", exited: null, error: null } },
      order: ["f"],
      settings: { f: { ssh: null, claude: null, command: null, extra: {} } },
    });
    vi.mocked(ipc.terminalCwd).mockReset().mockResolvedValue("/b");
    vi.mocked(ipc.setTerminalCwd).mockClear();
  });

  it("polls the folder 300 ms after Enter and applies a change", async () => {
    vi.useFakeTimers();
    try {
      const { term } = attach("f", document.createElement("div"));
      (term as unknown as { dataHandler: (d: string) => void }).dataHandler("\r");
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      expect(ipc.terminalCwd).toHaveBeenCalledWith("f");
      await vi.advanceTimersByTimeAsync(0);
      expect(ipc.setTerminalCwd).toHaveBeenCalledWith("f", "/b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls on the interval and stops after dispose", async () => {
    vi.useFakeTimers();
    try {
      attach("f", document.createElement("div"));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.terminalCwd).toHaveBeenCalledTimes(1);
      dispose("f");
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS * 2);
      expect(ipc.terminalCwd).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never polls an ssh tile or an exited tile", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState((s) => ({ settings: { ...s.settings, f: { ...s.settings.f, ssh: { host: "me@box", cwd: "/p" } } } }));
      const { term } = attach("f", document.createElement("div"));
      (term as unknown as { dataHandler: (d: string) => void }).dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS + CWD_POLL_AFTER_ENTER_MS);
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
      useStore.setState((s) => ({ settings: { ...s.settings, f: { ...s.settings.f, ssh: null } }, terminals: { f: { ...s.terminals.f, exited: 0 } } }));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("OSC 7 applies the decoded path for any tile", async () => {
    const { term } = attach("f", document.createElement("div"));
    const handler = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[7];
    expect(handler("file://box/Users/me/my%20proj")).toBe(true);
    await vi.waitFor(() => expect(ipc.setTerminalCwd).toHaveBeenCalledWith("f", "/Users/me/my proj"));
  });

  it("decodeOsc7 handles hostless and malformed payloads", () => {
    expect(decodeOsc7("file://localhost/a/b")).toBe("/a/b");
    expect(decodeOsc7("file:///a/b")).toBe("/a/b");
    expect(decodeOsc7("/plain")).toBe("/plain");
    expect(decodeOsc7("nonsense")).toBeNull();
    expect(decodeOsc7("file://h/%ZZ")).toBeNull();
  });
});
