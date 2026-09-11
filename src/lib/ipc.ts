import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Workspace } from "./workspace";

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  exited: number | null;
  error: string | null;
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const ipc = {
  createTerminal: (id: string, cwd: string, cols: number, rows: number, name?: string) =>
    invoke<TerminalInfo>("create_terminal", { id, cwd, cols, rows, name: name ?? null }),
  listTerminals: () => invoke<TerminalInfo[]>("list_terminals"),
  writeTerminal: (id: string, data: string) => invoke<void>("write_terminal", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", { id, cols, rows }),
  renameTerminal: (id: string, name: string) => invoke<TerminalInfo>("rename_terminal", { id, name }),
  closeTerminal: (id: string) => invoke<void>("close_terminal", { id }),
  restartTerminal: (id: string, cols: number, rows: number) =>
    invoke<TerminalInfo>("restart_terminal", { id, cols, rows }),
  onData: (id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
    listen<string>(`pty:data:${id}`, (e) => cb(base64ToBytes(e.payload))),
  onExit: (id: string, cb: (code: number | null) => void): Promise<UnlistenFn> =>
    listen<{ code: number | null }>(`pty:exit:${id}`, (e) => cb(e.payload.code)),
  loadWorkspace: () => invoke<Workspace | null>("load_workspace"),
  saveWorkspace: (workspace: Workspace) => invoke<void>("save_workspace", { workspace }),
};
