import { create } from "zustand";
import { homeDir } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc, type TerminalInfo, type TailscaleStatus } from "./lib/ipc";
import {
  addTab,
  allGroups,
  findGroup,
  findGroupOf,
  moveToGroup,
  removeTerminal,
  resizeSplit as resizeSplitNode,
  setActive,
  splitWith,
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
  reconcileLayout,
  sameWorkspaceContent,
  sanitizeLayout,
  startupIsSsh,
  startupLine,
  startupSteps,
  toWorkspace,
  touchMachine,
  validateAlias,
  validateHost,
  validateUser,
  MACHINES_MAX,
  type MachineConfig,
  type Machines,
  type SyncMeta,
  type TerminalSettings,
  type TerminalDef,
  type Workspace,
} from "./lib/workspace";
import { applyAgentEvent as foldAgentEvent, OFFLINE, type AgentState } from "./lib/agentState";
import type { AgentEventPayload } from "./lib/ipc";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const SAVE_DEBOUNCE_MS = 500;

export const SSH_POLL_MS = 500;
export const SSH_POLL_TIMEOUT_MS = 120_000;
export const SSH_SETTLE_MS = 300;

export const SYNC_PULL_MS = 30_000;
export const SYNC_STAT_MS = 5_000;

/** When this app run started: hook events older than this are replay from before launch. */
export let APP_LAUNCHED_AT = new Date().toISOString();
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

/**
 * Evidence that the watcher for `host` really ran: an event from it, or a watcher that outlived
 * the wait that started it. `agents_watch` resolving is not evidence — the core resolves it as
 * soon as it has spawned `tail`/`ssh`, long before ssh has connected — so an unreachable host
 * would otherwise reset its backoff on every hop and never escalate.
 */
function agentWatchSurvived(host: string | null) {
  agentWatch.attempts.delete(host);
  agentWatch.delay.delete(host);
  if (host === null && useStore.getState().agentHooksError === AGENT_UNAVAILABLE_LOCAL) {
    useStore.setState({ agentHooksError: null });
  }
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
        useStore.setState((st) => ({ startupNotes: { ...st.startupNotes, [id]: `agent state unavailable for ${machine}` } }));
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
} = {
  hook: async () => {},
  size: () => null,
};

/** Where a new terminal goes: a tab in a tile, or a new tile beside one. */
export type Placement =
  | { kind: "tab"; groupId: string }
  | { kind: "split"; groupId: string; side: Side };

/** What a new SSH terminal connects to. Claude, when set, gets a fresh session. */
export interface SshTerminalOptions {
  host: string;
  cwd?: string | null;
  claude?: { skipPermissions: boolean } | null;
  name?: string;
  machine?: string | null;
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
  machines: Machines;
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
  windowFocused: boolean;

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
  updateSettings(id: string, patch: Partial<TerminalSettings>): void;
  runStartup(id: string): Promise<void>;
  runRemoteStep(id: string): Promise<void>;
  cancelConnecting(id: string): void;
  chooseRemoteDir(id: string, path: string): Promise<void>;
  skipStartup(id: string): void;
  dismissPersistError(): void;
  refreshTailscale(): Promise<void>;
  updateMachine(name: string, patch: { alias?: string | null; user?: string | null; color?: string | null }): Promise<string | null>;
  applyAgentEvent(payload: AgentEventPayload): void;
  setWindowFocused(focused: boolean): void;
  installAgentHooks(): Promise<void>;
  ensureAgentWatchers(): Promise<void>;
  agentWatchEnded(payload: { host: string | null; gen: number }): void;
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
    if (!strOrNullOk("alias") || !strOrNullOk("user") || !strOrNullOk("cwd")) {
      dropped += 1;
      continue;
    }
    if (!isMachineColor(v.color as string | null | undefined)) {
      dropped += 1;
      continue;
    }
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

function focusFor(layout: Layout, termId: string | null) {
  if (!termId) return { focusedGroupId: null, focusedTerminalId: null };
  const g = findGroupOf(layout, termId);
  return { focusedGroupId: g?.id ?? null, focusedTerminalId: g ? termId : null };
}

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

const KNOWN_DEF_KEYS = new Set(["id", "name", "cwd", "ssh", "claude", "command", "origin"]);

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
  // settings (ssh, claude, command, ..., extra, origin) — openDefs' bulk pass compares settings
  // with JSON.stringify to decide whether an already-open terminal's startup bar should
  // re-arm, and that comparison is key-order sensitive.
  const { origin, ...rest } = opening.settings;
  return { settings: { ...rest, extra: extraFromDef(d), origin: origin ?? self ?? null }, note: opening.note };
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

async function openDefs(
  defs: TerminalDef[],
  savedLayout: Layout,
  set: SetState,
  allDefs: TerminalDef[] = defs,
): Promise<{ anyFailed: boolean }> {
  const preOpenIds = new Set(useStore.getState().order);
  const normalized = new Map(allDefs.map((d) => [d.id, regenerateIfUnsafe(d)]));
  const { selfMachine, machines, tailscale } = useStore.getState();
  const defaultUser = tailscale?.user ?? "";
  const known = knownMachineNames();
  let failedCount = 0;
  for (const def of defs) {
    const { def: regenerated, note: unsafeNote } = normalized.get(def.id) ?? regenerateIfUnsafe(def);
    try {
      const opening = openingFor(regenerated, selfMachine, machines, defaultUser, known);
      const { info, note } = await spawnDef({ ...regenerated, cwd: opening.cwd ?? (await homeDir()) });
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
      const sanitizedLayout = sanitizeLayout(savedLayout);
      const layoutWasInvalid = savedLayout !== null && sanitizedLayout === null;
      const layout = reconcileLayout(sanitizedLayout, s.order);
      const startupPending: Record<string, boolean> = { ...s.startupPending };
      for (const id of s.order) {
        const wasOpenBefore = preOpenIds.has(id);
        const changed = !wasOpenBefore || JSON.stringify(settings[id]) !== JSON.stringify(s.settings[id]);
        if (changed) startupPending[id] = startupLine(settings[id] ?? EMPTY_SETTINGS) !== null;
      }
      const keep =
        s.focusedTerminalId && findGroupOf(layout, s.focusedTerminalId)
          ? s.focusedTerminalId
          : (allGroups(layout)[0]?.active ?? null);
      const persistError =
        failedCount > 0
          ? `${failedCount} terminal(s) could not be opened; saving is paused until a successful Reload`
          : layoutWasInvalid
            ? "layout in workspace.json was invalid and was rebuilt"
            : s.persistError;
      return {
        settings,
        startupNotes,
        layout,
        startupPending,
        persistenceReady: failedCount === 0,
        persistError,
        ...focusFor(layout, keep),
      };
    } catch (e) {
      const layout = reconcileLayout(null, s.order);
      const keep =
        s.focusedTerminalId && findGroupOf(layout, s.focusedTerminalId)
          ? s.focusedTerminalId
          : (allGroups(layout)[0]?.active ?? null);
      return {
        layout,
        persistenceReady: false,
        persistError: `could not reconcile workspace: ${typeof e === "string" ? e : String(e)}`,
        ...focusFor(layout, keep),
      };
    }
  });
  return { anyFailed: failedCount > 0 };
}

async function safeSshCheck(host: string): Promise<boolean> {
  try {
    return await ipc.sshCheck(host);
  } catch {
    return false;
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

const pollers = new Map<string, { timer: ReturnType<typeof setInterval>; started: number; busy: boolean; staleForeground: number }>();

function stopPolling(id: string) {
  const p = pollers.get(id);
  if (p) {
    clearInterval(p.timer);
    pollers.delete(id);
  }
}

export function __stopAllPolling() {
  for (const id of Array.from(pollers.keys())) stopPolling(id);
}

function startPolling(id: string, host: string) {
  stopPolling(id);
  useStore.setState((s) => ({ sshConnecting: { ...s.sshConnecting, [id]: true }, sshConnected: omit(s.sshConnected, id) }));
  const entry = { timer: setInterval(() => void tick(), SSH_POLL_MS), started: Date.now(), busy: false, staleForeground: 0 };
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
        useStore.setState((s) => ({
          sshConnecting: omit(s.sshConnecting, id),
          startupPending: { ...s.startupPending, [id]: true },
          startupNotes: { ...s.startupNotes, [id]: "ssh exited before connecting; click Run to try again" },
        }));
      }
      return;
    }
    entry.staleForeground = 0;
    stopPolling(id);
    useStore.setState((s) => ({ sshConnected: { ...s.sshConnected, [id]: true }, sshConnecting: omit(s.sshConnecting, id) }));
    await new Promise((r) => setTimeout(r, SSH_SETTLE_MS));
    await useStore.getState().runRemoteStep(id);
  }
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
  machines: {},
  tailscale: null,
  tailscaleError: null,
  selfMachine: null,
  syncMeta: null,
  sync: { enabled: false, lastPullAt: null, lastPushAt: null, peersOk: 0, peersTotal: 0, error: null, adopting: false },
  agentState: {},
  agentHooksError: null,
  windowFocused: true,

  async createTerminal(cwd, placement) {
    const id = crypto.randomUUID();
    await beforeSpawn.hook(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const info = await ipc.createTerminal(id, cwd, dims.cols, dims.rows);
    const origin = useStore.getState().selfMachine ?? null;
    set((s) => {
      const groupId = placement?.groupId ?? s.focusedGroupId;
      let layout = addTab(s.layout, info.id, groupId);
      if (placement?.kind === "split") {
        layout = splitWith(layout, placement.groupId, info.id, placement.side);
      }
      return {
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        layout,
        lastCwd: cwd,
        settings: { ...s.settings, [info.id]: { ...EMPTY_SETTINGS, origin } },
        startupPending: { ...s.startupPending, [info.id]: false },
        ...focusFor(layout, info.id),
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
      const groupId = placement?.groupId ?? s.focusedGroupId;
      let layout = addTab(s.layout, info.id, groupId);
      if (placement?.kind === "split") {
        layout = splitWith(layout, placement.groupId, info.id, placement.side);
      }
      return {
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        layout,
        settings: { ...s.settings, [info.id]: settings },
        startupPending: { ...s.startupPending, [info.id]: true },
        machines: machineName ? touchMachine(s.machines, machineName, rememberedOrGivenCwd ? { cwd: rememberedOrGivenCwd } : {}) : s.machines,
        ...focusFor(layout, info.id),
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
    await ipc.closeTerminal(id);
    set((s) => {
      const terminals = { ...s.terminals };
      delete terminals[id];
      const homeGroupId = findGroupOf(s.layout, id)?.id ?? null;
      const layout = removeTerminal(s.layout, id);
      const stillFocused = s.focusedTerminalId && s.focusedTerminalId !== id ? s.focusedTerminalId : null;
      const fallback =
        stillFocused ??
        (homeGroupId && findGroup(layout, homeGroupId)?.active) ??
        allGroups(layout)[0]?.active ??
        null;
      return {
        terminals,
        order: s.order.filter((t) => t !== id),
        layout,
        settings: omit(s.settings, id),
        startupPending: omit(s.startupPending, id),
        startupNotes: omit(s.startupNotes, id),
        sshConnected: omit(s.sshConnected, id),
        sshConnecting: omit(s.sshConnecting, id),
        agentState: omit(s.agentState, id),
        ...focusFor(layout, fallback),
      };
    });
  },

  async restartTerminal(id) {
    stopPolling(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const info = await ipc.restartTerminal(id, dims.cols, dims.rows);
    set((s) => ({
      terminals: { ...s.terminals, [id]: info },
      startupPending: { ...s.startupPending, [id]: startupLine(s.settings[id] ?? EMPTY_SETTINGS) !== null },
      sshConnected: omit(s.sshConnected, id),
      sshConnecting: omit(s.sshConnecting, id),
      agentState: s.agentState[id] ? { ...s.agentState, [id]: OFFLINE } : s.agentState,
    }));
    // The fit addon only fires onResize when dimensions change, so if the
    // new PTY already matches dims (e.g. same terminal, no relayout since
    // exit) it would never be resized without this explicit call.
    void ipc.resizeTerminal(id, dims.cols, dims.rows).catch(() => {});
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
    set((s) => {
      const g = findGroupOf(s.layout, id);
      if (!g) return {};
      const layout = setActive(s.layout, g.id, id);
      const cur = s.agentState[id];
      const agentState = s.windowFocused && cur?.unseen ? { ...s.agentState, [id]: { ...cur, unseen: false } } : s.agentState;
      return { layout, focusedGroupId: g.id, focusedTerminalId: id, agentState };
    });
  },

  focusGroup(groupId) {
    set((s) => {
      const group = allGroups(s.layout).find((g) => g.id === groupId);
      const id = group?.active ?? null;
      const cur = id ? s.agentState[id] : undefined;
      const agentState = id && s.windowFocused && cur?.unseen ? { ...s.agentState, [id]: { ...cur, unseen: false } } : s.agentState;
      return { focusedGroupId: groupId, focusedTerminalId: id, agentState };
    });
  },

  moveTerminal(id, groupId) {
    set((s) => {
      const layout = moveToGroup(s.layout, id, groupId);
      return { layout, ...focusFor(layout, id) };
    });
  },

  splitTerminal(id, targetGroupId, side) {
    set((s) => {
      const layout = splitWith(s.layout, targetGroupId, id, side);
      return { layout, ...focusFor(layout, id) };
    });
  },

  resizeSplit(splitId, sizes) {
    set((s) => ({ layout: resizeSplitNode(s.layout, splitId, sizes) }));
  },

  setDragging(id) {
    set({ draggingTerminalId: id });
  },

  async loadWorkspace() {
    if (loadStarted) return;
    loadStarted = true;
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
    // openDefs sets persistenceReady itself: true when every def opened cleanly, false
    // (with a persistError) if any failed, so a partial load never gets overwritten by a save.
    await openDefs(ws.terminals, ws.layout, set);
    set({ syncMeta: ws.sync ?? null });
    lastSeenMtime = await ipc.workspaceStat().catch(() => null);
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
    const s = useStore.getState();
    if (s.sshConnecting[id]) return;
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    const steps = startupSteps(settings, id);
    if (steps.length === 0) return;
    const isSsh = startupIsSsh(settings);
    const host = settings.ssh?.host?.trim();
    if (isSsh && host && (await tileLive(id, host))) {
      // This tile's ssh is already live (e.g. Run was clicked again right after connecting,
      // before the bar updated): don't retype the ssh line, just proceed to the remote step.
      if (!useStore.getState().terminals[id]) return;
      set((st) => ({
        sshConnected: { ...st.sshConnected, [id]: true },
        sshConnecting: omit(st.sshConnecting, id),
        startupPending: { ...st.startupPending, [id]: false },
        startupNotes: omit(st.startupNotes, id),
      }));
      await useStore.getState().runRemoteStep(id);
      return;
    }
    await ipc.writeTerminal(id, steps[0].line + "\r");
    set((st) => {
      if (!st.terminals[id]) return {};
      return {
        startupPending: { ...st.startupPending, [id]: false },
        startupNotes: omit(st.startupNotes, id),
      };
    });
    if (isSsh && host) startPolling(id, host);
  },

  async runRemoteStep(id) {
    const s = useStore.getState();
    if (!s.sshConnected[id] || !s.terminals[id]) return;
    const remote = startupSteps(s.settings[id] ?? EMPTY_SETTINGS, id).find((st) => st.via === "remote");
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
    set((st) => {
      if (!st.terminals[id]) return {};
      return { startupPending: { ...st.startupPending, [id]: false } };
    });
  },

  cancelConnecting(id) {
    stopPolling(id);
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
    const before = useStore.getState();
    const oldLabel = machineLabel(name, before.machines[name]);
    const cleaned = {
      ...(patch.alias !== undefined ? { alias: patch.alias?.trim() || null } : {}),
      ...(patch.user !== undefined ? { user: patch.user?.trim() || null } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
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

  applyAgentEvent({ host, event }) {
    // The log reached us, so whatever watcher is tailing it is up.
    agentWatchSurvived(host);
    set((s) => {
      const id = event.terminal;
      if (!s.terminals[id]) return {};
      const settings = s.settings[id] ?? EMPTY_SETTINGS;
      // Replay from before this run: a Claude in one of our own PTYs died with the app, so only a
      // remote's (possibly still alive elsewhere) history counts.
      if (event.ts < APP_LAUNCHED_AT && !settings.ssh) return {};
      const focused = s.windowFocused && s.focusedTerminalId === id;
      const next = foldAgentEvent(s.agentState[id], event, focused);
      const patch: Partial<WorkbenchState> = {};
      if (next) patch.agentState = { ...s.agentState, [id]: next };
      // The first prompt is what makes a session resumable: only now is `--resume` valid.
      const c = settings.claude;
      if (event.event === "UserPromptSubmit" && c?.enabled && !c.started && event.sessionId === c.sessionId) {
        patch.settings = { ...s.settings, [id]: { ...settings, claude: { ...c, started: true } } };
      }
      return patch;
    });
  },

  setWindowFocused(focused) {
    set((s) => {
      const id = s.focusedTerminalId;
      const cur = id ? s.agentState[id] : undefined;
      if (!focused || !id || !cur?.unseen) return { windowFocused: focused };
      return { windowFocused: focused, agentState: { ...s.agentState, [id]: { ...cur, unseen: false } } };
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
        } catch (e) {
          agentWatch.installed.delete(host);
          const machine = (id ? s.settings[id]?.ssh?.machine : null) ?? hostLabel(host);
          if (id) set((st) => ({ startupNotes: { ...st.startupNotes, [id]: `could not install Claude hooks on ${machine}: ${typeof e === "string" ? e : String(e)}` } }));
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

  agentWatchEnded(payload) {
    const { host } = payload;
    // An end from a watcher we already replaced says nothing about the one running now.
    if (payload.gen !== agentWatch.gen.get(host)) return;
    agentWatch.gen.delete(host);
    agentWatch.watching.delete(host);
    ipc.agentsUnwatch(host).catch(() => {});
    const lived = Date.now() - (agentWatch.startedAt.get(host) ?? 0);
    if (lived > (agentWatch.delay.get(host) ?? 0)) agentWatchSurvived(host);
    if (wantedAgentHosts(useStore.getState()).has(host)) scheduleAgentRewatch(host);
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
  return toWorkspace({ order: s.order, terminals: persistedTerminals(s.terminals), settings: s.settings, layout: s.layout, machines: s.machines });
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
  const { anyFailed } = await openDefs(defs.filter((d) => !open.has(d.id)), ws.layout, useStore.setState, defs);
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
      layout: s.layout,
      machines: s.machines,
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
      layout: s.layout,
      machines: s.machines,
      sync: s.syncMeta ?? undefined,
    });
    p = ipc.saveWorkspace(ws).catch((e) => {
      useStore.setState({ persistError: `could not save workspace: ${typeof e === "string" ? e : String(e)}` });
    });
  }
  savePromise = p.finally(() => {
    savePromise = null;
  });
  return savePromise;
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
  if (s.sync.adopting) return;
  if (
    s.terminals !== prev.terminals ||
    s.order !== prev.order ||
    s.layout !== prev.layout ||
    s.settings !== prev.settings ||
    s.machines !== prev.machines
  ) {
    scheduleSave();
  }
});

useStore.subscribe((s, prev) => {
  if (s.sshConnected !== prev.sshConnected || s.order !== prev.order) void s.ensureAgentWatchers();
});
