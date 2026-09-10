import { create } from "zustand";
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

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const beforeSpawn: { hook: (id: string) => Promise<void> } = {
  hook: async () => {},
};

export interface WorkbenchState {
  terminals: Record<string, TerminalInfo>;
  order: string[];
  layout: Layout;
  focusedGroupId: string | null;
  focusedTerminalId: string | null;
  draggingTerminalId: string | null;
  lastCwd: string | null;

  createTerminal(cwd: string): Promise<string>;
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
}

function focusFor(layout: Layout, termId: string | null) {
  if (!termId) return { focusedGroupId: null, focusedTerminalId: null };
  const g = findGroupOf(layout, termId);
  return { focusedGroupId: g?.id ?? null, focusedTerminalId: g ? termId : null };
}

export const useStore = create<WorkbenchState>((set) => ({
  terminals: {},
  order: [],
  layout: null,
  focusedGroupId: null,
  focusedTerminalId: null,
  draggingTerminalId: null,
  lastCwd: null,

  async createTerminal(cwd) {
    const id = crypto.randomUUID();
    await beforeSpawn.hook(id);
    const info = await ipc.createTerminal(id, cwd, DEFAULT_COLS, DEFAULT_ROWS);
    set((s) => {
      const layout = addTab(s.layout, info.id, s.focusedGroupId);
      return {
        terminals: { ...s.terminals, [info.id]: info },
        order: [...s.order, info.id],
        layout,
        lastCwd: cwd,
        ...focusFor(layout, info.id),
      };
    });
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
        ...focusFor(layout, fallback),
      };
    });
  },

  async restartTerminal(id) {
    const info = await ipc.restartTerminal(id, DEFAULT_COLS, DEFAULT_ROWS);
    set((s) => ({ terminals: { ...s.terminals, [id]: info } }));
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
}));
