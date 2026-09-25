/**
 * What passes between the main window and the others (windows and layouts spec §4). The main
 * window owns the store; another window mirrors the slice its panes draw (`mirrorFor`), and sends
 * back every change as one of `PROXIED_ACTIONS`, which the main window applies. Pure, so both
 * sides and the tests share it.
 */
import { layoutsOf, type WorkbenchState } from "../store";
import { allGroups, type Layout } from "./layout";
import { displayTitle } from "./card";
import { MAIN, openTiles } from "./windowLayouts";

/** Per window: Tauri's `listen` hears events aimed at any window, so the label is in the name. */
export const WINDOW_STATE_EVENT = (label: string) => `window:state:${label}`;
export const WINDOW_HELLO_EVENT = "window:hello";
export const WINDOW_ACTION_EVENT = "window:action";
export const WINDOW_DROP_EVENT = (label: string) => `window:drop-at:${label}`;

/** The store actions another window may ask the main window for, and nothing else. */
export const PROXIED_ACTIONS = [
  "focusTerminal",
  "focusGroup",
  "moveTerminal",
  "splitTerminal",
  "resizeSplit",
  "setDragging",
  "createTerminal",
  "createSshTerminal",
  "restartTerminal",
  "runStartup",
  "skipStartup",
  "cancelConnecting",
  "chooseRemoteDir",
  "selectSession",
  "closeTerminal",
  "closeTab",
  "openInNewWindow",
  "moveGroupToNewWindow",
  "moveToWindow",
  "dropOutside",
  "closeWindow",
  "applyPreset",
  "newInSlot",
  "removeSlot",
  "toggleZoom",
  "undoClosed",
  "dismissClosedNotice",
] as const;
export type ProxiedAction = (typeof PROXIED_ACTIONS)[number];

/**
 * Actions another window's terminal registry calls that only the main window acts on: it
 * receives and parses every tile's output too, so clipboard, folder, resume and exit handling
 * happen there once.
 */
export const MAIN_ONLY_ACTIONS = [
  "setTerminalCwd",
  "flashCopied",
  "flashPasted",
  "noteResumeFailure",
  "remoteAttached",
  "markExited",
  "watchResume",
  "applyAgentEvent",
  "setWindowFocused",
] as const;

export interface WindowAction {
  label: string;
  name: ProxiedAction;
  args: unknown[];
}

export interface WindowDrop {
  id: string;
  x: number;
  y: number;
}

/** The store fields a window's mirror carries (its own tree as `layout`). */
export const MIRRORED_KEYS = [
  "terminals",
  "order",
  "settings",
  "agentState",
  "machines",
  "selfMachine",
  "conductor",
  "conductors",
  "startupPending",
  "startupNotes",
  "sshConnected",
  "sshConnecting",
  "sshDropped",
  "copiedAt",
  "pastedAt",
  "draggingTerminalId",
  "tailscale",
  "windows",
  "lastCwd",
] as const satisfies readonly (keyof WorkbenchState)[];

export type WindowMirror = Pick<WorkbenchState, (typeof MIRRORED_KEYS)[number]> & {
  layout: Layout;
  focusedGroupId: string | null;
  focusedTerminalId: string | null;
  zoomed: Record<string, string>;
  closedNotice: WorkbenchState["closedNotice"];
  /** Every tile open in some window, which a mirror cannot work out (it lacks the main window's tree). */
  openTileIds: string[];
};

/** Window `label`'s mirror of the main store. */
export function mirrorFor(s: WorkbenchState, label: string): WindowMirror | null {
  const w = s.windows[label];
  if (!w) return null;
  const out = {} as Record<string, unknown>;
  for (const k of MIRRORED_KEYS) out[k] = s[k];
  const g = allGroups(w.layout).find((x) => x.id === w.focusedGroupId);
  return {
    ...(out as Pick<WorkbenchState, (typeof MIRRORED_KEYS)[number]>),
    layout: w.layout,
    focusedGroupId: w.focusedGroupId,
    focusedTerminalId: g?.active || null,
    zoomed: s.zoomed[label] ? { [label]: s.zoomed[label] } : {},
    closedNotice: s.closedNotice?.window === label ? s.closedNotice : null,
    openTileIds: [...openTiles(layoutsOf(s))],
  };
}

/** The tiles open in some window on this Mac (spec §2), from the main store or a window's mirror. */
export function openTileSet(s: Pick<WorkbenchState, "windowLabel" | "layout" | "windows" | "openTileIds">): Set<string> {
  return s.windowLabel === MAIN ? openTiles(layoutsOf(s)) : new Set(s.openTileIds);
}

/** Whether a change to the main store changes what window mirrors show. */
export function mirrorChanged(s: WorkbenchState, prev: WorkbenchState): boolean {
  return MIRRORED_KEYS.some((k) => s[k] !== prev[k]) || s.layout !== prev.layout || s.zoomed !== prev.zoomed || s.closedNotice !== prev.closedNotice;
}

/** The windows by name, for "Move to window" (spec §4): the main window, then each other one by the tile it shows. */
export function windowNames(s: Pick<WorkbenchState, "windows" | "terminals" | "settings" | "agentState">): { label: string; name: string }[] {
  const out = [{ label: MAIN, name: "Main window" }];
  for (const [label, w] of Object.entries(s.windows)) {
    const first = allGroups(w.layout)[0]?.active;
    const t = first ? s.terminals[first] : undefined;
    const n = allGroups(w.layout).reduce((a, g) => a + g.tabs.length, 0);
    const title = t ? displayTitle(s.settings[first]?.card, s.agentState[first], t.name) : "Window";
    out.push({ label, name: n > 1 ? `${title} +${n - 1}` : title });
  }
  return out;
}

/** A pane's drop zone under a point (spec §4), by the same geometry as the drag-over zones. */
export function zoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): "left" | "right" | "top" | "bottom" | "center" {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0.25) return "left";
  if (fx > 0.75) return "right";
  if (fy < 0.25) return "top";
  if (fy > 0.75) return "bottom";
  return "center";
}
