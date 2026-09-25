/**
 * Terminal themes by machine (machine themes spec): five full palettes (dark Midnight, Forest,
 * Ember, light Daylight, cyberpunk Neon), one per Mac, so a pane
 * says where its shell runs at a glance. A Mac's `theme` in the shared workspace picks one; with
 * none picked it gets one by its place among the known Macs (so up to five Macs all differ), and
 * `plain` is swarmz's original look, tinted by the Mac's colour as before.
 */
import type { ITheme } from "@xterm/xterm";

export interface MachineTheme {
  id: string;
  name: string;
  /** What it feels like, for the picker's tooltip. */
  blurb: string;
  /** The Mac's colour when none is picked (its chip, badges): the theme's signature hue, bright enough for dark text. */
  accent: string;
  theme: ITheme & { background: string; foreground: string };
}

export const PLAIN_BG = "#0f1115";

/** swarmz's original look (the Mac's colour still tints it). */
export const PLAIN: MachineTheme = {
  id: "plain",
  accent: "#8b8e95",
  name: "Plain",
  blurb: "swarmz's own dark look, tinted by the Mac's colour",
  theme: { background: PLAIN_BG, foreground: "#d4d4d8", cursor: "#d4d4d8", selectionBackground: "#3b4252" },
};

export const THEMES: MachineTheme[] = [
  {
    id: "midnight",
    accent: "#82aaff",
    name: "Midnight",
    blurb: "dark: deep indigo, cool blue text",
    theme: {
      background: "#161a2e",
      foreground: "#c8d3f5",
      cursor: "#82aaff",
      cursorAccent: "#161a2e",
      selectionBackground: "#2d3f76",
      black: "#1b1d2b",
      red: "#ff757f",
      green: "#c3e88d",
      yellow: "#ffc777",
      blue: "#82aaff",
      magenta: "#c099ff",
      cyan: "#86e1fc",
      white: "#c8d3f5",
      brightBlack: "#636da6",
      brightRed: "#ff8d94",
      brightGreen: "#c7fb6d",
      brightYellow: "#ffd8ab",
      brightBlue: "#9ab8ff",
      brightMagenta: "#caabff",
      brightCyan: "#b2ebff",
      brightWhite: "#e4ebff",
    },
  },
  {
    id: "forest",
    accent: "#a7c080",
    name: "Forest",
    blurb: "moss green, soft parchment text",
    theme: {
      background: "#18231d",
      foreground: "#d8d3ba",
      cursor: "#a7c080",
      cursorAccent: "#18231d",
      selectionBackground: "#35503f",
      black: "#1f2b24",
      red: "#e67e80",
      green: "#a7c080",
      yellow: "#dbbc7f",
      blue: "#7fbbb3",
      magenta: "#d699b6",
      cyan: "#83c092",
      white: "#d8d3ba",
      brightBlack: "#5f7466",
      brightRed: "#f08f91",
      brightGreen: "#bcd495",
      brightYellow: "#e8cc93",
      brightBlue: "#93cdc5",
      brightMagenta: "#e3aac5",
      brightCyan: "#98d3a6",
      brightWhite: "#efe9cf",
    },
  },
  {
    id: "ember",
    accent: "#f5a55a",
    name: "Ember",
    blurb: "warm charcoal-brown, amber text",
    theme: {
      background: "#241c17",
      foreground: "#ebdbb2",
      cursor: "#fe8019",
      cursorAccent: "#241c17",
      selectionBackground: "#504036",
      black: "#2c231d",
      red: "#fb4934",
      green: "#b8bb26",
      yellow: "#fabd2f",
      blue: "#83a598",
      magenta: "#d3869b",
      cyan: "#8ec07c",
      white: "#ebdbb2",
      brightBlack: "#7c6a5c",
      brightRed: "#ff6450",
      brightGreen: "#cdd03a",
      brightYellow: "#ffd05a",
      brightBlue: "#9dbcaf",
      brightMagenta: "#e39db0",
      brightCyan: "#a4d492",
      brightWhite: "#fbf1c7",
    },
  },
  {
    id: "daylight",
    accent: "#7dd3fc",
    name: "Daylight",
    blurb: "light: warm paper, ink-dark text",
    theme: {
      background: "#f6f4ee",
      foreground: "#24292f",
      cursor: "#0969da",
      cursorAccent: "#f6f4ee",
      selectionBackground: "#c9ddf5",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#9a6700",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#7d4e00",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
  },
  {
    id: "neon",
    accent: "#ff5c8d",
    name: "Neon",
    blurb: "cyberpunk: ultraviolet night, hot pink and electric cyan",
    theme: {
      background: "#0d0221",
      foreground: "#e0f7ff",
      cursor: "#ff2a6d",
      cursorAccent: "#0d0221",
      selectionBackground: "#3b1060",
      black: "#1a0b33",
      red: "#ff2a6d",
      green: "#05ffa1",
      yellow: "#f9f002",
      blue: "#01c5ff",
      magenta: "#d300c5",
      cyan: "#00fff5",
      white: "#d1f7ff",
      brightBlack: "#5a3d8a",
      brightRed: "#ff5c8d",
      brightGreen: "#7fffd4",
      brightYellow: "#fffc58",
      brightBlue: "#4fd8ff",
      brightMagenta: "#ff4df0",
      brightCyan: "#6bfff9",
      brightWhite: "#ffffff",
    },
  },
];

const ALL = [...THEMES, PLAIN];

export function isThemeId(v: unknown): v is string {
  return typeof v === "string" && ALL.some((t) => t.id === v);
}

export function themeById(id: string): MachineTheme {
  return ALL.find((t) => t.id === id) ?? PLAIN;
}

/**
 * The theme a Mac shows: the one picked for it, else one by its place among the known Macs
 * sorted by name, so up to five Macs all differ. No Mac (not known yet): plain.
 */
export function themeFor(machine: string | null, picked: string | null | undefined, known: string[]): MachineTheme {
  if (isThemeId(picked)) return themeById(picked);
  if (!machine) return PLAIN;
  const names = [...new Set([...known, machine])].sort();
  return THEMES[names.indexOf(machine) % THEMES.length];
}

/**
 * A Mac's colour (its chip in the sidebar, its badges): the one picked for it, else the accent of
 * its terminal theme, so a chip matches the panes of that Mac (sidebar redesign spec). A Mac on the
 * plain theme takes the accent its place would have given it.
 */
export function machineAccent(machine: string, picked: { color?: string | null; theme?: string | null } | undefined, known: string[]): string {
  if (picked?.color) return picked.color;
  const t = themeFor(machine, picked?.theme, known);
  if (t.id !== PLAIN.id) return t.accent;
  return themeFor(machine, null, known).accent;
}
