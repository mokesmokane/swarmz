import { describe, expect, it } from "vitest";
import { isThemeId, PLAIN, THEMES, themeById, themeFor } from "./themes";

const hex = /^#[0-9a-f]{6}$/;
const lum = (c: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("machine themes", () => {
  it("are five full palettes with readable text, one light, one cyberpunk, and distinct backgrounds", () => {
    expect(THEMES).toHaveLength(5);
    const keys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
    for (const t of THEMES) {
      for (const k of [...keys, "background", "foreground", "cursor", "selectionBackground"] as const) expect(t.theme[k], `${t.id}.${k}`).toMatch(hex);
      expect(contrast(t.theme.background, t.theme.foreground), t.id).toBeGreaterThan(7);
    }
    expect(new Set(THEMES.map((t) => t.theme.background)).size).toBe(5);
    expect(THEMES.filter((t) => lum(t.theme.background) > 0.5).map((t) => t.id)).toEqual(["daylight"]);
    expect(THEMES.map((t) => t.id)).toContain("neon");
  });

  it("gives each Mac a picked theme, else one by its place, so up to five Macs differ", () => {
    const macs = ["mini", "mini-2", "mini-3"];
    const auto = macs.map((m) => themeFor(m, null, macs).id);
    expect(new Set(auto).size).toBe(3);
    expect(themeFor("mini-2", "neon", macs).id).toBe("neon");
    expect(themeFor("mini", "bogus", macs).id).toBe(auto[0]);
    expect(themeFor(null, null, macs)).toBe(PLAIN);
    expect(isThemeId("plain")).toBe(true);
    expect(isThemeId("nope")).toBe(false);
    expect(themeById("nope")).toBe(PLAIN);
  });
});
