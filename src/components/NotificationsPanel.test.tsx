// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    telegramGet: vi.fn(async () => ({ configured: false, chatId: "", tokenEnd: "" })),
    telegramSet: vi.fn(async (token: string, chatId: string) => ({ configured: !!(token || chatId), chatId, tokenEnd: token.slice(-4) })),
    telegramPush: vi.fn(async () => true),
    telegramTest: vi.fn(async () => {}),
    telegramFollow: vi.fn(async (on: boolean) => on),
  },
}));

import { ipc } from "../lib/ipc";
import { useStore } from "../store";
import { NotificationsPanel } from "./NotificationsPanel";

const ID = "t1";

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    terminals: { [ID]: { id: ID, name: "desk", cwd: "/home/me", exited: null, error: null } },
    order: [ID],
    settings: { [ID]: { ssh: { host: "mokes@box", cwd: null, machine: "box" }, claude: null, command: null, extra: {} } },
    sshConnected: { [ID]: true },
    machines: { box: { alias: "Studio", color: "#f59e0b", lastUsed: "t" } },
    conductor: null,
    telegramConfigured: null,
  });
});

afterEach(cleanup);

describe("NotificationsPanel", () => {
  it("saves the token and chat id, pushes them to connected Macs, and says so", async () => {
    render(<NotificationsPanel onClose={() => {}} />);
    expect(await screen.findByText("Not set up on this Mac")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send test" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: " 123456:AAxx " } });
    fireEvent.change(screen.getByLabelText("Chat id"), { target: { value: "42" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(ipc.telegramSet).toHaveBeenCalledWith("123456:AAxx", "42");
    // Saving copies the setup; it never removes another Mac's.
    expect(ipc.telegramPush).toHaveBeenCalledWith("mokes@box", false);
    expect(await screen.findByText("Studio: updated")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(useStore.getState().telegramConfigured).toBe(true);
    // The token field empties and its placeholder says one is set; Send test is on.
    expect((screen.getByLabelText("Bot token") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Bot token") as HTMLInputElement).placeholder).toContain("…AAxx");
    expect(screen.getByTestId("telegram-status").textContent).toContain("make a tile the conductor");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    });
    expect(ipc.telegramTest).toHaveBeenCalled();
    expect(await screen.findByText("Sent; check Telegram")).toBeTruthy();
  });

  it("pushes to every Mac online on the tailnet too, since any conductor may message the user", async () => {
    const peer = (name: string, online: boolean, os = "macOS") => ({ name, hostName: name, ip: "100.1.1.1", os, online });
    useStore.setState({
      selfMachine: "here",
      tailscale: { running: true, message: null, user: "mokes", self: null, peers: [peer("box", true), peer("laptop", true), peer("off", false), peer("phone", true, "android"), peer("here", true)] },
    });
    render(<NotificationsPanel onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "123456:AAxx" } });
    fireEvent.change(screen.getByLabelText("Chat id"), { target: { value: "42" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(vi.mocked(ipc.telegramPush).mock.calls.map((c) => c[0])).toEqual(["mokes@box", "mokes@laptop"]);
    useStore.setState({ tailscale: null, selfMachine: null });
  });

  it("shows a failed push per Mac and a failed test, and Remove clears the setup", async () => {
    vi.mocked(ipc.telegramGet).mockResolvedValueOnce({ configured: true, chatId: "42", tokenEnd: "AAxx" });
    vi.mocked(ipc.telegramPush).mockRejectedValueOnce("not reachable: timeout");
    vi.mocked(ipc.telegramTest).mockRejectedValueOnce("Telegram refused: chat not found (failed)");
    render(<NotificationsPanel onClose={() => {}} />);
    expect(await screen.findByText("Set up · make a tile the conductor to be able to write to it")).toBeTruthy();
    expect((screen.getByLabelText("Chat id") as HTMLInputElement).value).toBe("42");
    // Saving with the token untouched keeps it: the empty token goes through as "keep".
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(ipc.telegramSet).toHaveBeenCalledWith("", "42");
    expect(await screen.findByText("Studio: not reachable: timeout")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    });
    expect(await screen.findByText("Telegram refused: chat not found (failed)")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(ipc.telegramSet).toHaveBeenLastCalledWith("", "");
    // Only Remove takes the setup off the other Macs.
    expect(ipc.telegramPush).toHaveBeenLastCalledWith("mokes@box", true);
    expect(useStore.getState().telegramConfigured).toBe(false);
    expect(await screen.findByText("Removed")).toBeTruthy();
  });

  it("says when this Mac listens: the conductor runs here and Telegram is set up", async () => {
    vi.mocked(ipc.telegramGet).mockResolvedValueOnce({ configured: true, chatId: "42", tokenEnd: "AAxx" });
    useStore.setState({
      terminals: { c: { id: "c", name: "cond", cwd: "/home/me/.swarmz/conductor", exited: null, error: null } },
      order: ["c"],
      settings: { c: { ssh: null, claude: { enabled: true, sessionId: "s", skipPermissions: false, started: true }, command: null, extra: {} } },
      sshConnected: {},
      conductor: "c",
      telegramConfigured: true,
    });
    render(<NotificationsPanel onClose={() => {}} />);
    expect(await screen.findByText(/listening for your messages here/)).toBeTruthy();
  });
});
