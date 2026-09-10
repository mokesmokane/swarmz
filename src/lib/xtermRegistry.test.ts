import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInfo } from "./ipc";

const { instances } = vi.hoisted(() => ({ instances: [] as { disposed: boolean }[] }));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    disposed = false;
    element: HTMLElement | null = null;
    constructor() {
      instances.push(this);
    }
    onData() {}
    onResize() {}
    write() {}
    loadAddon() {}
    open() {}
    focus() {}
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
  },
}));

import { useStore } from "../store";
import { prepare } from "./xtermRegistry";

function info(id: string, name = id): TerminalInfo {
  return { id, name, cwd: "/tmp/x", exited: null, error: null };
}

beforeEach(() => {
  useStore.setState({ terminals: {} });
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
