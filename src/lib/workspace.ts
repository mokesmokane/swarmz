import { addTab, allGroups, removeTerminal, type Layout, type LayoutNode } from "./layout";

export interface SshConfig {
  host: string;
  cwd?: string | null;
}

export interface ClaudeConfig {
  enabled: boolean;
  sessionId: string;
  skipPermissions: boolean;
  started: boolean;
}

export interface TerminalSettings {
  ssh: SshConfig | null;
  claude: ClaudeConfig | null;
  command: string | null;
  /** Fields carried in workspace.json that this app version does not know about; preserved on save. */
  extra?: Record<string, unknown>;
}

export interface TerminalDef extends TerminalSettings {
  id: string;
  name: string;
  cwd: string;
}

export interface Workspace {
  version: 1;
  terminals: TerminalDef[];
  layout: Layout;
  sshHistory?: SshHistory;
}

export const EMPTY_SETTINGS: TerminalSettings = { ssh: null, claude: null, command: null, extra: {} };

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function claudeLine(c: ClaudeConfig): string {
  const parts = ["claude"];
  if (c.skipPermissions) parts.push("--dangerously-skip-permissions");
  parts.push(c.started ? "--resume" : "--session-id", c.sessionId);
  return parts.join(" ");
}

export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(id);
}

function trimmedCommand(s: TerminalSettings): string | null {
  const c = s.command?.trim();
  return c ? c : null;
}

function safeClaude(s: TerminalSettings): ClaudeConfig | null {
  return s.claude?.enabled && isSafeSessionId(s.claude.sessionId) ? s.claude : null;
}

export function startupUsesClaude(s: TerminalSettings): boolean {
  return trimmedCommand(s) === null && !!safeClaude(s);
}

export type Step = { line: string; via: "local" | "remote" };

export const SSH_OPTS = "-t -o ControlMaster=auto -o ControlPath=~/.swarmz/ssh/%C -o ControlPersist=10m";

export function sshLine(host: string): string {
  return `ssh ${SSH_OPTS} ${host}`;
}

export function validHost(s: TerminalSettings): string | null {
  const raw = s.ssh?.host?.trim();
  return raw && validateHost(raw) === null ? raw : null;
}

export function startupIsSsh(s: TerminalSettings): boolean {
  return trimmedCommand(s) === null && validHost(s) !== null;
}

export function startupSteps(s: TerminalSettings): Step[] {
  const command = trimmedCommand(s);
  if (command) return [{ via: "local", line: command }];
  const claudeConfig = safeClaude(s);
  const claude = claudeConfig ? claudeLine(claudeConfig) : null;
  const host = validHost(s);
  if (host) {
    const steps: Step[] = [{ via: "local", line: sshLine(host) }];
    if (claude && s.ssh?.cwd) steps.push({ via: "remote", line: `cd ${shellQuote(s.ssh.cwd)} && ${claude}` });
    return steps;
  }
  return claude ? [{ via: "local", line: claude }] : [];
}

/** Display form of the startup steps, or null when there are none. */
export function startupLine(s: TerminalSettings): string | null {
  const steps = startupSteps(s);
  return steps.length ? steps.map((st) => st.line).join(" ⏎ ") : null;
}

export function needsRemoteFolder(s: TerminalSettings): boolean {
  return startupIsSsh(s) && !!safeClaude(s) && !s.ssh?.cwd;
}

export interface SshHistoryEntry {
  cwd: string | null;
  lastUsed: string;
}
export type SshHistory = Record<string, SshHistoryEntry>;
export const SSH_HISTORY_MAX = 20;

export function touchSshHistory(
  h: SshHistory,
  host: string,
  cwd: string | null | undefined,
  now: string = new Date().toISOString(),
): SshHistory {
  const key = host.trim();
  const prev = h[key];
  const next: SshHistory = { ...h, [key]: { cwd: cwd === undefined ? (prev?.cwd ?? null) : cwd, lastUsed: now } };
  const keys = Object.keys(next).sort((a, b) => (next[b].lastUsed > next[a].lastUsed ? 1 : next[b].lastUsed < next[a].lastUsed ? -1 : 0));
  const kept: SshHistory = {};
  for (const k of keys.slice(0, SSH_HISTORY_MAX)) kept[k] = next[k];
  return kept;
}

export function recentSshHosts(h: SshHistory, limit = 8): Array<{ host: string } & SshHistoryEntry> {
  return Object.entries(h)
    .map(([host, e]) => ({ host, ...e }))
    .sort((a, b) => (b.lastUsed > a.lastUsed ? 1 : b.lastUsed < a.lastUsed ? -1 : 0))
    .slice(0, limit);
}

export function validateHost(host: string): string | null {
  const h = host.trim();
  if (!h) return "host cannot be empty";
  if (h.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(h)) {
    return "host may only contain letters, digits, . _ @ : - and cannot start with -";
  }
  return null;
}

export function isLayoutNode(v: unknown): v is LayoutNode {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === "group") {
    return (
      typeof o.id === "string" &&
      Array.isArray(o.tabs) &&
      o.tabs.every((t) => typeof t === "string") &&
      typeof o.active === "string"
    );
  }
  if (o.kind === "split") {
    return (
      typeof o.id === "string" &&
      (o.dir === "row" || o.dir === "col") &&
      Array.isArray(o.children) &&
      o.children.length >= 1 &&
      o.children.every((c) => isLayoutNode(c)) &&
      Array.isArray(o.sizes) &&
      o.sizes.length === o.children.length &&
      o.sizes.every((n) => typeof n === "number")
    );
  }
  return false;
}

export function sanitizeLayout(v: unknown): Layout {
  if (v === null) return null;
  return isLayoutNode(v) ? v : null;
}

export function reconcileLayout(layout: Layout, ids: string[]): Layout {
  const wanted = new Set(ids);
  let out: Layout = layout;
  for (const present of allGroups(out).flatMap((g) => g.tabs)) {
    if (!wanted.has(present)) out = removeTerminal(out, present);
  }
  const placed = new Set(allGroups(out).flatMap((g) => g.tabs));
  for (const id of ids) {
    if (!placed.has(id)) out = addTab(out, id, null);
  }
  return out;
}

export function toWorkspace(input: {
  order: string[];
  terminals: Record<string, { id: string; name: string; cwd: string }>;
  settings: Record<string, TerminalSettings>;
  layout: Layout;
  sshHistory: SshHistory;
}): Workspace {
  const terminals: TerminalDef[] = input.order
    .filter((id) => input.terminals[id])
    .map((id) => {
      const t = input.terminals[id];
      const s = input.settings[id] ?? EMPTY_SETTINGS;
      return { ...s.extra, id: t.id, name: t.name, cwd: t.cwd, ssh: s.ssh, claude: s.claude, command: s.command };
    });
  return {
    version: 1,
    terminals,
    layout: input.layout,
    ...(Object.keys(input.sshHistory).length ? { sshHistory: input.sshHistory } : {}),
  };
}

/** Short display name for an SSH host: drops `user@` and takes the first DNS label. */
export function hostLabel(host: string): string {
  const h = host.trim().replace(/^[^@]*@/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  return h.split(".")[0] || h;
}
