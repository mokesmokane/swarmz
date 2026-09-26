import { create } from "zustand";
import { homeDir } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc, updater, type TerminalInfo, type TailscaleStatus, type MachineStats, type PingResult } from "./lib/ipc";
import {
  addTab,
  allGroups,
  findGroup,
  findGroupOf,
  groupOf,
  removeGroup,
  removeTerminal,
  resizeSplit as resizeSplitNode,
  setActive,
  splitWith,
  tilesInOrder,
  tilesOf,
  type Layout,
  type Side,
} from "./lib/layout";
import {
  bumpSync,
  EMPTY_SETTINGS,
  hostLabel,
  isMachineColor,
  isNewer,
  isSafeRemotePath,
  isSafeSessionId,
  machineHost,
  machineLabel,
  mergeForFirstSync,
  openingFor,
  pickNewest,
  sameWorkspaceContent,
  sanitizeLayout,
  shellQuote,
  sshMasterLine,
  startupIsSsh,
  startupLine,
  startupSteps,
  toWorkspace,
  touchMachine,
  validateAlias,
  validateHost,
  validateUser,
  validHost,
  MACHINES_MAX,
  type MachineConfig,
  type Machines,
  type SyncMeta,
  type TerminalSettings,
  type TerminalDef,
  type Workspace,
  validateIcon,
  conductorFieldsOf,
  newerRoles,
  conductorOwner,
  liveSubs,
  workspaceExtra,
  type ConductorClaim,
  type SubConductors,
  tintBackground,
} from "./lib/workspace";
import { withUserTitle } from "./lib/card";
import {
  MAIN,
  dedupeLayouts,
  loadLayouts,
  migrateLayouts,
  newWindowLabel,
  placeTile,
  pruneLayouts,
  removeEverywhere,
  saveLayouts,
  windowOfGroup,
  windowOfNode,
  windowOfTile,
  type Bounds,
  type Layouts,
} from "./lib/windowLayouts";
import { arrange, presetById } from "./lib/presets";
import { readBoard, type BoardEntry } from "./lib/board";
import { isThemeId, machineAccent, PLAIN, PLAIN_BG, themeById, themeFor, type MachineTheme } from "./lib/themes";

type Point = { x: number; y: number };

/**
 * What the window module (`windows.ts`) does for the store (windows and layouts spec §4):
 * opening, focusing and closing the other windows, finding the window under a screen point,
 * handing a drop to another window, and reading a window's bounds. It fills these in at module
 * load so the store never imports the window API (tests mock nothing).
 */
export const windowHooks: {
  open: (label: string, at: Point | null, bounds?: Bounds | null) => Promise<void>;
  focus: (label: string) => void;
  close: (label: string) => void;
  /** The swarmz window under a screen point (the most recently focused first), or null. */
  windowAt: (p: Point) => Promise<string | null>;
  /** Asks window `label` to resolve a drop of tile `id` at screen point `p` (spec §4). */
  dropAt: (label: string, id: string, p: Point) => void;
  boundsOf: (label: string) => Promise<Bounds | null>;
} = {
  open: async () => {},
  focus: () => {},
  close: () => {},
  windowAt: async () => null,
  dropAt: () => {},
  boundsOf: async () => null,
};

/** How long the "still running" notice stays (spec §3). */
export const CLOSED_NOTICE_MS = 8000;

/** Another window's own state (spec §4): its tree and which group has focus. */
export interface WindowState {
  layout: Layout;
  focusedGroupId: string | null;
}

/** Tabs or a window just closed while their tiles run on (spec §3), with what Undo restores. */
export interface ClosedNotice {
  /** The window showing the notice. */
  window: string;
  ids: string[];
  at: number;
  undo: { kind: "tiles"; places: { id: string; groupId: string | null }[] } | { kind: "window"; layout: Layout; bounds: Bounds | null };
}
import { applyAgentEvent as foldAgentEvent, OFFLINE, type AgentState } from "./lib/agentState";
import type { AgentEventPayload } from "./lib/ipc";
import { bumpSession, isSafeFolder, promoteSession, removeSession, sanitizeSessions, upsertSession } from "./lib/sessions";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const SAVE_DEBOUNCE_MS = 500;

export const RESUME_WATCH_MS = 10_000;

/** The session id typed in a `--resume <id>` line, or null when the line doesn't resume one. */
function resumedSessionIn(line: string): string | null {
  const m = /--resume ([A-Za-z0-9-]{1,64})/.exec(line);
  return m ? m[1] : null;
}

export const SSH_POLL_MS = 500;
export const SSH_POLL_TIMEOUT_MS = 120_000;
export const SSH_SETTLE_MS = 300;
/** A session started this recently may still be one `swarmz new` is recording (its keep-def
 * helper watches for 30 s), so it is never offered as running outside the workspace. */
export const OUTSIDE_SETTLE_MS = 120_000;
/** How often a connected ssh tile checks that its ssh still owns the terminal. */
export const SSH_WATCHDOG_MS = 3_000;

export const SYNC_PULL_MS = 30_000;
export const SYNC_STAT_MS = 5_000;

/** When this app run started: hook events older than this are replay from before launch. */
export let APP_LAUNCHED_AT = new Date().toISOString();

/** Local tiles whose session holder was already running when this run joined it, with when that
 * holder started (ms, or null when unknown): their shells (and any Claude in them) outlived the
 * last run, so their events from before launch still describe them, back to the holder's start. */
const joinedTiles = new Map<string, number | null>();

function noteJoined(info: TerminalInfo) {
  if (!info.existed) {
    joinedTiles.delete(info.id);
    return;
  }
  const started = info.startedAt ? Date.parse(info.startedAt) : NaN;
  joinedTiles.set(info.id, Number.isNaN(started) ? null : started);
}

/** Whether a local event from before launch describes the tile's current session. */
function preLaunchEventCounts(id: string, ts: string): boolean {
  if (!joinedTiles.has(id)) return false;
  const started = joinedTiles.get(id) ?? null;
  const at = Date.parse(ts);
  return started === null || Number.isNaN(at) || at >= started;
}

/** Local events from before launch that arrived before the first load opened its tiles (the local
 * watcher replays the log's tail within milliseconds of starting, long before the holders have
 * answered). Null once they have been applied. */
let launchReplay: AgentEventPayload[] | null = [];
const LAUNCH_REPLAY_MAX = 5000;

/** Applies the buffered pre-launch events, in order, now that the joined tiles are known. */
function finishLaunchReplay() {
  const pending = launchReplay;
  launchReplay = null;
  for (const p of pending ?? []) useStore.getState().applyAgentEvent(p);
}
export function __setLaunchedAt(iso: string) {
  APP_LAUNCHED_AT = iso;
}

export const AGENT_WATCH_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Hosts with a live log watcher, hosts whose hooks were installed this run, and retry state.
 * `gen` is the core's generation for the watcher we last asked for, so an `agent:watch-ended`
 * from a watcher we have already replaced cannot unwatch the new one. */
const agentWatch = {
  watching: new Set<string | null>(),
  installed: new Set<string>(),
  attempts: new Map<string | null, number>(),
  retry: new Map<string | null, ReturnType<typeof setTimeout>>(),
  gen: new Map<string | null, number>(),
  /** When the watch we last asked for was issued, and the delay we waited before asking. */
  startedAt: new Map<string | null, number>(),
  delay: new Map<string | null, number>(),
};

export function __resetAgentWatchers() {
  agentWatch.watching.clear();
  agentWatch.installed.clear();
  agentWatch.attempts.clear();
  for (const t of agentWatch.retry.values()) clearTimeout(t);
  agentWatch.retry.clear();
  agentWatch.gen.clear();
  agentWatch.startedAt.clear();
  agentWatch.delay.clear();
}

/**
 * Hosts that should have a log watcher, with one terminal id per host for notes. This machine
 * (`null`, no tile of its own) is always wanted; an ssh host is wanted while it has a connected
 * tile.
 */
function wantedAgentHosts(s: WorkbenchState): Map<string | null, string | null> {
  const out = new Map<string | null, string | null>([[null, null]]);
  for (const id of s.order) {
    const host = s.settings[id]?.ssh?.host?.trim();
    if (host && s.sshConnected[id] && s.terminals[id]?.exited === null && !out.has(host)) out.set(host, id);
  }
  return out;
}

/**
 * `ensureAgentWatchers` awaits ipc calls per host, and a tile can close while one is in flight —
 * `wanted`, computed once at that call's entry, goes stale. Called after every await in its
 * per-host loop: rolls back (unwatching if a watch was already marked) and reports whether the
 * caller should stop working on this host.
 */
async function bailIfUnwanted(host: string | null): Promise<boolean> {
  if (wantedAgentHosts(useStore.getState()).has(host)) return false;
  if (agentWatch.watching.has(host)) {
    agentWatch.watching.delete(host);
    await ipc.agentsUnwatch(host).catch(() => {});
  }
  return true;
}

/** After this many failed re-watches (1+2+4+8+16 s ≈ 30 s) the tile gets a note. */
export const AGENT_WATCH_UNAVAILABLE_AFTER = 5;

/** Sidebar line for a local watcher that keeps dying; the remote equivalent is a tile note. */
export const AGENT_UNAVAILABLE_LOCAL = "agent state unavailable on this Mac";

/** The two tile notes this module writes, by prefix: each is cleared when what it reports
 * starts working again, and nothing else on the tile is touched. */
const AGENT_INSTALL_NOTE = "could not install Claude hooks on ";
const AGENT_UNAVAILABLE_NOTE = "agent state unavailable for ";

/** Drops `prefix` notes from every tile on `host`; notes the rest of the app wrote stay. */
function clearAgentNotes(host: string, prefix: string) {
  useStore.setState((s) => {
    let startupNotes = s.startupNotes;
    for (const id of s.order) {
      if (s.settings[id]?.ssh?.host?.trim() === host && startupNotes[id]?.startsWith(prefix)) {
        startupNotes = omit(startupNotes, id);
      }
    }
    return startupNotes === s.startupNotes ? {} : { startupNotes };
  });
}

/**
 * Evidence that the watcher for `host` really ran: an event from it, or a watcher that outlived
 * the wait that started it. `agents_watch` resolving is not evidence — the core resolves it as
 * soon as it has spawned `tail`/`ssh`, long before ssh has connected — so an unreachable host
 * would otherwise reset its backoff on every hop and never escalate.
 */
function agentWatchSurvived(host: string | null) {
  agentWatch.attempts.delete(host);
  agentWatch.delay.delete(host);
  if (host === null) {
    if (useStore.getState().agentHooksError === AGENT_UNAVAILABLE_LOCAL) useStore.setState({ agentHooksError: null });
  } else {
    clearAgentNotes(host, AGENT_UNAVAILABLE_NOTE);
  }
}

/**
 * A remote watcher almost always dies because its ssh died, and `sshConnected` is never cleared
 * while the tile lives — so without this a tile whose connection dropped would keep its host
 * "wanted" and keep respawning ssh for the rest of the run. Re-checks every connected tile of
 * `host`, forgets the ones that are gone (which lets the subscription drop the watcher) and
 * reports whether any is still live.
 */
async function agentTilesStillLive(host: string): Promise<boolean> {
  const s = useStore.getState();
  const ids = s.order.filter((id) => s.settings[id]?.ssh?.host?.trim() === host && s.sshConnected[id]);
  let live = false;
  for (const id of ids) {
    // The watchdog's rule: the local shell back in the foreground means the ssh is gone. A tile
    // whose ssh still runs but whose master check fails is dropped too (its watcher cannot run),
    // without touching the pane's modes, since the ssh may still own them.
    const busy = await foregroundBusyOrNull(id);
    if (busy === true && (await safeSshCheck(host))) {
      live = true;
      continue;
    }
    if (!useStore.getState().sshConnected[id]) continue;
    markDisconnected(id, { resetModes: busy === false });
  }
  return live;
}

function scheduleAgentRewatch(host: string | null) {
  const n = agentWatch.attempts.get(host) ?? 0;
  agentWatch.attempts.set(host, n + 1);
  if (n + 1 === AGENT_WATCH_UNAVAILABLE_AFTER) {
    if (host === null) {
      useStore.setState({ agentHooksError: AGENT_UNAVAILABLE_LOCAL });
    } else {
      const s = useStore.getState();
      const id = wantedAgentHosts(s).get(host);
      if (id) {
        const machine = s.settings[id]?.ssh?.machine ?? hostLabel(host);
        useStore.setState((st) => ({ startupNotes: { ...st.startupNotes, [id]: `${AGENT_UNAVAILABLE_NOTE}${machine}` } }));
      }
    }
  }
  const delay = AGENT_WATCH_BACKOFF_MS[Math.min(n, AGENT_WATCH_BACKOFF_MS.length - 1)];
  agentWatch.delay.set(host, delay);
  const existing = agentWatch.retry.get(host);
  if (existing) clearTimeout(existing);
  agentWatch.retry.set(
    host,
    setTimeout(() => {
      agentWatch.retry.delete(host);
      void useStore.getState().ensureAgentWatchers();
    }, delay),
  );
}

// Note: this store does NOT import xtermRegistry directly (that would create
// an import cycle, since xtermRegistry imports beforeSpawn/useStore from
// here). Instead xtermRegistry registers its `size` function onto this
// object at module load time, mirroring the existing `hook` pattern.
export const beforeSpawn: {
  hook: (id: string) => Promise<void>;
  size: (id: string) => { cols: number; rows: number } | null;
  /** After joining a running session without a size: send the pane's size once it is laid out. */
  claimSize: (id: string) => void;
  /** After an ssh tile's connection ended: turn off the modes the remote program left on in the
   * pane (`resetTerminalModes`), writing to the xterm only. */
  resetModes: (id: string) => void;
} = {
  hook: async () => {},
  size: () => null,
  claimSize: () => {},
  resetModes: () => {},
};

/** Where a new terminal goes: a tab in a tile, or a new tile beside one. */
export type Placement =
  | { kind: "tab"; groupId: string }
  | { kind: "split"; groupId: string; side: Side };

/** What a new SSH terminal connects to. Claude, when set, gets a fresh session. */
/** A Mac in the Machines view (activity bar and machines spec §3–§4). */
export interface MachineStatus {
  name: string;
  self: boolean;
  online: boolean;
  /** The last numbers it gave (kept while a later ask fails). */
  stats: MachineStats | null;
  /** Why the last ask failed: `old_tool` when its swarmz predates `stats`. */
  error: string | null;
  ping: PingResult | null;
  /** When it was last asked. */
  at: string;
}

/**
 * The Macs the Machines view asks: this one, then every macOS machine on the tailnet (online ones
 * with the ssh destination the sync uses; offline ones only to be shown as offline).
 */
export function machineList(s: Pick<WorkbenchState, "selfMachine" | "tailscale" | "machines">): { name: string; self: boolean; online: boolean; host: string | null }[] {
  const out: { name: string; self: boolean; online: boolean; host: string | null }[] = [];
  if (s.selfMachine) out.push({ name: s.selfMachine, self: true, online: true, host: null });
  if (!s.tailscale?.running) return out;
  for (const p of s.tailscale.peers) {
    if (p.os !== "macOS" || p.name === s.selfMachine) continue;
    const host = machineHost(p.name, s.machines[p.name], s.tailscale.user ?? "");
    if (validateHost(host) !== null) continue;
    out.push({ name: p.name, self: false, online: p.online, host });
  }
  return out;
}

function statsError(reason: unknown): string {
  const m = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason);
  return m.includes("old_tool") || m.includes("(usage)") ? "old_tool" : m;
}

export interface SshTerminalOptions {
  host: string;
  cwd?: string | null;
  claude?: { skipPermissions: boolean } | null;
  name?: string;
  machine?: string | null;
}

/**
 * The desktop updater's state machine. `idle` is both "not asked yet" and "nothing to install";
 * a check that found something goes `checking` -> `available`, installing goes `available` ->
 * `downloading` -> `ready` (and then relaunches). Every failure lands in `failed` with the
 * reason and the version still set, so the notice stays and offers a retry: a broken endpoint,
 * a refused download or a relaunch that will not happen must never stop the app being used.
 */
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "failed";

export interface UpdateState {
  status: UpdateStatus;
  /** Which step failed, so the notice offers the retry that can actually work: checking again
   * after a check that never got an answer, installing again after a download that broke. */
  failedAt: "check" | "install" | null;
  /** The offered version, kept through `failed` so a retry knows what it is retrying. */
  version: string | null;
  notes: string | null;
  error: string | null;
  downloaded: number;
  contentLength: number | null;
  /** Whether the last check was asked for by hand, so an empty result is worth reporting. */
  manual: boolean;
  checkedAt: string | null;
  /** The user pressed Later: the notice hides until a different version turns up. */
  dismissed: boolean;
}

export const EMPTY_UPDATE: UpdateState = {
  status: "idle",
  failedAt: null,
  version: null,
  notes: null,
  error: null,
  downloaded: 0,
  contentLength: null,
  manual: false,
  checkedAt: null,
  dismissed: false,
};

/** Tauri rejects with a bare string as often as with an Error; both must read the same. */
function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export interface WorkbenchState {
  terminals: Record<string, TerminalInfo>;
  order: string[];
  layout: Layout;
  focusedGroupId: string | null;
  focusedTerminalId: string | null;
  draggingTerminalId: string | null;
  lastCwd: string | null;
  settings: Record<string, TerminalSettings>;
  startupPending: Record<string, boolean>;
  startupNotes: Record<string, string>;
  persistError: string | null;
  persistenceReady: boolean;
  sshConnected: Record<string, boolean>;
  sshConnecting: Record<string, boolean>;
  /** Ssh tiles whose connection ended under them (the card offers Reconnect); cleared once
   * connected again. */
  sshDropped: Record<string, boolean>;
  /** Per ssh host: whether its swarmz tool speaks our protocol, so its tiles attach to a session
   * holder there (`swarmz attach`). Absent means not asked yet; false falls back to plain ssh. */
  toolReady: Record<string, boolean>;
  machines: Machines;
  /** The tile allowed to act on the others (conductor spec §3), from the workspace; null when none. */
  conductor: string | null;
  /** A tile asking to be the conductor, until Approve or Deny (conductor spec §3). */
  conductorClaim: ConductorClaim | null;
  /** Sub-conductors by tile id (conductor tree spec §2), from the workspace. */
  conductors: SubConductors;
  /** When the conductor fields last changed (tree spec §7); the newer copy of them always wins. */
  conductorAt: string | null;
  /** Top-level workspace fields this app does not know, written back through every save. */
  workspaceExtra: Record<string, unknown>;
  /** Each Mac's numbers for the Machines view (activity bar and machines spec §4), by machine name. */
  machineStats: Record<string, MachineStatus>;
  /** Asks every Mac on the tailnet (and this one) for its numbers and pings it; results land in `machineStats`. */
  refreshMachineStats(): Promise<void>;
  /** Whether the Conductors dialog (the tree, arranged by hand) is open. */
  conductorsPanel: boolean;
  setConductorsPanel(open: boolean): void;
  /** Whether `~/.swarmz/telegram.json` is set up here (conductor spec §5); null until asked. */
  telegramConfigured: boolean | null;
  /** The file the viewer shows (file viewing spec §3): which tile named it, the resolved path, the line. */
  fileView: { id: string; path: string; line: number | null } | null;
  tailscale: TailscaleStatus | null;
  tailscaleError: string | null;
  selfMachine: string | null;
  syncMeta: SyncMeta | null;
  sync: {
    enabled: boolean;
    lastPullAt: string | null;
    lastPushAt: string | null;
    peersOk: number;
    peersTotal: number;
    error: string | null;
    adopting: boolean;
  };
  agentState: Record<string, AgentState>;
  agentHooksError: string | null;
  /** Whether some swarmz window has focus. */
  windowFocused: boolean;
  /** The swarmz window that has (or last had) focus (windows and layouts spec §4). */
  focusedWindow: string;
  /** Window `label` gained or lost focus (the main window's, or one sent by another window). */
  windowFocus(label: string, focused: boolean): void;
  /** When each terminal last copied a selection to the clipboard (ms since epoch), for the pane's "Copied" flash. */
  copiedAt: Record<string, number>;
  /** When each terminal last pushed a clipboard image to its remote (ms since epoch), for the pane's paste flash. */
  pastedAt: Record<string, number>;
  /** Armed for 10 s after typing a `--resume <sessionId>` line, while xtermRegistry scans for Claude reporting it gone. */
  resumeWatch: Record<string, { sessionId: string; until: number }>;
  /** Ids of running sessions on this Mac that are not in the workspace and have no open tile. */
  outsideSessions: string[];
  update: UpdateState;

  createTerminal(cwd: string, placement?: Placement): Promise<string>;
  createSshTerminal(opts: SshTerminalOptions, placement?: Placement): Promise<string>;
  createRemoteTerminal(
    opts: { machine: string; cwd: string | null; claude: { skipPermissions: boolean } | null },
    placement?: Placement,
  ): Promise<string>;
  closeTerminal(id: string): Promise<void>;
  restartTerminal(id: string): Promise<void>;
  renameTerminal(id: string, name: string): Promise<string | null>;
  markExited(id: string, code: number | null): void;
  focusTerminal(id: string): void;
  focusGroup(groupId: string): void;
  moveTerminal(id: string, groupId: string): void;
  splitTerminal(id: string, targetGroupId: string, side: Side): void;
  resizeSplit(splitId: string, sizes: number[]): void;
  setDragging(id: string | null): void;
  loadWorkspace(): Promise<void>;
  reloadWorkspace(): Promise<void>;
  pullWorkspace(): Promise<void>;
  checkExternalChange(): Promise<void>;
  refreshOutsideSessions(): Promise<void>;
  closeOutsideSessions(): Promise<string | null>;
  updateSettings(id: string, patch: Partial<TerminalSettings>): void;
  /** Makes `id` the conductor, or clears the role with null (conductor spec §6), through the tool so the tiles concerned are told; the file it wrote is adopted. */
  setConductor(id: string | null): Promise<void>;
  /** Makes `id` a conductor under `parent` (conductor tree spec §4), or moves one, through the tool. */
  setSubConductor(id: string, parent: string): Promise<void>;
  /** Puts tile `id` under conductor `to` (a sub-conductor, or the top to take it back), through the tool. */
  assignTile(id: string, to: string): Promise<void>;
  /** Turns sub-conductor `id` back into an ordinary tile; its tiles go back to its parent. */
  removeSubConductor(id: string): Promise<void>;
  /** Answers the pending claim (conductor spec §3): Approve makes the claimant the conductor, Deny clears the claim; either tells the claimant. */
  decideClaim(approve: boolean): Promise<void>;
  /** A local Claude tile in `cwd` (the conductor's folder by default), made the conductor at once (conductor spec §6). */
  createConductorTerminal(cwd: string, placement?: Placement): Promise<string>;
  /** Records whether Telegram is set up on this Mac (the Notifications panel and startup tell it). */
  setTelegramConfigured(configured: boolean): void;
  /** Opens `path` (absolute or `~`-relative) as tile `id` sees it, at `line` (file viewing spec §3). */
  openFile(id: string, path: string, line?: number | null): void;
  closeFile(): void;
  /** The user typed a title for the tile's card (conversation cards spec §5); empty hands it back. */
  setCardTitle(id: string, title: string): void;
  /** Which window this store draws: `main`, or the label of the window whose mirror it is. */
  windowLabel: string;
  /** The other windows on this Mac and their trees (windows and layouts spec §4); `layout` is the main window's. */
  windows: Record<string, WindowState>;
  /** The zoomed group of each window (spec §9), by window label; never saved. */
  zoomed: Record<string, string>;
  /** The shared file's `layout`, written back untouched for older apps (spec §2). */
  fileLayout: Layout;
  /** Tiles picked in the sidebar (spec §8), in the order they were picked. */
  selectedTiles: string[];
  /** The "still running" notice after closing tabs or a window (spec §3). */
  closedNotice: ClosedNotice | null;
  /** In another window's mirror: every tile open in some window (the main window works it out). */
  openTileIds: string[];
  /** The tile whose sidebar row the pointer is over: its pane and tab are outlined wherever they show. */
  hoveredTile: string | null;
  hoverTile(id: string | null): void;
  /** Each tile's board as its agent last wrote it (tile board spec); absent until known. */
  boards: Record<string, BoardEntry>;
  /** Asks the tile's Mac for its board when none is known yet (a pane showing it for the first time). */
  loadBoard(id: string): Promise<void>;
  /** Types a board answer into the tile and submits it. */
  answerBoard(id: string, text: string): Promise<void>;
  /** Tiles showing their identify label (identify spec): one tile, or all of them numbered in list order. */
  identify: { ids: string[]; numbered: boolean; at: number } | null;
  /** Shows where tile `id` is: its window comes forward, its tab shows, and a label flashes over its pane. */
  identifyTile(id: string): void;
  /** Numbers every open tile's pane and its sidebar row alike (`ids` in the order the list shows them). */
  identifyAll(ids: string[]): void;
  /** Closes the tab: the tile keeps running, not open in any window (spec §3). */
  closeTab(id: string): void;
  /** Moves these tiles into a new window at `at` (screen, logical px), arranged by a preset or as tabs of one group. */
  openInNewWindow(ids: string[], at: Point | null, presetId?: string | null): Promise<void>;
  /** Moves every tab of group `groupId` into a new window (spec §4). */
  moveGroupToNewWindow(groupId: string): Promise<void>;
  /** Moves tile `id` into window `label` (its focused group), or a new window for `new`. */
  moveToWindow(id: string, label: string): Promise<void>;
  /** A drag of tile `id` that no window took, ended at screen point `at` over window `from`'s surroundings (spec §4). */
  dropOutside(id: string, at: Point, from: string): Promise<void>;
  /** The user closed window `label`: its tiles keep running, not open here (spec §3, §4). */
  closeWindow(label: string): Promise<void>;
  /** Opens the windows this Mac had when it last ran (spec §4). */
  restoreWindows(): Promise<void>;
  /** Arranges the tiles of the window holding group `groupId` into preset `presetId` (spec §6). */
  applyPreset(groupId: string, presetId: string): void;
  /** Arranges the picked tiles into a preset, in a new window or the main one (spec §8). */
  arrangeSelection(presetId: string, target: "new" | "main"): Promise<void>;
  /** A local shell in empty slot `groupId` (spec §7). */
  newInSlot(groupId: string): Promise<void>;
  /** Removes empty slot `groupId`. */
  removeSlot(groupId: string): void;
  /** Zooms group `groupId` to fill its window, or puts it back (spec §9). */
  toggleZoom(groupId: string): void;
  /** Cmd/Ctrl-click (toggle) or Shift-click (range over `visible`, the rows as listed) on a row (spec §8). */
  selectTile(id: string, mode: "toggle" | "range", visible: string[]): void;
  /** Picks exactly these tiles (a group header's button), or clears them if they already are. */
  selectTiles(ids: string[]): void;
  clearSelection(): void;
  /** Opens the tiles (or the window) the notice is about again, where they were. */
  undoClosed(): Promise<void>;
  dismissClosedNotice(): void;
  runStartup(id: string): Promise<void>;
  runRemoteStep(id: string): Promise<void>;
  /** The remote `swarmz attach` reported it is bridging this tile (`isNew`: it started the
   * session rather than rejoining one). */
  remoteAttached(id: string, isNew: boolean): Promise<void>;
  cancelConnecting(id: string): void;
  chooseRemoteDir(id: string, path: string): Promise<void>;
  skipStartup(id: string): void;
  dismissPersistError(): void;
  refreshTailscale(): Promise<void>;
  updateMachine(name: string, patch: { alias?: string | null; user?: string | null; color?: string | null; icon?: string | null; theme?: string | null }): Promise<string | null>;
  applyAgentEvent(payload: AgentEventPayload): void;
  setWindowFocused(focused: boolean): void;
  flashCopied(id: string): void;
  flashPasted(id: string): void;
  setTerminalCwd(id: string, cwd: string, source: "poll" | "osc7" | "hook" | "remote"): Promise<void>;
  selectSession(id: string, sessionId: string, opts: { connect: boolean }): Promise<void>;
  watchResume(id: string, sessionId: string): void;
  noteResumeFailure(id: string, sessionId: string): void;
  installAgentHooks(): Promise<void>;
  ensureAgentWatchers(): Promise<void>;
  agentWatchEnded(payload: { host: string | null; gen: number }): Promise<void>;
  /** Asks the endpoint once; never rejects. `manual` makes an empty answer worth showing. */
  checkForUpdates(opts?: { manual?: boolean }): Promise<void>;
  /** Downloads, installs and relaunches the offered update; never rejects. */
  installUpdate(): Promise<void>;
  dismissUpdate(): void;
}

/**
 * NOT safe to use as a zustand hook selector: it allocates a fresh `{ name, cfg }` object on
 * every call, and zustand 5 has no default equality check, so `useStore((s) => machineFor(s, id))`
 * would make the component re-render on every store update forever. Call it inside a plain
 * function (a store action, a non-hook selector like `terminalColor`, or a test), or — in a
 * component — select the primitives it would have read (e.g. `s.settings[id]?.ssh?.machine`)
 * directly instead.
 */
export function machineFor(s: WorkbenchState, id: string): { name: string; cfg: MachineConfig | undefined } | null {
  const name = s.settings[id]?.ssh?.machine;
  return name ? { name, cfg: s.machines[name] } : null;
}

/**
 * Safe to use as a hook selector: unlike `machineFor`, this returns a primitive (a string or
 * null), so zustand's default `Object.is` comparison is enough to avoid rerendering when the
 * value hasn't changed — no `useShallow` needed. Any new selector derived from `machineFor`
 * should follow the same rule: return a primitive, not the object.
 */
export function terminalColor(s: WorkbenchState, id: string): string | null {
  return machineFor(s, id)?.cfg?.color ?? null;
}

/** The Mac a tile's shell runs on: its ssh machine, else this one. */
export function tileMachine(s: Pick<WorkbenchState, "settings" | "selfMachine">, id: string): string | null {
  return s.settings[id]?.ssh?.machine ?? s.selfMachine;
}

/** Every Mac this app knows, for the themes chosen by place (machine themes spec). */
export function knownMacs(s: Pick<WorkbenchState, "selfMachine" | "tailscale" | "machines">): string[] {
  const peers = (s.tailscale?.peers ?? []).filter((p) => p.os === "macOS").map((p) => p.name);
  return [...new Set([...(s.selfMachine ? [s.selfMachine] : []), ...peers, ...Object.keys(s.machines)])];
}

/** The theme id of Mac `name` (a primitive, safe as a selector). */
export function machineThemeId(s: Pick<WorkbenchState, "selfMachine" | "tailscale" | "machines">, name: string | null): string {
  return themeFor(name, name ? s.machines[name]?.theme : null, knownMacs(s)).id;
}

/** Mac `name`'s colour: picked, else its theme's accent (a primitive, safe as a selector). */
export function machineColor(s: Pick<WorkbenchState, "selfMachine" | "tailscale" | "machines">, name: string): string {
  return machineAccent(name, s.machines[name], knownMacs(s));
}

/** The theme id a tile's pane shows: its Mac's (a primitive, safe as a selector). */
export function tileThemeId(s: WorkbenchState, id: string): string {
  return machineThemeId(s, tileMachine(s, id));
}

/** A tile's full xterm theme and pane background: its Mac's theme, or plain tinted by the Mac's colour. */
export function tileTheme(s: WorkbenchState, id: string): MachineTheme["theme"] {
  const t = themeById(tileThemeId(s, id));
  if (t.id !== PLAIN.id) return t.theme;
  return { ...t.theme, background: tintBackground(PLAIN_BG, terminalColor(s, id)) };
}

/** Loaded from workspace.json: parses and validates each machine entry, dropping any whose key
 * is not a valid host or whose string fields fail validation, and caps the result at
 * `MACHINES_MAX` entries (newest `lastUsed` first). */
function sanitizeMachines(input: unknown): { machines: Machines; dropped: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { machines: {}, dropped: 0 };
  const out: Machines = {};
  let dropped = 0;
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (validateHost(name) !== null) {
      dropped += 1;
      continue;
    }
    if (typeof value !== "object" || value === null) {
      dropped += 1;
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.lastUsed !== "string") {
      dropped += 1;
      continue;
    }
    const strOrNullOk = (k: string) => v[k] === undefined || v[k] === null || typeof v[k] === "string";
    if (!strOrNullOk("alias") || !strOrNullOk("user") || !strOrNullOk("cwd") || !strOrNullOk("icon")) {
      dropped += 1;
      continue;
    }
    if (typeof v.icon === "string" && v.icon.trim() !== "" && validateIcon(v.icon) !== null) {
      dropped += 1;
      continue;
    }
    if (!isMachineColor(v.color as string | null | undefined)) {
      dropped += 1;
      continue;
    }
    // An unknown theme (a newer app's) is left out rather than dropping the Mac.
    const theme = isThemeId(v.theme) ? { theme: v.theme } : v.theme === null ? { theme: null } : {};
    if (typeof v.cwd === "string" && !isSafeRemotePath(v.cwd)) {
      dropped += 1;
      continue;
    }
    if (typeof v.user === "string" && validateUser(v.user) !== null) {
      dropped += 1;
      continue;
    }
    out[name] = {
      lastUsed: v.lastUsed,
      ...(v.alias !== undefined ? { alias: v.alias as string | null } : {}),
      ...(v.user !== undefined ? { user: v.user as string | null } : {}),
      ...(v.cwd !== undefined ? { cwd: v.cwd as string | null } : {}),
      ...(v.color !== undefined ? { color: v.color as string | null } : {}),
      ...theme,
    };
  }
  // The cap trims excess entries (oldest first), which is routine housekeeping rather than an
  // invalid-data condition, so it is not counted in `dropped` (that count drives the "invalid
  // and were dropped" persistError note).
  const keys = Object.keys(out).sort((a, b) => (out[b].lastUsed > out[a].lastUsed ? 1 : out[b].lastUsed < out[a].lastUsed ? -1 : 0));
  const capped: Machines = {};
  for (const k of keys.slice(0, MACHINES_MAX)) capped[k] = out[k];
  return { machines: capped, dropped };
}

/** Every window's tree (windows and layouts spec §4): the main window's and the others'. */
export function layoutsOf(s: Pick<WorkbenchState, "layout" | "windows">): Layouts {
  const out: Layouts = { [MAIN]: s.layout };
  for (const [label, w] of Object.entries(s.windows)) out[label] = w.layout;
  return out;
}

/**
 * The store's fields for a new set of trees: the main window's `layout`, the other windows
 * (a window whose tree emptied is dropped, and the window module closes it), each window's focus
 * kept when its group survives, zoom dropped with its group, and focus moved to tile `focus`
 * when given. The main window's focus falls back to its first group.
 */
function commit(s: WorkbenchState, ls: Layouts, focus: string | null = null): Partial<WorkbenchState> {
  const layout = ls[MAIN] ?? null;
  const windows: Record<string, WindowState> = {};
  for (const [label, l] of Object.entries(ls)) {
    if (label === MAIN || !l) continue;
    const prev = s.windows[label]?.focusedGroupId ?? null;
    windows[label] = { layout: l, focusedGroupId: prev && findGroup(l, prev) ? prev : (allGroups(l)[0]?.id ?? null) };
  }
  const zoomed: Record<string, string> = {};
  for (const [label, g] of Object.entries(s.zoomed)) if (findGroup(ls[label] ?? null, g)) zoomed[label] = g;
  const first = allGroups(layout)[0];
  let main: { focusedGroupId: string | null; focusedTerminalId: string | null } =
    s.focusedGroupId && findGroup(layout, s.focusedGroupId)
      ? { focusedGroupId: s.focusedGroupId, focusedTerminalId: findGroup(layout, s.focusedGroupId)?.active || null }
      : { focusedGroupId: first?.id ?? null, focusedTerminalId: first?.active || null };
  if (focus) {
    const label = windowOfTile(ls, focus);
    const g = label ? findGroupOf(ls[label], focus) : null;
    if (label === MAIN && g) main = { focusedGroupId: g.id, focusedTerminalId: focus };
    else if (label && g && windows[label]) windows[label] = { ...windows[label], focusedGroupId: g.id };
  }
  return { layout, windows, zoomed, ...main };
}

/**
 * The trees with a new tile placed: in the placement's group (whichever window holds it), as a
 * tab or beside it, else as a tab of the main window's focused group.
 */
function placeNew(s: WorkbenchState, id: string, placement?: Placement): Layouts {
  const ls = layoutsOf(s);
  const label = (placement && windowOfGroup(ls, placement.groupId)) || MAIN;
  const groupId = placement?.groupId ?? s.focusedGroupId;
  let l = addTab(ls[label], id, groupId);
  if (placement?.kind === "split") l = splitWith(l, placement.groupId, id, placement.side);
  return { ...ls, [label]: l };
}

/** The tile the user is looking at: the showing tab of the focused group of the focused window. */
export function seenTile(s: Pick<WorkbenchState, "focusedWindow" | "focusedTerminalId" | "windows">): string | null {
  if (s.focusedWindow === MAIN) return s.focusedTerminalId;
  const w = s.windows[s.focusedWindow];
  if (!w?.focusedGroupId) return null;
  return findGroup(w.layout, w.focusedGroupId)?.active || null;
}

/** Where tile `id` is shown, for Undo (spec §3). */
function placeOf(s: WorkbenchState, id: string): { id: string; groupId: string | null } {
  const ls = layoutsOf(s);
  const label = windowOfTile(ls, id);
  return { id, groupId: label ? (findGroupOf(ls[label], id)?.id ?? null) : null };
}

/** Boards being fetched, so a pane mounting twice asks once. */
const boardLoading = new Set<string>();

/** How long an identify label stays (identify spec). */
export const IDENTIFY_MS = 3500;
let identifyTimer: ReturnType<typeof setTimeout> | null = null;
function showIdentify(v: NonNullable<WorkbenchState["identify"]>): void {
  useStore.setState({ identify: v });
  if (identifyTimer) clearTimeout(identifyTimer);
  identifyTimer = setTimeout(() => {
    identifyTimer = null;
    if (useStore.getState().identify?.at === v.at) useStore.setState({ identify: null });
  }, IDENTIFY_MS);
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(n: ClosedNotice): void {
  useStore.setState({ closedNotice: n });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (useStore.getState().closedNotice?.at === n.at) useStore.setState({ closedNotice: null });
  }, CLOSED_NOTICE_MS);
}

/** The last tile a drop placed, so the drag's end does not place it a second time (spec §4). */
let lastPlaced: { id: string; at: number } | null = null;
export const DROP_SETTLE_MS = 1500;

/** This Mac's saved trees while the first load opens their tiles (see `loadWorkspaceOnce`). */
let initialLayouts: Layouts | null = null;

/** Whether this Mac's trees are loaded, so changes to them are saved (never in another window's mirror). */
let layoutsLoaded = false;

/** Defs with any repeated id dropped, keeping the first mention. */
function dedupeById(defs: TerminalDef[]): TerminalDef[] {
  const seen = new Set<string>();
  return defs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

function omit<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const out = { ...rec };
  delete out[id];
  return out;
}

async function spawnDef(def: TerminalDef): Promise<{ info: TerminalInfo; note: string | null }> {
  await beforeSpawn.hook(def.id);
  const dims = beforeSpawn.size(def.id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  try {
    return { info: await ipc.createTerminal(def.id, def.cwd, dims.cols, dims.rows, def.name), note: null };
  } catch (e) {
    const msg = typeof e === "string" ? e : String(e);
    if (!msg.includes("is not a directory")) throw e;
    const home = await homeDir();
    const info = await ipc.createTerminal(def.id, home, dims.cols, dims.rows, def.name);
    return { info, note: `${def.cwd} no longer exists; opened in ${home}` };
  }
}

type SetState = (partial: Partial<WorkbenchState> | ((s: WorkbenchState) => Partial<WorkbenchState>)) => void;

let loadStarted = false;

export function __resetLoadGuard() {
  loadStarted = false;
  layoutsLoaded = false;
  lastPlaced = null;
  initialLayouts = null;
  launchReplay = [];
}

/**
 * For each terminal the registry could not name as asked (it deduplicates, so a def called
 * "swarmz" opened next to a live "swarmz" becomes "swarmz-2"), the name the workspace file asked
 * for. The shared file keeps the requested name and the suffix stays machine-local — otherwise
 * two Macs that each have to deduplicate the other's def would see a name difference in the
 * post-adoption comparison, write their own spelling back, and rewrite each other forever.
 * A rename by the user drops the entry: that name is a real change, not a local workaround.
 */
const requestedNames = new Map<string, string>();

/** What each open terminal is called, as the shared file would spell it (see `requestedNames`). */
function effectiveNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, t] of Object.entries(useStore.getState().terminals)) out.set(id, requestedNames.get(id) ?? t.name);
  return out;
}

/** The store's terminals as the workspace file should spell them (see `requestedNames`). */
function persistedTerminals(terminals: Record<string, TerminalInfo>): Record<string, TerminalInfo> {
  if (requestedNames.size === 0) return terminals;
  const out: Record<string, TerminalInfo> = {};
  for (const [id, t] of Object.entries(terminals)) {
    const requested = requestedNames.get(id);
    out[id] = requested !== undefined && requested !== t.name ? { ...t, name: requested } : t;
  }
  return out;
}

const UNSAFE_SESSION_NOTE = "claude session id in workspace.json was invalid; a new session was created";
const INVALID_HOST_NOTE = "ssh host in workspace.json is invalid and was ignored";
const UNSAFE_CWD_NOTE = "ssh remote directory in workspace.json contained unsupported characters and was ignored";

function machineDropNote(dropped: number): string {
  return `${dropped} machine ${dropped === 1 ? "entry" : "entries"} in workspace.json were invalid and were dropped`;
}

const KNOWN_DEF_KEYS = new Set(["id", "name", "cwd", "ssh", "claude", "command", "origin", "sessions", "card"]);

/** Fields on a loaded def that this app version does not know about; kept so they round-trip on save. */
function extraFromDef(def: TerminalDef): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (!KNOWN_DEF_KEYS.has(k)) extra[k] = v;
  }
  return extra;
}

/** The settings a def should open with: `openingFor` resolves origin/foreign/ssh, plus this
 * app version's unknown-field passthrough. Used for both newly-spawned defs and the bulk
 * settings pass over already-open terminals (so an already-open foreign local keeps its
 * derived ssh when the workspace is reconciled). */
function settingsFromDef(
  d: TerminalDef,
  self: string | null,
  machines: Machines,
  user: string,
  known: Set<string>,
): { settings: TerminalSettings; note: string | null } {
  const opening = openingFor(d, self, machines, user, known);
  // `origin` is pulled out and re-added last (after `extra`) rather than left wherever
  // `openingFor` placed it, so this always produces the same key order as `EMPTY_SETTINGS`-based
  // settings (ssh, claude, command, ..., extra, origin). Nothing depends on that order any more
  // (openDefs' bulk pass compares a key-ordered `startupKey` projection, not the whole object),
  // but keeping it makes the two shapes easy to diff by eye.
  const { origin, ...rest } = opening.settings;
  return { settings: { ...rest, sessions: sanitizeSessions(d.sessions), extra: extraFromDef(d), origin: origin ?? self ?? null }, note: opening.note };
}

/** Machine names this app can actually reach: tailnet peers plus every machine recorded in
 * workspace.json. Used to decide whether a def's `origin` names a real machine (see
 * `openingFor`). */
function knownMachineNames(): Set<string> {
  const s = useStore.getState();
  return new Set([...(s.tailscale?.peers ?? []).map((p) => p.name), ...Object.keys(s.machines)]);
}

function regenerateIfUnsafe(def: TerminalDef): { def: TerminalDef; note: string | null } {
  let out = def;
  let note: string | null = null;
  if (out.claude?.enabled && !isSafeSessionId(out.claude.sessionId)) {
    out = { ...out, claude: { ...out.claude, sessionId: crypto.randomUUID(), started: false } };
    note = UNSAFE_SESSION_NOTE;
  }
  // Keep the ssh settings as loaded (so the user can fix them in the panel); just flag them.
  if (out.ssh?.host && validateHost(out.ssh.host) !== null) {
    note = note ?? INVALID_HOST_NOTE;
  }
  if (out.ssh?.cwd && !isSafeRemotePath(out.ssh.cwd)) {
    out = { ...out, ssh: { ...out.ssh, cwd: null } };
    note = note ?? UNSAFE_CWD_NOTE;
  }
  return { def: out, note };
}

/** The parts of a tile's settings that decide what Connect would type. `sessions` changes on
 * every hook event (and `extra`/`origin` are pure passthrough), so only these fields may re-arm
 * an already-open tile's startup bar when the workspace is reconciled. */
function startupKey(x: TerminalSettings | undefined): string {
  return JSON.stringify({ ssh: x?.ssh ?? null, claude: x?.claude ?? null, command: x?.command ?? null, origin: x?.origin ?? null, foreign: x?.foreign ?? null });
}

async function openDefs(
  defs: TerminalDef[],
  set: SetState,
  allDefs: TerminalDef[] = defs,
): Promise<{ anyFailed: boolean }> {
  const preOpenIds = new Set(useStore.getState().order);
  const normalized = new Map(allDefs.map((d) => [d.id, regenerateIfUnsafe(d)]));
  const { selfMachine, machines, tailscale } = useStore.getState();
  const defaultUser = tailscale?.user ?? "";
  const known = knownMachineNames();
  let failedCount = 0;
  const existedIds = new Set<string>();
  for (const def of defs) {
    const { def: regenerated, note: unsafeNote } = normalized.get(def.id) ?? regenerateIfUnsafe(def);
    try {
      const opening = openingFor(regenerated, selfMachine, machines, defaultUser, known);
      const { info, note } = await spawnDef({ ...regenerated, cwd: opening.cwd ?? (await homeDir()) });
      if (info.existed) existedIds.add(info.id);
      noteJoined(info);
      // The registry renamed it to avoid a clash: remember what the file asked for, so this
      // machine's suffix never travels back into the shared workspace.
      if (info.name !== regenerated.name) requestedNames.set(info.id, regenerated.name);
      else requestedNames.delete(info.id);
      const startupNote = unsafeNote ?? opening.note ?? note;
      const { settings } = settingsFromDef(regenerated, selfMachine, machines, defaultUser, known);
      set((s) => ({
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        settings: { ...s.settings, [info.id]: settings },
        startupNotes: startupNote ? { ...s.startupNotes, [info.id]: startupNote } : s.startupNotes,
        lastCwd: info.cwd,
      }));
      // The session is recorded now, so the pane's size can no longer be dropped.
      if (info.existed) beforeSpawn.claimSize(info.id);
    } catch (e) {
      failedCount += 1;
      set({ persistError: `could not open "${def.name}": ${typeof e === "string" ? e : String(e)}` });
    }
  }
  set((s) => {
    try {
      const settings = { ...s.settings };
      let startupNotes = s.startupNotes;
      for (const [id, { def: d, note }] of normalized) {
        if (s.terminals[id]) {
          const derived = settingsFromDef(d, selfMachine, machines, defaultUser, known);
          settings[id] = derived.settings;
          const n = note ?? derived.note;
          if (n) startupNotes = { ...startupNotes, [id]: n };
        }
      }
      // The trees are this Mac's (windows and layouts spec §2): tiles gone from the workspace
      // leave them, and tiles new to it are not opened here until the user opens them.
      const layouts = dedupeLayouts(pruneLayouts(initialLayouts ?? layoutsOf(s), s.order));
      initialLayouts = null;
      const startupPending: Record<string, boolean> = { ...s.startupPending };
      for (const id of s.order) {
        const wasOpenBefore = preOpenIds.has(id);
        const changed = !wasOpenBefore || startupKey(settings[id]) !== startupKey(s.settings[id]);
        if (changed) startupPending[id] = !existedIds.has(id) && startupLine(settings[id] ?? EMPTY_SETTINGS) !== null;
      }
      const keep = s.focusedTerminalId && findGroupOf(layouts[MAIN], s.focusedTerminalId) ? s.focusedTerminalId : null;
      const persistError =
        failedCount > 0 ? `${failedCount} terminal(s) could not be opened; saving is paused until a successful Reload` : s.persistError;
      return {
        settings,
        startupNotes,
        startupPending,
        persistenceReady: failedCount === 0,
        persistError,
        ...commit(s, layouts, keep),
      };
    } catch (e) {
      return {
        persistenceReady: false,
        persistError: `could not reconcile workspace: ${typeof e === "string" ? e : String(e)}`,
        ...commit(s, pruneLayouts(layoutsOf(s), s.order)),
      };
    }
  });
  for (const id of existedIds) {
    const host = useStore.getState().settings[id]?.ssh?.host?.trim();
    if (!host) continue;
    void tileLive(id, host).then((live) => {
      const st = useStore.getState();
      if (!st.terminals[id]) return;
      if (live) {
        set((st) => ({ sshConnected: { ...st.sshConnected, [id]: true }, startupPending: { ...st.startupPending, [id]: false } }));
        return;
      }
      // The session survived but its ssh did not (the network dropped, the other Mac slept):
      // the shell sits at a local prompt, so offer Connect — unless a Run already started.
      if (startupInFlight.has(id) || st.sshConnecting[id] || st.sshConnected[id]) return;
      if (startupLine(st.settings[id] ?? EMPTY_SETTINGS) === null) return;
      set((st) => ({ startupPending: { ...st.startupPending, [id]: true } }));
    });
  }
  return { anyFailed: failedCount > 0 };
}

async function safeSshCheck(host: string): Promise<boolean> {
  try {
    return await ipc.sshCheck(host);
  } catch {
    return false;
  }
}

/** The tile's foreground state, or null when the holder could not be asked (never a guess: the
 * watchdog must not call a connection dead because one round trip failed). */
async function foregroundBusyOrNull(id: string): Promise<boolean | null> {
  try {
    return await ipc.terminalForegroundBusy(id);
  } catch {
    return null;
  }
}

async function safeForegroundBusy(id: string): Promise<boolean> {
  try {
    return await ipc.terminalForegroundBusy(id);
  } catch {
    return false;
  }
}

/**
 * Whether the ssh connection this tile started is actually live: the host's shared
 * multiplexed master must be up (`ssh -O check`) AND this tile's own pty must currently have a
 * foreground process other than the shell (i.e. an `ssh` this tile itself is running). The
 * first check alone is host-scoped and can be true from an unrelated master that outlived a
 * connection attempt this tile's ssh already gave up on — typing the remote step in that case
 * would land in the tile's local shell instead.
 */
async function tileLive(id: string, host: string): Promise<boolean> {
  return (await safeSshCheck(host)) && (await safeForegroundBusy(id));
}

/** Whether this ssh tile connects by attaching to a session holder on its host. Never when this
 * Mac's own name is unknown or the host is this Mac: the tile's id names its own local holder
 * there, and attaching it would run the session inside itself. */
function attachModeFor(id: string): boolean {
  const s = useStore.getState();
  const ssh = s.settings[id]?.ssh;
  const host = ssh?.host?.trim();
  if (!host || s.toolReady[host] !== true) return false;
  const self = s.selfMachine?.trim().toLowerCase();
  if (!self) return false;
  return ssh?.machine?.trim().toLowerCase() !== self && hostLabel(host).toLowerCase() !== self;
}

/** In-flight tool checks by host: a check can upload the tool and take tens of seconds, and every
 * tile on the host waits for the same answer. */
const toolChecks = new Map<string, Promise<void>>();

/** Asks `host` whether its swarmz tool is usable (installing it when needed) and records the
 * answer. Only a definite "no" is remembered; a failed check (host unreachable, password login
 * with no shared socket yet) leaves the host unknown, so this Run uses plain ssh and the next one
 * asks again. */
function checkToolReady(host: string): Promise<void> {
  const running = toolChecks.get(host);
  if (running) return running;
  const check = (async () => {
    let ok: boolean;
    try {
      ok = (await ipc.toolRemoteReady(host)) === true;
    } catch {
      return;
    }
    useStore.setState((st) => ({ toolReady: { ...st.toolReady, [host]: ok } }));
  })().finally(() => toolChecks.delete(host));
  toolChecks.set(host, check);
  return check;
}

/** Tiles inside `runStartup` right now: its first await (the tool check) can be long, and a second
 * Connect or the auto-run must not type a second line into what the first one started. */
const startupInFlight = new Set<string>();

/** Tiles whose attach line was typed and whose marker has not arrived yet: only these may type
 * the remote step for a new session, however late the marker comes. */
const attachPending = new Set<string>();

/** Attached tiles whose user picked another Claude session: applied when the session is next seen
 * (a reattach, or Connect on a live tile) if the session's shell is idle. */
const pendingSwitch = new Set<string>();

/** Tiles typing the remote step for a session their attach just started: until it is typed (and
 * Claude has the tile), a picked session must not be typed on top of it. */
const newSessionStep = new Set<string>();

/** Ssh tiles whose remote `swarmz attach` has reported in this run: they have a session holder on
 * their host, which closing the tile must end too. */
const attachedTiles = new Set<string>();

function forgetAttach(id: string) {
  attachPending.delete(id);
  pendingSwitch.delete(id);
}

function machineOf(id: string, host: string): string {
  const s = useStore.getState();
  const machine = s.settings[id]?.ssh?.machine;
  return machine ? machineLabel(machine, s.machines[machine]) : hostLabel(host);
}

export const SWITCH_BUSY_NOTE = "Claude is still running in the session on ";

/** Types the picked session's remote step into an attached tile when its session's shell is idle,
 * or explains why not. */
async function applyPendingSwitch(id: string): Promise<void> {
  const host = useStore.getState().settings[id]?.ssh?.host?.trim();
  if (!host || !pendingSwitch.has(id) || newSessionStep.has(id)) return;
  let info: Awaited<ReturnType<typeof ipc.remoteTileInfo>> | null = null;
  let error: string | null = null;
  try {
    info = await ipc.remoteTileInfo(host, id);
  } catch (e) {
    error = typeof e === "string" ? e : String(e);
  }
  if (!pendingSwitch.has(id) || newSessionStep.has(id) || !useStore.getState().terminals[id]) return;
  pendingSwitch.delete(id);
  if (info?.running && info.foregroundBusy === false) {
    await useStore.getState().runRemoteStep(id);
    return;
  }
  const machine = machineOf(id, host);
  const note = error !== null ? `could not check the session on ${machine}: ${error}` : `${SWITCH_BUSY_NOTE}${machine}; exit it to switch`;
  useStore.setState((st) => ({ startupNotes: { ...st.startupNotes, [id]: note } }));
}

/** What a poller waits for: the plain ssh line's session, the attach line's marker, or the
 * master that the master-only login line leaves behind. */
type PollMode = "connect" | "attach" | "master";

const pollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; started: number; busy: boolean; staleForeground: number; mode: PollMode }
>();

/** Tiles between their master coming up and their connect line being typed (the tool check can
 * take a while): the token goes when the step is cancelled, so its end types nothing. */
const masterSteps = new Map<string, object>();

function stopPolling(id: string) {
  masterSteps.delete(id);
  const p = pollers.get(id);
  if (p) {
    clearInterval(p.timer);
    pollers.delete(id);
  }
}

export function __stopAllPolling() {
  for (const id of Array.from(pollers.keys())) stopPolling(id);
  masterSteps.clear();
  stopWatchdog();
}

/** Whether the watchdog may judge this tile now: a connected, running ssh tile that no connect
 * step owns. */
function watchable(id: string): boolean {
  const s = useStore.getState();
  return (
    s.sshConnected[id] === true &&
    s.terminals[id]?.exited === null &&
    !!s.settings[id]?.ssh?.host?.trim() &&
    !s.sshConnecting[id] &&
    !startupInFlight.has(id) &&
    !pollers.has(id) &&
    !masterSteps.has(id)
  );
}

/**
 * The tile's ssh ended (the network dropped, the other Mac slept, the user typed exit): the local
 * shell has the terminal back. Offers Connect again and turns off whatever the remote program
 * left on in the pane, so the shell does not receive mouse reports. An attached tile's session
 * is still running on its host, and Connect rejoins it. A picked session stays pending for that
 * rejoin.
 */
function markDisconnected(id: string, opts: { resetModes: boolean }) {
  const s = useStore.getState();
  const host = s.settings[id]?.ssh?.host?.trim();
  if (!s.terminals[id] || !host) return;
  attachPending.delete(id);
  if (opts.resetModes) beforeSpawn.resetModes(id);
  const machine = machineOf(id, host);
  const note = attachedTiles.has(id)
    ? `Connection to ${machine} ended; the session is still running there, and Reconnect rejoins it`
    : `Connection to ${machine} ended`;
  useStore.setState((st) => ({
    sshConnected: omit(st.sshConnected, id),
    sshDropped: { ...st.sshDropped, [id]: true },
    startupPending: { ...st.startupPending, [id]: startupLine(st.settings[id] ?? EMPTY_SETTINGS) !== null },
    startupNotes: { ...st.startupNotes, [id]: note },
  }));
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
/** Tiles with a watchdog check in flight (one per tile). */
const watchdogChecks = new Set<string>();

function stopWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  watchdogChecks.clear();
}

function watchdogTick() {
  const s = useStore.getState();
  for (const id of s.order) {
    if (watchdogChecks.has(id) || !watchable(id)) continue;
    watchdogChecks.add(id);
    void foregroundBusyOrNull(id)
      .then((busy) => {
        // Only a definite answer counts, and only if nothing started connecting meanwhile.
        if (busy === false && watchable(id)) markDisconnected(id, { resetModes: true });
      })
      .finally(() => watchdogChecks.delete(id));
  }
}

/** Runs the watchdog while any ssh tile is connected. */
function syncWatchdog(s: WorkbenchState) {
  const wanted = s.order.some((id) => s.sshConnected[id] && s.terminals[id]?.exited === null && !!s.settings[id]?.ssh?.host?.trim());
  if (wanted && !watchdogTimer) watchdogTimer = setInterval(watchdogTick, SSH_WATCHDOG_MS);
  else if (!wanted && watchdogTimer) stopWatchdog();
}

export function __resetAttachState() {
  toolChecks.clear();
  startupInFlight.clear();
  newSessionStep.clear();
  attachPending.clear();
  pendingSwitch.clear();
  attachedTiles.clear();
  joinedTiles.clear();
}

function startPolling(id: string, host: string, mode: PollMode) {
  stopPolling(id);
  useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: true }, sshConnected: omit(s.sshConnected, id) }));
  const entry = { timer: setInterval(() => void tick(), SSH_POLL_MS), started: Date.now(), busy: false, staleForeground: 0, mode };
  pollers.set(id, entry);

  async function tick() {
    if (entry.busy || !pollers.has(id)) return;
    const st = useStore.getState();
    const t = st.terminals[id];
    if (!t || t.exited !== null) {
      stopPolling(id);
      useStore.setState((s) => ({ sshConnecting: omit(s.sshConnecting, id) }));
      return;
    }
    if (Date.now() - entry.started > SSH_POLL_TIMEOUT_MS) {
      stopPolling(id);
      useStore.setState((s) => ({
        sshConnecting: omit(s.sshConnecting, id),
        startupPending: { ...s.startupPending, [id]: true },
        startupNotes: { ...s.startupNotes, [id]: "connection not detected; click Run to try again" },
      }));
      return;
    }
    entry.busy = true;
    const sshOk = await safeSshCheck(host);
    if (entry.mode === "master") {
      await masterTick(sshOk);
      entry.busy = false;
      return;
    }
    if (!sshOk) {
      entry.busy = false;
      entry.staleForeground = 0;
      return;
    }
    if (!pollers.has(id)) {
      entry.busy = false;
      return;
    }
    const foregroundBusy = await safeForegroundBusy(id);
    entry.busy = false;
    if (!pollers.has(id)) return;
    if (!foregroundBusy) {
      // The host-wide master is up, but this tile's own pty has no foreground process (its
      // ssh already exited, or never started one) — on the second consecutive miss, give up
      // rather than risk typing the remote step into the tile's local shell.
      entry.staleForeground += 1;
      if (entry.staleForeground >= 2) {
        stopPolling(id);
        if (entry.mode === "attach") {
          // The master is up but the attach is gone: most likely the remote tool refused or
          // failed (its error is in the terminal). Forget the host's answer so the next Run
          // checks the tool again instead of retrying attach mode forever.
          attachPending.delete(id);
          pendingSwitch.delete(id);
          useStore.setState((s) => ({
            sshConnecting: omit(s.sshConnecting, id),
            toolReady: omit(s.toolReady, host),
            startupPending: { ...s.startupPending, [id]: true },
            startupNotes: { ...s.startupNotes, [id]: `the swarmz session on ${machineOf(id, host)} could not start; see the terminal and click Run` },
          }));
          return;
        }
        useStore.setState((s) => ({
          sshConnecting: omit(s.sshConnecting, id),
          startupPending: { ...s.startupPending, [id]: true },
          startupNotes: { ...s.startupNotes, [id]: "ssh exited before connecting; click Run to try again" },
        }));
      }
      return;
    }
    entry.staleForeground = 0;
    // In attach mode the remote `swarmz attach` marker (`remoteAttached`) marks the tile connected
    // and decides whether to type the remote step, and it stops this poller. Until then keep
    // polling without typing, so a tool that fails (ssh exits) or never answers still ends in the
    // exit and timeout notes above instead of a tile stuck connecting.
    if (entry.mode === "attach") return;
    stopPolling(id);
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true }, sshConnecting: omit(s.sshConnecting, id) }));
    await new Promise((r) => setTimeout(r, SSH_SETTLE_MS));
    await useStore.getState().runRemoteStep(id);
  }

  /** The master-only login: `ssh -fN` goes to the background once logged in, so the shell is
   * idle both before a failed login and after a good one; only the master tells them apart. */
  async function masterTick(sshOk: boolean) {
    if (!pollers.has(id)) return;
    if (sshOk) {
      stopPolling(id);
      await connectAfterMaster(id, host);
      return;
    }
    const busy = await foregroundBusyOrNull(id);
    if (!pollers.has(id)) return;
    if (busy !== false) {
      // Still logging in (or the holder did not answer this time).
      entry.staleForeground = 0;
      return;
    }
    // No master and the shell has the terminal back, twice in a row: the login failed (wrong
    // password, host unreachable); its error is in the terminal.
    entry.staleForeground += 1;
    if (entry.staleForeground < 2) return;
    stopPolling(id);
    useStore.setState((s) => ({
      sshConnecting: omit(s.sshConnecting, id),
      startupPending: { ...s.startupPending, [id]: true },
      startupNotes: { ...s.startupNotes, [id]: `could not log in to ${machineOf(id, host)}; see the terminal and click Connect` },
    }));
  }
}

/** The master is up: ask the host's tool (its BatchMode ssh can use the master now), then type
 * the connect line, which reuses the master and so does not prompt either. The tile stays
 * connecting throughout, which also keeps a second Connect out. */
async function connectAfterMaster(id: string, host: string): Promise<void> {
  const token = {};
  masterSteps.set(id, token);
  const owned = !startupInFlight.has(id);
  startupInFlight.add(id);
  try {
    await checkToolReady(host);
    if (masterSteps.get(id) !== token || !useStore.getState().terminals[id]) return;
    masterSteps.delete(id);
    await typeConnectLine(id);
    // Typing started a poller (connecting again), or found the tile already live (connected).
    if (!pollers.has(id)) useStore.setState((s) => ({ sshConnecting: omit(s.sshConnecting, id) }));
  } finally {
    if (masterSteps.get(id) === token) {
      masterSteps.delete(id);
      useStore.setState((s) => ({ sshConnecting: omit(s.sshConnecting, id) }));
    }
    if (owned) startupInFlight.delete(id);
  }
}

async function runStartupNow(id: string): Promise<void> {
  const s = useStore.getState();
  // A new Run supersedes an attach that never reported back.
  attachPending.delete(id);
  const settings = s.settings[id] ?? EMPTY_SETTINGS;
  if (startupSteps(settings, id).length === 0) return;
  const host = startupIsSsh(settings) ? validHost(settings) : null;
  if (host && useStore.getState().toolReady[host] === undefined) {
    // Whether to attach depends on the host's tool, and asking it needs a login. With no master
    // yet (a password host cannot log in in BatchMode), log in first, in the tile, with a
    // master-only line; the poller then asks the tool and types the connect line.
    if (!(await safeSshCheck(host))) {
      if (!useStore.getState().terminals[id]) return;
      await ipc.writeTerminal(id, sshMasterLine(host) + "\r");
      useStore.setState((st) => {
        if (!st.terminals[id]) return {};
        return { startupPending: { ...st.startupPending, [id]: false }, startupNotes: omit(st.startupNotes, id) };
      });
      startPolling(id, host, "master");
      return;
    }
    await checkToolReady(host);
    if (!useStore.getState().terminals[id]) return;
  }
  await typeConnectLine(id);
}

/** Types the tile's first startup line (for an ssh tile: the attach line when its host's tool is
 * ready, else plain ssh) unless its ssh is already live, and starts watching the connection. */
async function typeConnectLine(id: string): Promise<void> {
  const cur = useStore.getState();
  const settings = cur.settings[id] ?? EMPTY_SETTINGS;
  const isSsh = startupIsSsh(settings);
  const host = isSsh ? validHost(settings) : null;
  const attach = isSsh && attachModeFor(id);
  const steps = startupSteps(settings, id, { attach, name: cur.terminals[id]?.name });
  if (steps.length === 0) return;
  if (host && (await tileLive(id, host))) {
    // This tile's ssh is already live (e.g. Run was clicked again right after connecting,
    // before the bar updated): don't retype the ssh line, just proceed to the remote step —
    // unless the tile is attached, where the session may already be running Claude: then only a
    // session the user picked is switched to, and only if the session's shell is idle.
    if (!useStore.getState().terminals[id]) return;
    useStore.setState((st) => ({
      sshConnected: { ...st.sshConnected, [id]: true },
      sshConnecting: omit(st.sshConnecting, id),
      startupPending: { ...st.startupPending, [id]: false },
      startupNotes: omit(st.startupNotes, id),
    }));
    if (!attach) await useStore.getState().runRemoteStep(id);
    else await applyPendingSwitch(id);
    return;
  }
  await ipc.writeTerminal(id, steps[0].line + "\r");
  if (attach) attachPending.add(id);
  const resumed0 = resumedSessionIn(steps[0].line);
  if (resumed0) useStore.getState().watchResume(id, resumed0);
  useStore.setState((st) => {
    if (!st.terminals[id]) return {};
    return {
      startupPending: { ...st.startupPending, [id]: false },
      startupNotes: omit(st.startupNotes, id),
    };
  });
  if (host) startPolling(id, host, attach ? "attach" : "connect");
}

function resetSessionIfFolderChanged(cur: TerminalSettings, next: TerminalSettings): { settings: TerminalSettings; note: string | null } {
  const before = cur.ssh?.cwd ?? null;
  const after = next.ssh?.cwd ?? null;
  if (next.claude?.enabled && next.claude.started && before !== after) {
    return {
      settings: { ...next, claude: { ...next.claude, sessionId: crypto.randomUUID(), started: false } },
      note: "folder changed; Claude will start a new session",
    };
  }
  return { settings: next, note: null };
}

/** The first load's work (see `loadWorkspace`). */
async function loadWorkspaceOnce(set: SetState): Promise<void> {
  // Identity BEFORE the defs are opened: `openDefs` needs `selfMachine` to tell this machine's
  // own locals from another machine's (which must open as remotes, not as local shells in a
  // path that belongs to the other Mac) and to stamp `origin` on legacy defs. Waiting for the
  // caller to refresh Tailscale afterwards would be too late. `refreshTailscale` swallows its
  // own errors, so a machine without Tailscale just carries on with `selfMachine` null.
  if (useStore.getState().selfMachine === null) await useStore.getState().refreshTailscale();
  void useStore.getState().installAgentHooks();
  void useStore.getState().ensureAgentWatchers();
  let ws: Awaited<ReturnType<typeof ipc.loadWorkspace>> = null;
  try {
    ws = await ipc.loadWorkspace();
  } catch (e) {
    const msg = typeof e === "string" ? e : String(e);
    set({ persistError: `${msg} — saving is paused until a successful Reload`, persistenceReady: false });
    return;
  }
  if (!ws) {
    neverSyncedAtLoad = true;
    set({ persistenceReady: true });
    layoutsLoaded = true;
    return;
  }
  neverSyncedAtLoad = !ws.sync;
  // Machines are applied before openDefs (when the file actually carries a `machines`
  // section) so that `openingFor` can resolve a foreign local's ssh user/color from the
  // SAME file being loaded. A file with no `machines` key at all (e.g. a peer's copy that
  // had none to report) leaves whatever machines this app already knows about untouched,
  // rather than wiping them, since there's no user-facing way to delete a known machine
  // that a full replace-with-nothing should honor.
  if (ws.machines !== undefined) {
    const { machines, dropped } = sanitizeMachines(ws.machines);
    set({ machines, ...(dropped > 0 ? { persistError: machineDropNote(dropped) } : {}) });
  }
  set({ ...conductorFieldsOf(ws), workspaceExtra: workspaceExtra(ws) });
  // This Mac's trees (windows and layouts spec §2), or on the first run of this version the
  // file's layout with every tile placed, plus a window for each old breakout.
  const saved = loadLayouts();
  const fileLayout = ws.layout ?? null;
  const initial = saved ?? migrateLayouts(sanitizeLayout(fileLayout), ws.terminals.map((t) => t.id));
  if (!saved && fileLayout !== null && sanitizeLayout(fileLayout) === null) set({ persistError: "layout in workspace.json was invalid and was rebuilt" });
  // Applied by openDefs once the tiles are open, so no pane mounts before its terminal exists.
  initialLayouts = initial;
  set({ fileLayout });
  // openDefs sets persistenceReady itself: true when every def opened cleanly, false
  // (with a persistError) if any failed, so a partial load never gets overwritten by a save.
  await openDefs(ws.terminals, set);
  layoutsLoaded = true;
  set({ syncMeta: ws.sync ?? null });
  lastSeenMtime = await ipc.workspaceStat().catch(() => null);
}

export const useStore = create<WorkbenchState>((set) => ({
  terminals: {},
  order: [],
  layout: null,
  focusedGroupId: null,
  focusedTerminalId: null,
  draggingTerminalId: null,
  lastCwd: null,
  settings: {},
  startupPending: {},
  startupNotes: {},
  persistError: null,
  persistenceReady: false,
  sshConnected: {},
  sshConnecting: {},
  sshDropped: {},
  toolReady: {},
  machines: {},
  conductor: null,
  conductorClaim: null,
  conductors: {},
  conductorAt: null,
  workspaceExtra: {},
  conductorsPanel: false,
  machineStats: {},
  async refreshMachineStats() {
    const s = useStore.getState();
    const self = s.selfMachine;
    const at = new Date().toISOString();
    const macs = machineList(s);
    if (macs.length === 0) return;
    // Offline Macs are marked at once; the others answer in parallel, each on its own.
    set((st) => {
      const next = { ...st.machineStats };
      for (const m of macs) {
        if (!m.online) next[m.name] = { ...(next[m.name] ?? { stats: null, ping: null }), name: m.name, self: false, online: false, error: null, at };
      }
      return { machineStats: next };
    });
    await Promise.all(
      macs
        .filter((m) => m.online)
        .map(async (m) => {
          const [stats, ping] = await Promise.allSettled([ipc.machineStats(m.self ? null : m.host), m.self || !self ? Promise.resolve(null) : ipc.tailscalePing(m.name)]);
          set((st) => {
            const prev = st.machineStats[m.name];
            return {
              machineStats: {
                ...st.machineStats,
                [m.name]: {
                  name: m.name,
                  self: m.self,
                  online: true,
                  stats: stats.status === "fulfilled" ? stats.value : (prev?.stats ?? null),
                  error: stats.status === "rejected" ? statsError(stats.reason) : null,
                  ping: ping.status === "fulfilled" ? ping.value : null,
                  at,
                },
              },
            };
          });
        }),
    );
  },
  setConductorsPanel(open) {
    set({ conductorsPanel: open });
  },
  telegramConfigured: null,
  fileView: null,
  tailscale: null,
  tailscaleError: null,
  selfMachine: null,
  syncMeta: null,
  sync: { enabled: false, lastPullAt: null, lastPushAt: null, peersOk: 0, peersTotal: 0, error: null, adopting: false },
  agentState: {},
  agentHooksError: null,
  windowFocused: true,
  focusedWindow: MAIN,
  copiedAt: {},
  pastedAt: {},
  resumeWatch: {},
  outsideSessions: [],
  update: EMPTY_UPDATE,

  async createTerminal(cwd, placement) {
    const id = crypto.randomUUID();
    await beforeSpawn.hook(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const info = await ipc.createTerminal(id, cwd, dims.cols, dims.rows);
    const origin = useStore.getState().selfMachine ?? null;
    set((s) => {
      const layouts = placeNew(s, info.id, placement);
      return {
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        lastCwd: cwd,
        settings: { ...s.settings, [info.id]: { ...EMPTY_SETTINGS, origin } },
        startupPending: { ...s.startupPending, [info.id]: false },
        ...commit(s, layouts, info.id),
      };
    });
    return info.id;
  },

  async createSshTerminal(opts, placement) {
    const id = crypto.randomUUID();
    // A host used before keeps its last folder unless the caller gives one explicitly.
    const machineName = opts.machine ?? null;
    const remembered = machineName ? (useStore.getState().machines[machineName]?.cwd ?? null) : null;
    const rememberedOrGivenCwd = opts.cwd === undefined ? remembered : opts.cwd?.trim() || null;
    await beforeSpawn.hook(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const home = await homeDir();
    const info = await ipc.createTerminal(id, home, dims.cols, dims.rows, opts.name ?? hostLabel(opts.host));
    const settings: TerminalSettings = {
      ...EMPTY_SETTINGS,
      ssh: { host: opts.host.trim(), cwd: rememberedOrGivenCwd, ...(machineName ? { machine: machineName } : {}) },
      claude: opts.claude
        ? { enabled: true, sessionId: crypto.randomUUID(), skipPermissions: opts.claude.skipPermissions, started: false }
        : null,
      origin: useStore.getState().selfMachine ?? null,
    };
    set((s) => {
      const layouts = placeNew(s, info.id, placement);
      return {
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        settings: { ...s.settings, [info.id]: settings },
        startupPending: { ...s.startupPending, [info.id]: true },
        machines: machineName ? touchMachine(s.machines, machineName, rememberedOrGivenCwd ? { cwd: rememberedOrGivenCwd } : {}) : s.machines,
        ...commit(s, layouts, info.id),
      };
    });
    // The user asked for this connection right now, so run it without a click.
    await useStore.getState().runStartup(info.id);
    return info.id;
  },

  async createRemoteTerminal(opts, placement): Promise<string> {
    const s = useStore.getState();
    const cfg = s.machines[opts.machine];
    const user = s.tailscale?.user ?? "";
    if (!cfg?.user?.trim() && !user.trim()) throw "no username for this machine";
    const host = machineHost(opts.machine, cfg, user);
    const hostErr = validateHost(host);
    if (hostErr) throw `cannot connect: ${hostErr}`;
    return useStore.getState().createSshTerminal(
      { host, cwd: opts.cwd, claude: opts.claude, name: machineLabel(opts.machine, cfg), machine: opts.machine },
      placement,
    );
  },

  async closeTerminal(id) {
    stopPolling(id);
    forgetAttach(id);
    // A tile whose home is another Mac has a session holder there too (§3.6): end it alongside
    // the local one, best effort and without waiting (the host may be asleep or offline).
    const before = useStore.getState();
    const host = before.settings[id]?.ssh?.host?.trim();
    if (host && (before.toolReady[host] === true || attachedTiles.has(id))) {
      void Promise.resolve()
        .then(() => ipc.remoteTileClose(host, id))
        .catch(() => {});
    }
    attachedTiles.delete(id);
    joinedTiles.delete(id);
    await ipc.closeTerminal(id);
    set((s) => {
      const terminals = { ...s.terminals };
      delete terminals[id];
      const homeGroupId = findGroupOf(s.layout, id)?.id ?? null;
      const layouts = removeEverywhere(layoutsOf(s), id);
      const layout = layouts[MAIN];
      const stillFocused = s.focusedTerminalId && s.focusedTerminalId !== id ? s.focusedTerminalId : null;
      const fallback =
        stillFocused ??
        ((homeGroupId && findGroup(layout, homeGroupId)?.active) || null) ??
        (allGroups(layout)[0]?.active || null);
      return {
        terminals,
        order: s.order.filter((t) => t !== id),
        selectedTiles: s.selectedTiles.includes(id) ? s.selectedTiles.filter((t) => t !== id) : s.selectedTiles,
        settings: omit(s.settings, id),
        startupPending: omit(s.startupPending, id),
        startupNotes: omit(s.startupNotes, id),
        sshConnected: omit(s.sshConnected, id),
        sshConnecting: omit(s.sshConnecting, id),
        sshDropped: omit(s.sshDropped, id),
        agentState: omit(s.agentState, id),
        // The conductor's tile is gone: nobody holds the role (and a claim by it lapses).
        ...(s.conductor === id ? { conductor: null } : {}),
        ...(s.conductorClaim?.tile === id ? { conductorClaim: null } : {}),
        // A closed sub-conductor's tiles go back to its parent (conductor tree spec §2).
        ...(Object.keys(s.conductors).length ? { conductors: withoutTile(s.conductors, id) } : {}),
        ...(s.conductor === id || s.conductorClaim?.tile === id || s.conductors[id] || Object.values(s.conductors).some((c) => c.tiles.includes(id))
          ? { conductorAt: new Date().toISOString() }
          : {}),
        ...commit(s, layouts, fallback),
      };
    });
  },

  async restartTerminal(id) {
    stopPolling(id);
    forgetAttach(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const info = await ipc.restartTerminal(id, dims.cols, dims.rows);
    noteJoined(info);
    set((s) => ({
      terminals: { ...s.terminals, [id]: info },
      startupPending: { ...s.startupPending, [id]: !info.existed && startupLine(s.settings[id] ?? EMPTY_SETTINGS) !== null },
      sshConnected: omit(s.sshConnected, id),
      sshConnecting: omit(s.sshConnecting, id),
      sshDropped: omit(s.sshDropped, id),
      agentState: s.agentState[id] ? { ...s.agentState, [id]: OFFLINE } : s.agentState,
    }));
    // The fit addon only fires onResize when dimensions change, so if the
    // new PTY already matches dims (e.g. same terminal, no relayout since
    // exit) it would never be resized without this explicit call. A rejoined
    // session was joined without a size: the pane sends its own once laid out.
    if (info.existed) beforeSpawn.claimSize(id);
    else void ipc.resizeTerminal(id, dims.cols, dims.rows).catch(() => {});
  },

  async renameTerminal(id, name) {
    try {
      const info = await ipc.renameTerminal(id, name);
      // The user picked this name: it is the one to share, whatever the file asked for before.
      requestedNames.delete(id);
      set((s) => ({ terminals: { ...s.terminals, [id]: info } }));
      return null;
    } catch (e) {
      return typeof e === "string" ? e : String(e);
    }
  },

  markExited(id, code) {
    stopPolling(id);
    set((s) => {
      const t = s.terminals[id];
      if (!t) return {};
      return {
        terminals: { ...s.terminals, [id]: { ...t, exited: code ?? -1 } },
        sshConnected: omit(s.sshConnected, id),
        sshConnecting: omit(s.sshConnecting, id),
        agentState: s.agentState[id] ? { ...s.agentState, [id]: OFFLINE } : s.agentState,
      };
    });
  },

  focusTerminal(id) {
    if (!useStore.getState().terminals[id]) return;
    let shown: string | null = null;
    set((s) => {
      let ls = layoutsOf(s);
      let label = windowOfTile(ls, id);
      // Not open here (windows and layouts spec §2): it opens as a tab of the main window's focused group.
      if (!label) {
        ls = { ...ls, [MAIN]: addTab(ls[MAIN], id, s.focusedGroupId) };
        label = MAIN;
      }
      const g = findGroupOf(ls[label], id);
      if (!g) return {};
      ls = { ...ls, [label]: setActive(ls[label], g.id, id) };
      shown = label;
      const cur = s.agentState[id];
      const agentState = s.windowFocused && s.focusedWindow === label && cur?.unseen ? { ...s.agentState, [id]: { ...cur, unseen: false } } : s.agentState;
      const zoomed = s.zoomed[label] && s.zoomed[label] !== g.id ? omit(s.zoomed, label) : s.zoomed;
      return { ...commit({ ...s, zoomed }, ls, id), agentState };
    });
    if (shown && shown !== MAIN) windowHooks.focus(shown);
  },

  focusGroup(groupId) {
    set((s) => {
      const ls = layoutsOf(s);
      const label = windowOfGroup(ls, groupId);
      if (!label) return {};
      const group = findGroup(ls[label], groupId);
      const id = group?.active || null;
      const cur = id ? s.agentState[id] : undefined;
      const agentState = id && s.windowFocused && s.focusedWindow === label && cur?.unseen ? { ...s.agentState, [id]: { ...cur, unseen: false } } : s.agentState;
      if (label !== MAIN) return { windows: { ...s.windows, [label]: { ...s.windows[label], focusedGroupId: groupId } }, agentState };
      return { focusedGroupId: groupId, focusedTerminalId: id, agentState };
    });
  },

  moveTerminal(id, groupId) {
    lastPlaced = { id, at: Date.now() };
    set((s) => commit(s, placeTile(layoutsOf(s), id, groupId), id));
  },

  splitTerminal(id, targetGroupId, side) {
    lastPlaced = { id, at: Date.now() };
    set((s) => commit(s, placeTile(layoutsOf(s), id, targetGroupId, side), id));
  },

  resizeSplit(splitId, sizes) {
    set((s) => {
      const ls = layoutsOf(s);
      const label = windowOfNode(ls, splitId);
      if (!label) return {};
      return commit(s, { ...ls, [label]: resizeSplitNode(ls[label], splitId, sizes) });
    });
  },

  setDragging(id) {
    set({ draggingTerminalId: id });
  },

  async loadWorkspace() {
    if (loadStarted) return;
    loadStarted = true;
    try {
      await loadWorkspaceOnce(set);
    } finally {
      finishLaunchReplay();
    }
  },

  async reloadWorkspace() {
    const wasReady = useStore.getState().persistenceReady;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ persistenceReady: false });
    let ws: Awaited<ReturnType<typeof ipc.loadWorkspace>> = null;
    try {
      ws = await ipc.loadWorkspace();
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      set({ persistError: `${msg} — saving is paused until a successful Reload` });
      return;
    }
    if (!ws) {
      set({ persistError: "no workspace file found — saving is paused until a successful Reload" });
      return;
    }
    // Restore the pre-reload readiness before handing off: applyWorkspace re-derives
    // "wasReady" from current state (to also serve the adopt path), and re-pauses
    // immediately as its own first step.
    set({ persistenceReady: wasReady });
    // Through the same queue as `adopt`: a reload and an adoption both close/open terminals and
    // rebuild the layout, and interleaving them would double-open or lose defs.
    const loaded = ws;
    await runExclusive(() => applyWorkspace(loaded, { confirmClose: true, scheduleSave: true }));
  },

  async pullWorkspace() {
    const s = useStore.getState();
    if (!s.sync.enabled || s.sync.adopting) return;
    // Latched at load, not read from `syncMeta`: a local save (the launch debounce, say) writes
    // a `sync` block of its own, and asking afterwards would answer "this machine has synced"
    // for a machine that has only ever talked to itself.
    const neverSynced = neverSyncedAtLoad && !firstPullDone;
    try {
      // Save (and revision-bump) any local edit before comparing against peers, so a pending
      // debounced save can never land after — and clobber — an adoption below. A machine that
      // has never synced skips this: that save would PUSH its terminals to the peers first, and
      // the union below would then merge its own file back into itself — the local terminals the
      // union exists to protect would have been broadcast already, and a peer's reassert would
      // later close them. Its first write to the tailnet is the union itself.
      if (!neverSynced) await flushPendingSave();
      const peers = peerHosts();
      const cands: Workspace[] = [];
      let ok = 0;
      const failed: string[] = [];
      const malformed: string[] = [];
      for (const p of peers) {
        let text: string | null;
        try {
          text = await ipc.workspacePull(p.host);
        } catch (e) {
          failed.push(`${p.name}: ${typeof e === "string" ? e : String(e)}`);
          continue;
        }
        ok += 1;
        if (!text) continue;
        // A peer's file is untrusted input (a truncated push, a hand-edited file, a future
        // version): only a copy with the shape the adopt path relies on is a candidate, since
        // adopting a malformed one would save it verbatim over our own workspace.
        let parsed: Workspace | null = null;
        try {
          parsed = JSON.parse(text) as Workspace;
        } catch {
          parsed = null;
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.version === 1 &&
          Array.isArray(parsed.terminals) &&
          // Every entry must be usable before anything touches it: a `null` or a def without an
          // id would otherwise throw inside the dedupe below and take the whole pull down.
          parsed.terminals.every((d) => !!d && typeof d === "object" && typeof (d as { id?: unknown }).id === "string") &&
          parsed.sync &&
          typeof parsed.sync.revision === "number"
        ) {
          cands.push({ ...parsed, terminals: dedupeById(parsed.terminals) });
        } else {
          malformed.push(p.name);
        }
      }
      const problems = [
        ...(failed.length ? [`pull failed for ${failed.join("; ")}`] : []),
        ...(malformed.length ? [`ignored malformed workspace from ${malformed.join(", ")}`] : []),
      ];
      set((st) => ({
        sync: {
          ...st.sync,
          lastPullAt: new Date().toISOString(),
          peersOk: ok,
          peersTotal: peers.length,
          error: problems.length ? problems.join("; ") : null,
        },
      }));
      const best = pickNewest(cands);
      if (!best) return;
      // Re-read `adopting`: flushing and pulling above are awaits, and an adoption may have
      // started (or a reload may be running) in the meantime.
      if (useStore.getState().sync.adopting) return;
      if (neverSynced) {
        // This machine has never synced, so its terminals are not an older copy of the peer's
        // workspace — they were never shared. Union them in rather than closing them.
        const merged = mergeForFirstSync(currentWorkspace(), best);
        await adoptGuarded(merged);
        // The peers still hold `best`; if the union added anything, save it so the usual bump and
        // push carry it back to them and everyone converges on the union. That save runs on the
        // debounce, by which time `firstPullDone` is set and pushing is allowed again.
        if (!sameWorkspaceContent(merged, best)) scheduleSave();
        return;
      }
      if (isNewer(best.sync, useStore.getState().syncMeta)) await adoptGuarded(best);
    } finally {
      firstPullDone = true;
    }
  },

  async checkExternalChange() {
    const s = useStore.getState();
    if (!s.sync.enabled || s.sync.adopting) return;
    // Same reasoning as `pullWorkspace`: flush before comparing/adopting.
    await flushPendingSave();
    const mtime = await ipc.workspaceStat().catch(() => null);
    if (mtime === null || mtime === lastSeenMtime) return;
    if (lastSeenMtime === null) {
      // No baseline yet (e.g. this poll ran before `loadWorkspace`/a save ever recorded one):
      // record this mtime and wait for the next tick rather than treating "unknown" as "changed".
      lastSeenMtime = mtime;
      return;
    }
    let ws: Workspace | null = null;
    try {
      ws = await ipc.loadWorkspace();
    } catch {
      return;
    }
    if (!ws) return;
    // Re-read `adopting`: the stat and the load above are awaits (see `pullWorkspace`).
    if (useStore.getState().sync.adopting) return;
    // `lastSeenMtime` is advanced only by a round that actually acts on the file: one that bails
    // out must look again on the next tick instead of treating a change it never handled as seen.
    if (isNewer(ws.sync, useStore.getState().syncMeta)) {
      lastSeenMtime = mtime;
      await adoptGuarded(ws);
      await announceLocalWrite(ws);
      return;
    }
    // The file on disk is OLDER than what we hold: something (a peer pushing a stale copy, a
    // restored backup) overwrote our workspace. Rewrite ours over it — the save bumps the
    // revision, so the peer that sent the stale copy adopts ours on its next round. With saving
    // paused there is nothing trustworthy to write, so leave the file (and the baseline) alone
    // and try again once a Reload has made this app ready.
    if (!useStore.getState().persistenceReady) return;
    lastSeenMtime = mtime;
    scheduleSave();
  },

  async refreshOutsideSessions() {
    let rows: Awaited<ReturnType<typeof ipc.localSessions>>;
    try {
      rows = await ipc.localSessions();
    } catch {
      return;
    }
    const settled = Date.now() - OUTSIDE_SETTLE_MS;
    const s = useStore.getState();
    const ids = rows
      .filter((r) => r.running && !r.known && !s.terminals[r.id] && r.startedAt !== null && Date.parse(r.startedAt) < settled)
      .map((r) => r.id);
    set({ outsideSessions: ids });
  },

  async closeOutsideSessions(): Promise<string | null> {
    // Only sessions that are still outside now: one may have been adopted as a tile (or its
    // workspace become unreadable) since the list was shown.
    const shown = new Set(useStore.getState().outsideSessions);
    set({ outsideSessions: [] });
    await useStore.getState().refreshOutsideSessions();
    const targets = useStore.getState().outsideSessions.filter((id) => shown.has(id));
    let firstError: string | null = null;
    for (const id of targets) {
      try {
        await ipc.closeSession(id);
      } catch (e) {
        firstError ??= `could not close ${id}: ${typeof e === "string" ? e : String(e)}`;
      }
    }
    set({ outsideSessions: [] });
    await useStore.getState().refreshOutsideSessions();
    return firstError;
  },

  windowLabel: MAIN,
  windows: {},
  zoomed: {},
  fileLayout: null,
  selectedTiles: [],
  closedNotice: null,
  openTileIds: [],
  identify: null,
  boards: {},
  hoveredTile: null,

  hoverTile(id) {
    if (useStore.getState().hoveredTile !== id) set({ hoveredTile: id });
  },

  async loadBoard(id) {
    const s = useStore.getState();
    if (!s.terminals[id] || s.boards[id] || boardLoading.has(id)) return;
    boardLoading.add(id);
    try {
      const r = await ipc.boardGet(id, s.settings[id]?.ssh?.machine ?? null);
      const board = readBoard(r?.board);
      set((st) => (st.boards[id] ? {} : { boards: { ...st.boards, [id]: { board, at: r?.at ?? null } } }));
    } catch {
      // An older tool, or the Mac is away: the board arrives with the next Board event.
    } finally {
      boardLoading.delete(id);
    }
  },

  async answerBoard(id, text) {
    const s = useStore.getState();
    await ipc.tileSend(id, text, s.settings[id]?.ssh?.machine ?? null);
  },

  identifyTile(id) {
    if (!useStore.getState().terminals[id]) return;
    // Open somewhere: shown and brought forward. Not open: the row says so, nothing opens.
    if (windowOfTile(layoutsOf(useStore.getState()), id)) useStore.getState().focusTerminal(id);
    showIdentify({ ids: [id], numbered: false, at: Date.now() });
  },

  identifyAll(ids) {
    const s = useStore.getState();
    showIdentify({ ids: ids.filter((id) => s.terminals[id]), numbered: true, at: Date.now() });
  },

  closeTab(id) {
    const s = useStore.getState();
    const ls = layoutsOf(s);
    const label = windowOfTile(ls, id);
    if (!label) return;
    // The last tab of another window: the window closes, and its Undo brings the window back.
    if (label !== MAIN && tilesOf(ls[label]).length === 1) {
      void useStore.getState().closeWindow(label);
      return;
    }
    const place = placeOf(s, id);
    set((st) => commit(st, removeEverywhere(layoutsOf(st), id)));
    showNotice({ window: label, ids: [id], at: Date.now(), undo: { kind: "tiles", places: [place] } });
  },

  async openInNewWindow(ids, at, presetId = null) {
    const s = useStore.getState();
    const tiles = ids.filter((id) => s.terminals[id]);
    if (tiles.length === 0) return;
    const label = newWindowLabel();
    const preset = presetId ? presetById(presetId) : null;
    const ls0 = layoutsOf(s);
    // A group moved whole keeps the tab it was showing.
    const source = windowOfTile(ls0, tiles[0]);
    const showing = source ? findGroupOf(ls0[source], tiles[0])?.active : null;
    const tree = preset ? arrange(preset, tiles) : groupOf(tiles, showing && tiles.includes(showing) ? showing : tiles[0]);
    set((st) => {
      let ls = layoutsOf(st);
      for (const id of tiles) ls = removeEverywhere(ls, id);
      return commit(st, { ...ls, [label]: tree }, tiles[0]);
    });
    try {
      await windowHooks.open(label, at);
    } catch (e) {
      // No window: the tiles go back to the main window rather than vanish.
      set((st) => {
        let main = layoutsOf(st)[MAIN];
        for (const id of tiles) main = addTab(main, id, st.focusedGroupId);
        return { ...commit(st, { ...omit(layoutsOf(st), label), [MAIN]: main }), persistError: `could not open a window: ${errText(e)}` };
      });
    }
  },

  async moveGroupToNewWindow(groupId) {
    const s = useStore.getState();
    const ls = layoutsOf(s);
    const label = windowOfGroup(ls, groupId);
    const g = label ? findGroup(ls[label], groupId) : null;
    if (!g || g.tabs.length === 0) return;
    const bounds = label ? await windowHooks.boundsOf(label) : null;
    const at = bounds ? { x: bounds.x + 80, y: bounds.y + 60 } : null;
    await useStore.getState().openInNewWindow([g.active, ...g.tabs.filter((t) => t !== g.active)], at);
  },

  async moveToWindow(id, label): Promise<void> {
    const s = useStore.getState();
    if (label === "new") {
      await useStore.getState().openInNewWindow([id], null);
      return;
    }
    const ls = layoutsOf(s);
    const target = ls[label];
    if (label !== MAIN && !target) return;
    const groupId = (label === MAIN ? s.focusedGroupId : s.windows[label]?.focusedGroupId) ?? allGroups(target)[0]?.id ?? null;
    if (groupId && findGroup(target, groupId)) {
      useStore.getState().moveTerminal(id, groupId);
    } else {
      set((st) => commit(st, { ...removeEverywhere(layoutsOf(st), id), [label]: addTab(null, id, null) }, id));
    }
    if (label !== MAIN) windowHooks.focus(label);
  },

  async dropOutside(id, at, from) {
    if (!useStore.getState().terminals[id]) return;
    // Another window's webview took this drop a moment ago (its drag end can still say "none").
    if (lastPlaced?.id === id && Date.now() - lastPlaced.at < DROP_SETTLE_MS) return;
    const under = await windowHooks.windowAt(at);
    // Back over the window it came from: a drop nothing took, so nothing moves.
    if (under === from) return;
    if (under) {
      windowHooks.dropAt(under, id, at);
      return;
    }
    await useStore.getState().openInNewWindow([id], at);
  },

  async closeWindow(label) {
    if (label === MAIN) return;
    const s = useStore.getState();
    const w = s.windows[label];
    if (!w) return;
    const bounds = await windowHooks.boundsOf(label).catch(() => null);
    const ids = allGroups(w.layout).flatMap((g) => g.tabs);
    set((st) => commit(st, omit(layoutsOf(st), label)));
    if (ids.length > 0) showNotice({ window: MAIN, ids, at: Date.now(), undo: { kind: "window", layout: w.layout, bounds } });
  },

  async restoreWindows() {
    for (const label of Object.keys(useStore.getState().windows)) {
      try {
        await windowHooks.open(label, null);
      } catch {
        // No window after all: its tiles are simply not open here.
        set((st) => commit(st, omit(layoutsOf(st), label)));
      }
    }
  },

  applyPreset(groupId, presetId) {
    const preset = presetById(presetId);
    if (!preset) return;
    set((s) => {
      const ls = layoutsOf(s);
      const label = windowOfGroup(ls, groupId);
      if (!label) return {};
      const tree = arrange(preset, tilesInOrder(ls[label]));
      return { ...commit({ ...s, zoomed: omit(s.zoomed, label) }, { ...ls, [label]: tree }) };
    });
  },

  async arrangeSelection(presetId, target) {
    const s = useStore.getState();
    const preset = presetById(presetId);
    const ids = s.selectedTiles.filter((id) => s.terminals[id]);
    if (!preset || ids.length === 0) return;
    set({ selectedTiles: [] });
    if (target === "new") {
      await useStore.getState().openInNewWindow(ids, null, presetId);
      return;
    }
    // In the main window: what it showed and was not picked is closed there, still running (spec §8).
    const closed = tilesOf(s.layout).filter((id) => !ids.includes(id));
    const places = closed.map((id) => placeOf(s, id));
    set((st) => {
      let ls = layoutsOf(st);
      for (const id of ids) ls = removeEverywhere(ls, id);
      return commit({ ...st, zoomed: omit(st.zoomed, MAIN) }, { ...ls, [MAIN]: arrange(preset, ids) }, ids[0]);
    });
    if (closed.length > 0) showNotice({ window: MAIN, ids: closed, at: Date.now(), undo: { kind: "tiles", places } });
  },

  async newInSlot(groupId) {
    const s = useStore.getState();
    const cwd = (s.focusedTerminalId && s.terminals[s.focusedTerminalId]?.cwd) || s.lastCwd || (await homeDir());
    await useStore.getState().createTerminal(cwd, { kind: "tab", groupId });
  },

  removeSlot(groupId) {
    set((s) => {
      const ls = layoutsOf(s);
      const label = windowOfGroup(ls, groupId);
      if (!label) return {};
      return commit(s, { ...ls, [label]: removeGroup(ls[label], groupId) });
    });
  },

  toggleZoom(groupId) {
    set((s) => {
      const label = windowOfGroup(layoutsOf(s), groupId);
      if (!label) return {};
      return { zoomed: s.zoomed[label] === groupId ? omit(s.zoomed, label) : { ...s.zoomed, [label]: groupId } };
    });
  },

  selectTile(id, mode, visible) {
    set((s) => {
      const cur = s.selectedTiles;
      if (mode === "toggle") return { selectedTiles: cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id] };
      const anchor = cur[cur.length - 1];
      const a = anchor ? visible.indexOf(anchor) : -1;
      const b = visible.indexOf(id);
      if (a === -1 || b === -1) return { selectedTiles: cur.includes(id) ? cur : [...cur, id] };
      const range = visible.slice(Math.min(a, b), Math.max(a, b) + 1);
      const ordered = a <= b ? range : range.reverse();
      return { selectedTiles: [...cur, ...ordered.filter((t) => !cur.includes(t))] };
    });
  },

  selectTiles(ids) {
    set((s) => {
      const all = ids.length > 0 && ids.every((id) => s.selectedTiles.includes(id)) && s.selectedTiles.length === ids.length;
      return { selectedTiles: all ? [] : [...ids] };
    });
  },

  clearSelection() {
    set({ selectedTiles: [] });
  },

  async undoClosed() {
    const n = useStore.getState().closedNotice;
    if (!n) return;
    set({ closedNotice: null });
    const alive = (id: string) => useStore.getState().terminals[id] !== undefined;
    if (n.undo.kind === "window") {
      const label = newWindowLabel();
      const layout = n.undo.layout;
      set((st) => {
        let ls = layoutsOf(st);
        let tree = layout;
        for (const id of tilesOf(layout)) {
          if (alive(id)) ls = removeEverywhere(ls, id);
          else tree = removeTerminal(tree, id);
        }
        return tree ? commit(st, { ...ls, [label]: tree }) : {};
      });
      if (useStore.getState().windows[label]) {
        await windowHooks.open(label, null, n.undo.bounds).catch(() => set((st) => commit(st, omit(layoutsOf(st), label))));
      }
      return;
    }
    const places = n.undo.places;
    set((st) => {
      let ls = layoutsOf(st);
      for (const { id, groupId } of places) {
        if (!alive(id)) continue;
        if (groupId && windowOfGroup(ls, groupId)) {
          ls = placeTile(ls, id, groupId);
        } else {
          ls = removeEverywhere(ls, id);
          ls = { ...ls, [MAIN]: addTab(ls[MAIN], id, st.focusedGroupId) };
        }
      }
      return commit(st, ls, places.find((p) => alive(p.id))?.id ?? null);
    });
  },

  dismissClosedNotice() {
    set({ closedNotice: null });
  },

  setCardTitle(id, title) {
    set((s) => {
      if (!s.terminals[id]) return {};
      const current = s.settings[id] ?? EMPTY_SETTINGS;
      const card = withUserTitle(current.card ?? null, title, new Date().toISOString());
      if ((card ?? null) === (current.card ?? null)) return {};
      return { settings: { ...s.settings, [id]: { ...current, card } } };
    });
  },

  setTelegramConfigured(configured) {
    set({ telegramConfigured: configured });
  },

  openFile(id, path, line) {
    set({ fileView: { id, path, line: line ?? null } });
  },

  closeFile() {
    set({ fileView: null });
  },

  async setConductor(id) {
    if (id !== null && !useStore.getState().terminals[id]) throw `${id} is not an open tile`;
    await conductorViaTool(id === null ? ["clear"] : ["set", id]);
  },

  async setSubConductor(id, parent) {
    if (!useStore.getState().terminals[id]) throw `${id} is not an open tile`;
    await conductorViaTool(["sub", id, parent]);
  },

  async assignTile(id, to) {
    if (!useStore.getState().terminals[id]) throw `${id} is not an open tile`;
    await conductorViaTool(["assign", id, to]);
  },

  async removeSubConductor(id) {
    await conductorViaTool(["remove", id]);
  },

  async decideClaim(approve) {
    const claim = useStore.getState().conductorClaim;
    if (!claim) return;
    await conductorViaTool(approve ? ["set", claim.tile] : ["deny"]);
  },

  async createConductorTerminal(cwd, placement): Promise<string> {
    const id: string = await useStore.getState().createTerminal(cwd, placement);
    useStore.getState().updateSettings(id, { claude: { enabled: true, sessionId: crypto.randomUUID(), skipPermissions: false, started: false } });
    // Claude starts as any local Claude tile does: the startup line is typed into the fresh shell.
    set((s) => ({ startupPending: { ...s.startupPending, [id]: true } }));
    await useStore.getState().runStartup(id);
    await useStore.getState().setConductor(id);
    return id;
  },

  updateSettings(id, patch) {
    set((s) => {
      const current = s.settings[id] ?? EMPTY_SETTINGS;
      const next: TerminalSettings = { ...current, ...patch };
      if (next.claude?.enabled && !next.claude.sessionId) {
        next.claude = { ...next.claude, sessionId: crypto.randomUUID() };
      }
      const { settings: finalSettings, note } = resetSessionIfFolderChanged(current, next);
      return {
        settings: { ...s.settings, [id]: finalSettings },
        startupPending: { ...s.startupPending, [id]: startupLine(finalSettings) !== null },
        startupNotes: note ? { ...s.startupNotes, [id]: note } : s.startupNotes,
      };
    });
  },

  async runStartup(id) {
    if (useStore.getState().sshConnecting[id] || startupInFlight.has(id)) return;
    startupInFlight.add(id);
    try {
      await runStartupNow(id);
    } finally {
      startupInFlight.delete(id);
    }
  },

  async runRemoteStep(id) {
    const s = useStore.getState();
    if (!s.sshConnected[id] || !s.terminals[id]) return;
    const remote = startupSteps(s.settings[id] ?? EMPTY_SETTINGS, id, { attach: attachModeFor(id), name: s.terminals[id].name }).find(
      (st) => st.via === "remote",
    );
    if (!remote) return;
    const host = s.settings[id]?.ssh?.host?.trim();
    if (!host || !(await tileLive(id, host))) {
      set((st) => ({
        sshConnected: omit(st.sshConnected, id),
        startupPending: { ...st.startupPending, [id]: true },
      }));
      return;
    }
    await ipc.writeTerminal(id, remote.line + "\r");
    const resumedRemote = resumedSessionIn(remote.line);
    if (resumedRemote) useStore.getState().watchResume(id, resumedRemote);
    set((st) => {
      if (!st.terminals[id]) return {};
      return { startupPending: { ...st.startupPending, [id]: false } };
    });
  },

  async remoteAttached(id, isNew) {
    const s = useStore.getState();
    // Any program's output can carry the marker, so it only ever counts for an ssh tile, and it
    // only types anything for a tile whose attach line this app typed and is still waiting on.
    if (!s.terminals[id] || !s.settings[id]?.ssh?.host?.trim()) return;
    const typedAttach = attachPending.delete(id);
    attachedTiles.add(id);
    stopPolling(id);
    set((st) => ({
      sshConnected: { ...st.sshConnected, [id]: true },
      sshConnecting: omit(st.sshConnecting, id),
      startupPending: { ...st.startupPending, [id]: false },
      startupNotes: omit(st.startupNotes, id),
    }));
    // A rejoined session keeps whatever it was running (a picked session is switched to only if
    // its shell is idle); only a session the holder just started for our own attach line needs
    // the `cd` / Claude line, which already carries any picked session.
    if (isNew && typedAttach) {
      // Hold the tile for the whole step: a Connect or a session pick in the settle window must
      // not type a second line (the shell looks idle until Claude has started).
      const owned = !startupInFlight.has(id);
      startupInFlight.add(id);
      newSessionStep.add(id);
      try {
        await new Promise((r) => setTimeout(r, SSH_SETTLE_MS));
        // The step reads the settings now, so it already carries any session picked so far; a
        // pick after this point stays pending for the next reattach.
        pendingSwitch.delete(id);
        await useStore.getState().runRemoteStep(id);
      } finally {
        newSessionStep.delete(id);
        if (owned) startupInFlight.delete(id);
      }
    } else if (!isNew) {
      await applyPendingSwitch(id);
    }
  },

  cancelConnecting(id) {
    stopPolling(id);
    attachPending.delete(id);
    set((s) => ({ sshConnecting: omit(s.sshConnecting, id), startupPending: { ...s.startupPending, [id]: true } }));
  },

  async chooseRemoteDir(id, path) {
    const clean = path.trim();
    if (!clean) return;
    if (!isSafeRemotePath(clean)) {
      set((s) => ({ startupNotes: { ...s.startupNotes, [id]: "folder name contains unsupported characters" } }));
      return;
    }
    const host = useStore.getState().settings[id]?.ssh?.host;
    if (!host) return;
    set((s) => {
      const cur = s.settings[id] ?? EMPTY_SETTINGS;
      if (!cur.ssh?.host) return {};
      const { settings, note } = resetSessionIfFolderChanged(cur, { ...cur, ssh: { ...cur.ssh, cwd: clean } });
      return {
        settings: { ...s.settings, [id]: settings },
        machines: cur.ssh.machine ? touchMachine(s.machines, cur.ssh.machine, { cwd: clean }) : s.machines,
        startupNotes: note ? { ...s.startupNotes, [id]: note } : s.startupNotes,
        startupPending: { ...s.startupPending, [id]: !s.sshConnected[id] },
      };
    });
    if (useStore.getState().sshConnected[id]) {
      if (await tileLive(id, host)) {
        await useStore.getState().runRemoteStep(id);
      } else {
        set((s) => ({ sshConnected: { ...s.sshConnected, [id]: false }, startupPending: { ...s.startupPending, [id]: true } }));
      }
    }
  },

  skipStartup(id) {
    set((s) => ({ startupPending: { ...s.startupPending, [id]: false }, startupNotes: omit(s.startupNotes, id) }));
  },

  dismissPersistError() {
    set({ persistError: null });
  },

  async refreshTailscale() {
    try {
      const st = await ipc.tailscaleStatus();
      set((s) => ({
        tailscale: st,
        tailscaleError: null,
        selfMachine: st.self?.name ?? null,
        sync: { ...s.sync, enabled: st.running && !!st.self },
      }));
    } catch (e) {
      set({ tailscaleError: typeof e === "string" ? e : String(e) });
    }
  },

  async updateMachine(name, patch) {
    if (patch.alias !== undefined && patch.alias !== null && patch.alias.trim() !== "") {
      const err = validateAlias(patch.alias);
      if (err) return err;
    }
    if (patch.user !== undefined && patch.user !== null) {
      const err = validateUser(patch.user);
      if (err) return err;
    }
    if (patch.color !== undefined && !isMachineColor(patch.color)) return "unsupported colour";
    if (patch.theme !== undefined && patch.theme !== null && !isThemeId(patch.theme)) return "unsupported theme";
    if (patch.icon !== undefined && patch.icon !== null && patch.icon.trim() !== "") {
      const err = validateIcon(patch.icon);
      if (err) return err;
    }
    const before = useStore.getState();
    const oldLabel = machineLabel(name, before.machines[name]);
    const cleaned = {
      ...(patch.alias !== undefined ? { alias: patch.alias?.trim() || null } : {}),
      ...(patch.user !== undefined ? { user: patch.user?.trim() || null } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon?.trim() || null } : {}),
      ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
    };
    set((s) => ({ machines: touchMachine(s.machines, name, cleaned, undefined, { bump: false }) }));
    const after = useStore.getState();
    const newLabel = machineLabel(name, after.machines[name]);
    if (newLabel !== oldLabel) {
      for (const id of after.order) {
        if (after.settings[id]?.ssh?.machine === name && after.terminals[id]?.name === oldLabel) {
          await useStore.getState().renameTerminal(id, newLabel);
        }
      }
    }
    return null;
  },

  applyAgentEvent(payload) {
    const { host, event } = payload;
    // The log reached us, so whatever watcher is tailing it is up.
    agentWatchSurvived(host);
    // This Mac's history, before the first load has said which tiles rejoined running sessions:
    // keep it until then (see `finishLaunchReplay`).
    if (host === null && event.ts < APP_LAUNCHED_AT && launchReplay !== null) {
      if (launchReplay.length < LAUNCH_REPLAY_MAX) launchReplay.push(payload);
      return;
    }
    const id = event.terminal;
    let folderToApply: string | null = null;
    set((s) => {
      if (!s.terminals[id]) return {};
      const settings = s.settings[id] ?? EMPTY_SETTINGS;
      // A log only describes the machine it lives on: terminal ids travel in the shared
      // workspace, so the same id can appear in another Mac's log for a tile that is not this
      // one. Match the tile to the host the event came from (null = this Mac).
      if (host === null ? settings.ssh != null : settings.ssh?.host?.trim() !== host) return {};
      // Replay from before this run: a local tile whose session this run started fresh had its
      // Claude die with the old session, so its history is stale. A tile that joined a session
      // still running in its holder keeps the history since that holder started (an older
      // holder's, e.g. from before a reboot, is stale too); every remote's history counts.
      if (event.ts < APP_LAUNCHED_AT && host === null && !preLaunchEventCounts(id, event.ts)) return {};
      // A board (tile board spec §2) replaces the tile's; it says nothing about its status.
      if (event.event === "Board") return { boards: { ...s.boards, [id]: { board: readBoard(event.board), at: event.ts } } };
      const focused = s.windowFocused && seenTile(s) === id;
      const next = foldAgentEvent(s.agentState[id], event, focused);
      const patch: Partial<WorkbenchState> = {};
      if (next) patch.agentState = { ...s.agentState, [id]: next };
      // The first prompt is what makes a session resumable: only now is `--resume` valid.
      const c = settings.claude;
      if (event.event === "UserPromptSubmit" && c?.enabled && !c.started && event.sessionId === c.sessionId) {
        patch.settings = { ...s.settings, [id]: { ...settings, claude: { ...c, started: true } } };
      }
      // Session adoption and history (folder/session spec §4).
      const trimmed = settings.command?.trim();
      if (!trimmed && event.sessionId) {
        const now = event.ts;
        const base = patch.settings?.[id] ?? settings;
        let next2: TerminalSettings | null = null;
        if (event.event === "SessionStart") {
          const skipPermissions = event.permissionMode === "bypassPermissions";
          const cwd = event.cwd && isSafeFolder(event.cwd) ? event.cwd : (base.sessions?.find((r) => r.sessionId === event.sessionId)?.cwd ?? null);
          if (cwd) {
            const sessions = upsertSession(base.sessions, { sessionId: event.sessionId, cwd, skipPermissions }, now);
            const claude = base.claude?.enabled && base.claude.sessionId === event.sessionId
              ? base.claude
              : { enabled: true, sessionId: event.sessionId, skipPermissions, started: false };
            next2 = { ...base, sessions, claude };
            folderToApply = cwd;
          }
        } else if (event.event === "UserPromptSubmit") {
          // Only prompts bump the record. Stop/StopFailure/Notification arrive several times a
          // turn and a new `settings` identity is a save, a revision bump and a push to every
          // peer, so they leave history alone (folder/session spec §4, §7).
          const bumped = bumpSession(base.sessions, event.sessionId, now);
          if (bumped) next2 = { ...base, sessions: bumped };
          // A prompt's `cwd` is not applied: Claude Code reports the folder of its own Bash shell
          // there, which moves as Claude `cd`s, while the tile's shell (the holder's Info, OSC 7)
          // stays put. Taking both made a tile's folder flip between the two on every event, each
          // flip re-arming the connect card and bumping the shared workspace. SessionStart's
          // `cwd` is the session's project folder, which is what Connect needs (folder spec §3.2).
        }
        if (next2) patch.settings = { ...(patch.settings ?? s.settings), [id]: next2 };
      }
      return patch;
    });
    if (folderToApply) void useStore.getState().setTerminalCwd(id, folderToApply, "hook");
  },

  flashCopied(id) {
    set((s) => ({ copiedAt: { ...s.copiedAt, [id]: Date.now() } }));
  },

  flashPasted(id) {
    set((s) => ({ pastedAt: { ...s.pastedAt, [id]: Date.now() } }));
  },

  async setTerminalCwd(id, cwd, source) {
    const s = useStore.getState();
    const t = s.terminals[id];
    if (!t || !isSafeFolder(cwd)) return;
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    // A remote tile is a local shell that typed `ssh`: until that connected, its OSC 7 and its
    // `lsof` cwd describe *this* Mac, and writing either into the tile's remote folder would
    // break Connect. Hook events are already matched to the host they came from (§4).
    if (settings.foreign || settings.ssh) {
      if (source === "poll") return;
      if ((source === "osc7" || source === "remote") && s.sshConnected[id] !== true) return;
    }
    if (settings.foreign) {
      if (settings.foreign.cwd === cwd) return;
      set((st) => {
        const cur = st.settings[id];
        if (!cur?.foreign) return {};
        return { settings: { ...st.settings, [id]: { ...cur, foreign: { cwd }, ssh: cur.ssh ? { ...cur.ssh, cwd } : cur.ssh } } };
      });
      return;
    }
    if (settings.ssh) {
      if (settings.ssh.cwd === cwd) return;
      set((st) => {
        const cur = st.settings[id];
        if (!cur?.ssh) return {};
        return { settings: { ...st.settings, [id]: { ...cur, ssh: { ...cur.ssh, cwd } } } };
      });
      return;
    }
    if (t.cwd === cwd) return;
    try {
      const info = await ipc.setTerminalCwd(id, cwd);
      set((st) => (st.terminals[id] ? { terminals: { ...st.terminals, [id]: { ...st.terminals[id], cwd: info.cwd } } } : {}));
    } catch {
      // registry refused (unknown id or bad path); the next poll will try again
    }
  },

  async selectSession(id, sessionId, { connect }) {
    const s = useStore.getState();
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    const rec = settings.sessions?.find((r) => r.sessionId === sessionId);
    if (!s.terminals[id] || !rec) return;
    // A command tile is never adopted (spec §4), so it has no history to go back to; going
    // back would also make its startup line `cd <folder> && <command>`. SessionHistory hides
    // itself for these tiles, so this only catches a stale record or a direct caller.
    if (settings.command?.trim()) return;
    const now = new Date().toISOString();
    set((st) => {
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      return {
        settings: {
          ...st.settings,
          [id]: { ...cur, claude: { enabled: true, sessionId, skipPermissions: rec.skipPermissions, started: true }, sessions: promoteSession(cur.sessions ?? [], sessionId, now) },
        },
        startupNotes: omit(st.startupNotes, id),
      };
    });
    await useStore.getState().setTerminalCwd(id, rec.cwd, "hook");
    const after = useStore.getState();
    const isSsh = !!after.settings[id]?.ssh;
    if (isSsh && attachModeFor(id)) {
      // The tile's shell lives in a session on the remote, which may already be running Claude:
      // Connect (or Run on a live tile) switches only once that session is seen idle.
      pendingSwitch.add(id);
      await useStore.getState().runStartup(id);
      return;
    }
    if (isSsh) {
      const host = after.settings[id]!.ssh!.host;
      const live = await tileLive(id, host);
      if (connect || !live) {
        await useStore.getState().runStartup(id);
        return;
      }
      const busy = await safeForegroundBusy(id);
      if (busy) {
        set((st) => ({ startupNotes: { ...st.startupNotes, [id]: "switch takes effect on next Connect" } }));
        return;
      }
      await useStore.getState().runRemoteStep(id);
      return;
    }
    // Local tile: whether or not we're connecting, a fresh/idle shell needs an explicit `cd` to
    // the record's folder before the claude line — resuming in place would land in the tile's
    // current directory, not the one the session was recorded under.
    const busy = await safeForegroundBusy(id);
    if (busy) {
      set((st) => ({ startupNotes: { ...st.startupNotes, [id]: "switch takes effect on next Connect" } }));
      return;
    }
    const claude = startupSteps(after.settings[id] ?? EMPTY_SETTINGS, id).find((st) => st.via === "local")?.line;
    if (!claude) return;
    const line = `cd ${shellQuote(rec.cwd)} && ${claude}`;
    await ipc.writeTerminal(id, line + "\r");
    const resumedLocal = resumedSessionIn(line);
    if (resumedLocal) useStore.getState().watchResume(id, resumedLocal);
    set((st) => ({ startupPending: { ...st.startupPending, [id]: false }, startupNotes: omit(st.startupNotes, id) }));
  },

  watchResume(id, sessionId) {
    const until = Date.now() + RESUME_WATCH_MS;
    set((s) => ({ resumeWatch: { ...s.resumeWatch, [id]: { sessionId, until } } }));
    setTimeout(() => {
      set((s) => (s.resumeWatch[id]?.until === until ? { resumeWatch: omit(s.resumeWatch, id) } : {}));
    }, RESUME_WATCH_MS);
  },

  noteResumeFailure(id, sessionId) {
    set((s) => {
      const cur = s.settings[id];
      if (!cur) return {};
      const isCurrent = cur.claude?.enabled && cur.claude.sessionId === sessionId;
      const claude = isCurrent && cur.claude ? { ...cur.claude, started: false } : cur.claude;
      // An empty list and no list mean the same thing (`toWorkspace` omits both), so dropping
      // the last record leaves the key off rather than writing `[]`.
      const left = removeSession(cur.sessions, sessionId);
      const sessions = left.length ? left : undefined;
      return {
        settings: { ...s.settings, [id]: { ...cur, claude, sessions } },
        resumeWatch: omit(s.resumeWatch, id),
        ...(isCurrent
          ? { startupNotes: { ...s.startupNotes, [id]: `session ${sessionId} is gone; Connect starts a new one` }, startupPending: { ...s.startupPending, [id]: true } }
          : {}),
      };
    });
  },

  setWindowFocused(focused) {
    useStore.getState().windowFocus(MAIN, focused);
  },

  windowFocus(label, focused) {
    set((s) => {
      // A blur from a window that no longer has focus arrived after the next window's focus.
      if (!focused) return label === s.focusedWindow ? { windowFocused: false } : {};
      const next = { ...s, windowFocused: true, focusedWindow: label };
      const id = seenTile(next);
      const cur = id ? s.agentState[id] : undefined;
      if (!id || !cur?.unseen) return { windowFocused: true, focusedWindow: label };
      return { windowFocused: true, focusedWindow: label, agentState: { ...s.agentState, [id]: { ...cur, unseen: false } } };
    });
  },

  async installAgentHooks() {
    try {
      await ipc.agentsInstallLocal();
      set({ agentHooksError: null });
    } catch (e) {
      set({ agentHooksError: `could not install Claude hooks: ${typeof e === "string" ? e : String(e)}` });
    }
  },

  async ensureAgentWatchers() {
    const s = useStore.getState();
    const wanted = wantedAgentHosts(s);
    for (const host of Array.from(agentWatch.watching)) {
      if (!wanted.has(host)) {
        agentWatch.watching.delete(host);
        agentWatch.attempts.delete(host);
        const t = agentWatch.retry.get(host);
        if (t) clearTimeout(t);
        agentWatch.retry.delete(host);
        await ipc.agentsUnwatch(host).catch(() => {});
      }
    }
    for (const [host, id] of wanted) {
      // Mark before awaiting: the subscription and an explicit call can run this concurrently,
      // and the second must see the first's claim, not race it into a duplicate install.
      if (host !== null && !agentWatch.installed.has(host)) {
        agentWatch.installed.add(host);
        try {
          await ipc.agentsInstallRemote(host);
          clearAgentNotes(host, AGENT_INSTALL_NOTE);
          // The tile is connected now, so the shared ssh socket is up: a host whose tool could
          // not be checked before connecting (password login) is checked again for later tiles.
          // Not awaited: the watcher does not depend on it, and a tool upload can take a while.
          void checkToolReady(host);
        } catch (e) {
          agentWatch.installed.delete(host);
          const machine = (id ? s.settings[id]?.ssh?.machine : null) ?? hostLabel(host);
          if (id) set((st) => ({ startupNotes: { ...st.startupNotes, [id]: `${AGENT_INSTALL_NOTE}${machine}: ${typeof e === "string" ? e : String(e)}` } }));
        }
        // The tile may have closed while that install call was in flight: `wanted` above is a
        // snapshot taken at entry, so check the live state before acting on it further.
        if (await bailIfUnwanted(host)) continue;
      }
      if (!agentWatch.watching.has(host) && !agentWatch.retry.has(host)) {
        agentWatch.watching.add(host);
        try {
          agentWatch.startedAt.set(host, Date.now());
          agentWatch.gen.set(host, await ipc.agentsWatch(host));
        } catch {
          agentWatch.watching.delete(host);
          scheduleAgentRewatch(host);
          continue;
        }
        if (await bailIfUnwanted(host)) continue;
      }
    }
  },

  async agentWatchEnded(payload) {
    const { host } = payload;
    // An end from a watcher we already replaced says nothing about the one running now.
    if (payload.gen !== agentWatch.gen.get(host)) return;
    agentWatch.gen.delete(host);
    agentWatch.watching.delete(host);
    ipc.agentsUnwatch(host).catch(() => {});
    const lived = Date.now() - (agentWatch.startedAt.get(host) ?? 0);
    if (lived > (agentWatch.delay.get(host) ?? 0)) agentWatchSurvived(host);
    if (host !== null && !(await agentTilesStillLive(host))) return;
    if (wantedAgentHosts(useStore.getState()).has(host)) scheduleAgentRewatch(host);
  },

  async checkForUpdates(opts) {
    const manual = opts?.manual === true;
    const { status, version: known, failedAt: wasFailedAt, error: wasError } = useStore.getState().update;
    // A check in flight, a download running, or an update already staged on disk: asking again
    // would either duplicate the request or throw away a package we have already paid for.
    if (status === "checking" || status === "downloading" || status === "ready") return;
    // A download that broke is the only thing the notice tells the user about, and a background
    // check failing on top of it must not relabel it - an unasked-for check failure renders
    // nothing, so the "could not update" would simply vanish. A check they asked for answers for
    // itself. Captured here because the line below clears the error we would have to restore.
    const keepInstallFailure = wasFailedAt === "install" && !manual;
    set((s) => ({ update: { ...s.update, status: "checking", error: null, manual } }));
    let found: Awaited<ReturnType<typeof updater.check>>;
    try {
      found = await updater.check();
    } catch (e) {
      const msg = errText(e);
      console.warn("swarmz: update check failed:", msg);
      set((s) => ({
        update: {
          ...s.update,
          status: "failed",
          failedAt: keepInstallFailure ? "install" : "check",
          error: keepInstallFailure ? wasError : msg,
          checkedAt: new Date().toISOString(),
        },
      }));
      return;
    }
    const checkedAt = new Date().toISOString();
    if (!found) {
      set((s) => ({ update: { ...EMPTY_UPDATE, manual: s.update.manual, checkedAt } }));
      return;
    }
    set((s) => ({
      update: {
        ...s.update,
        status: "available",
        failedAt: null,
        version: found.version,
        notes: found.notes,
        error: null,
        downloaded: 0,
        contentLength: null,
        checkedAt,
        // A version we have not already been told about is worth showing again.
        dismissed: s.update.dismissed && found.version === known,
      },
    }));
  },

  async installUpdate() {
    const { status, version, failedAt } = useStore.getState().update;
    if (!version) return;
    if (status !== "available" && status !== "failed") return;
    // A check that never got an answer left no package to resume; only a failed download can be
    // retried by installing again.
    if (status === "failed" && failedAt !== "install") return;
    set((s) => ({
      update: { ...s.update, status: "downloading", failedAt: null, error: null, downloaded: 0, contentLength: null },
    }));
    try {
      await updater.install((p) =>
        set((s) => (s.update.status === "downloading" ? { update: { ...s.update, ...p } } : {})),
      );
    } catch (e) {
      const msg = errText(e);
      console.warn("swarmz: update download failed:", msg);
      set((s) => ({ update: { ...s.update, status: "failed", failedAt: "install", error: msg } }));
      return;
    }
    set((s) => ({ update: { ...s.update, status: "ready", failedAt: null, error: null } }));
    try {
      await updater.relaunch();
    } catch (e) {
      // The new version is installed either way; the user restarting by hand gets it, and the
      // holders keep every session alive meanwhile.
      const msg = errText(e);
      console.warn("swarmz: relaunch failed:", msg);
      set((s) => ({ update: { ...s.update, error: msg } }));
    }
  },

  dismissUpdate() {
    set((s) => ({ update: { ...s.update, dismissed: true, manual: false } }));
  },
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Non-null exactly while a save (the body `runSave` runs, whether invoked by the debounce
 * timer or flushed early) is actually writing/pushing. `flushPendingSave` awaits this instead
 * of racing a second save past it. */
let savePromise: Promise<void> | null = null;

/** Last mtime this app observed for workspace.json (via our own save or a stat poll), used to
 * tell "someone else wrote the file" apart from silence. Reset for tests via `__resetSyncState`. */
let lastSeenMtime: number | null = null;

/**
 * Serialises the operations that reconcile the running app against a whole workspace snapshot
 * (adoption and reload). Both close terminals, open the missing ones and rebuild the layout across
 * many awaits; running two at once double-opens defs and leaves duplicates in `order`. Each queued
 * body runs only after the previous one has settled (failures do not stall the queue).
 */
let syncOp: Promise<void> = Promise.resolve();

/**
 * Whether a pull has completed since this app started (with sync enabled). Until it has, a
 * machine that has never synced must not push: its file would reach the peers before it has seen
 * theirs, and the first-sync union — which exists so that its local terminals survive meeting a
 * peer's workspace — would merge its own copy back into itself. `runSave` therefore saves
 * locally but skips the push in that window; the union's own save, which happens after the pull,
 * is the first thing this machine sends out.
 */
let firstPullDone = false;

/**
 * Whether the workspace this app started from had no `sync` block at all (or there was no file):
 * this machine has never taken part in the sync. Latched at load rather than re-derived from
 * `syncMeta`, because the first held-back save writes a `sync` block — re-deriving would end the
 * hold-back after one save and make the first-sync union unreachable as soon as a debounced save
 * beat the first pull to it.
 */
let neverSyncedAtLoad = false;

function runExclusive(fn: () => Promise<void>): Promise<void> {
  const next = syncOp.then(fn, fn);
  syncOp = next.then(
    () => {},
    () => {},
  );
  return next;
}

export function __resetSyncState() {
  lastSeenMtime = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  savePromise = null;
  syncOp = Promise.resolve();
  firstPullDone = false;
  neverSyncedAtLoad = false;
  requestedNames.clear();
}

/** `toWorkspace` of the live store, without sync metadata — what `sameWorkspaceContent`
 * compares against the file that was adopted. */
function currentWorkspace(): Workspace {
  const s = useStore.getState();
  return toWorkspace({ order: s.order, terminals: persistedTerminals(s.terminals), settings: s.settings, layout: s.fileLayout, machines: s.machines, conductor: s.conductor, conductorClaim: s.conductorClaim, conductors: s.conductors, conductorAt: s.conductorAt, extra: s.workspaceExtra });
}

/**
 * Reconciles the running app with a workspace snapshot: closes terminals absent from it (asking
 * first unless `confirmClose` is false), opens the ones missing here, applies its machines, and
 * records its sync metadata. Shared by `reloadWorkspace` (loading workspace.json by hand) and
 * `adopt` (a newer copy pulled from, or noticed written by, a peer). `scheduleSave` controls
 * whether the reconciled state gets an explicit save afterwards: `reloadWorkspace` wants one
 * (the user asked to reload, and reconciling may have changed regenerated ids/layout/etc that
 * should be persisted); `adopt` does not — the file already *is* this exact state (adopt just
 * wrote it verbatim), so scheduling one would just bump the revision and push it right back to
 * the peer we got it from, which would adopt it and do the same, forever.
 */
async function applyWorkspace(
  ws: Workspace,
  opts: { confirmClose: boolean; scheduleSave: boolean; namesAtStart?: Map<string, string> },
): Promise<void> {
  const wasReady = useStore.getState().persistenceReady;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  useStore.setState({ persistenceReady: false });
  // Machines are applied before openDefs (when the file actually carries a `machines`
  // section) so `openingFor` can resolve a foreign local's ssh user/color from the same file
  // being reconciled to. See the matching comment in `loadWorkspace` for why an absent
  // `machines` key is left alone rather than treated as "clear what we know".
  if (ws.machines !== undefined) {
    const { machines, dropped } = sanitizeMachines(ws.machines);
    useStore.setState({ machines, ...(dropped > 0 ? { persistError: machineDropNote(dropped) } : {}) });
  }
  // The conductor and a claim are whole-file facts: absent means none (the tool and every save
  // write the whole file).
  // Roles newer here than in the file (a tool write this Mac made, or one it took from disk before
  // a peer's older copy arrived) are kept; `adopt`'s drift check then saves them back out, so the
  // peers converge on the newest roles whatever the file's revision says (tree spec §7).
  const incoming = conductorFieldsOf(ws);
  const keepRoles = newerRoles(useStore.getState().conductorAt, incoming.conductorAt);
  useStore.setState({ ...(keepRoles ? {} : incoming), workspaceExtra: workspaceExtra(ws) });
  // What each open terminal was called (as the shared file would spell it) when this operation
  // began — see the rename pass below. `adopt` captures it before its own save, because a user
  // rename made while that save is in flight belongs to the user, not to the file.
  const namesAtStart = opts.namesAtStart ?? effectiveNames();
  // A file can name the same id twice (a truncated push, a hand-merged file); opening it twice
  // would spawn two ptys for one id and list it twice in the sidebar. First mention wins.
  const defs = dedupeById(ws.terminals);
  const wanted = new Set(defs.map((t) => t.id));
  const toClose = useStore.getState().order.filter((id) => !wanted.has(id));
  if (toClose.length > 0) {
    if (opts.confirmClose) {
      const ok = await confirm(`Close ${toClose.length} terminal(s) that are not in workspace.json?`, { title: "Reload workspace" });
      if (!ok) {
        // Nothing changed — restore whatever readiness this started with.
        useStore.setState({ persistenceReady: wasReady });
        return;
      }
    } else {
      // Adoption closes without asking (there is nobody to ask on the machine that pushed), so
      // say what happened in the existing dismissible line rather than letting tiles vanish.
      useStore.setState({
        persistError: `${toClose.length} terminal(s) closed by a workspace update from ${ws.sync?.updatedBy ?? "another machine"}`,
      });
    }
    for (const id of toClose) await useStore.getState().closeTerminal(id);
  }
  const open = new Set(useStore.getState().order);
  useStore.setState({ fileLayout: ws.layout ?? null });
  const { anyFailed } = await openDefs(defs.filter((d) => !open.has(d.id)), useStore.setState, defs);
  // Names travel too. A terminal that was already open keeps the name the registry gave it when
  // it was spawned, so a rename made on another machine would never land here — and then that
  // machine would write "other" and this one would write the old name back, once per round,
  // forever. Defs opened just above already carry the file's name (or a local suffix, recorded
  // by `openDefs`), so only the ones that were open before need this.
  for (const d of defs) {
    if (!open.has(d.id)) continue;
    const live = useStore.getState().terminals[d.id];
    // `namesAtStart`, not the live name: the file only has something new to say when it disagrees
    // with what this terminal was called when the adoption began. If it agrees, a rename the user
    // made while the adoption was in flight is theirs to keep (the post-adoption comparison then
    // saves it); undoing it here would make every adoption quietly revert edits made during it.
    const before = namesAtStart.get(d.id);
    if (!live || before === undefined || before === d.name) continue;
    const err = await useStore.getState().renameTerminal(d.id, d.name);
    // The registry refuses (something else here holds that name): keep the live one and remember
    // what the file asked for, so the difference stays machine-local instead of being written
    // back at the machine that made the rename.
    if (err !== null) requestedNames.set(d.id, d.name);
  }
  // Take the file's terminal order too, not just its layout: `openDefs` appends whatever was
  // missing to the end, so the machine that had to open defs would otherwise list them in a
  // different order from the machine that wrote the file — and `toWorkspace` writes terminals in
  // `order`, so the two machines would keep rewriting each other's file forever. Anything the
  // file does not mention (only possible on the reload path, which keeps unknown terminals after
  // a declined confirm) keeps its place at the end.
  useStore.setState((s) => {
    const present = new Set(s.order);
    const fromFile = defs.map((t) => t.id).filter((id) => present.has(id));
    const known = new Set(fromFile);
    return { order: [...fromFile, ...s.order.filter((id) => !known.has(id))] };
  });
  useStore.setState({ syncMeta: ws.sync ?? null });
  if (!anyFailed) {
    useStore.setState({ persistenceReady: true });
    // openDefs already set persistenceReady true; schedule an explicit save so the
    // reconciled state (regenerated ids, rebuilt layout, etc.) is persisted right away —
    // but only when asked to (see the doc comment above).
    if (opts.scheduleSave) scheduleSave();
  }
}

/** Online tailnet peers this machine can push/pull workspace.json with, resolved to a usable
 * `user@host`; a peer whose host can't be resolved to a valid address is left out. Only macOS
 * peers: a phone, an iPad or a Linux box on the tailnet does not run swarmz, so pushing to it
 * would just time out every round and report a permanent sync error. */
function peerHosts(): { name: string; host: string }[] {
  const s = useStore.getState();
  if (!s.tailscale?.running) return [];
  return s.tailscale.peers
    .filter((p) => p.online && p.os === "macOS")
    .map((p) => ({ name: p.name, host: machineHost(p.name, s.machines[p.name], s.tailscale?.user ?? "") }))
    .filter((p) => validateHost(p.host) === null);
}

async function pushWorkspace(text: string) {
  const peers = peerHosts();
  if (peers.length === 0 || !useStore.getState().sync.enabled) return;
  let ok = 0;
  const failed: string[] = [];
  // In parallel: each push is an ssh round trip with a 10 s timeout, and one unreachable peer
  // should not delay the others (a sequential loop makes every save wait for the slowest).
  const results = await Promise.allSettled(peers.map((p) => ipc.workspacePush(p.host, text)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok += 1;
    else failed.push(`${peers[i].name}: ${typeof r.reason === "string" ? r.reason : String(r.reason)}`);
  });
  useStore.setState((s) => ({
    sync: {
      ...s.sync,
      lastPushAt: new Date().toISOString(),
      peersOk: ok,
      peersTotal: peers.length,
      error: failed.length ? `push failed for ${failed.join("; ")}` : null,
    },
  }));
}

/** Adopts a peer's (or our own file's, per `checkExternalChange`) newer workspace: saves it
 * verbatim so it's the durable copy, then reconciles the running app to match it. */
function adopt(ws: Workspace): Promise<void> {
  return runExclusive(async () => {
    let applied = false;
    useStore.setState((s) => ({ sync: { ...s.sync, adopting: true } }));
    const namesAtStart = effectiveNames();
    try {
      // Nothing pending should be allowed to land after this write.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (savePromise) await savePromise;
      await ipc.saveWorkspace(ws);
      lastSeenMtime = await ipc.workspaceStat().catch(() => null);
      useStore.setState({ syncMeta: ws.sync ?? null });
      // `scheduleSave: false` — the file already is this exact state; see applyWorkspace's doc.
      await applyWorkspace(ws, { confirmClose: false, scheduleSave: false, namesAtStart });
      applied = true;
    } finally {
      useStore.setState((s) => ({ sync: { ...s.sync, adopting: false } }));
      // Edits made while `adopting` was set were deliberately not scheduled for saving (the
      // subscription ignores them, since most are the adoption reconciling itself). Anything the
      // user changed in the meantime — a rename, a new tile — would otherwise be lost on the next
      // adoption, so compare the reconciled state with the file we adopted and save if it drifted.
      // `applied` gates this: an adoption that threw before reconciling (the save failed, say)
      // has not produced a state worth writing anywhere.
      if (applied && useStore.getState().persistenceReady && !sameWorkspaceContent(currentWorkspace(), ws)) {
        scheduleSave();
      }
    }
  });
}

/** `adopt` with its failures reported in the sync line instead of thrown: a peer's copy that we
 * cannot save or open must not take down the polling loop that called us. */
/**
 * A file the tool wrote on this Mac (a claim, an approval, a card: `sync.updatedBy` is this
 * machine) is known to nobody else until pushed: the peers would only see it on their next
 * pull, and any save they make before that starts from the old revision and overwrites it.
 * So it is announced right after it is adopted, as a save of ours would be. A peer's copy
 * (another name) is theirs to announce.
 */
async function announceLocalWrite(ws: Workspace) {
  const self = useStore.getState().selfMachine;
  if (!self || !ws.sync || ws.sync.updatedBy !== self) return;
  await pushWorkspace(JSON.stringify(ws, null, 2));
}

async function adoptGuarded(ws: Workspace) {
  try {
    await adopt(ws);
  } catch (e) {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    useStore.setState((s) => ({ sync: { ...s.sync, error: `could not adopt workspace: ${msg}` } }));
  }
}

/** The actual save: bumps and pushes when sync is enabled, otherwise a plain save that leaves
 * an existing `syncMeta` untouched. Run either by the debounce timer (`scheduleSave`) or
 * immediately by `flushPendingSave`; both paths go through this so there is exactly one save
 * implementation to keep in sync with `toWorkspace`/`bumpSync`/`pushWorkspace`. */
function runSave(): Promise<void> {
  if (!useStore.getState().persistenceReady) return Promise.resolve();
  const p = takeNewerRolesFromDisk().then(() => runSaveNow());
  savePromise = p.finally(() => {
    savePromise = null;
  });
  return savePromise;
}

/** Set while roles read from disk are put in the store, so that change schedules no second save. */
let takingDiskRoles = false;

/**
 * The file on disk may hold newer roles than this app (the tool wrote them here, or a peer's push
 * landed, since the last adoption): take them before saving, so a save never writes older roles
 * over newer ones (tree spec §7). A failed read changes nothing.
 */
async function takeNewerRolesFromDisk(): Promise<void> {
  let disk: Awaited<ReturnType<typeof ipc.workspaceRoles>> = null;
  try {
    disk = await ipc.workspaceRoles();
  } catch {
    return;
  }
  if (!disk) return;
  const fields = conductorFieldsOf(disk);
  if (!newerRoles(fields.conductorAt, useStore.getState().conductorAt)) return;
  takingDiskRoles = true;
  try {
    useStore.setState(fields);
  } finally {
    takingDiskRoles = false;
  }
}

function runSaveNow(): Promise<void> {
  if (!useStore.getState().persistenceReady) return Promise.resolve();
  const s = useStore.getState();
  let p: Promise<void>;
  if (s.sync.enabled) {
    const self = s.selfMachine ?? "unknown";
    // A machine that has never synced keeps every save to itself until it has pulled (see
    // `neverSyncedAtLoad`/`firstPullDone`): sending one would pre-empt the first-sync union.
    const holdBack = neverSyncedAtLoad && !firstPullDone;
    const sync = bumpSync(s.syncMeta, self);
    useStore.setState({ syncMeta: sync });
    const ws = toWorkspace({
      order: s.order,
      terminals: persistedTerminals(s.terminals),
      settings: s.settings,
      layout: s.fileLayout,
      machines: s.machines,
      conductor: s.conductor,
      conductorClaim: s.conductorClaim,
      conductors: s.conductors,
      conductorAt: s.conductorAt,
      extra: s.workspaceExtra,
      sync,
    });
    p = ipc
      .saveWorkspace(ws)
      .then(async () => {
        lastSeenMtime = await ipc.workspaceStat().catch(() => null);
        if (!holdBack) await pushWorkspace(JSON.stringify(ws, null, 2));
      })
      .catch((e) => {
        useStore.setState({ persistError: `could not save workspace: ${typeof e === "string" ? e : String(e)}` });
      });
  } else {
    const ws = toWorkspace({
      order: s.order,
      terminals: persistedTerminals(s.terminals),
      settings: s.settings,
      layout: s.fileLayout,
      machines: s.machines,
      conductor: s.conductor,
      conductorClaim: s.conductorClaim,
      conductors: s.conductors,
      conductorAt: s.conductorAt,
      extra: s.workspaceExtra,
      sync: s.syncMeta ?? undefined,
    });
    p = ipc.saveWorkspace(ws).catch((e) => {
      useStore.setState({ persistError: `could not save workspace: ${typeof e === "string" ? e : String(e)}` });
    });
  }
  return p;
}

/** If a debounced save is scheduled, cancel the timer and run it right now instead (awaiting
 * completion); if a save is already in flight, wait for it. Called at the top of
 * `pullWorkspace`/`checkExternalChange` so a local edit is always saved (and its revision
 * bumped) before comparing against a peer or an externally-changed file — otherwise the
 * debounce could fire later and save the pre-adoption state over the adopted copy. */
async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    // A save already in flight must finish first: `runSave` reads `syncMeta` and bumps it, so
    // starting a second one alongside would compute both revisions from the same base and write
    // them in whatever order the two ipc calls happen to complete.
    if (savePromise) await savePromise;
    await runSave();
    return;
  }
  if (savePromise) await savePromise;
}

/**
 * The conductor is changed through the tool (`swarmz conductor --set/--deny/--clear`), the one
 * implementation that also tells the tiles concerned, here or over ssh (conductor spec §3, §6).
 * The tool writes the workspace with a bumped revision, so a save pending here is flushed first
 * (it would otherwise land on top with a stale copy) and the file is adopted afterwards, which
 * is what an external change does anyway; the peers pick it up on their next pull. When the file
 * cannot be read back the fields are set from the tool's reply so the sidebar is right at once.
 */
async function conductorViaTool(args: ["set", string] | ["deny"] | ["clear"] | ["sub", string, string] | ["assign", string, string] | ["remove", string]): Promise<void> {
  await flushPendingSave();
  const reply =
    args[0] === "sub" || args[0] === "assign"
      ? await ipc.conductorAction(args[0], args[1], args[2])
      : await ipc.conductorAction(args[0], args[0] === "set" || args[0] === "remove" ? args[1] : undefined);
  // The reply first: if the file on disk has meanwhile been overwritten by a peer's older copy,
  // adopting that file keeps these newer roles rather than the file's (tree spec §7).
  applyRolesReply(reply);
  const ws = await ipc.loadWorkspace().catch(() => null);
  if (ws && isNewer(ws.sync, useStore.getState().syncMeta)) {
    lastSeenMtime = await ipc.workspaceStat().catch(() => null);
    await adoptGuarded(ws);
    await announceLocalWrite(ws);
  }
}

/**
 * The tool's reply is the roles it just wrote: newer than the store's unless something newer has
 * arrived since, in which case the store's stand. Taking them schedules a save, which carries them
 * to the peers even if the file on disk has meanwhile been overwritten by an older copy.
 */
function applyRolesReply(reply: { conductor: string | null; conductors?: unknown; claim: unknown; conductorAt?: unknown }) {
  const fields = conductorFieldsOf({ conductor: reply.conductor, conductors: reply.conductors, conductorClaim: reply.claim, conductorAt: reply.conductorAt });
  const local = useStore.getState().conductorAt;
  if (fields.conductorAt ? newerRoles(fields.conductorAt, local) || fields.conductorAt === local : !local) useStore.setState(fields);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void runSave();
  }, SAVE_DEBOUNCE_MS);
}

useStore.subscribe((s, prev) => {
  if (!s.persistenceReady) return;
  // While adopting, every state change is the adoption reconciling itself (openDefs rebuilding
  // `settings`/`terminals`/etc. references) to a file that's already durable — scheduling a
  // save here would re-bump the revision and push it right back to the peer we just adopted
  // from, which would adopt that and do the same, forever.
  if (s.sync.adopting || takingDiskRoles) return;
  if (
    s.terminals !== prev.terminals ||
    s.order !== prev.order ||
    s.settings !== prev.settings ||
    s.machines !== prev.machines ||
    s.conductor !== prev.conductor ||
    s.conductorClaim !== prev.conductorClaim ||
    s.conductors !== prev.conductors
  ) {
    scheduleSave();
  }
});

useStore.subscribe((s, prev) => {
  // Watchers, the watchdog and the Telegram follower are the main window's; another window only mirrors.
  if (s.windowLabel !== MAIN) return;
  if (s.sshConnected !== prev.sshConnected || s.order !== prev.order) void s.ensureAgentWatchers();
});

// This Mac's trees are its own (windows and layouts spec §2): kept per Mac, never in the file.
useStore.subscribe((s, prev) => {
  if (s.windowLabel !== MAIN || (s.layout === prev.layout && s.windows === prev.windows)) return;
  if (layoutsLoaded) saveLayouts(layoutsOf(s));
  // A window whose tree emptied closes (its tiles moved elsewhere, or it was closed).
  for (const label of Object.keys(prev.windows)) if (!s.windows[label]) windowHooks.close(label);
});

useStore.subscribe((s, prev) => {
  if (s.windowLabel !== MAIN) return;
  if (s.sshConnected === prev.sshConnected && s.order === prev.order && s.terminals === prev.terminals && s.settings === prev.settings) return;
  syncWatchdog(s);
  const reconnected = Object.keys(s.sshDropped).filter((id) => s.sshConnected[id] || !s.terminals[id]);
  if (reconnected.length > 0) useStore.setState((st) => ({ sshDropped: reconnected.reduce((acc, id) => omit(acc, id), st.sshDropped) }));
});

useStore.subscribe((s, prev) => {
  if (s.windowLabel !== MAIN || s.terminals === prev.terminals) return;
  for (const id of Object.keys(prev.terminals)) if (!(id in s.terminals)) forgetAttach(id);
});

/** Whether `id` is a conductor: the top, or a sub-conductor whose chain reaches it (conductor tree spec §2). */
export function isConductorTile(s: Pick<WorkbenchState, "conductor" | "conductors">, id: string): boolean {
  return s.conductor === id || id in liveSubs(s.conductor, s.conductors);
}

/** The conductor `id` answers to, as the tool decides it; null for the top or with no top. */
export function conductorFor(s: Pick<WorkbenchState, "conductor" | "conductors">, id: string): string | null {
  return conductorOwner(s.conductor, s.conductors, id);
}

/** The sub-conductors with tile `id` gone: its own entry (its tiles go to the top) and any listing of it. */
function withoutTile(subs: SubConductors, id: string): SubConductors {
  const out: SubConductors = {};
  for (const [sid, sub] of Object.entries(subs)) {
    if (sid === id) continue;
    out[sid] = sub.tiles.includes(id) ? { ...sub, tiles: sub.tiles.filter((t) => t !== id) } : sub;
  }
  return out;
}

/**
 * Whether this Mac should run the Telegram follower (conductor spec §5): Telegram is set up,
 * and the conductor is a tile whose shell runs here (not ssh, not a foreign local) and has not
 * exited. Every other Mac leaves it to the conductor's home.
 */
export function telegramFollowWanted(s: Pick<WorkbenchState, "telegramConfigured" | "conductor" | "terminals" | "settings">): boolean {
  if (!s.telegramConfigured || !s.conductor) return false;
  const t = s.terminals[s.conductor];
  const st = s.settings[s.conductor];
  if (!t || t.exited !== null || !st) return false;
  return !st.ssh && !st.foreign;
}

let telegramFollowing = false;
useStore.subscribe((s, prev) => {
  if (s.windowLabel !== MAIN) return;
  if (s.telegramConfigured === prev.telegramConfigured && s.conductor === prev.conductor && s.terminals === prev.terminals && s.settings === prev.settings) return;
  const wanted = telegramFollowWanted(s);
  if (wanted === telegramFollowing) return;
  telegramFollowing = wanted;
  ipc.telegramFollow(wanted).catch(() => {
    telegramFollowing = !wanted;
  });
});
