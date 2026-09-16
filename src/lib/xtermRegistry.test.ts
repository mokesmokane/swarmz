// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo } from "./ipc";

const { instances, dataCallbacks, replayCallbacks } = vi.hoisted(() => ({
  instances: [] as { disposed: boolean; selection: string; element: HTMLElement | null }[],
  dataCallbacks: {} as Record<string, (b: Uint8Array) => void>,
  replayCallbacks: {} as Record<string, (b: Uint8Array) => void>,
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
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean) {
      this.keyHandler = cb;
    }
    onResize() {}
    writes: Array<{ data: unknown; done?: () => void }> = [];
    write(data: unknown, done?: () => void) {
      this.writes.push({ data, done });
    }
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
    onData: vi.fn(async (_id: string, cb: (b: Uint8Array) => void) => {
      dataCallbacks[_id] = cb;
      return () => {};
    }),
    onReplay: vi.fn(async (_id: string, cb: (b: Uint8Array) => void) => {
      replayCallbacks[_id] = cb;
      return () => {};
    }),
    onExit: vi.fn(async () => () => {}),
    terminalCwd: vi.fn(async () => null),
    setTerminalCwd: vi.fn(async (id: string, cwd: string) => ({ id, name: "x", cwd, exited: null, error: null })),
    pasteImageToRemote: vi.fn(async () => null as string | null),
    remoteTileInfo: vi.fn(async () => ({ running: false }) as { running: boolean; cwd?: string | null }),
  },
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useStore } from "../store";
import { ipc } from "./ipc";
import {
  CWD_POLL_AFTER_ENTER_MS,
  CWD_POLL_INTERVAL_MS,
  IMAGE_PASTE_KEY,
  REMOTE_REPLAY_MARKED_MAX_MS,
  REMOTE_REPLAY_MAX_MS,
  REPLAY_END_MARKER,
  SHIFT_ENTER_SEQUENCE,
  attach,
  decodeOsc52,
  decodeOsc7,
  dispose,
  parseAttachMarker,
  prepare,
} from "./xtermRegistry";

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
  // These tiles are never in `terminals`, so the store subscription that disposes removed
  // terminals never reaches them: without this bookkeeping each one leaks a real 5 s cwd-poll
  // interval into every test that runs after, including the fake-timer ones below.
  const openIds: string[] = [];
  const opened: { disposed: boolean }[] = [];
  function open(id: string, container: HTMLElement) {
    openIds.push(id);
    const r = attach(id, container);
    opened.push(r.term as unknown as { disposed: boolean });
    return r;
  }
  afterEach(() => {
    while (openIds.length) dispose(openIds.pop()!);
  });

  it("copies the selected text when the mouse is released over the terminal", () => {
    const container = document.createElement("div");
    const { term } = open("c", container);
    (term as unknown as { selection: string }).selection = "hello world";

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello world");
  });

  it("flashes the pane once the clipboard write succeeds", async () => {
    const container = document.createElement("div");
    const { term } = open("c2", container);
    (term as unknown as { selection: string }).selection = "copied text";
    useStore.setState({ copiedAt: {} });

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(useStore.getState().copiedAt.c2).toBeUndefined();
    await vi.waitFor(() => expect(typeof useStore.getState().copiedAt.c2).toBe("number"));
  });

  it("does not flash when the clipboard write fails", async () => {
    vi.mocked(writeText).mockRejectedValueOnce(new Error("denied"));
    const container = document.createElement("div");
    const { term } = open("c3", container);
    (term as unknown as { selection: string }).selection = "x";
    useStore.setState({ copiedAt: {} });
    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().copiedAt.c3).toBeUndefined();
  });

  it("lets Option-drag select inside programs that track the mouse", () => {
    const container = document.createElement("div");
    const { term } = open("c4", container);
    expect((term as unknown as { options: { macOptionClickForcesSelection?: boolean } }).options.macOptionClickForcesSelection).toBe(true);
  });

  it("does not copy when there is no selection", () => {
    const container = document.createElement("div");
    const { term } = open("d", container);

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).not.toHaveBeenCalled();
  });

  it("stops copying once the terminal is disposed", () => {
    const container = document.createElement("div");
    const { term } = open("e", container);
    (term as unknown as { selection: string }).selection = "goodbye";
    const element = term.element!;

    dispose("e");
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps copying, once per mouse-up, after being re-parented into another container", () => {
    const container1 = document.createElement("div");
    const container2 = document.createElement("div");
    const { term } = open("f", container1);
    (term as unknown as { selection: string }).selection = "reparented";

    open("f", container2);
    expect(term.element!.parentElement).toBe(container2);

    term.element!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("reparented");
  });

  // Runs last in this describe: every terminal the tests above attached must be gone, and with
  // it the real interval `attach` starts.
  it("leaves no terminal of its own attached", () => {
    expect(opened.filter((t) => !t.disposed)).toEqual([]);
  });
});

describe("Shift+Enter", () => {
  const key = (type: string, init: KeyboardEventInit) => new KeyboardEvent(type, init);
  const handlerOf = (term: unknown) => (term as { keyHandler: (e: KeyboardEvent) => boolean }).keyHandler;

  beforeEach(() => {
    useStore.setState({ terminals: { k: { id: "k", name: "k", cwd: "/", exited: null, error: null } }, order: ["k"], settings: { k: { ssh: null, claude: null, command: null, extra: {} } } });
    vi.mocked(ipc.writeTerminal).mockClear();
  });
  afterEach(() => dispose("k"));

  it("sends a line feed (Claude inserts a newline; shells treat it as Enter) instead of a carriage return", () => {
    const { term } = attach("k", document.createElement("div"));
    expect(handlerOf(term)(key("keydown", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(ipc.writeTerminal).toHaveBeenCalledTimes(1);
    expect(ipc.writeTerminal).toHaveBeenCalledWith("k", SHIFT_ENTER_SEQUENCE);
    expect(SHIFT_ENTER_SEQUENCE).toBe("\n");
  });

  it("swallows the matching keypress and keyup without sending again", () => {
    const { term } = attach("k", document.createElement("div"));
    expect(handlerOf(term)(key("keypress", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(handlerOf(term)(key("keyup", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });

  it("leaves plain Enter and other modified Enters to xterm", () => {
    const { term } = attach("k", document.createElement("div"));
    expect(handlerOf(term)(key("keydown", { key: "Enter" }))).toBe(true);
    expect(handlerOf(term)(key("keydown", { key: "Enter", shiftKey: true, ctrlKey: true }))).toBe(true);
    expect(handlerOf(term)(key("keydown", { key: "Enter", shiftKey: true, altKey: true }))).toBe(true);
    expect(handlerOf(term)(key("keydown", { key: "Enter", shiftKey: true, metaKey: true }))).toBe(true);
    expect(handlerOf(term)(key("keydown", { key: "a", shiftKey: true }))).toBe(true);
    expect(ipc.writeTerminal).not.toHaveBeenCalled();
  });
});

describe("OSC 52 clipboard writes from programs in the terminal", () => {
  const handlerFor = (term: unknown) => (term as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[52];

  beforeEach(() => {
    useStore.setState({ terminals: { o: { id: "o", name: "o", cwd: "/", exited: null, error: null } }, order: ["o"], settings: { o: { ssh: null, claude: null, command: null, extra: {} } }, copiedAt: {} });
    vi.mocked(writeText).mockClear();
  });

  it("copies the base64 payload to the clipboard and flashes the pane", async () => {
    const { term } = attach("o", document.createElement("div"));
    const payload = btoa(unescape(encodeURIComponent("hello wörld")));
    expect(handlerFor(term)(`c;${payload}`)).toBe(true);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("hello wörld"));
    await vi.waitFor(() => expect(typeof useStore.getState().copiedAt.o).toBe("number"));
  });

  it("accepts any selection parameter and a missing one", async () => {
    const { term } = attach("o", document.createElement("div"));
    handlerFor(term)(`;${btoa("a")}`);
    handlerFor(term)(`ps;${btoa("b")}`);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  });

  it("refuses clipboard queries and malformed or oversized payloads", async () => {
    const { term } = attach("o", document.createElement("div"));
    expect(handlerFor(term)("c;?")).toBe(true);
    expect(handlerFor(term)("c;not*base64!")).toBe(true);
    expect(handlerFor(term)("c")).toBe(true);
    expect(handlerFor(term)(`c;${"QUFB".repeat(400_000)}`)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("decodeOsc52 returns the text or null", () => {
    expect(decodeOsc52(`c;${btoa("x y")}`)).toBe("x y");
    expect(decodeOsc52("c;?")).toBeNull();
    expect(decodeOsc52("")).toBeNull();
    expect(decodeOsc52("c;")).toBeNull();
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

  it("skips interval ticks while the window is unfocused but still polls after Enter", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ windowFocused: false });
      const { term } = attach("f", document.createElement("div"));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS * 2);
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
      // Enter is the user acting on this tile, so it is polled either way.
      (term as unknown as { dataHandler: (d: string) => void }).dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      expect(ipc.terminalCwd).toHaveBeenCalledTimes(1);
      useStore.setState({ windowFocused: true });
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.terminalCwd).toHaveBeenCalledTimes(2);
    } finally {
      useStore.setState({ windowFocused: true });
      dispose("f");
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

  it("drops a poll whose answer arrives after the tile became an ssh tile", async () => {
    const apply = vi.fn(async () => {});
    const real = useStore.getState().setTerminalCwd;
    useStore.setState({ setTerminalCwd: apply });
    try {
      let resolve: (v: string) => void = () => {};
      vi.mocked(ipc.terminalCwd).mockReset().mockImplementation(() => new Promise<string>((r) => (resolve = r)));
      const { term } = attach("f", document.createElement("div"));
      (term as unknown as { dataHandler: (d: string) => void }).dataHandler("\r");
      await vi.waitFor(() => expect(ipc.terminalCwd).toHaveBeenCalledWith("f"));
      // The user typed `ssh` and the tile became remote while `lsof` was still running: the
      // local path it is about to return is not this tile's folder any more.
      useStore.setState((s) => ({ settings: { ...s.settings, f: { ...s.settings.f, ssh: { host: "me@box", cwd: "/p" } } } }));
      resolve("/Users/me");
      await new Promise((r) => setTimeout(r, 0));
      expect(apply).not.toHaveBeenCalled();
    } finally {
      useStore.setState({ setTerminalCwd: real });
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

describe("resume failure scanning", () => {
  it("reports the phrase for the watched session even when split across chunks", async () => {
    const note = vi.fn();
    useStore.setState({ noteResumeFailure: note, resumeWatch: { r: { sessionId: "abc", until: Date.now() + 10_000 } }, terminals: { r: { id: "r", name: "r", cwd: "/", exited: null, error: null } }, settings: { r: { ssh: null, claude: null, command: null, extra: {} } } });
    await prepare("r");
    const writes = (instances[instances.length - 1] as unknown as { writes: Array<{ done?: () => void }> }).writes;
    const enc = new TextEncoder();
    dataCallbacks.r(enc.encode("No conversation found with sess"));
    dataCallbacks.r(enc.encode("ion ID abc\r\n"));
    // The scan runs once xterm has parsed each chunk.
    expect(note).not.toHaveBeenCalled();
    writes.forEach((w) => w.done?.());
    expect(note).toHaveBeenCalledWith("r", "abc");
  });
  it("ignores output when no watch is active or the id differs", async () => {
    const note = vi.fn();
    useStore.setState({ noteResumeFailure: note, resumeWatch: {}, terminals: { q: { id: "q", name: "q", cwd: "/", exited: null, error: null } }, settings: { q: { ssh: null, claude: null, command: null, extra: {} } } });
    await prepare("q");
    dataCallbacks.q(new TextEncoder().encode("No conversation found with session ID zzz\r\n"));
    (instances[instances.length - 1] as unknown as { writes: Array<{ done?: () => void }> }).writes.forEach((w) => w.done?.());
    expect(note).not.toHaveBeenCalled();
  });
});

describe("Ctrl+V in an ssh tile", () => {
  const PATH = "/Users/me/.swarmz/paste/paste-1.png";

  function tile(id: string, opts: { ssh?: boolean; connected?: boolean } = {}) {
    useStore.setState({
      terminals: { [id]: { id, name: id, cwd: "/a", exited: null, error: null } },
      settings: { [id]: { ssh: opts.ssh ? { host: "me@box", cwd: "/p" } : null, claude: null, command: null, extra: {} } },
      sshConnected: opts.connected ? { [id]: true } : {},
      pastedAt: {},
    });
    const { term } = attach(id, document.createElement("div"));
    return (term as unknown as { dataHandler: (d: string) => void }).dataHandler;
  }

  beforeEach(() => {
    vi.mocked(ipc.writeTerminal).mockClear();
    vi.mocked(ipc.pasteImageToRemote).mockReset().mockResolvedValue(null);
  });

  it("sends the clipboard image to the remote and types its path instead of Ctrl+V", async () => {
    vi.mocked(ipc.pasteImageToRemote).mockResolvedValue(PATH);
    const send = tile("p1", { ssh: true, connected: true });
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p1", PATH));
      expect(ipc.pasteImageToRemote).toHaveBeenCalledWith("me@box");
      // No newline: the user adds their prompt and presses Enter themselves.
      expect(ipc.writeTerminal).not.toHaveBeenCalledWith("p1", IMAGE_PASTE_KEY);
      expect(typeof useStore.getState().pastedAt.p1).toBe("number");
    } finally {
      dispose("p1");
    }
  });

  it("falls back to Claude's own Ctrl+V when the clipboard holds no image", async () => {
    const send = tile("p2", { ssh: true, connected: true });
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p2", IMAGE_PASTE_KEY));
      expect(useStore.getState().pastedAt.p2).toBeUndefined();
    } finally {
      dispose("p2");
    }
  });

  it("falls back to Ctrl+V when the push fails", async () => {
    vi.mocked(ipc.pasteImageToRemote).mockRejectedValue("not reachable: x");
    const send = tile("p3", { ssh: true, connected: true });
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p3", IMAGE_PASTE_KEY));
      expect(useStore.getState().pastedAt.p3).toBeUndefined();
    } finally {
      dispose("p3");
    }
  });

  it("leaves a local tile's Ctrl+V alone", async () => {
    const send = tile("p4");
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p4", IMAGE_PASTE_KEY));
      expect(ipc.pasteImageToRemote).not.toHaveBeenCalled();
    } finally {
      dispose("p4");
    }
  });

  it("leaves an ssh tile that is not connected yet alone", async () => {
    const send = tile("p5", { ssh: true });
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p5", IMAGE_PASTE_KEY));
      expect(ipc.pasteImageToRemote).not.toHaveBeenCalled();
    } finally {
      dispose("p5");
    }
  });

  it("ignores a second Ctrl+V while the first push is still in flight", async () => {
    let resolve: (v: string | null) => void = () => {};
    vi.mocked(ipc.pasteImageToRemote).mockImplementation(() => new Promise<string | null>((r) => (resolve = r)));
    const send = tile("p7", { ssh: true, connected: true });
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.pasteImageToRemote).toHaveBeenCalledTimes(1));
      // An impatient second press must not start a second push, nor leak a raw \x16 into the
      // prompt the first push is about to type a path into.
      send(IMAGE_PASTE_KEY);
      expect(ipc.pasteImageToRemote).toHaveBeenCalledTimes(1);
      expect(ipc.writeTerminal).not.toHaveBeenCalled();

      resolve(PATH);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p7", PATH));
      expect(ipc.writeTerminal).toHaveBeenCalledTimes(1);

      // Once it settled the tile accepts Ctrl+V again.
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.pasteImageToRemote).toHaveBeenCalledTimes(2));
    } finally {
      resolve(null);
      dispose("p7");
    }
  });

  it("frees the tile again after a failed push", async () => {
    vi.mocked(ipc.pasteImageToRemote).mockRejectedValue("not reachable: x");
    const send = tile("p8", { ssh: true, connected: true });
    try {
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p8", IMAGE_PASTE_KEY));
      send(IMAGE_PASTE_KEY);
      await vi.waitFor(() => expect(ipc.pasteImageToRemote).toHaveBeenCalledTimes(2));
    } finally {
      dispose("p8");
    }
  });

  it("forwards ordinary typing in a connected ssh tile unchanged", async () => {
    const send = tile("p6", { ssh: true, connected: true });
    try {
      send("hello\r");
      await vi.waitFor(() => expect(ipc.writeTerminal).toHaveBeenCalledWith("p6", "hello\r"));
      expect(ipc.pasteImageToRemote).not.toHaveBeenCalled();
    } finally {
      dispose("p6");
    }
  });
});

describe("replayed output", () => {
  it("is written to the terminal but never copies to the clipboard", async () => {
    useStore.setState({ terminals: { rp: { id: "rp", name: "rp", cwd: "/", exited: null, error: null } }, order: ["rp"], settings: { rp: { ssh: null, claude: null, command: null, extra: {} } } });
    vi.mocked(writeText).mockClear();
    const { term } = attach("rp", document.createElement("div"));
    await prepare("rp");
    const osc52 = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[52];
    const writes = (term as unknown as { writes: Array<{ data: unknown; done?: () => void }> }).writes;
    replayCallbacks.rp(new TextEncoder().encode("old output"));
    expect(writes.length).toBeGreaterThan(0);
    osc52(`c;${btoa("from the past")}`);
    writes[writes.length - 1].done?.();
    osc52(`c;${btoa("live")}`);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("live");
    dispose("rp");
  });

  it("does not apply an OSC 7 cwd fired during replay, but does apply one fired after", async () => {
    useStore.setState({ terminals: { rp2: { id: "rp2", name: "rp2", cwd: "/orig", exited: null, error: null } }, order: ["rp2"], settings: { rp2: { ssh: null, claude: null, command: null, extra: {} } } });
    vi.mocked(ipc.setTerminalCwd).mockClear();
    const { term } = attach("rp2", document.createElement("div"));
    await prepare("rp2");
    const osc7 = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[7];
    const writes = (term as unknown as { writes: Array<{ data: unknown; done?: () => void }> }).writes;
    replayCallbacks.rp2(new TextEncoder().encode("old output"));
    expect(writes.length).toBeGreaterThan(0);
    osc7("file:///old/path");
    expect(ipc.setTerminalCwd).not.toHaveBeenCalled();
    writes[writes.length - 1].done?.();
    osc7("file:///new/path");
    await vi.waitFor(() => expect(ipc.setTerminalCwd).toHaveBeenCalledWith("rp2", "/new/path"));
    dispose("rp2");
  });
});

describe("attach marker and remote folders", () => {
  const originals = { remoteAttached: useStore.getState().remoteAttached, setTerminalCwd: useStore.getState().setTerminalCwd };
  beforeEach(() => {
    useStore.setState({
      terminals: { ra: { id: "ra", name: "ra", cwd: "/home/me", exited: null, error: null } },
      order: ["ra"],
      settings: { ra: { ssh: { host: "me@box", cwd: "/p" }, claude: null, command: null, extra: {} } },
      sshConnected: { ra: true },
      toolReady: { "me@box": true },
    });
  });
  afterEach(() => {
    dispose("ra");
    useStore.setState(originals);
  });

  it("passes the marker to the store and ignores it during replay", async () => {
    const remoteAttached = vi.fn(async () => {});
    useStore.setState({ remoteAttached });
    const { term } = attach("ra", document.createElement("div"));
    await prepare("ra");
    const osc = (term as unknown as { oscHandlers: Record<number, (d: string) => boolean> }).oscHandlers[1337];
    expect(osc("swarmz-attach;new=1")).toBe(true);
    expect(remoteAttached).toHaveBeenCalledWith("ra", true);
    replayCallbacks.ra(new TextEncoder().encode("x"));
    osc("swarmz-attach;new=1");
    expect(remoteAttached).toHaveBeenCalledTimes(1);
    expect(osc("something-else")).toBe(false);
  });

  it("polls the remote tool for a connected ssh tile's folder", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: true, cwd: "/p/sub" });
      const setTerminalCwd = vi.fn(async () => {});
      useStore.setState({ setTerminalCwd });
      attach("ra", document.createElement("div"));
      await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
      expect(ipc.remoteTileInfo).toHaveBeenCalledWith("me@box", "ra");
      expect(setTerminalCwd).toHaveBeenCalledWith("ra", "/p/sub", "remote");
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls the remote folder shortly after Enter, and never for a tile without the tool or connection", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ipc.remoteTileInfo).mockReset().mockResolvedValue({ running: true, cwd: "/p/after" });
      vi.mocked(ipc.terminalCwd).mockClear();
      const setTerminalCwd = vi.fn(async () => {});
      useStore.setState({ setTerminalCwd });
      const { term } = attach("ra", document.createElement("div"));
      const t = term as unknown as { dataHandler: (d: string) => void };
      t.dataHandler("cd after\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      expect(setTerminalCwd).toHaveBeenCalledWith("ra", "/p/after", "remote");
      expect(ipc.terminalCwd).not.toHaveBeenCalled();

      vi.mocked(ipc.remoteTileInfo).mockClear();
      setTerminalCwd.mockClear();
      useStore.setState({ toolReady: { "me@box": false } });
      t.dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      useStore.setState({ toolReady: { "me@box": true }, sshConnected: {} });
      t.dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      vi.mocked(ipc.remoteTileInfo).mockResolvedValue({ running: false, cwd: "/p/other" });
      useStore.setState({ sshConnected: { ra: true } });
      t.dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      vi.mocked(ipc.remoteTileInfo).mockRejectedValue("tool error");
      t.dataHandler("\r");
      await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
      expect(ipc.remoteTileInfo).toHaveBeenCalledTimes(2);
      expect(setTerminalCwd).not.toHaveBeenCalled();
      expect(ipc.terminalCwd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a rejoined remote session's replay", () => {
  const originals = { remoteAttached: useStore.getState().remoteAttached, setTerminalCwd: useStore.getState().setTerminalCwd, noteResumeFailure: useStore.getState().noteResumeFailure };
  const enc = (t: string) => new TextEncoder().encode(t);
  const last = <T,>(a: T[]): T | undefined => a[a.length - 1];
  type Fake = {
    oscHandlers: Record<number, (d: string) => boolean>;
    writes: Array<{ data: unknown; done?: () => void }>;
    dataHandler: (d: string) => void;
    keyHandler: (e: KeyboardEvent) => boolean;
  };
  const remoteAttached = vi.fn(async () => {});
  const setTerminalCwd = vi.fn(async () => {});
  beforeEach(() => {
    remoteAttached.mockClear();
    setTerminalCwd.mockClear();
    vi.mocked(writeText).mockClear();
    useStore.setState({
      terminals: { rr: { id: "rr", name: "rr", cwd: "/home/me", exited: null, error: null } },
      order: ["rr"],
      settings: { rr: { ssh: { host: "me@box", cwd: "/p" }, claude: null, command: null, extra: {} } },
      sshConnected: { rr: true },
      toolReady: {},
      resumeWatch: {},
      remoteAttached,
      setTerminalCwd,
    });
  });
  afterEach(() => {
    dispose("rr");
    vi.useRealTimers();
    useStore.setState({ ...originals, resumeWatch: {} });
  });
  const setup = async () => {
    const { term } = attach("rr", document.createElement("div"));
    await prepare("rr");
    return term as unknown as Fake;
  };

  /** Delivers `text` as one pty chunk and plays xterm's part: runs the OSC handlers in order
   * while "parsing" it, then the chunk's write callback. */
  const feed = (t: Fake, text: string) => {
    dataCallbacks.rr(enc(text));
    const re = /\x1b\](\d+);([^\x07]*)\x07/g;
    for (let m = re.exec(text); m; m = re.exec(text)) t.oscHandlers[Number(m[1])]?.(m[2]);
    last(t.writes)?.done?.();
  };
  /** The attach marker of the current tool, which promises the end marker. */
  const ATTACH0 = "\x1b]1337;swarmz-attach;new=0;end=1\x07";
  /** The attach marker of an older tool, without the promise. */
  const ATTACH0_OLD = "\x1b]1337;swarmz-attach;new=0\x07";
  const osc52 = (s: string) => `\x1b]52;c;${btoa(s)}\x07`;

  it("suppresses OSC 52 and OSC 7 exactly until the replay-end marker, however long the gap", async () => {
    vi.useFakeTimers();
    const t = await setup();
    feed(t, ATTACH0 + "\x1b[!pold output");
    expect(remoteAttached).toHaveBeenCalledWith("rr", false);
    await vi.advanceTimersByTimeAsync(3000);
    feed(t, osc52("old copy") + "\x1b]7;file:///old\x07");
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).not.toHaveBeenCalled();
    expect(setTerminalCwd).not.toHaveBeenCalled();
    feed(t, "tail of the replay" + osc52("older copy") + REPLAY_END_MARKER + osc52("live copy") + "\x1b]7;file:///live\x07");
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("live copy");
    expect(setTerminalCwd).toHaveBeenCalledTimes(1);
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
  });

  it("the end marker has no effect inside a local replay", async () => {
    const t = await setup();
    feed(t, ATTACH0);
    replayCallbacks.rr(enc("x"));
    t.oscHandlers[1337]("swarmz-replay-end");
    last(t.writes)?.done?.();
    t.oscHandlers[7]("file:///still-replay");
    expect(setTerminalCwd).not.toHaveBeenCalled();
    feed(t, REPLAY_END_MARKER);
    t.oscHandlers[7]("file:///live");
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
  });

  it("with end=1, typing during the replay does not end it; only the end marker does", async () => {
    const t = await setup();
    feed(t, ATTACH0 + "\x1b[!pold");
    t.dataHandler("x");
    t.keyHandler({ key: "Enter", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, type: "keydown" } as KeyboardEvent);
    feed(t, osc52("old copy") + "\x1b]7;file:///old\x07");
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).not.toHaveBeenCalled();
    expect(setTerminalCwd).not.toHaveBeenCalled();
    feed(t, REPLAY_END_MARKER + osc52("live copy"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("live copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("with end=1, only the long safety cap ends a replay whose end marker never comes", async () => {
    vi.useFakeTimers();
    const t = await setup();
    feed(t, ATTACH0);
    await vi.advanceTimersByTimeAsync(REMOTE_REPLAY_MARKED_MAX_MS - 1);
    t.oscHandlers[7]("file:///old");
    expect(setTerminalCwd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    t.oscHandlers[7]("file:///live");
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
  });

  it("an older tool's marker (no end=1) still parses and its replay also honours the end marker", async () => {
    const t = await setup();
    feed(t, ATTACH0_OLD + "\x1b[!p" + osc52("old copy") + REPLAY_END_MARKER + osc52("live copy"));
    expect(remoteAttached).toHaveBeenCalledWith("rr", false);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("live copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("falls back to ending at user input for a tool without the end marker", async () => {
    const t = await setup();
    feed(t, ATTACH0_OLD);
    t.oscHandlers[52](`c;${btoa("old copy")}`);
    t.dataHandler("x");
    t.oscHandlers[52](`c;${btoa("live copy")}`);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("live copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter also ends the replay (fallback)", async () => {
    const t = await setup();
    feed(t, ATTACH0_OLD);
    t.keyHandler({ key: "Enter", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, type: "keydown" } as KeyboardEvent);
    t.oscHandlers[7]("file:///live");
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
  });

  it("falls back to the cap however busy the output stays", async () => {
    vi.useFakeTimers();
    const t = await setup();
    feed(t, ATTACH0_OLD);
    for (let elapsed = 0; elapsed < REMOTE_REPLAY_MAX_MS; elapsed += 200) {
      feed(t, "busy\x1b]7;file:///old\x07");
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(setTerminalCwd).not.toHaveBeenCalled();
    t.oscHandlers[7]("file:///live");
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
  });

  it("a new=1 marker does not suppress anything (the typed startup line's output is live)", async () => {
    const t = await setup();
    t.oscHandlers[1337]("swarmz-attach;new=1");
    t.oscHandlers[7]("file:///live");
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
    expect(t.oscHandlers[1337]("swarmz-attach;new=2")).toBe(false);
  });

  it("the resume scan follows the replay state: replayed failures are ignored, live ones reported", async () => {
    const noteResumeFailure = vi.fn();
    useStore.setState({ noteResumeFailure, resumeWatch: { rr: { sessionId: "abc", until: Date.now() + 10_000 } } });
    const t = await setup();
    const gone = "No conversation found with session ID abc";
    feed(t, ATTACH0 + "\x1b[!p" + gone);
    feed(t, gone);
    // Split so that the end-marker chunk carries the tail of a replayed failure.
    feed(t, "No conversation found with sess");
    feed(t, "ion ID abc" + REPLAY_END_MARKER + "prompt$ ");
    expect(noteResumeFailure).not.toHaveBeenCalled();
    feed(t, gone);
    expect(noteResumeFailure).toHaveBeenCalledWith("rr", "abc");
  });

  it("a whole reattach in one chunk still reports a live failure after the end marker", async () => {
    const noteResumeFailure = vi.fn();
    useStore.setState({ noteResumeFailure, resumeWatch: { rr: { sessionId: "abc", until: Date.now() + 10_000 } } });
    const t = await setup();
    const gone = "No conversation found with session ID abc";
    feed(t, ATTACH0 + "\x1b[!p" + gone + REPLAY_END_MARKER);
    expect(noteResumeFailure).not.toHaveBeenCalled();
    feed(t, ATTACH0 + "\x1b[!pold" + REPLAY_END_MARKER + gone);
    expect(noteResumeFailure).toHaveBeenCalledWith("rr", "abc");
  });

  it("remote folder polls never overlap", async () => {
    let resolve: (v: { running: boolean; cwd?: string | null }) => void = () => {};
    vi.mocked(ipc.remoteTileInfo).mockReset().mockImplementation(() => new Promise((r) => (resolve = r)));
    useStore.setState({ toolReady: { "me@box": true } });
    vi.useFakeTimers();
    const t = await setup();
    t.dataHandler("\r");
    await vi.advanceTimersByTimeAsync(CWD_POLL_AFTER_ENTER_MS);
    await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS * 3);
    expect(ipc.remoteTileInfo).toHaveBeenCalledTimes(1);
    resolve({ running: true, cwd: "/p/x" });
    await vi.advanceTimersByTimeAsync(0);
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/p/x", "remote");
    await vi.advanceTimersByTimeAsync(CWD_POLL_INTERVAL_MS);
    expect(ipc.remoteTileInfo).toHaveBeenCalledTimes(2);
  });

  it("a marker in a local tile suppresses nothing", async () => {
    useStore.setState({ settings: { rr: { ssh: null, claude: null, command: null, extra: {} } } });
    const t = await setup();
    t.oscHandlers[1337]("swarmz-attach;new=0");
    t.oscHandlers[7]("file:///live");
    expect(setTerminalCwd).toHaveBeenCalledWith("rr", "/live", "osc7");
  });
});

describe("parseAttachMarker", () => {
  it("reads the current and the older form and ignores unknown fields", () => {
    expect(parseAttachMarker("swarmz-attach;new=0;end=1")).toEqual({ isNew: false, endMarker: true });
    expect(parseAttachMarker("swarmz-attach;new=1;end=1")).toEqual({ isNew: true, endMarker: true });
    expect(parseAttachMarker("swarmz-attach;new=0")).toEqual({ isNew: false, endMarker: false });
    expect(parseAttachMarker("swarmz-attach;new=1")).toEqual({ isNew: true, endMarker: false });
    expect(parseAttachMarker("swarmz-attach;new=0;v=9;end=1;x")).toEqual({ isNew: false, endMarker: true });
    expect(parseAttachMarker("swarmz-attach;new=0;end=0")).toEqual({ isNew: false, endMarker: false });
  });
  it("rejects anything else", () => {
    for (const d of ["swarmz-attach", "swarmz-attach;new=2", "swarmz-attach;end=1;new=0", "swarmz-replay-end", "File=inline=1:abc", "swarmz-attach;new=01", ""]) {
      expect(parseAttachMarker(d)).toBeNull();
    }
  });
});
