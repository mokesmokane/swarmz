import { create } from "zustand";
import { homeDir } from "@tauri-apps/api/path";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc, type TerminalInfo } from "./lib/ipc";
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
  EMPTY_SETTINGS,
  hostLabel,
  isSafeSessionId,
  reconcileLayout,
  sanitizeLayout,
  startupLine,
  startupUsesClaude,
  toWorkspace,
  validateHost,
  type TerminalSettings,
  type TerminalDef,
} from "./lib/workspace";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const SAVE_DEBOUNCE_MS = 500;

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

  createTerminal(cwd: string, placement?: Placement): Promise<string>;
  createSshTerminal(opts: SshTerminalOptions, placement?: Placement): Promise<string>;
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
  updateSettings(id: string, patch: Partial<TerminalSettings>): void;
  runStartup(id: string): Promise<void>;
  skipStartup(id: string): void;
  dismissPersistError(): void;
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

const KNOWN_DEF_KEYS = new Set(["id", "name", "cwd", "ssh", "claude", "command"]);

/** Fields on a loaded def that this app version does not know about; kept so they round-trip on save. */
function extraFromDef(def: TerminalDef): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (!KNOWN_DEF_KEYS.has(k)) extra[k] = v;
  }
  return extra;
}

function settingsFromDef(d: TerminalDef): TerminalSettings {
  return { ssh: d.ssh ?? null, claude: d.claude ?? null, command: d.command ?? null, extra: extraFromDef(d) };
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
  let failedCount = 0;
  for (const def of defs) {
    const { def: regenerated, note: unsafeNote } = normalized.get(def.id) ?? regenerateIfUnsafe(def);
    try {
      const { info, note } = await spawnDef(regenerated);
      const startupNote = unsafeNote ?? note;
      set((s) => ({
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        settings: { ...s.settings, [info.id]: settingsFromDef(regenerated) },
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
          settings[id] = settingsFromDef(d);
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

  async createTerminal(cwd, placement) {
    const id = crypto.randomUUID();
    await beforeSpawn.hook(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const info = await ipc.createTerminal(id, cwd, dims.cols, dims.rows);
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
        settings: { ...s.settings, [info.id]: EMPTY_SETTINGS },
        startupPending: { ...s.startupPending, [info.id]: false },
        ...focusFor(layout, info.id),
      };
    });
    return info.id;
  },

  async createSshTerminal(opts, placement) {
    const id = crypto.randomUUID();
    await beforeSpawn.hook(id);
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const home = await homeDir();
    const info = await ipc.createTerminal(id, home, dims.cols, dims.rows, hostLabel(opts.host));
    const settings: TerminalSettings = {
      ...EMPTY_SETTINGS,
      ssh: { host: opts.host.trim(), cwd: opts.cwd?.trim() || null },
      claude: opts.claude
        ? { enabled: true, sessionId: crypto.randomUUID(), skipPermissions: opts.claude.skipPermissions, started: false }
        : null,
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
        ...focusFor(layout, info.id),
      };
    });
    // The user asked for this connection right now, so run it without a click.
    await useStore.getState().runStartup(info.id);
    return info.id;
  },

  async closeTerminal(id) {
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
        ...focusFor(layout, fallback),
      };
    });
  },

  async restartTerminal(id) {
    const dims = beforeSpawn.size(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const info = await ipc.restartTerminal(id, dims.cols, dims.rows);
    set((s) => ({
      terminals: { ...s.terminals, [id]: info },
      startupPending: { ...s.startupPending, [id]: startupLine(s.settings[id] ?? EMPTY_SETTINGS) !== null },
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
    set((s) => {
      const t = s.terminals[id];
      if (!t) return {};
      return { terminals: { ...s.terminals, [id]: { ...t, exited: code ?? -1 } } };
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
    // openDefs sets persistenceReady itself: true when every def opened cleanly, false
    // (with a persistError) if any failed, so a partial load never gets overwritten by a save.
    await openDefs(ws.terminals, ws.layout, set);
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
    const wanted = new Set(ws.terminals.map((t) => t.id));
    const toClose = useStore.getState().order.filter((id) => !wanted.has(id));
    if (toClose.length > 0) {
      const ok = await confirm(`Close ${toClose.length} terminal(s) that are not in workspace.json?`, { title: "Reload workspace" });
      if (!ok) {
        // Nothing changed — restore whatever readiness this reload started with.
        set({ persistenceReady: wasReady });
        return;
      }
      for (const id of toClose) await useStore.getState().closeTerminal(id);
    }
    const open = new Set(useStore.getState().order);
    const { anyFailed } = await openDefs(ws.terminals.filter((d) => !open.has(d.id)), ws.layout, set, ws.terminals);
    if (!anyFailed) {
      // openDefs already set persistenceReady true; schedule an explicit save so the
      // reconciled state (regenerated ids, rebuilt layout, etc.) is persisted right away.
      set({ persistenceReady: true });
      scheduleSave();
    }
  },

  updateSettings(id, patch) {
    set((s) => {
      const current = s.settings[id] ?? EMPTY_SETTINGS;
      const next: TerminalSettings = { ...current, ...patch };
      if (next.claude?.enabled && !next.claude.sessionId) {
        next.claude = { ...next.claude, sessionId: crypto.randomUUID() };
      }
      return {
        settings: { ...s.settings, [id]: next },
        startupPending: { ...s.startupPending, [id]: startupLine(next) !== null },
      };
    });
  },

  async runStartup(id) {
    const s = useStore.getState();
    const settings = s.settings[id] ?? EMPTY_SETTINGS;
    const line = startupLine(settings);
    if (!line) return;
    await ipc.writeTerminal(id, line + "\r");
    set((st) => {
      if (!st.terminals[id]) return {};
      const cur = st.settings[id] ?? EMPTY_SETTINGS;
      const claude = startupUsesClaude(cur) && cur.claude ? { ...cur.claude, started: true } : cur.claude;
      return {
        settings: { ...st.settings, [id]: { ...cur, claude } },
        startupPending: { ...st.startupPending, [id]: false },
        startupNotes: omit(st.startupNotes, id),
      };
    });
  },

  skipStartup(id) {
    set((s) => ({ startupPending: { ...s.startupPending, [id]: false }, startupNotes: omit(s.startupNotes, id) }));
  },

  dismissPersistError() {
    set({ persistError: null });
  },
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!useStore.getState().persistenceReady) return;
    const s = useStore.getState();
    ipc.saveWorkspace(toWorkspace({ order: s.order, terminals: s.terminals, settings: s.settings, layout: s.layout })).catch((e) => {
      useStore.setState({ persistError: `could not save workspace: ${typeof e === "string" ? e : String(e)}` });
    });
  }, SAVE_DEBOUNCE_MS);
}

useStore.subscribe((s, prev) => {
  if (!s.persistenceReady) return;
  if (s.terminals !== prev.terminals || s.order !== prev.order || s.layout !== prev.layout || s.settings !== prev.settings) {
    scheduleSave();
  }
});
