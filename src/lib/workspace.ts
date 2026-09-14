import { addTab, allGroups, removeTerminal, type Layout, type LayoutNode } from "./layout";

export interface SshConfig {
  host: string;
  cwd?: string | null;
  machine?: string | null;
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
  /** Name of the machine that owns this terminal's local working directory; null/absent means "here". */
  origin?: string | null;
  /** In-memory marker for a local terminal whose origin is another machine; never persisted. */
  foreign?: { cwd: string } | null;
  /** Fields carried in workspace.json that this app version does not know about; preserved on save. */
  extra?: Record<string, unknown>;
}

export interface TerminalDef extends TerminalSettings {
  id: string;
  name: string;
  cwd: string;
}

export interface SyncMeta {
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface Workspace {
  version: 1;
  terminals: TerminalDef[];
  layout: Layout;
  machines?: Machines;
  sync?: SyncMeta;
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
    if (s.ssh?.cwd) {
      const cd = `cd ${shellQuote(s.ssh.cwd)}`;
      steps.push({ via: "remote", line: claude ? `${cd} && ${claude}` : cd });
    }
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
  return startupIsSsh(s) && !s.ssh?.cwd;
}

export const MACHINE_COLORS = ["#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#a3e635"] as const;
export const MACHINES_MAX = 50;

export interface MachineConfig {
  alias?: string | null;
  user?: string | null;
  color?: string | null;
  cwd?: string | null;
  lastUsed: string;
}
export type Machines = Record<string, MachineConfig>;

export function machineLabel(name: string, cfg: MachineConfig | undefined): string {
  const alias = cfg?.alias?.trim();
  return alias ? alias : name;
}

export function machineHost(name: string, cfg: MachineConfig | undefined, defaultUser: string): string {
  const user = cfg?.user?.trim() || defaultUser.trim();
  return `${user}@${name}`;
}

export function touchMachine(
  m: Machines,
  name: string,
  patch: Partial<Omit<MachineConfig, "lastUsed">>,
  now: string = new Date().toISOString(),
  opts: { bump?: boolean } = {},
): Machines {
  const prev = m[name];
  const lastUsed = opts.bump === false && prev ? prev.lastUsed : now;
  const next: Machines = { ...m, [name]: { ...prev, ...patch, lastUsed } };
  const keys = Object.keys(next).sort((a, b) => (next[b].lastUsed > next[a].lastUsed ? 1 : next[b].lastUsed < next[a].lastUsed ? -1 : 0));
  const kept: Machines = {};
  for (const k of keys.slice(0, MACHINES_MAX)) kept[k] = next[k];
  return kept;
}

const UNSUPPORTED_ALIAS = /["'`\\$\x00-\x1f\x7f]/;
export function validateAlias(alias: string): string | null {
  const a = alias.trim();
  if (!a) return "alias cannot be empty";
  if (a.length > 64 || UNSUPPORTED_ALIAS.test(a)) return "alias may not contain quotes, backslash, $ or control characters, and must be at most 64 characters";
  return null;
}

export function isMachineColor(c: string | null | undefined): boolean {
  return c === null || c === undefined || (MACHINE_COLORS as readonly string[]).includes(c);
}

export function tintBackground(base: string, color: string | null): string {
  if (!color) return base;
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [br, bg, bb] = hex(base);
  const [cr, cg, cb] = hex(color);
  const mix = (b: number, c: number) => Math.round(b * 0.9 + c * 0.1);
  const out = [mix(br, cr), mix(bg, cg), mix(bb, cb)].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `#${out}`;
}

/** Rejects control characters (which could smuggle terminal escapes into a typed `cd`) in a
 * remote path chosen via the picker, typed by hand, or loaded from workspace.json. */
export function isSafeRemotePath(p: string): boolean {
  return p.length > 0 && !/[\x00-\x1f\x7f]/.test(p);
}

export function validateHost(host: string): string | null {
  const h = host.trim();
  if (!h) return "host cannot be empty";
  if (h.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(h)) {
    return "host may only contain letters, digits, . _ @ : - and cannot start with -";
  }
  return null;
}

const UNSUPPORTED_USER = /^[A-Za-z0-9._-]+$/;
/** Validates a machine's ssh username. Empty (after trimming) means "use the default" and is
 * not an error — only a non-empty value that fails the allowlist is rejected. */
export function validateUser(user: string): string | null {
  const u = user.trim();
  if (!u) return null;
  if (u.length > 32 || !UNSUPPORTED_USER.test(u)) {
    return "username may only contain letters, digits, . _ -";
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

export function isNewer(a: SyncMeta | undefined | null, b: SyncMeta | undefined | null): boolean {
  if (!a) return false;
  if (!b) return true;
  if (a.revision !== b.revision) return a.revision > b.revision;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  // Exact tie on revision AND timestamp: break it on the machine name so every machine in the
  // tailnet picks the SAME winner (without this, two copies are each "not newer" than the other
  // and the two machines can settle on different files and never converge). Equal metas — the
  // common case, including `isNewer(a, a)` — still compare as not newer.
  return a.updatedBy > b.updatedBy;
}

export function pickNewest(cands: Workspace[]): Workspace | null {
  let best: Workspace | null = null;
  for (const c of cands) if (!best || isNewer(c.sync, best.sync)) best = c;
  return best;
}

export function bumpSync(prev: SyncMeta | undefined | null, self: string, now: string = new Date().toISOString()): SyncMeta {
  return { revision: (prev?.revision ?? 0) + 1, updatedAt: now, updatedBy: self };
}

export function unknownOriginNote(origin: string): string {
  return `origin machine ${origin} is not on your tailnet; opened locally`;
}

/**
 * How a def should open here. `knownMachines` is the set of machine names this app can actually
 * reach (tailnet peers plus machines recorded in workspace.json): a foreign local is only turned
 * into a remote when its `origin` is one of them, because `machineHost` would otherwise invent a
 * `user@name` address for a machine that does not exist and every startup would fail. An unknown
 * origin opens locally in `def.cwd` with a `note` explaining why.
 */
export function openingFor(
  def: TerminalDef,
  self: string | null,
  machines: Machines,
  defaultUser: string,
  knownMachines: Set<string>,
): { cwd: string | null; settings: TerminalSettings; note: string | null } {
  const origin = def.origin ?? null;
  const base: TerminalSettings = { ssh: def.ssh ?? null, claude: def.claude ?? null, command: def.command ?? null, origin };
  if (def.ssh) return { cwd: null, settings: base, note: null };
  if (self && origin && origin !== self) {
    if (!knownMachines.has(origin)) return { cwd: def.cwd, settings: base, note: unknownOriginNote(origin) };
    return {
      cwd: null,
      settings: { ...base, ssh: { host: machineHost(origin, machines[origin], defaultUser), cwd: def.cwd, machine: origin }, foreign: { cwd: def.cwd } },
      note: null,
    };
  }
  return { cwd: def.cwd, settings: base, note: null };
}

/**
 * The first time this machine syncs (it has no `sync` of its own) its terminals are not "an older
 * copy of the peer's workspace" — they were never shared at all, so adopting the peer's file
 * verbatim would silently close them. Merge instead: the peer's workspace plus any local terminal
 * the peer does not have, keeping the peer's sync metadata (the union is saved locally and, being
 * different from what the peers hold, is bumped and pushed back by the usual save path).
 */
export function mergeForFirstSync(local: Workspace, peer: Workspace): Workspace {
  const fromPeer = new Set(peer.terminals.map((t) => t.id));
  const terminals = [...peer.terminals, ...local.terminals.filter((t) => !fromPeer.has(t.id))];
  const machines = { ...(local.machines ?? {}), ...(peer.machines ?? {}) };
  return {
    version: 1,
    terminals,
    layout: reconcileLayout(peer.layout, terminals.map((t) => t.id)),
    ...(Object.keys(machines).length ? { machines } : {}),
    ...(peer.sync ? { sync: peer.sync } : {}),
  };
}

export function toWorkspace(input: {
  order: string[];
  terminals: Record<string, { id: string; name: string; cwd: string }>;
  settings: Record<string, TerminalSettings>;
  layout: Layout;
  machines: Machines;
  sync?: SyncMeta | null;
}): Workspace {
  const terminals: TerminalDef[] = input.order
    .filter((id) => input.terminals[id])
    .map((id) => {
      const t = input.terminals[id];
      const s = input.settings[id] ?? EMPTY_SETTINGS;
      const foreign = s.foreign ?? null;
      return {
        ...s.extra,
        id: t.id,
        name: t.name,
        cwd: foreign ? foreign.cwd : t.cwd,
        ssh: foreign ? null : s.ssh,
        claude: s.claude,
        command: s.command,
        ...(s.origin ? { origin: s.origin } : {}),
      };
    });
  const machines = input.machines ?? {};
  return {
    version: 1,
    terminals,
    layout: input.layout,
    ...(Object.keys(machines).length ? { machines } : {}),
    ...(input.sync ? { sync: input.sync } : {}),
  };
}

/** Short display name for an SSH host: drops `user@` and takes the first DNS label. */
export function hostLabel(host: string): string {
  const h = host.trim().replace(/^[^@]*@/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  return h.split(".")[0] || h;
}
