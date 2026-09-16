import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Workspace } from "./workspace";
import type { AgentEvent } from "./agentState";

export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  exited: number | null;
  error: string | null;
  existed?: boolean;
}

export interface RemoteListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

export interface TailscaleMachine {
  name: string;
  hostName: string;
  ip: string | null;
  os: string;
  online: boolean;
}

export interface TailscaleStatus {
  running: boolean;
  message: string | null;
  user: string;
  self: TailscaleMachine | null;
  peers: TailscaleMachine[];
}

export interface AgentEventPayload {
  host: string | null;
  event: AgentEvent;
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
  onReplay: (id: string, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
    listen<string>(`pty:replay:${id}`, (e) => cb(base64ToBytes(e.payload))),
  onExit: (id: string, cb: (code: number | null) => void): Promise<UnlistenFn> =>
    listen<{ code: number | null }>(`pty:exit:${id}`, (e) => cb(e.payload.code)),
  loadWorkspace: () => invoke<Workspace | null>("load_workspace"),
  saveWorkspace: (workspace: Workspace) => invoke<void>("save_workspace", { workspace }),
  sshCheck: (host: string) => invoke<boolean>("ssh_check", { host }),
  sshOpenMaster: (host: string) => invoke<boolean>("ssh_open_master", { host }),
  sshListDir: (host: string, path: string | null) => invoke<RemoteListing>("ssh_list_dir", { host, path }),
  terminalForegroundBusy: (id: string) => invoke<boolean>("terminal_foreground_busy", { id }),
  terminalCwd: (id: string) => invoke<string | null>("terminal_cwd", { id }),
  setTerminalCwd: (id: string, cwd: string) => invoke<TerminalInfo>("set_terminal_cwd", { id, cwd }),
  tailscaleStatus: () => invoke<TailscaleStatus>("tailscale_status"),
  tailscaleOpen: () => invoke<void>("tailscale_open"),
  workspacePull: (host: string) => invoke<string | null>("workspace_pull", { host }),
  workspacePush: (host: string, contents: string) => invoke<void>("workspace_push", { host, contents }),
  workspaceStat: () => invoke<number | null>("workspace_stat"),
  agentsInstallLocal: () => invoke<boolean>("agents_install_local"),
  agentsInstallRemote: (host: string) => invoke<boolean>("agents_install_remote", { host }),
  /** Resolves with the generation of the watcher now running for `host` (see `agents_watch`). */
  agentsWatch: (host: string | null) => invoke<number>("agents_watch", { host }),
  agentsUnwatch: (host: string | null) => invoke<void>("agents_unwatch", { host }),
  /** Pushes the local clipboard image to `host` as a PNG, resolving with its absolute remote path, or null when the clipboard holds no image. */
  pasteImageToRemote: (host: string) => invoke<string | null>("paste_image_to_remote", { host }),
  onAgentEvent: (cb: (p: AgentEventPayload) => void): Promise<UnlistenFn> =>
    listen<AgentEventPayload>("agent:event", (e) => cb(e.payload)),
  onAgentWatchEnded: (cb: (p: { host: string | null; gen: number }) => void): Promise<UnlistenFn> =>
    listen<{ host: string | null; gen: number }>("agent:watch-ended", (e) => cb(e.payload)),
};
