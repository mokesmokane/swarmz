// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({ ipc: {}, updater: { check: vi.fn(), install: vi.fn(), relaunch: vi.fn() } }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true), open: vi.fn(async () => null) }));

import { EMPTY_UPDATE, useStore, type UpdateState } from "../store";
import { UpdateNotice, UpdateVersionLine } from "./UpdateNotice";

const setUpdate = (patch: Partial<UpdateState>) => useStore.setState({ update: { ...EMPTY_UPDATE, ...patch } });

afterEach(cleanup);

beforeEach(() => {
  useStore.setState({ update: EMPTY_UPDATE });
});

describe("UpdateNotice", () => {
  it("shows nothing when there is no update", () => {
    const { container } = render(<UpdateNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("offers the update without a modal, and says the terminals survive", () => {
    setUpdate({ status: "available", version: "0.2.0" });
    render(<UpdateNotice />);
    expect(screen.getByText(/swarmz 0\.2\.0 is ready/)).toBeTruthy();
    expect(screen.getByText(/Your terminals keep running/)).toBeTruthy();
    expect(document.querySelector("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later" })).toBeTruthy();
  });

  it("hides once dismissed", () => {
    setUpdate({ status: "available", version: "0.2.0", dismissed: true });
    const { container } = render(<UpdateNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("Later dismisses it", () => {
    setUpdate({ status: "available", version: "0.2.0" });
    render(<UpdateNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(useStore.getState().update.dismissed).toBe(true);
  });

  it("Update and restart installs", () => {
    const installUpdate = vi.fn(async () => {});
    setUpdate({ status: "available", version: "0.2.0" });
    useStore.setState({ installUpdate });
    render(<UpdateNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
    expect(installUpdate).toHaveBeenCalled();
  });

  it("shows download progress", () => {
    setUpdate({ status: "downloading", version: "0.2.0", downloaded: 500, contentLength: 1000 });
    render(<UpdateNotice />);
    expect(screen.getByText(/Downloading swarmz 0\.2\.0 · 50%/)).toBeTruthy();
  });

  it("keeps the notice and offers a retry when the download failed", () => {
    setUpdate({ status: "failed", failedAt: "install", version: "0.2.0", error: "disk full" });
    render(<UpdateNotice />);
    expect(screen.getByText(/disk full/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a failed download retries the install", () => {
    const installUpdate = vi.fn(async () => {});
    const checkForUpdates = vi.fn(async () => {});
    setUpdate({ status: "failed", failedAt: "install", version: "0.2.0", error: "disk full" });
    useStore.setState({ installUpdate, checkForUpdates });
    render(<UpdateNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(installUpdate).toHaveBeenCalled();
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("a failed check checks again rather than installing", () => {
    const installUpdate = vi.fn(async () => {});
    const checkForUpdates = vi.fn(async () => {});
    setUpdate({ status: "failed", failedAt: "check", manual: true, error: "network down" });
    useStore.setState({ installUpdate, checkForUpdates });
    render(<UpdateNotice />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(checkForUpdates).toHaveBeenCalledWith({ manual: true });
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("says to restart by hand when the relaunch failed", () => {
    setUpdate({ status: "ready", version: "0.2.0", error: "cannot restart" });
    render(<UpdateNotice />);
    expect(screen.getByText(/Quit and reopen swarmz/)).toBeTruthy();
  });

  it("stays quiet about a failed background check", () => {
    setUpdate({ status: "failed", failedAt: "check", error: "network down", manual: false });
    const { container } = render(<UpdateNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("stays quiet about a failed background check even when it knows a version", () => {
    // A version left over from an earlier check is not a reason to shout about a check that
    // nobody asked for.
    setUpdate({ status: "failed", failedAt: "check", version: "0.2.0", error: "network down", manual: false });
    const { container } = render(<UpdateNotice />);
    expect(container.firstChild).toBeNull();
  });

  it("reports a failed check that was asked for", () => {
    setUpdate({ status: "failed", failedAt: "check", error: "network down", manual: true });
    render(<UpdateNotice />);
    expect(screen.getByText(/Could not check for updates/)).toBeTruthy();
    expect(screen.getByText(/network down/)).toBeTruthy();
  });
});

describe("UpdateVersionLine", () => {
  it("checks for updates on click", () => {
    const checkForUpdates = vi.fn(async () => {});
    useStore.setState({ checkForUpdates });
    render(<UpdateVersionLine />);
    fireEvent.click(screen.getByRole("button", { name: /Check for updates/ }));
    expect(checkForUpdates).toHaveBeenCalledWith({ manual: true });
  });

  it("reports being up to date after a manual check", () => {
    setUpdate({ status: "idle", manual: true, checkedAt: new Date().toISOString() });
    render(<UpdateVersionLine />);
    expect(screen.getByText(/You are up to date/)).toBeTruthy();
  });

  it("says nothing about being up to date after a background check", () => {
    setUpdate({ status: "idle", manual: false, checkedAt: new Date().toISOString() });
    render(<UpdateVersionLine />);
    expect(screen.queryByText(/You are up to date/)).toBeNull();
  });

  it("shows the running version", () => {
    render(<UpdateVersionLine />);
    expect(screen.getByText(new RegExp(`swarmz ${__APP_VERSION__.replace(/\./g, "\\.")}`))).toBeTruthy();
  });
});
