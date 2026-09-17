// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const FP_ED = "SHA256:r1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD/hh6U";
const FP_RSA = "SHA256:7CQ/ldJqhjJfG5HDFdkweMu4jkmliY+CecbtNbpO8J0";

vi.mock("../lib/ipc", () => ({
  ipc: {
    phones: vi.fn(async () => [{ device: "Galaxy Fold", keyType: "ssh-ed25519", keyEnd: "VGVzdA" }]),
    revokePhone: vi.fn(async () => ({ removed: 1, machines: [{ machine: "studio", ok: false, error: "not reachable" }] })),
    hostKeys: vi.fn(async () => ({ host: "mini", user: "me", fingerprints: [FP_ED, FP_RSA] })),
  },
}));

import { ipc } from "../lib/ipc";
import { pairUri } from "../lib/pairing";
import { PhonesPanel } from "./PhonesPanel";

afterEach(cleanup);

describe("PhonesPanel", () => {
  it("lists phones and revokes one, showing Macs that could not be updated", async () => {
    render(<PhonesPanel onClose={() => {}} />);
    expect(await screen.findByText("Galaxy Fold")).toBeTruthy();
    vi.mocked(ipc.phones).mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    });
    expect(ipc.revokePhone).toHaveBeenCalledWith("Galaxy Fold");
    expect(await screen.findByText("studio: not reachable")).toBeTruthy();
    expect(await screen.findByText("No phones paired")).toBeTruthy();
  });

  it("shows a read error", async () => {
    vi.mocked(ipc.phones).mockRejectedValueOnce("denied");
    render(<PhonesPanel onClose={() => {}} />);
    expect(await screen.findByText("denied")).toBeTruthy();
  });

  it("reloads the list and keeps the error when the fan-out fails after revoking locally", async () => {
    render(<PhonesPanel onClose={() => {}} />);
    expect(await screen.findByText("Galaxy Fold")).toBeTruthy();
    vi.mocked(ipc.revokePhone).mockRejectedValueOnce("revoked here; could not reach the other Macs: not reachable (failed)");
    vi.mocked(ipc.phones).mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    });
    expect(await screen.findByText("revoked here; could not reach the other Macs: not reachable (failed)")).toBeTruthy();
    expect(await screen.findByText("No phones paired")).toBeTruthy();
  });

  it("shows a pairing code with this Mac's name and user, and closes again", async () => {
    const { container } = render(<PhonesPanel onClose={() => {}} />);
    expect(await screen.findByText("Galaxy Fold")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link a device" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Link a device" });
    // The payload is the URI built from the ipc reply, and the code draws it.
    const code = screen.getByRole("img");
    expect(code.getAttribute("title")).toBe(pairUri({ host: "mini", user: "me", fingerprints: [FP_ED, FP_RSA] }));
    expect(code.querySelector("svg")).toBeTruthy();
    // The name and user in plain text, for when the camera will not read it.
    expect(dialog.textContent).toContain("mini");
    expect(dialog.textContent).toContain("me");
    expect(dialog.textContent).toContain("Scan this in the swarmz app on your phone. You will still need this Mac's password once.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("says why there is no pairing code", async () => {
    vi.mocked(ipc.hostKeys).mockRejectedValueOnce("this Mac's Tailscale name is not known; is Tailscale running?");
    render(<PhonesPanel onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Link a device" }));
    });
    expect(await screen.findByText("this Mac's Tailscale name is not known; is Tailscale running?")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
