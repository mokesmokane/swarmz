import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgress, UpdateInfo } from "./lib/ipc";

const check = vi.fn<() => Promise<UpdateInfo | null>>(async () => null);
const install = vi.fn<(onProgress?: (p: DownloadProgress) => void) => Promise<void>>(async () => {});
const relaunch = vi.fn<() => Promise<void>>(async () => {});

vi.mock("./lib/ipc", () => ({
  ipc: {},
  updater: {
    check: (...a: []) => check(...a),
    install: (...a: [((p: DownloadProgress) => void)?]) => install(...a),
    relaunch: (...a: []) => relaunch(...a),
  },
}));

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

import { EMPTY_UPDATE, useStore } from "./store";

const state = () => useStore.getState().update;

beforeEach(() => {
  check.mockReset();
  check.mockResolvedValue(null);
  install.mockReset();
  install.mockResolvedValue(undefined);
  relaunch.mockReset();
  relaunch.mockResolvedValue(undefined);
  useStore.setState({ update: EMPTY_UPDATE });
});

const found: UpdateInfo = { version: "0.2.0", currentVersion: "0.1.0", notes: "fixes", date: null };

describe("update state machine", () => {
  it("starts idle", () => {
    expect(state().status).toBe("idle");
    expect(state().version).toBeNull();
  });

  it("goes idle again when there is no update, and remembers a manual check", async () => {
    await useStore.getState().checkForUpdates({ manual: true });
    expect(check).toHaveBeenCalledTimes(1);
    expect(state().status).toBe("idle");
    expect(state().manual).toBe(true);
    expect(state().checkedAt).not.toBeNull();
    expect(state().error).toBeNull();
  });

  it("does not mark a background check manual", async () => {
    await useStore.getState().checkForUpdates();
    expect(state().manual).toBe(false);
  });

  it("becomes available when one is found", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    expect(state().status).toBe("available");
    expect(state().version).toBe("0.2.0");
    expect(state().notes).toBe("fixes");
    expect(state().dismissed).toBe(false);
  });

  it("is checking while the check is in flight", async () => {
    let release: (v: UpdateInfo | null) => void = () => {};
    check.mockReturnValue(new Promise((res) => (release = res)));
    const done = useStore.getState().checkForUpdates();
    expect(state().status).toBe("checking");
    release(null);
    await done;
    expect(state().status).toBe("idle");
  });

  it("fails without throwing when the check errors", async () => {
    check.mockRejectedValue("network down");
    await expect(useStore.getState().checkForUpdates()).resolves.toBeUndefined();
    expect(state().status).toBe("failed");
    expect(state().error).toContain("network down");
  });

  it("ignores a second check while one is in flight", async () => {
    let release: (v: UpdateInfo | null) => void = () => {};
    check.mockReturnValue(new Promise((res) => (release = res)));
    const first = useStore.getState().checkForUpdates();
    await useStore.getState().checkForUpdates();
    expect(check).toHaveBeenCalledTimes(1);
    release(null);
    await first;
  });

  it("does not clobber a downloaded update with a fresh check", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    install.mockResolvedValue(undefined);
    relaunch.mockRejectedValue("no");
    await useStore.getState().installUpdate();
    expect(state().status).toBe("ready");
    check.mockClear();
    await useStore.getState().checkForUpdates({ manual: true });
    expect(check).not.toHaveBeenCalled();
    expect(state().status).toBe("ready");
  });

  it("downloads, installs and relaunches", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    install.mockImplementation(async (onProgress) => {
      onProgress?.({ downloaded: 0, contentLength: 400 });
      expect(state().status).toBe("downloading");
      expect(state().contentLength).toBe(400);
      onProgress?.({ downloaded: 200, contentLength: 400 });
      expect(state().downloaded).toBe(200);
    });
    await useStore.getState().installUpdate();
    expect(state().status).toBe("ready");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps the notice when the download fails, and can retry", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    install.mockRejectedValueOnce("disk full");
    await expect(useStore.getState().installUpdate()).resolves.toBeUndefined();
    expect(state().status).toBe("failed");
    expect(state().version).toBe("0.2.0");
    expect(state().error).toContain("disk full");

    install.mockResolvedValue(undefined);
    await useStore.getState().installUpdate();
    expect(state().status).toBe("ready");
  });

  it("stays ready with a note when the relaunch fails", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    relaunch.mockRejectedValue("cannot restart");
    await expect(useStore.getState().installUpdate()).resolves.toBeUndefined();
    expect(state().status).toBe("ready");
    expect(state().error).toContain("cannot restart");
  });

  it("will not install when nothing is available", async () => {
    await useStore.getState().installUpdate();
    expect(install).not.toHaveBeenCalled();
    expect(state().status).toBe("idle");
  });

  it("will not install twice at once", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    let release: () => void = () => {};
    install.mockReturnValue(new Promise<void>((res) => (release = res)));
    const first = useStore.getState().installUpdate();
    await useStore.getState().installUpdate();
    expect(install).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("dismisses the notice without forgetting the update", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    useStore.getState().dismissUpdate();
    expect(state().dismissed).toBe(true);
    expect(state().status).toBe("available");
    expect(state().version).toBe("0.2.0");
  });

  it("dismissing clears a manual up-to-date report", async () => {
    await useStore.getState().checkForUpdates({ manual: true });
    expect(state().manual).toBe(true);
    useStore.getState().dismissUpdate();
    expect(state().manual).toBe(false);
  });

  it("records which step failed, so the notice can offer the right retry", async () => {
    check.mockRejectedValue("network down");
    await useStore.getState().checkForUpdates({ manual: true });
    expect(state().status).toBe("failed");
    expect(state().failedAt).toBe("check");

    check.mockReset();
    check.mockResolvedValue(found);
    useStore.setState({ update: EMPTY_UPDATE });
    await useStore.getState().checkForUpdates();
    expect(state().failedAt).toBeNull();
    install.mockRejectedValueOnce("disk full");
    await useStore.getState().installUpdate();
    expect(state().status).toBe("failed");
    expect(state().failedAt).toBe("install");
  });

  it("clears failedAt once a retry works", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    install.mockRejectedValueOnce("disk full");
    await useStore.getState().installUpdate();
    expect(state().failedAt).toBe("install");
    install.mockResolvedValue(undefined);
    await useStore.getState().installUpdate();
    expect(state().status).toBe("ready");
    expect(state().failedAt).toBeNull();
  });

  it("a failed check can be checked again, unlike a failed install", async () => {
    // installUpdate only resumes a failed *install*: there is nothing to install after a check
    // that never got an answer, and calling it would fail forever.
    check.mockRejectedValue("network down");
    await useStore.getState().checkForUpdates({ manual: true });
    await useStore.getState().installUpdate();
    expect(install).not.toHaveBeenCalled();

    check.mockReset();
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates({ manual: true });
    expect(state().status).toBe("available");
    expect(state().failedAt).toBeNull();
  });

  it("a failed background check does not bury a failed install", async () => {
    // The notice is the only place the user learns a download broke. A later background check
    // that also fails must not relabel it as a check failure, which would hide it.
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    install.mockRejectedValueOnce("disk full");
    await useStore.getState().installUpdate();
    expect(state().failedAt).toBe("install");

    check.mockReset();
    check.mockRejectedValue("network down");
    await useStore.getState().checkForUpdates();
    expect(state().failedAt).toBe("install");
    expect(state().error).toContain("disk full");
    expect(state().version).toBe("0.2.0");
  });

  it("a check the user asked for does report its own failure", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    install.mockRejectedValueOnce("disk full");
    await useStore.getState().installUpdate();

    check.mockReset();
    check.mockRejectedValue("network down");
    await useStore.getState().checkForUpdates({ manual: true });
    expect(state().failedAt).toBe("check");
    expect(state().error).toContain("network down");
  });

  it("un-dismisses when a newer version turns up", async () => {
    check.mockResolvedValue(found);
    await useStore.getState().checkForUpdates();
    useStore.getState().dismissUpdate();
    useStore.setState({ update: { ...state(), status: "idle" } });
    check.mockResolvedValue({ ...found, version: "0.3.0" });
    await useStore.getState().checkForUpdates();
    expect(state().dismissed).toBe(false);
    expect(state().version).toBe("0.3.0");
  });
});
