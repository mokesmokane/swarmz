/** A tile's built-in browser (tile browser spec): state the store keeps, and the address bar. */
import { clampRect, type ScratchRect } from "./scratch";

export const BLANK = "about:blank";
/** A load that has not finished after this long shows the error strip (spec §5, as ruled). */
export const LOAD_STALL_MS = 25_000;

export interface BrowserRequest {
  url: string;
  note: string | null;
  /** "Claude" or "Codex", for the banner. */
  agent: string;
  at: string;
}

export interface BrowserState {
  /** The frame shows (a hidden browser keeps its page). */
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  loadingSince: number | null;
  rect: ScratchRect | null;
  request: BrowserRequest | null;
  /** Bumped when the page should take the keyboard. */
  focusToken: number;
  /** An agent opened it while the user was elsewhere. */
  pulse: boolean;
  error: string | null;
}

export function emptyBrowser(): BrowserState {
  return { open: false, url: BLANK, title: "", loading: false, loadingSince: null, rect: null, request: null, focusToken: 0, pulse: false, error: null };
}

const MARGIN = 12;

export function defaultBrowserRect(bounds: { w: number; h: number }): ScratchRect {
  const w = Math.round((bounds.w * 2) / 3);
  const h = Math.round(bounds.h * 0.6);
  return clampRect({ x: bounds.w - w - MARGIN, y: MARGIN, w, h }, bounds);
}

const HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[^\s/:.]+(?:\.[^\s/:.]+)+)(:\d+)?([/?#]\S*)?$/i;

/** What the address bar loads for typed text: a web address, a search, or a refusal. */
export function addressFor(text: string): { url: string } | { error: string } | null {
  const t = text.trim();
  if (!t) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
  const m = HOST.exec(t);
  if (m) return { url: `${/^(localhost|\d)/i.test(m[1]) ? "http" : "https"}://${t}` };
  if (scheme === "http" || scheme === "https") return /\s/.test(t) ? { error: "An address cannot contain spaces" } : { url: t };
  if (scheme && !/\s/.test(t)) return { error: `swarmz's browser only opens http and https addresses, not ${scheme}:` };
  return { url: `https://duckduckgo.com/?q=${encodeURIComponent(t)}` };
}

const chains = new Map<string, Promise<void>>();

/** Runs a tile's core calls one after another, so a close never overtakes the show before it. */
export function queued(tile: string, call: () => Promise<unknown>): Promise<void> {
  const next = (chains.get(tile) ?? Promise.resolve()).then(() => call()).then(
    () => {},
    () => {},
  );
  chains.set(tile, next);
  return next;
}
