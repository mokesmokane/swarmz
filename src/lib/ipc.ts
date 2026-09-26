import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WINDOW_ACTION_EVENT, WINDOW_DROP_EVENT, WINDOW_HELLO_EVENT, WINDOW_STATE_EVENT, type WindowAction, type WindowDrop, type WindowMirror } from "./windowMirror";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { ConductorClaim, SubConductors, Workspace } from "./workspace";
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

/** The pairing QR code's contents: this Mac's name, login user and ssh host key fingerprints. */
export interface HostKeys {
  host: string;
  user: string;
  /** `SHA256:<unpadded base64>`, one per host key type the Mac offers; empty when it offers none. */
  fingerprints: string[];
}

/** A Mac's numbers as `swarmz stats` reports them (activity bar and machines spec §4). */
export interface MachineStats {
  cpu: { percent: number; load1: number | null; cores: number | null };
  memory: { usedPercent: number | null; totalBytes: number | null };
  disk: { freePercent: number | null; freeBytes: number | null };
  uptimeSeconds: number | null;
  claude: { working: number; needsYou: number; idle: number; stopped: number };
  app: string | null;
  tool: string;
  build: number;
}

/** One `tailscale ping`: the round trip, and direct or through a DERP relay. */
export interface PingResult {
  ms: number | null;
  direct: boolean;
  relay: string | null;
}

/** A file as `read_file` returns it (file viewing spec §3). */
export interface FileView {
  kind: "text" | "image" | "binary" | "dir";
  path: string;
  size: number;
  truncated: boolean;
  text?: string;
  base64?: string;
  mime?: string;
  /** A folder's entries, folders first (file viewing spec §5). */
  entries?: Array<{ name: string; dir: boolean }>;
}

export interface TelegramInfo {
  configured: boolean;
  chatId: string;
  tokenEnd: string;
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
  /** Another window's own viewer of a tile's holder (windows and layouts spec §4). */
  openView: (id: string) => invoke<void>("open_view", { id }),
  closeView: (id: string) => invoke<void>("close_view", { id }),
  /** The main window's picture of what window `label` draws, sent to it on every change. */
  sendWindowState: (label: string, state: WindowMirror) => emitTo(label, WINDOW_STATE_EVENT(label), state),
  onWindowState: (label: string, cb: (state: WindowMirror) => void): Promise<UnlistenFn> => listen<WindowMirror>(WINDOW_STATE_EVENT(label), (e) => cb(e.payload)),
  /** Another window announcing itself, and asking the main window to act. */
  windowHello: (label: string) => emitTo("main", WINDOW_HELLO_EVENT, { label }),
  onWindowHello: (cb: (label: string) => void): Promise<UnlistenFn> => listen<{ label: string }>(WINDOW_HELLO_EVENT, (e) => cb(e.payload.label)),
  windowAction: (action: WindowAction) => emitTo("main", WINDOW_ACTION_EVENT, action),
  onWindowAction: (cb: (action: WindowAction) => void): Promise<UnlistenFn> => listen<WindowAction>(WINDOW_ACTION_EVENT, (e) => cb(e.payload)),
  /** A drag no window took, handed to window `label` to resolve at a screen point. */
  sendWindowDrop: (label: string, drop: WindowDrop) => emitTo(label, WINDOW_DROP_EVENT(label), drop),
  onWindowDrop: (label: string, cb: (drop: WindowDrop) => void): Promise<UnlistenFn> => listen<WindowDrop>(WINDOW_DROP_EVENT(label), (e) => cb(e.payload)),
  loadWorkspace: () => invoke<Workspace | null>("load_workspace"),
  saveWorkspace: (workspace: Workspace) => invoke<void>("save_workspace", { workspace }),
  sshCheck: (host: string) => invoke<boolean>("ssh_check", { host }),
  sshOpenMaster: (host: string) => invoke<boolean>("ssh_open_master", { host }),
  sshListDir: (host: string, path: string | null) => invoke<RemoteListing>("ssh_list_dir", { host, path }),
  terminalForegroundBusy: (id: string) => invoke<boolean>("terminal_foreground_busy", { id }),
  terminalCwd: (id: string) => invoke<string | null>("terminal_cwd", { id }),
  /** Whether the tile's program has bracketed paste on, per its holder; null when it cannot say. */
  terminalBracketedPaste: (id: string) => invoke<boolean | null>("terminal_bracketed_paste", { id }),
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
  /** Sets, denies or clears the conductor through the tool, which tells the tiles concerned (conductor spec §6). */
  /** Allow (`yes`) or Deny (`no`) a tile's permission dialog, on its Mac when that is another one. */
  tileAnswer: (tile: string, choice: "yes" | "no", machine: string | null) => invoke<unknown>("tile_answer", { tile, choice, machine }),
  /** A tile's board (tile board spec §2), from its Mac: `{board, at}`, board null when it has none. */
  boardGet: (tile: string, machine: string | null) => invoke<{ board: unknown; at?: string }>("board_get", { tile, machine }),
  /** Each conversation's latest board in a tile, newest first (the History tab). */
  boardHistory: (tile: string, machine: string | null) => invoke<{ history: { sessionId: string; at: string; board: unknown }[] }>("board_history", { tile, machine }),
  /** Types `text` into the tile and submits it (a board's answer button). */
  tileSend: (tile: string, text: string, machine: string | null) => invoke<unknown>("tile_send", { tile, text, machine }),
  conductorAction: (action: "set" | "deny" | "clear" | "sub" | "assign" | "remove", id?: string, parent?: string) =>
    invoke<{ conductor: string | null; conductors?: SubConductors; claim: ConductorClaim | null; conductorAt?: string | null }>("conductor_action", {
      action,
      id: id ?? null,
      parent: parent ?? null,
    }),
  /** Creates `~/.swarmz/conductor` (with its CLAUDE.md) if missing and returns the path. */
  conductorDir: () => invoke<string>("conductor_dir"),
  /** The conductor fields of the workspace file on disk, or null with no file (read before every save). */
  workspaceRoles: () => invoke<{ conductor?: unknown; conductors?: unknown; conductorClaim?: unknown; conductorAt?: unknown } | null>("workspace_roles"),
  /** `swarmz stats` here (null) or on `host` over ssh; rejects with `old_tool` for a tool without it. */
  machineStats: (host: string | null) => invoke<MachineStats>("machine_stats", { host }),
  /** One `tailscale ping` to a machine; null when it did not answer within two seconds. */
  tailscalePing: (name: string) => invoke<PingResult | null>("tailscale_ping", { name }),
  /** A URL from a pane, in the browser (file viewing spec §2). */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  /** Opens `path` outside swarmz (spec §4): the default app, or Finder with `reveal`; a remote file is copied here first. Resolves with the path opened. */
  openPath: (host: string | null, path: string, reveal: boolean) => invoke<string>("open_path", { host, path, reveal }),
  /** Whether VS Code's `code` command is on this Mac. */
  codeAvailable: () => invoke<boolean>("code_available"),
  /** Opens `path` in VS Code, here or on `host` through its Remote SSH. */
  openInCode: (host: string | null, path: string, line: number | null) => invoke<void>("open_in_code", { host, path, line }),
  /** A file a tile talks about: on `host` over the ssh master, else on this Mac; `path` absolute or `~`-relative. */
  readFile: (host: string | null, path: string) => invoke<FileView>("read_file", { host, path }),
  /** Whether Telegram is set up on this Mac (conductor spec §5), the chat id and the token's end. */
  telegramGet: () => invoke<TelegramInfo>("telegram_get"),
  /** Writes `~/.swarmz/telegram.json`; both empty removes it. */
  telegramSet: (token: string, chatId: string) => invoke<TelegramInfo>("telegram_set", { token, chatId }),
  /** Makes `host`'s Telegram setup match this Mac's; true when it changed. */
  /** Copies this Mac's Telegram setup to `host`; with `remove` (the user removed it here), removes `host`'s too. */
  telegramPush: (host: string, remove = false) => invoke<boolean>("telegram_push", { host, remove }),
  /** Sends a test message through `swarmz notify`. */
  telegramTest: () => invoke<void>("telegram_test"),
  /** Starts or stops the follower that types the user's Telegram messages into the conductor; resolves with its state. */
  telegramFollow: (enabled: boolean) => invoke<boolean>("telegram_follow", { enabled }),
  /** The phones paired with this Mac. */
  phones: () => invoke<PhoneKey[]>("phones"),
  /** Removes a phone's key here and on every other Mac the tool can reach. */
  revokePhone: (device: string) => invoke<{ removed: number; machines: MachineResult[] }>("revoke_phone", { device }),
  /** This Mac's name, login user and ssh host key fingerprints, for the pairing QR code. */
  hostKeys: () => invoke<HostKeys>("host_keys"),
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

/** An update the endpoint offers, flattened out of the plugin's `Update` handle. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  /** Bytes the server promised, or null when it did not say. */
  contentLength: number | null;
}

/**
 * The updater, wrapped the way `ipc` wraps `invoke`: the store only ever sees plain data, so the
 * plugin's `Update` resource (which cannot be serialised or reconstructed) stays in this module
 * and the state machine is testable with a mock of this file. Closing the previous handle is
 * best effort — a leaked resource must never fail a check.
 */
let pendingUpdate: Update | null = null;

export const updater = {
  async check(): Promise<UpdateInfo | null> {
    const previous = pendingUpdate;
    pendingUpdate = null;
    if (previous) await previous.close().catch(() => {});
    const found = await check();
    pendingUpdate = found;
    return found
      ? { version: found.version, currentVersion: found.currentVersion, notes: found.body ?? null, date: found.date ?? null }
      : null;
  },
  /** Downloads and installs the update found by the last `check`. */
  async install(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    const update = pendingUpdate;
    if (!update) throw new Error("no update to install");
    let downloaded = 0;
    let contentLength: number | null = null;
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") contentLength = e.data.contentLength ?? null;
      else if (e.event === "Progress") downloaded += e.data.chunkLength;
      onProgress?.({ downloaded, contentLength });
    });
  },
  relaunch: () => relaunch(),
};
