// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    phones: vi.fn(async () => [{ device: "Galaxy Fold", keyType: "ssh-ed25519", keyEnd: "VGVzdA" }]),
    revokePhone: vi.fn(async () => ({ removed: 1, machines: [{ machine: "studio", ok: false, error: "not reachable" }] })),
  },
}));

import { ipc } from "../lib/ipc";
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
});
