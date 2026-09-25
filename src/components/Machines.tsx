import { useEffect, useState, type ReactNode } from "react";
import { useStore, machineList, machineThemeId, type MachineStatus } from "../store";
import { themeById } from "../lib/themes";
import { bytesText, uptimeText } from "../lib/activityBar";
import { machineLabel } from "../lib/workspace";
import { ThemePicker } from "./ThemePicker";

/** How often the Machines numbers are asked for while they are showing (spec §4, amended: 30 s). */
export const MACHINES_POLL_MS = 30_000;

/**
 * Keeps the numbers fresh while `active` (the section open or the view showing) and the window is
 * focused: once now, then every `MACHINES_POLL_MS`, and again as soon as focus comes back.
 */
export function useMachinesPolling(active: boolean) {
  const focused = useStore((s) => s.windowFocused);
  const refresh = useStore((s) => s.refreshMachineStats);
  useEffect(() => {
    if (!active || !focused) return;
    void refresh();
    const t = setInterval(() => void refresh(), MACHINES_POLL_MS);
    return () => clearInterval(t);
  }, [active, focused, refresh]);
}

/** The Macs in the order the view shows them (this one first, then by name), as primitive keys. */
function useMacNames(): string[] {
  const names = useStore((s) => {
    const list = machineList(s);
    const self = list.filter((m) => m.self).map((m) => m.name);
    const rest = list.filter((m) => !m.self).map((m) => m.name).sort((a, b) => a.localeCompare(b));
    return [...self, ...rest].join("\n");
  });
  return names ? names.split("\n") : [];
}

function useLabel(name: string): { label: string; color: string | null } {
  const label = useStore((s) => machineLabel(name, s.machines[name]));
  const color = useStore((s) => s.machines[name]?.color ?? null);
  return { label, color };
}

/** The dot beside a Mac: green answering, grey offline, amber when it answered with an error. */
function stateOf(m: MachineStatus | undefined): { cls: string; word: string } {
  if (!m) return { cls: "bg-neutral-600", word: "asking…" };
  if (!m.online) return { cls: "bg-neutral-600", word: "offline" };
  if (m.error === "old_tool") return { cls: "bg-amber-500", word: "update swarmz there" };
  if (m.error) return { cls: "bg-amber-500", word: m.error };
  return { cls: "bg-emerald-500", word: "online" };
}

function pingText(m: MachineStatus | undefined): string | null {
  if (!m?.ping || m.ping.ms === null) return null;
  return `${m.ping.ms}ms${m.ping.direct ? "" : " ↯"}`;
}

function Bar({ percent, warn = 85, danger = 95, invert = false, label }: { percent: number | null | undefined; warn?: number; danger?: number; invert?: boolean; label: string }) {
  const p = percent ?? 0;
  const level = invert ? 100 - p : p;
  const colour = level >= danger ? "bg-red-500" : level >= warn ? "bg-amber-500" : "bg-sky-500";
  return (
    <span className="inline-block h-1.5 w-full overflow-hidden rounded bg-neutral-800" role="meter" aria-label={label} aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <span className={`block h-full ${colour}`} style={{ width: `${Math.max(0, Math.min(100, p))}%` }} />
    </span>
  );
}

function sessionsText(m: MachineStatus | undefined): ReactNode {
  const c = m?.stats?.claude;
  if (!c) return null;
  const live = c.working + c.needsYou + c.idle;
  return (
    <>
      <span>{`${live} Claude`}</span>
      {c.needsYou > 0 && <span className="ml-1 rounded bg-red-900/60 px-1 text-red-200">{`${c.needsYou} need${c.needsYou === 1 ? "s" : ""} you`}</span>}
    </>
  );
}

/** One line per Mac under the terminal list (spec §3). */
export function MachinesSection({ active }: { active: boolean }) {
  useMachinesPolling(active);
  const names = useMacNames();
  return (
    <div className="space-y-0.5 px-2 pb-2" data-testid="machines-section">
      {names.length === 0 && <div className="px-1 text-xs text-neutral-500">No Macs known yet.</div>}
      {names.map((n) => (
        <MachineLine key={n} name={n} />
      ))}
    </div>
  );
}

function MachineLine({ name }: { name: string }) {
  const m = useStore((s) => s.machineStats[name]);
  const { label, color } = useLabel(name);
  const st = stateOf(m);
  const ping = pingText(m);
  return (
    <div className="flex items-center gap-2 rounded px-1 py-0.5 text-xs text-neutral-300" data-testid={`machine-line-${name}`} title={`${name}: ${st.word}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${st.cls}`} />
      <span className="min-w-0 flex-1 truncate" style={{ color: color ?? undefined }}>{label}</span>
      {m?.online && m.stats && (
        <span className="w-10 shrink-0" title={`CPU ${m.stats.cpu.percent}%`}>
          <Bar percent={m.stats.cpu.percent} label={`${label} CPU`} />
        </span>
      )}
      {ping && <span className="w-12 shrink-0 text-right text-neutral-500" title={m?.ping?.direct ? "direct" : `relayed via ${m?.ping?.relay}`}>{ping}</span>}
      <span className="shrink-0 text-neutral-400">{m?.online ? sessionsText(m) : <span className="text-neutral-600">{st.word}</span>}</span>
    </div>
  );
}

/** A card per Mac (spec §3): every number, and why a Mac did not answer. */
export function MachinesView() {
  useMachinesPolling(true);
  const names = useMacNames();
  const refresh = useStore((s) => s.refreshMachineStats);
  return (
    <div className="flex h-full flex-col" data-testid="machines-view">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-neutral-800 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <span>Machines</span>
        <button className="rounded px-1.5 text-sm leading-none text-neutral-400 hover:bg-neutral-800" onClick={() => void refresh()} title="Ask every Mac now" aria-label="Refresh machines">
          ↻
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {names.length === 0 && <div className="px-1 text-xs text-neutral-500">No Macs known yet: Tailscale lists them once it is running.</div>}
        {names.map((n) => (
          <MachineCard key={n} name={n} />
        ))}
      </div>
    </div>
  );
}

/** The Mac's terminal theme (machine themes spec), folded to its name until opened. */
function ThemeRow({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const current = useStore((s) => machineThemeId(s, name));
  return (
    <div className="mt-1.5 border-t border-neutral-800 pt-1.5">
      <button className="flex w-full items-center gap-2 text-left text-neutral-500 hover:text-neutral-300" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid={`theme-row-${name}`}>
        <span className="w-[4.5rem]">Theme</span>
        <span className="flex-1 text-neutral-300">{themeById(current).name}</span>
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1.5">
          <ThemePicker name={name} />
        </div>
      )}
    </div>
  );
}

function MachineCard({ name }: { name: string }) {
  const m = useStore((s) => s.machineStats[name]);
  const { label, color } = useLabel(name);
  const st = stateOf(m);
  const s = m?.stats;
  const row = (k: string, v: ReactNode, bar?: ReactNode) => (
    <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
      <span className="text-neutral-500">{k}</span>
      <span className="min-w-0">
        <span className="block truncate text-neutral-200">{v}</span>
        {bar}
      </span>
    </div>
  );
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs" data-testid={`machine-card-${name}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${st.cls}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: color ?? undefined }}>{label}</span>
        {m?.self && <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">this Mac</span>}
        {pingText(m) && <span className="text-neutral-400" title={m?.ping?.direct ? "direct" : `relayed via ${m?.ping?.relay}`}>{m?.ping?.direct ? `${m?.ping?.ms}ms direct` : `${m?.ping?.ms}ms via ${m?.ping?.relay}`}</span>}
      </div>
      {(!m?.online || (m.error && !s)) && <div className="text-neutral-500">{st.word}</div>}
      {s && (
        <div className="space-y-1">
          {row("CPU", `${s.cpu.percent}%${s.cpu.load1 !== null ? ` · load ${s.cpu.load1} / ${s.cpu.cores ?? "?"} cores` : ""}`, <Bar percent={s.cpu.percent} label={`${label} CPU`} />)}
          {row("Memory", s.memory.usedPercent !== null ? `${s.memory.usedPercent}% of ${bytesText(s.memory.totalBytes)}` : "–", <Bar percent={s.memory.usedPercent} label={`${label} memory`} />)}
          {row("Disk", s.disk.freePercent !== null ? `${bytesText(s.disk.freeBytes)} free (${s.disk.freePercent}%)` : "–", <Bar percent={s.disk.freePercent === null ? null : 100 - s.disk.freePercent} warn={90} label={`${label} disk used`} />)}
          {row("Claude", `${s.claude.working} working · ${s.claude.needsYou} need you · ${s.claude.idle} idle · ${s.claude.stopped} stopped`)}
          {row("Up", uptimeText(s.uptimeSeconds))}
          {row("swarmz", `${s.app ? `app ${s.app} · ` : ""}tool ${s.tool}`)}
          {m?.error && <div className="text-amber-400">{`Last ask failed: ${st.word}`}</div>}
        </div>
      )}
      <ThemeRow name={name} />
    </div>
  );
}
