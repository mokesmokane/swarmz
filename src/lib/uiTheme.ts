import { useLayoutEffect } from "react";
import { machineThemeId, useStore } from "../store";
import { themeById } from "./themes";

/** The window follows its own Mac, even when viewing tiles on other Macs. */
export function useUiTheme() {
  const id = useStore((s) => machineThemeId(s, s.selfMachine));
  useLayoutEffect(() => {
    const palette = uiPalette(id);
    const root = document.documentElement;
    root.dataset.appearance = palette.light ? "light" : "dark";
    root.style.colorScheme = palette.light ? "light" : "dark";
    for (const [key, value] of Object.entries(palette.colors)) root.style.setProperty(`--ui-${key}`, value);
  }, [id]);
}

const mix = (a: string, b: string, amount: number) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount) + parseInt(b.slice(i, i + 2), 16) * amount).toString(16).padStart(2, "0")).join("");

export function isLightTheme(id: string): boolean {
  const bg = themeById(id).theme.background;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

/** Neutral surfaces retain the terminal palette's tint; ink and status colours remain readable. */
export function uiPalette(id: string) {
  const theme = themeById(id).theme;
  const light = isLightTheme(id);
  const bg = theme.background;
  const ink = theme.foreground;
  const colors: Record<string, string> = {
    background: bg, ink,
    panel: mix(bg, ink, 0.035), rail: mix(bg, light ? ink : "#000000", light ? 0.065 : 0.2),
    well: light ? mix(bg, "#ffffff", 0.65) : mix(bg, "#000000", 0.15),
    hover: mix(bg, ink, 0.08), focus: mix(bg, ink, 0.13), chip: mix(bg, ink, 0.15),
    line: mix(bg, ink, light ? 0.2 : 0.14),
    "ink-2": mix(bg, ink, 0.85), "ink-3": mix(bg, ink, 0.7),
    muted: mix(bg, ink, light ? 0.72 : 0.65), faint: mix(bg, ink, light ? 0.69 : 0.63),
    pick: light ? "#075fc5" : "#6195de", link: light ? "#075fc5" : "#93c5fd",
    needs: light ? "#965300" : "#edb74e", working: light ? "#237b43" : "#66ce91", exited: light ? "#b4232e" : "#e76c5b",
    "badge-ink": light ? "#ffffff" : "#1a1405",
  };
  // Legacy neutral utilities are roles too: high numbers are surfaces, low numbers are ink.
  const roles: Record<number, string> = { 50: "ink", 100: "ink", 200: "ink-2", 300: "ink-2", 400: "ink-3", 500: "muted", 600: "faint", 700: "line", 800: "hover", 900: "panel", 950: "well" };
  for (const [shade, role] of Object.entries(roles)) colors[`neutral-${shade}`] = colors[role];
  return { light, colors };
}
