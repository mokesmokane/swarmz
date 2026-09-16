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
  /** When the tile's session holder started (UTC); absent until connected. */
  startedAt?: string | null;
}

export interface RemoteListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

export interface RemoteTileInfo {
  running: boolean;
  cwd?: string | null;
  foregroundBusy?: boolean | null;
  foregroundCommand?: string | null;
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

export interface TermSize {
  cols: number;
  rows: number;
}

export interface SessionRow {
  id: string;
  name: string | null;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  known: boolean;
}

export interface PhoneKey {
  device: string;
  keyType: string;
  keyEnd: string;
}

export interface MachineResult {
  machine: string;
  ok: boolean;
  error?: string;
}

interface ReplayPayload {
  data: string;
  cols: number;
  rows: number;
}

export function replaySize(p: { cols?: number; rows?: number }): TermSize | null {
  return p.cols && p.rows && p.cols > 0 && p.rows > 0 ? { cols: p.cols, rows: p.rows } : null;
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
  /** The replayed history of a session this tile joined, with the size it was written at (null
   * when the holder did not say). */
  onReplay: (id: string, cb: (bytes: Uint8Array, size: TermSize | null) => void): Promise<UnlistenFn> =>
    listen<ReplayPayload>(`pty:replay:${id}`, (e) => cb(base64ToBytes(e.payload.data), replaySize(e.payload))),
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
  toolRemoteReady: (host: string) => invoke<boolean>("tool_remote_ready", { host }),
  remoteTileInfo: (host: string, id: string) => invoke<RemoteTileInfo>("remote_tile_info", { host, id }),
  /** Ends the tile's session holder on `host`; true when one was running. */
  remoteTileClose: (host: string, id: string) => invoke<boolean>("remote_tile_close", { host, id }),
  /** Every session on this Mac; dead ones older than a week are pruned first. */
  localSessions: () => invoke<SessionRow[]>("local_sessions"),
  /** Ends a session that no tile in this window shows. */
  closeSession: (id: string) => invoke<boolean>("close_session", { id }),
  /** The phones paired with this Mac. */
  phones: () => invoke<PhoneKey[]>("phones"),
  /** Removes a phone's key here and on every other Mac the tool can reach. */
  revokePhone: (device: string) => invoke<{ removed: number; machines: MachineResult[] }>("revoke_phone", { device }),
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
