// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./ipc", () => ({ ipc: {} }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/me") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
import { useStore } from "../store";
import { uiPalette, useUiTheme } from "./uiTheme";

function WindowTheme() { useUiTheme(); return null; }
afterEach(cleanup);

it("updates window colours when this Mac's theme changes, without adopting a remote Mac's palette", () => {
  useStore.setState({ selfMachine: "local", tailscale: null, machines: { local: { lastUsed: "", theme: "daylight" }, remote: { lastUsed: "", theme: "neon" } } });
  render(<WindowTheme />);
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(document.documentElement.style.getPropertyValue("--ui-background")).toBe("#f6f4ee");
  expect(document.documentElement.style.getPropertyValue("--ui-ink")).toBe("#24292f");
  act(() => useStore.setState({ machines: { local: { lastUsed: "", theme: "forest" }, remote: { lastUsed: "", theme: "daylight" } } }));
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(document.documentElement.style.getPropertyValue("--ui-background")).toBe("#18231d");
  expect(document.documentElement.style.getPropertyValue("--ui-ink")).toBe("#d8d3ba");
});

it("uses the automatic local palette and plain dark colours until the Mac is known", () => {
  useStore.setState({ selfMachine: null, tailscale: null, machines: {} });
  render(<WindowTheme />);
  expect(document.documentElement.style.getPropertyValue("--ui-background")).toBe("#0f1115");
  act(() => useStore.setState({ selfMachine: "local" }));
  expect(document.documentElement.style.getPropertyValue("--ui-background")).toBe("#161a2e");
});

it("keeps secondary labels and status text readable on each palette's panel", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const id of ["daylight", "midnight", "forest", "ember", "neon", "plain"]) {
    const { colors } = uiPalette(id);
    for (const role of ["ink", "ink-2", "muted", "faint", "needs", "exited", "working", "link"]) {
      const [a, b] = [luminance(colors.panel), luminance(colors[role])].sort((x, y) => y - x);
      expect((a + 0.05) / (b + 0.05), `${id}.${role}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
