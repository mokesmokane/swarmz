// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    readFile: vi.fn(async (_host: string | null, path: string) => ({ kind: "text", path, size: 22, truncated: false, text: "const a = 1;\nconst b = 2;\n" })),
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { FileViewer, highlightLines, languageOf } from "./FileViewer";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    terminals: { t1: { id: "t1", name: "api", cwd: "/proj", exited: null, error: null } },
    settings: { t1: { ssh: null, claude: null, command: null, extra: {} } },
    sshConnected: {},
    machines: {},
    fileView: null,
  });
});

afterEach(cleanup);

describe("FileViewer", () => {
  it("shows nothing until a file is opened, then the text with the linked line marked, and closes on Esc", async () => {
    render(<FileViewer />);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    await act(async () => {
      useStore.getState().openFile("t1", "/proj/src/a.ts", 2);
    });
    expect(ipc.readFile).toHaveBeenCalledWith(null, "/proj/src/a.ts");
    expect((await screen.findByRole("dialog")).getAttribute("aria-label")).toBe("/proj/src/a.ts");
    expect(screen.getByTitle("/proj/src/a.ts").textContent).toBe("/proj/src/a.ts:2");
    const body = screen.getByTestId("file-body");
    const rows = body.querySelectorAll("tr");
    expect(rows.length).toBe(2);
    expect(rows[1].className).toContain("bg-amber");
    expect(rows[1].textContent).toContain("const b = 2;");
    // Coloured: a keyword span from highlight.js.
    expect(body.querySelector(".hljs-keyword")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().fileView).toBeNull();
  });

  it("reads over ssh for a connected ssh tile, names the Mac, and says when it is not connected", async () => {
    useStore.setState({
      settings: { t1: { ssh: { host: "me@box", cwd: "/remote", machine: "box" }, claude: null, command: null, extra: {} } },
      machines: { box: { alias: "Studio", color: null, lastUsed: "t" } },
      sshConnected: { t1: true },
    });
    render(<FileViewer />);
    await act(async () => {
      useStore.getState().openFile("t1", "~/notes.md", null);
    });
    expect(ipc.readFile).toHaveBeenCalledWith("me@box", "~/notes.md");
    expect(await screen.findByTitle("The Mac the file is on")).toBeTruthy();
    expect(screen.getByTitle("The Mac the file is on").textContent).toBe("Studio");
    act(() => {
      useStore.setState({ sshConnected: {} });
    });
    expect(await screen.findByText("not connected: connect the tile first")).toBeTruthy();
  });

  it("shows an image inline, a binary as a note, and a read error", async () => {
    vi.mocked(ipc.readFile).mockResolvedValueOnce({ kind: "image", path: "/p/shot.png", size: 3, truncated: false, base64: "AQID", mime: "image/png" });
    render(<FileViewer />);
    await act(async () => {
      useStore.getState().openFile("t1", "/p/shot.png");
    });
    const img = (await screen.findByAltText("/p/shot.png")) as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,AQID");
    vi.mocked(ipc.readFile).mockResolvedValueOnce({ kind: "binary", path: "/p/a.zip", size: 5 * 1024 * 1024, truncated: true });
    await act(async () => {
      useStore.getState().openFile("t1", "/p/a.zip");
    });
    expect(await screen.findByText(/Not a text file \(5\.0 MB\)/)).toBeTruthy();
    vi.mocked(ipc.readFile).mockRejectedValueOnce("not found");
    await act(async () => {
      useStore.getState().openFile("t1", "/p/missing.txt");
    });
    expect(await screen.findByText("not found")).toBeTruthy();
  });

  it("renders markdown, with Raw to see the source", async () => {
    vi.mocked(ipc.readFile).mockResolvedValueOnce({ kind: "text", path: "/p/README.md", size: 20, truncated: false, text: "# Title\n\nSome *words*.\n" });
    render(<FileViewer />);
    await act(async () => {
      useStore.getState().openFile("t1", "/p/README.md");
    });
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Title");
    fireEvent.click(screen.getByText("Raw"));
    expect(screen.getByTestId("file-body").querySelectorAll("tr").length).toBe(3);
    expect(screen.getByText("Rendered")).toBeTruthy();
  });

  it("knows its languages and colours line by line", () => {
    expect(languageOf("a/b.rs")).toBe("rust");
    expect(languageOf("x.unknown")).toBeNull();
    expect(languageOf("Makefile")).toBeNull();
    const lines = highlightLines("let x = 1;\n<b>\n", "typescript");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("hljs-keyword");
    expect(lines[1]).toBe("&lt;b&gt;");
    expect(highlightLines("<script>", null)).toEqual(["&lt;script&gt;"]);
  });
});
