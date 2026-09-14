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
  openingFor,
  pickNewest,
  reconcileLayout,
  sanitizeLayout,
  startupIsSsh,
  startupLine,
  startupSteps,
  startupUsesClaude,
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

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const SAVE_DEBOUNCE_MS = 500;

export const SSH_POLL_MS = 500;
export const SSH_POLL_TIMEOUT_MS = 120_000;
export const SSH_SETTLE_MS = 300;

export const SYNC_PULL_MS = 30_000;
export const SYNC_STAT_MS = 5_000;

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
function settingsFromDef(d: TerminalDef, self: string | null, machines: Machines, user: string): TerminalSettings {
  const opening = openingFor(d, self, machines, user);
  // `origin` is pulled out and re-added last (after `extra`) rather than left wherever
  // `openingFor` placed it, so this always produces the same key order as `EMPTY_SETTINGS`-based
  // settings (ssh, claude, command, ..., extra, origin) — openDefs' bulk pass compares settings
  // with JSON.stringify to decide whether an already-open terminal's startup bar should
  // re-arm, and that comparison is key-order sensitive.
  const { origin, ...rest } = opening.settings;
  return { ...rest, extra: extraFromDef(d), origin: origin ?? self ?? null };
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
  let failedCount = 0;
  for (const def of defs) {
    const { def: regenerated, note: unsafeNote } = normalized.get(def.id) ?? regenerateIfUnsafe(def);
    try {
      const opening = openingFor(regenerated, selfMachine, machines, defaultUser);
      const { info, note } = await spawnDef({ ...regenerated, cwd: opening.cwd ?? (await homeDir()) });
      const startupNote = unsafeNote ?? note;
      const settings = settingsFromDef(regenerated, selfMachine, machines, defaultUser);
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
          settings[id] = settingsFromDef(d, selfMachine, machines, defaultUser);
          if (note) startupNotes = { ...startupNotes, [id]: note };
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
    }));
    // The fit addon only fires onResize when dimensions change, so if the
    // new PTY already matches dims (e.g. same terminal, no relayout since
    // exit) it would never be resized without this explicit call.
    void ipc.resizeTerminal(id, dims.cols, dims.rows).catch(() => {});
  },

  async renameTerminal(id, name) {
    try {
      const info = await ipc.renameTerminal(id, name);
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
      };
    });
  },

  focusTerminal(id) {
    set((s) => {
      const g = findGroupOf(s.layout, id);
      if (!g) return {};
      const layout = setActive(s.layout, g.id, id);
      return { layout, focusedGroupId: g.id, focusedTerminalId: id };
    });
  },

  focusGroup(groupId) {
    set((s) => {
      const group = allGroups(s.layout).find((g) => g.id === groupId);
      return { focusedGroupId: groupId, focusedTerminalId: group?.active ?? null };
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
    let ws: Awaited<ReturnType<typeof ipc.loadWorkspace>> = null;
    try {
      ws = await ipc.loadWorkspace();
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      set({ persistError: `${msg} — saving is paused until a successful Reload`, persistenceReady: false });
      return;
    }
    if (!ws) {
      set({ persistenceReady: true });
      return;
    }
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
    await applyWorkspace(ws, { confirmClose: true, scheduleSave: true });
  },

  async pullWorkspace() {
    const s = useStore.getState();
    if (!s.sync.enabled || s.sync.adopting) return;
    // Save (and revision-bump) any local edit before comparing against peers, so a pending
    // debounced save can never land after — and clobber — an adoption below.
    await flushPendingSave();
    const peers = peerHosts();
    const cands: Workspace[] = [];
    let ok = 0;
    const failed: string[] = [];
    for (const p of peers) {
      try {
        const text = await ipc.workspacePull(p.host);
        ok += 1;
        if (text) {
          const parsed = JSON.parse(text) as Workspace;
          if (parsed && typeof parsed === "object" && parsed.sync) cands.push(parsed);
        }
      } catch (e) {
        failed.push(`${p.name}: ${typeof e === "string" ? e : String(e)}`);
      }
    }
    set((st) => ({
      sync: {
        ...st.sync,
        lastPullAt: new Date().toISOString(),
        peersOk: ok,
        peersTotal: peers.length,
        error: failed.length ? `pull failed for ${failed.join("; ")}` : null,
      },
    }));
    const best = pickNewest(cands);
    if (best && isNewer(best.sync, useStore.getState().syncMeta)) await adopt(best);
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
    lastSeenMtime = mtime;
    let ws: Workspace | null = null;
    try {
      ws = await ipc.loadWorkspace();
    } catch {
      return;
    }
    if (ws && isNewer(ws.sync, useStore.getState().syncMeta)) await adopt(ws);
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
    const steps = startupSteps(settings);
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
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = !isSsh && startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return {
        settings: { ...st.settings, [id]: { ...cur, claude } },
        startupPending: { ...st.startupPending, [id]: false },
        startupNotes: omit(st.startupNotes, id),
      };
    });
    if (isSsh && host) startPolling(id, host);
  },

  async runRemoteStep(id) {
    const s = useStore.getState();
    if (!s.sshConnected[id] || !s.terminals[id]) return;
    const remote = startupSteps(s.settings[id] ?? EMPTY_SETTINGS).find((st) => st.via === "remote");
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
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return { settings: { ...st.settings, [id]: { ...cur, claude } }, startupPending: { ...st.startupPending, [id]: false } };
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
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Non-null exactly while a save (the body `runSave` runs, whether invoked by the debounce
 * timer or flushed early) is actually writing/pushing. `flushPendingSave` awaits this instead
 * of racing a second save past it. */
let savePromise: Promise<void> | null = null;

/** Last mtime this app observed for workspace.json (via our own save or a stat poll), used to
 * tell "someone else wrote the file" apart from silence. Reset for tests via `__resetSyncState`. */
let lastSeenMtime: number | null = null;

export function __resetSyncState() {
  lastSeenMtime = null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  savePromise = null;
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
async function applyWorkspace(ws: Workspace, opts: { confirmClose: boolean; scheduleSave: boolean }): Promise<void> {
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
  const wanted = new Set(ws.terminals.map((t) => t.id));
  const toClose = useStore.getState().order.filter((id) => !wanted.has(id));
  if (toClose.length > 0) {
    if (opts.confirmClose) {
      const ok = await confirm(`Close ${toClose.length} terminal(s) that are not in workspace.json?`, { title: "Reload workspace" });
      if (!ok) {
        // Nothing changed — restore whatever readiness this started with.
        useStore.setState({ persistenceReady: wasReady });
        return;
      }
    }
    for (const id of toClose) await useStore.getState().closeTerminal(id);
  }
  const open = new Set(useStore.getState().order);
  const { anyFailed } = await openDefs(ws.terminals.filter((d) => !open.has(d.id)), ws.layout, useStore.setState, ws.terminals);
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
 * `user@host`; a peer whose host can't be resolved to a valid address is left out. */
function peerHosts(): { name: string; host: string }[] {
  const s = useStore.getState();
  if (!s.tailscale?.running) return [];
  return s.tailscale.peers
    .filter((p) => p.online)
    .map((p) => ({ name: p.name, host: machineHost(p.name, s.machines[p.name], s.tailscale?.user ?? "") }))
    .filter((p) => validateHost(p.host) === null);
}

async function pushWorkspace(text: string) {
  const peers = peerHosts();
  if (peers.length === 0 || !useStore.getState().sync.enabled) return;
  let ok = 0;
  const failed: string[] = [];
  for (const p of peers) {
    try {
      await ipc.workspacePush(p.host, text);
      ok += 1;
    } catch (e) {
      failed.push(`${p.name}: ${typeof e === "string" ? e : String(e)}`);
    }
  }
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
async function adopt(ws: Workspace) {
  useStore.setState((s) => ({ sync: { ...s.sync, adopting: true } }));
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
    await applyWorkspace(ws, { confirmClose: false, scheduleSave: false });
  } finally {
    useStore.setState((s) => ({ sync: { ...s.sync, adopting: false } }));
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
    const sync = bumpSync(s.syncMeta, self);
    useStore.setState({ syncMeta: sync });
    const ws = toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout, machines: s.machines, sync });
    p = ipc
      .saveWorkspace(ws)
      .then(async () => {
        lastSeenMtime = await ipc.workspaceStat().catch(() => null);
        await pushWorkspace(JSON.stringify(ws, null, 2));
      })
      .catch((e) => {
        useStore.setState({ persistError: `could not save workspace: ${typeof e === "string" ? e : String(e)}` });
      });
  } else {
    const ws = toWorkspace({
      order: s.order,
      terminals: s.terminals,
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
