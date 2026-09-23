import type { AgentState } from "./agentState";
import { needsYou } from "./agentState";
import type { SessionRecord } from "./sessions";
import { hostLabel, machineLabel, type Machines } from "./workspace";

/** How the sidebar lists tiles (sidebar groups spec §3), a per-machine preference. */
export type GroupBy = "workspace" | "machine" | "status" | "folder";
export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "workspace", label: "Workspace" },
  { value: "machine", label: "Machine" },
  { value: "status", label: "Status" },
  { value: "folder", label: "Folder" },
];
const KEY = "swarmz.sidebarGroupBy";

export function loadGroupBy(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): GroupBy {
  const raw = storage?.getItem(KEY);
  return GROUP_BY_OPTIONS.some((o) => o.value === raw) ? (raw as GroupBy) : "workspace";
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
  /** The machine chip: the machine's name, its alias (for the tooltip), colour, and whether a remote is known offline. */
  machine: { key: string; label: string; alias: string | null; color: string | null; self: boolean; online: boolean | null };
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
  /** For a Machine group: the chip's colour and a remote's state, for the header. */
  color?: string | null;
  online?: boolean | null;
  ids: string[];
}

const STATUS_ORDER: RowStatus[] = ["needs you", "working", "idle", "stopped"];

function statusBucket(s: RowStatus): RowStatus {
  return s.startsWith("exited") ? "stopped" : s;
}

function byActivity(infos: Map<string, RowInfo>) {
  return (a: string, b: string) => {
    const ta = infos.get(a)?.since ? Date.parse(infos.get(a)!.since!) : 0;
    const tb = infos.get(b)?.since ? Date.parse(infos.get(b)!.since!) : 0;
    return tb - ta;
  };
}

/** The list's groups for `groupBy` (spec §3); a single untitled group in workspace order for "workspace". */
export function groupRows(order: string[], infos: Map<string, RowInfo>, groupBy: GroupBy): Group[] {
  if (groupBy === "workspace") return [{ key: "all", title: "", ids: order }];
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
      extra = { color: info.machine.color, online: info.machine.self ? null : info.machine.online };
    } else if (groupBy === "status") {
      key = statusBucket(info.status);
      title = key;
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
  } else if (groupBy === "status") {
    out.sort((a, b) => STATUS_ORDER.indexOf(a.key as RowStatus) - STATUS_ORDER.indexOf(b.key as RowStatus));
  } else {
    out.sort((a, b) => a.title.localeCompare(b.title));
  }
  return out;
}
