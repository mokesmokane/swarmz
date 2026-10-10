/** A tile's scratch shell (scratch terminal spec): a plain shell the user runs beside an agent,
 * kept out of the workspace and away from agents. */

export const SCRATCH_PREFIX = "scratch-";

export function isScratchId(id: string): boolean {
  return id.startsWith(SCRATCH_PREFIX);
}

export function scratchIdFor(tileId: string): string {
  return SCRATCH_PREFIX + tileId;
}

export function scratchParent(id: string): string | null {
  return isScratchId(id) ? id.slice(SCRATCH_PREFIX.length) : null;
}

/** Position and size in pixels, relative to the tile's pane. */
export interface ScratchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What an agent asked for with `swarmz scratch` (spec §4). */
export interface ScratchRequest {
  note: string | null;
  command: string | null;
  /** "Claude" or "Codex", for the banner. */
  agent: string;
  at: string;
}

export interface ScratchState {
  /** A holder is running for it. */
  started: boolean;
  /** The window is showing (hidden keeps the shell). */
  open: boolean;
  rect: ScratchRect | null;
  request: ScratchRequest | null;
  /** Bumped when the scratch shell should take the keyboard. */
  focusToken: number;
  /** An agent opened it while the user was elsewhere: the `>_` button pulses until it is seen. */
  pulse: boolean;
  /** The tile's folder was missing, so the shell started in the home folder. */
  inHome: boolean;
  /** `<folder>` or `<machine>:<folder>`, for the title bar. */
  label: string;
}

export const MIN_W = 220;
export const MIN_H = 120;
const MARGIN = 12;

export function defaultRect(bounds: { w: number; h: number }): ScratchRect {
  const w = Math.round(bounds.w / 2);
  const h = Math.round(bounds.h * 0.4);
  return clampRect({ x: bounds.w - w - MARGIN, y: bounds.h - h - MARGIN, w, h }, bounds);
}

export function clampRect(r: ScratchRect, bounds: { w: number; h: number }): ScratchRect {
  const w = Math.min(Math.max(r.w, MIN_W), bounds.w);
  const h = Math.min(Math.max(r.h, MIN_H), bounds.h);
  const x = Math.min(Math.max(r.x, 0), Math.max(bounds.w - w, 0));
  const y = Math.min(Math.max(r.y, 0), Math.max(bounds.h - h, 0));
  return { x, y, w, h };
}

export const SCRATCH_LIVE_MS = 30_000;

/** A `Scratch` event is acted on only when it is happening now: after this run started and
 * within `SCRATCH_LIVE_MS` of the clock (a little skew between Macs is fine). */
export function scratchEventIsLive(ts: string, now: number, launchedAt: string): boolean {
  const at = Date.parse(ts);
  if (Number.isNaN(at) || ts < launchedAt) return false;
  return Math.abs(now - at) <= SCRATCH_LIVE_MS;
}

/** Text safe to type at a prompt: no control characters, so never an Enter. */
export function oneLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}
