/** Tiles shown in their own windows on this Mac (breakout windows spec §2): a per-Mac record, never synced. */
const KEY = "swarmz.breakouts";

export function breakoutLabel(id: string): string {
  return `tile-${id}`;
}

export function tileOfLabel(label: string): string | null {
  return label.startsWith("tile-") ? label.slice(5) : null;
}

/** The window bounds to remember with a breakout, in logical pixels. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Breakouts = Record<string, { bounds: Bounds | null }>;

export function loadBreakouts(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): Breakouts {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: Breakouts = {};
    for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) continue;
      const b = (entry as { bounds?: unknown })?.bounds;
      out[id] = { bounds: isBounds(b) ? b : null };
    }
    return out;
  } catch {
    return {};
  }
}

function isBounds(b: unknown): b is Bounds {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number));
}

export function saveBreakouts(b: Breakouts, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(b));
  } catch {
    // storage unavailable: the windows still exist for this run
  }
}

/** Whether a drag ended outside the main window: the pointer's screen position against the window's bounds (spec §5). */
export function pointerOutside(pointer: { x: number; y: number }, window: Bounds): boolean {
  return pointer.x < window.x || pointer.y < window.y || pointer.x > window.x + window.width || pointer.y > window.y + window.height;
}

/** Where a new breakout window goes: its header under the pointer, 40 px in from the top-left. */
export function windowAt(pointer: { x: number; y: number } | null, size = { width: 900, height: 600 }): Bounds | null {
  if (!pointer) return null;
  return { x: Math.max(0, Math.round(pointer.x - 40)), y: Math.max(0, Math.round(pointer.y - 40)), ...size };
}

/** What the main window tells a breakout window about its tile (spec §4), and re-sends on change. */
export interface TileState {
  terminal: { id: string; name: string; cwd: string; exited: number | null; error: string | null };
  settings: unknown;
  agent: unknown;
  machines: unknown;
  selfMachine: string | null;
  /** The sidebar's second line, ready to show. */
  line: { glyph: string; machine: string; color: string | null; folder: string; status: string; since: string | null };
  title: string;
}

export const TILE_STATE_EVENT = (id: string) => `tile:state:${id}`;
/** A breakout window asking for its state, and acting on its tile. */
export const BREAKOUT_HELLO_EVENT = "breakout:hello";
export const BREAKOUT_ACTION_EVENT = "breakout:action";
export type BreakoutAction = { id: string; action: "return" | "restart" | "focus-main" };
