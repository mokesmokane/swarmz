import { addTab, allGroups, removeTerminal, type Layout } from "./layout";

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
}

export const EMPTY_SETTINGS: TerminalSettings = { ssh: null, claude: null, command: null };

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

export function startupLine(s: TerminalSettings): string | null {
  const command = trimmedCommand(s);
  if (command) return command;
  const claudeConfig = safeClaude(s);
  const claude = claudeConfig ? claudeLine(claudeConfig) : null;
  const host = s.ssh?.host?.trim();
  if (host) {
    if (!claude) return `ssh -t ${host}`;
    const cd = s.ssh?.cwd ? `cd ${shellQuote(s.ssh.cwd)} && ` : "";
    return `ssh -t ${host} ${shellQuote(cd + claude)}`;
  }
  return claude;
}

export function validateHost(host: string): string | null {
  const h = host.trim();
  if (!h) return "host cannot be empty";
  if (h.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(h)) {
    return "host may only contain letters, digits, . _ @ : - and cannot start with -";
  }
  return null;
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
}): Workspace {
  const terminals: TerminalDef[] = input.order
    .filter((id) => input.terminals[id])
    .map((id) => {
      const t = input.terminals[id];
      const s = input.settings[id] ?? EMPTY_SETTINGS;
      return { id: t.id, name: t.name, cwd: t.cwd, ssh: s.ssh, claude: s.claude, command: s.command };
    });
  return { version: 1, terminals, layout: input.layout };
}
