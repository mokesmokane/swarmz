import { addTab, allGroups, removeTerminal, type Layout, type LayoutNode } from "./layout";
import type { SessionRecord } from "./sessions";

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
  /** Claude sessions that ran in this tile, newest first. */
  sessions?: SessionRecord[];
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

const REMOTE_TOOL = "~/.swarmz/bin/swarmz";

/** The ssh line for a tile that attaches to its session holder on `host`. The remote command is
 * one word for the local shell (quoted once) and is parsed again by the remote shell (arguments
 * quoted again); the leading `~` is left for the remote shell to expand. Callers pass a host that
 * passed `validateHost` and a tile id that passed `isSafeSessionId`. */
export function attachLine(host: string, tileId: string, cwd: string | null | undefined, name: string): string {
  const parts = [REMOTE_TOOL, "attach", tileId];
  if (cwd) parts.push("--cwd", shellQuote(cwd));
  parts.push("--name", shellQuote(name));
  return `ssh ${SSH_OPTS} ${host} ${shellQuote(parts.join(" "))}`;
}

export interface StartupOpts {
  /** Connect by attaching to the tile's session holder on the remote (`attachLine`). */
  attach?: boolean;
  /** The tile's name, passed to the remote holder; defaults to the tile id. */
  name?: string;
}

export function validHost(s: TerminalSettings): string | null {
  const raw = s.ssh?.host?.trim();
  return raw && validateHost(raw) === null ? raw : null;
}

export function startupIsSsh(s: TerminalSettings): boolean {
  return trimmedCommand(s) === null && validHost(s) !== null;
}

export function startupSteps(s: TerminalSettings, terminalId?: string, opts: StartupOpts = {}): Step[] {
  const command = trimmedCommand(s);
  if (command) return [{ via: "local", line: command }];
  const claudeConfig = safeClaude(s);
  const claude = claudeConfig ? claudeLine(claudeConfig) : null;
  const host = validHost(s);
  if (host) {
    const attach = opts.attach && terminalId && isSafeSessionId(terminalId);
    const cwd = s.ssh?.cwd && isSafeRemotePath(s.ssh.cwd) ? s.ssh.cwd : null;
    const first = attach ? attachLine(host, terminalId, cwd, opts.name ?? terminalId) : sshLine(host);
    const steps: Step[] = [{ via: "local", line: first }];
    // The remote shell does not inherit our env, so the tile id is exported there first (a UUID,
    // so no quoting): the hook script then reports any Claude in that shell, including one the
    // user starts by hand later, not just the one swarmz launches now.
    const parts: string[] = [];
    if (terminalId) parts.push(`export SWARMZ_TERMINAL_ID=${terminalId}`);
    if (s.ssh?.cwd) {
      parts.push(`cd ${shellQuote(s.ssh.cwd)}`);
      if (claude) parts.push(claude);
    }
    if (parts.length) steps.push({ via: "remote", line: parts.join(" && ") });
    return steps;
  }
  return claude ? [{ via: "local", line: claude }] : [];
}

/** Display form of the startup steps, or null when there are none. */
export function startupLine(s: TerminalSettings, terminalId?: string, opts: StartupOpts = {}): string | null {
  const steps = startupSteps(s, terminalId, opts);
  return steps.length ? steps.map((st) => st.line).join(" ⏎ ") : null;
}

/** Plain-language form of the startup steps for the connect card, or null when there are none. */
export function startupSummary(s: TerminalSettings, machines: Machines): string | null {
  const command = trimmedCommand(s);
  if (command) return `Run ${command}`;
  const c = safeClaude(s);
  const claudePart = c ? `${c.started ? "resume" : "start"} Claude${c.skipPermissions ? " (permissions skipped)" : ""}` : null;
  const host = validHost(s);
  if (host) {
    const machine = s.ssh?.machine;
    const label = machine ? machineLabel(machine, machines[machine]) : hostLabel(host);
    const parts = [`Connect to ${label}`];
    if (s.ssh?.cwd) parts.push(`open ${s.ssh.cwd}`);
    if (claudePart) parts.push(claudePart);
    return parts.join(", ");
  }
  if (!claudePart) return null;
  return claudePart.charAt(0).toUpperCase() + claudePart.slice(1);
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
  // A remote created elsewhere that points at THIS machine is really one of ours: open it as a
  // local in the remote folder. It is then saved as a local def with `origin` = self, which the
  // rule below turns back into a remote on every other machine.
  if (def.ssh && self && def.ssh.machine === self) {
    return { cwd: def.ssh.cwd ?? null, settings: { ...base, ssh: null, origin: self }, note: null };
  }
  if (def.ssh) return { cwd: null, settings: base, note: null };
  if (self && origin && origin !== self) {
    // Opened here as a plain shell because the origin cannot be reached. Its folder still belongs
    // to the origin machine: keep it as `foreign` so a home fallback (the folder rarely exists
    // here) is never written back over the def's real folder.
    if (!knownMachines.has(origin)) return { cwd: def.cwd, settings: { ...base, foreign: { cwd: def.cwd } }, note: unknownOriginNote(origin) };
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

/** JSON with every object's keys in a fixed order, so two values that differ only in key order
 * stringify identically. Array order is preserved (it is meaningful for `tabs` and `sizes`). */
function stableJson(v: unknown): string {
  const stable = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(stable);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = stable(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(stable(v));
}

/**
 * Whether two workspaces describe the same thing, ignoring how they are written down: terminals
 * are compared as a map keyed by id (so the order they appear in is irrelevant), the layout
 * structurally, machines as a map, and `sync` not at all.
 *
 * This is what decides whether the state reached after an adoption still differs from the file
 * that was adopted. It must NOT be order-sensitive: two machines reconcile the same file into the
 * same set of terminals but can list them differently, and an order-sensitive comparison would
 * make each machine "fix" the other's order forever, one revision per round.
 */
export function sameWorkspaceContent(a: Workspace, b: Workspace): boolean {
  const key = (ws: Workspace) => {
    const terminals: Record<string, unknown> = {};
    for (const t of ws.terminals) {
      terminals[t.id] = {
        name: t.name,
        cwd: t.cwd,
        ssh: t.ssh ?? null,
        claude: t.claude ?? null,
        command: t.command ?? null,
        origin: t.origin ?? null,
        sessions: t.sessions ?? [],
      };
    }
    return stableJson({ terminals, layout: ws.layout, machines: ws.machines ?? {} });
  };
  return key(a) === key(b);
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
        ...(s.sessions?.length ? { sessions: s.sessions } : {}),
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
