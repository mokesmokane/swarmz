import type { AgentState } from "./agentState";
import { needsYou } from "./agentState";
import type { SessionRecord } from "./sessions";
import { hostLabel, machineGlyph, machineLabel, type Machines } from "./workspace";

/** How the sidebar lists tiles (sidebar redesign spec: Mac · Triage · Folder · Tree · Time), a per-machine preference. */
export type GroupBy = "machine" | "triage" | "folder" | "conductor" | "time";
export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "machine", label: "Mac" },
  { value: "triage", label: "Triage" },
  { value: "folder", label: "Folder" },
  { value: "conductor", label: "Tree" },
  { value: "time", label: "Time" },
];
const KEY = "swarmz.sidebarGroupBy";

export function loadGroupBy(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): GroupBy {
  const raw = storage?.getItem(KEY);
  // The old Workspace and Status groupings are what Triage does now.
  return GROUP_BY_OPTIONS.some((o) => o.value === raw) ? (raw as GroupBy) : "triage";
}

export function saveGroupBy(value: GroupBy, storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(KEY, value);
  } catch {
    // storage unavailable: the choice still applies for this run
  }
}

export type RowStatus = "needs you" | "working" | "idle" | "stopped" | `exited ${number}`;

/** What a row's second line and the groupings are built from (spec §2). */
export interface RowInfo {
  id: string;
  /** The machine badge: its glyph (icon or monogram), the machine's name, its alias (for the tooltip), colour, and whether a remote is known offline. */
  machine: { key: string; glyph: string; label: string; alias: string | null; color: string | null; self: boolean; online: boolean | null };
  folder: string;
  status: RowStatus;
  /** ISO time of the last hook event, else the newest session's activity; null when neither. */
  since: string | null;
}

export interface RowSource {
  id: string;
  name: string;
  cwd: string;
  exited: number | null;
  ssh: { host: string; cwd?: string | null; machine?: string | null } | null;
  foreign: { cwd: string } | null;
  sessions: SessionRecord[] | undefined;
  agent: AgentState | undefined;
}

export interface RowContext {
  selfMachine: string | null;
  machines: Machines;
  /** Online state by machine name, from Tailscale; a name not present is unknown. */
  online: Record<string, boolean>;
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function rowStatus(agent: AgentState | undefined, exited: number | null): RowStatus {
  if (exited !== null) return exited === 0 ? "stopped" : `exited ${exited}`;
  if (!agent || agent.status === "offline") return "stopped";
  if (needsYou(agent)) return "needs you";
  return agent.status === "working" ? "working" : "idle";
}

export function rowInfo(t: RowSource, ctx: RowContext): RowInfo {
  const remote = t.ssh?.machine ?? null;
  let machine: RowInfo["machine"];
  if (t.ssh) {
    const key = remote ?? hostLabel(t.ssh.host);
    const alias = remote ? machineLabel(remote, ctx.machines[remote]) : null;
    machine = {
      key,
      glyph: machineGlyph(key, remote ? ctx.machines[remote] : undefined),
      label: key,
      alias: alias && alias !== key ? alias : null,
      color: remote ? (ctx.machines[remote]?.color ?? null) : null,
      self: false,
      online: remote ? (ctx.online[remote] ?? null) : null,
    };
  } else {
    const self = ctx.selfMachine;
    const alias = self ? machineLabel(self, ctx.machines[self]) : null;
    machine = {
      key: self ?? "this-mac",
      glyph: self ? machineGlyph(self, ctx.machines[self]) : "⌂",
      label: self ?? "this Mac",
      alias: alias && alias !== self ? alias : null,
      color: self ? (ctx.machines[self]?.color ?? null) : null,
      self: true,
      online: true,
    };
  }
  const folder = basename(t.foreign?.cwd ?? t.ssh?.cwd ?? t.cwd);
  const since = t.agent?.since || t.sessions?.[0]?.lastActiveAt || null;
  return { id: t.id, machine, folder, status: rowStatus(t.agent, t.exited), since };
}

/** `now`, `3m`, `2h`, `1d`, the phone's shape (spec §2); empty for a missing or future time. */
export function relativeActivity(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface Group {
  key: string;
  title: string;
  /** For a Machine group: the badge's glyph and colour and a remote's state, for the header. */
  glyph?: string;
  color?: string | null;
  online?: boolean | null;
  ids: string[];
}

function byActivity(infos: Map<string, RowInfo>) {
  return (a: string, b: string) => {
    const ta = infos.get(a)?.since ? Date.parse(infos.get(a)!.since!) : 0;
    const tb = infos.get(b)?.since ? Date.parse(infos.get(b)!.since!) : 0;
    return tb - ta;
  };
}

/** Triage (sidebar redesign spec): what needs you, what is working, and the rest, each newest first. */
export function triage(order: string[], infos: Map<string, RowInfo>): { needs: string[]; working: string[]; quiet: string[]; exited: number } {
  const sort = byActivity(infos);
  const known = order.filter((id) => infos.has(id));
  const is = (id: string, s: RowStatus) => infos.get(id)!.status === s;
  const needs = known.filter((id) => is(id, "needs you")).sort(sort);
  const working = known.filter((id) => is(id, "working")).sort(sort);
  const quiet = known.filter((id) => !is(id, "needs you") && !is(id, "working")).sort(sort);
  return { needs, working, quiet, exited: quiet.filter((id) => infos.get(id)!.status.startsWith("exited")).length };
}

/** The Time view's buckets by last activity (sidebar redesign spec). */
export const TIME_BUCKETS: { key: string; title: string; upTo: number }[] = [
  { key: "hour", title: "Last hour", upTo: 3600_000 },
  { key: "today", title: "Today", upTo: 86_400_000 },
  { key: "week", title: "This week", upTo: 7 * 86_400_000 },
  { key: "older", title: "Older", upTo: Infinity },
];

/** The list's groups for `groupBy`; Triage and Tree draw their own (see `triage`, ConductorTree). */
export function groupRows(order: string[], infos: Map<string, RowInfo>, groupBy: GroupBy, now: number = Date.now()): Group[] {
  if (groupBy === "triage" || groupBy === "conductor") return [];
  if (groupBy === "time") {
    const sort = byActivity(infos);
    const out: Group[] = TIME_BUCKETS.map((b) => ({ key: b.key, title: b.title, ids: [] as string[] }));
    for (const id of [...order].filter((x) => infos.has(x)).sort(sort)) {
      const since = infos.get(id)!.since;
      const age = since ? now - Date.parse(since) : Infinity;
      const i = TIME_BUCKETS.findIndex((b) => (Number.isFinite(age) ? Math.max(0, age) : Infinity) < b.upTo || b.upTo === Infinity);
      out[i].ids.push(id);
    }
    return out.filter((g) => g.ids.length > 0);
  }
  const sort = byActivity(infos);
  const groups = new Map<string, Group>();
  for (const id of order) {
    const info = infos.get(id);
    if (!info) continue;
    let key: string;
    let title: string;
    let extra: Partial<Group> = {};
    if (groupBy === "machine") {
      key = info.machine.key;
      title = info.machine.alias ? `${info.machine.label} (${info.machine.alias})` : info.machine.label;
      extra = { glyph: info.machine.glyph, color: info.machine.color, online: info.machine.self ? null : info.machine.online };
    } else {
      key = info.folder;
      title = info.folder;
    }
    const g = groups.get(key) ?? { key, title, ids: [], ...extra };
    g.ids.push(id);
    groups.set(key, g);
  }
  const out = Array.from(groups.values());
  for (const g of out) g.ids.sort(sort);
  if (groupBy === "machine") {
    const selfKey = order.map((id) => infos.get(id)).find((i) => i?.machine.self)?.machine.key;
    out.sort((a, b) => (a.key === selfKey ? -1 : b.key === selfKey ? 1 : a.title.localeCompare(b.title)));
  } else {
    out.sort((a, b) => a.title.localeCompare(b.title));
  }
  return out;
}
