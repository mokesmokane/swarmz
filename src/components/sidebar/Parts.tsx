import { useState, type ReactNode } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useStore, machineColor, machineList, type MachineStatus } from "../../store";
import { ipc } from "../../lib/ipc";
import { displayTitle } from "../../lib/card";
import { GROUP_BY_OPTIONS, relativeActivity, type GroupBy, type RowInfo } from "../../lib/sidebarGroups";
import { machineGlyph, machineLabel } from "../../lib/workspace";
import { useMachinesPolling } from "../Machines";
import { CaretIcon, SelectAllIcon, TreeIcon } from "./icons";

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/** A Mac's chip: its glyph on its colour, hollow when it is offline (sidebar redesign spec). */
export function MacChip({ glyph, color, offline = false, title }: { glyph: string; color: string | null; offline?: boolean; title?: string }) {
  const c = color ?? "#525252";
  return (
    <span
      className="flex h-3.5 min-w-3.5 flex-none items-center justify-center rounded-[3px] px-0.5 text-[8.5px] font-bold"
      style={offline ? { border: `1px solid ${c}`, color: c } : { backgroundColor: c, color: "#101114" }}
      title={title}
      data-testid="machine-glyph"
    >
      {glyph}
    </span>
  );
}

/**
 * The notices line (sidebar redesign spec): sync's state in one line with a count of the other
 * notices; a click opens them all (sync, update, save and hook errors, sessions outside the
 * workspace), each with what can be done about it.
 */
export function Notices({ localError, onClearLocalError }: { localError: string | null; onClearLocalError: () => void }) {
  const [open, setOpen] = useState(false);
  const sync = useStore((s) => s.sync);
  const running = useStore((s) => s.tailscale?.running ?? false);
  const pull = useStore((s) => s.pullWorkspace);
  const persistError = useStore((s) => s.persistError);
  const dismissPersist = useStore((s) => s.dismissPersistError);
  const hooksError = useStore((s) => s.agentHooksError);
  const outside = useStore((s) => s.outsideSessions.length);
  const closeOutside = useStore((s) => s.closeOutsideSessions);
  const [outsideError, setOutsideError] = useState<string | null>(null);

  const ago = sync.lastPullAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(sync.lastPullAt)) / 1000))} s ago` : "not yet";
  const syncState: "off" | "error" | "ok" = !running || !sync.enabled ? "off" : sync.error ? "error" : "ok";
  const summary =
    syncState === "off" ? (running ? "Sync off" : "Sync off · Tailscale not running") : syncState === "error" ? null : `Synced · ${sync.peersOk}/${sync.peersTotal} Macs · ${ago}`;

  const items: { key: string; tone: "needs" | "muted" | "pick" | "exited"; text: string; action?: string; act?: () => void }[] = [];
  if (sync.error) items.push({ key: "sync", tone: "needs", text: `Sync error · ${sync.error}`, action: "Retry", act: () => void pull() });
  if (persistError) items.push({ key: "persist", tone: "needs", text: persistError, action: "Dismiss", act: dismissPersist });
  if (localError) items.push({ key: "local", tone: "exited", text: localError, action: "Dismiss", act: onClearLocalError });
  if (hooksError) items.push({ key: "hooks", tone: "needs", text: hooksError, action: "Retry", act: () => void useStore.getState().installAgentHooks().then(() => useStore.getState().ensureAgentWatchers()) });
  if (outside > 0 || outsideError)
    items.push({
      key: "outside",
      tone: "muted",
      text: outsideError ?? `${outside} session${outside === 1 ? "" : "s"} running outside this workspace`,
      action: outsideError ? "Dismiss" : "Close…",
      act: async () => {
        if (outsideError) return setOutsideError(null);
        const ok = await confirm(`End ${outside} shell${outside === 1 ? "" : "s"} that no tile shows? Anything running in them stops.`, { title: "Sessions outside this workspace" });
        if (ok) setOutsideError(await closeOutside());
      },
    });
  const count = items.length - (sync.error ? 1 : 0);
  const tone = { needs: "bg-needs", muted: "bg-muted", pick: "bg-pick", exited: "bg-exited" };
  const dot = syncState === "error" ? "bg-needs" : syncState === "ok" ? "bg-working" : "bg-faint";

  return (
    <>
      <button
        className="mx-2 flex h-[26px] flex-none items-center gap-[7px] rounded-[5px] px-1.5 text-left text-[11px] text-ink-3 hover:bg-hover"
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => void pull()}
        aria-expanded={open}
        title="Notices · double-click to sync now"
        data-testid="notices"
      >
        <span className={`h-1.5 w-1.5 flex-none rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate">
          {syncState === "error" ? (
            <>
              <span className="text-needs">Sync error</span>
              {` · ${sync.peersOk}/${sync.peersTotal} Macs · ${ago}`}
            </>
          ) : (
            summary
          )}
        </span>
        {count > 0 && <span className="flex-none rounded-lg bg-[#2a2c31] px-1.5 py-px text-[10px] font-semibold text-ink" data-testid="notices-count">{count}</span>}
      </button>
      {open && (
        <div className="mx-2 mt-1 flex flex-none flex-col overflow-hidden rounded-md border border-chip" data-testid="notices-list">
          {syncState !== "error" && (
            <NoticeRow tone={syncState === "ok" ? "bg-working" : "bg-faint"} text={summary ?? ""} action="Sync now" onAct={() => void pull()} />
          )}
          {items.map((n) => (
            <NoticeRow key={n.key} tone={tone[n.tone]} text={n.text} action={n.action} onAct={n.act} />
          ))}
        </div>
      )}
    </>
  );
}

function NoticeRow({ tone, text, action, onAct }: { tone: string; text: string; action?: string; onAct?: () => void }) {
  return (
    <div className="flex items-start gap-2 border-t border-line px-2 py-[7px] text-[11px] leading-[1.4] first:border-t-0">
      <span className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${tone}`} />
      <span className="min-w-0 flex-1 break-words text-ink-2">{text}</span>
      {action && onAct && (
        <button className="flex-none font-semibold text-link hover:underline" onClick={onAct}>
          {action}
        </button>
      )}
    </div>
  );
}

/** Mac · Triage · Folder · Tree · Time (sidebar redesign spec). */
export function ViewPicker({ value, onChange }: { value: GroupBy; onChange: (v: GroupBy) => void }) {
  return (
    <div className="mx-2 mb-1 mt-2 flex flex-none gap-0.5 rounded-md bg-well p-0.5" role="radiogroup" aria-label="View">
      {GROUP_BY_OPTIONS.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={`flex-1 rounded py-1 text-center text-[11px] ${value === o.value ? "bg-[#2e3137] font-semibold text-ink" : "text-muted hover:text-ink-2"}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A section's header: its label in small caps, a count, and what else it needs to say. */
export function SectionHeader({ children, testId, onClick, expanded }: { children: ReactNode; testId?: string; onClick?: () => void; expanded?: boolean }) {
  const cls = "flex w-full items-center gap-1.5 px-3 pb-1 pt-3.5 text-left text-[10.5px] font-semibold tracking-[0.05em] text-muted";
  return onClick ? (
    <button className={cls} onClick={onClick} aria-expanded={expanded} data-testid={testId}>
      {children}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {children}
    </div>
  );
}

/** A group's header in the Mac, Folder and Time views, with its select-all. */
export function GroupHeader({ label, count, needs, chip, onSelectAll, testId }: { label: string; count: number; needs: number; chip?: ReactNode; onSelectAll: () => void; testId: string }) {
  return (
    <div className="flex items-center gap-1.5 pb-1 pl-3 pr-2.5 pt-3 text-[10.5px] font-semibold tracking-[0.05em] text-muted" data-testid={testId}>
      {chip}
      <span className="truncate uppercase">{label}</span>
      <span className="font-medium text-faint">{count}</span>
      {needs > 0 && <span className="rounded-[7px] bg-needs px-[5px] text-[10px] font-bold leading-[14px] text-[#1a1405]">{needs}</span>}
      <span className="flex-1" />
      <button
        className="flex h-[18px] w-[18px] items-center justify-center rounded text-faint hover:bg-[#24262b] hover:text-ink"
        onClick={onSelectAll}
        title={`Select these ${count} to show them together in a layout`}
        aria-label={`Select ${label}`}
      >
        <SelectAllIcon />
      </button>
    </div>
  );
}

/** A folding caret for a section header. */
export function Caret({ folded }: { folded: boolean }) {
  return (
    <span className="flex" style={{ transform: folded ? "rotate(-90deg)" : undefined }}>
      <CaretIcon />
    </span>
  );
}

/** A tile asking for a conductor role, as a card at the top of Needs you (conductor spec §3). */
export function ClaimCard() {
  const claim = useStore((s) => s.conductorClaim);
  const title = useStore((s) => {
    const c = s.conductorClaim;
    if (!c) return "";
    const t = s.terminals[c.tile];
    return c.title?.trim() || (t ? displayTitle(s.settings[c.tile]?.card, s.agentState[c.tile], t.name) : c.tile);
  });
  const what = useStore((s) => {
    const c = s.conductorClaim;
    if (!c) return "";
    const name = (id: string | null | undefined) => {
      const t = id ? s.terminals[id] : undefined;
      return t && id ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : "";
    };
    if (c.sub) return `asks to be a sub-conductor${c.parent ? ` under ${name(c.parent)}` : ""}`;
    const top = s.conductor && s.conductor !== c.tile ? name(s.conductor) : "";
    return top ? `asks to replace ${top} as the top conductor` : "asks to be the conductor";
  });
  const decide = useStore((s) => s.decideClaim);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!claim) return null;
  const answer = (approve: boolean) => {
    setBusy(true);
    setError(null);
    decide(approve)
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-[7px] border border-dashed border-needs/45 bg-[#1a1b1f] px-2.5 py-2" data-testid="claim-bar">
      <div className="flex items-start gap-[7px] text-xs leading-[1.4] text-ink">
        <span className="mt-0.5 flex-none text-needs">
          <TreeIcon size={13} strokeWidth={1.4} />
        </span>
        <span>
          <b className="font-semibold">{title}</b> {what}
        </span>
      </div>
      {error && <div className="text-[11px] text-exited">{error}</div>}
      <div className="flex justify-end gap-1.5">
        <button className="rounded bg-chip px-2.5 py-[3px] text-[11px] text-ink-2 hover:bg-[#2e3137] disabled:opacity-50" disabled={busy} onClick={() => answer(false)}>
          Deny
        </button>
        <button className="rounded bg-needs px-2.5 py-[3px] text-[11px] font-semibold text-[#1a1405] disabled:opacity-50" disabled={busy} onClick={() => answer(true)}>
          Approve
        </button>
      </div>
    </div>
  );
}

/**
 * A tile that needs the user, as a Triage card (sidebar redesign spec): its title and age, what
 * it wants (the card's recap), its Mac and folder, and a way to answer: Deny / Allow for a
 * permission (answered through the tool, which refuses unless the dialog is on screen), else
 * Answer, which opens the tile.
 */
export function NeedsCard({ id, info, now }: { id: string; info: RowInfo | undefined; now: number }) {
  const t = useStore((s) => s.terminals[id]);
  const card = useStore((s) => s.settings[id]?.card ?? null);
  const agent = useStore((s) => s.agentState[id]);
  const machine = useStore((s) => s.settings[id]?.ssh?.machine ?? null);
  const focused = useStore((s) => s.focusedTerminalId === id);
  const isConductor = useStore((s) => s.conductor === id || id in s.conductors);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!t) return null;
  const permission = agent?.status === "blocked" && agent.lastEvent === "PermissionRequest";
  const finished = agent?.status === "idle";
  const body = card?.recap || agent?.firstPrompt || (permission ? "Waiting for a permission." : finished ? "Finished while you were away." : "Waiting for your answer.");
  const answer = (choice: "yes" | "no") => {
    setBusy(true);
    setError(null);
    ipc
      .tileAnswer(id, choice, machine)
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div
      className={`flex cursor-default flex-col gap-[5px] rounded-[7px] border border-needs/30 px-2.5 py-2 ${focused ? "bg-needs/[0.14]" : "bg-needs/[0.07]"}`}
      onClick={() => focusTerminal(id)}
      data-testid={`needs-card-${id}`}
    >
      <div className="flex items-center gap-[7px]">
        <span className="h-2 w-2 flex-none rounded-full bg-needs shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-needs)_22%,transparent)]" />
        {isConductor && (
          <span className="flex-none text-needs">
            <TreeIcon size={13} strokeWidth={1.4} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{displayTitle(card, agent, t.name)}</span>
        <span className="flex-none font-mono text-[10.5px] text-[#7d8087]">{relativeActivity(info?.since ?? null, now)}</span>
      </div>
      <div className="line-clamp-2 text-[11.5px] leading-[1.45] text-[#b9bbc1]">{body}</div>
      {error && <div className="text-[11px] text-exited">{error}</div>}
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <MacChip glyph={info?.machine.glyph ?? "?"} color={info?.machine.color ?? null} offline={info?.machine.online === false} />
        <span className="min-w-0 flex-1 truncate">{info?.folder ?? ""}</span>
        {permission ? (
          <span className="flex flex-none gap-1" onClick={stop}>
            <button className="rounded bg-chip px-2 py-0.5 text-ink-2 hover:bg-[#2e3137] disabled:opacity-50" disabled={busy} onClick={() => answer("no")}>
              Deny
            </button>
            <button className="rounded bg-ink px-2 py-0.5 font-semibold text-[#111] disabled:opacity-50" disabled={busy} onClick={() => answer("yes")}>
              Allow
            </button>
          </span>
        ) : (
          <button
            className="flex-none rounded bg-ink px-2 py-0.5 font-semibold text-[#111]"
            onClick={(e) => {
              stop(e);
              focusTerminal(id);
            }}
          >
            {finished ? "Open" : "Answer"}
          </button>
        )}
      </div>
    </div>
  );
}

function macDot(m: MachineStatus | undefined): string {
  if (!m || !m.online) return "bg-faint";
  if (m.error || (m.stats?.disk.freePercent ?? 100) < 5) return "bg-needs";
  return "bg-working";
}

/** The Machines footer (sidebar redesign spec): always there, a line per Mac; a click opens the Machines view. */
export function MachinesFooter({ onOpen }: { onOpen: () => void }) {
  useMachinesPolling(true);
  const namesKey = useStore((s) => {
    const list = machineList(s);
    return [...list.filter((m) => m.self), ...list.filter((m) => !m.self).sort((a, b) => a.name.localeCompare(b.name))].map((m) => m.name).join("\n");
  });
  const names = namesKey ? namesKey.split("\n") : [];
  const check = useStore((s) => s.checkForUpdates);
  const checking = useStore((s) => s.update.status === "checking");
  // "Up to date" answers a check the user asked for; a quiet background check says nothing.
  const upToDate = useStore((s) => s.update.status === "idle" && s.update.manual && s.update.checkedAt !== null);
  return (
    <div className="flex-none border-t border-line pb-2.5 pt-2" data-testid="machines-footer">
      <div className="flex items-center px-3 pb-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted">
        <button className="flex-1 text-left hover:text-ink" onClick={onOpen} title="Open the Machines view">
          MACHINES
        </button>
        <button
          className="font-medium tracking-normal text-faint hover:text-ink disabled:opacity-60"
          onClick={() => void check({ manual: true })}
          title="Check for a newer swarmz"
          disabled={checking}
          data-testid="check-updates"
        >
          {checking ? "Checking…" : upToDate ? `Up to date · v${__APP_VERSION__}` : `v${__APP_VERSION__} · Check for updates`}
        </button>
      </div>
      {names.map((n) => (
        <MachineLine key={n} name={n} onOpen={onOpen} />
      ))}
    </div>
  );
}

function MachineLine({ name, onOpen }: { name: string; onOpen: () => void }) {
  const m = useStore((s) => s.machineStats[name]);
  const label = useStore((s) => machineLabel(name, s.machines[name]));
  const color = useStore((s) => machineColor(s, name));
  const glyph = useStore((s) => machineGlyph(name, s.machines[name]));
  const needs = (m?.stats?.claude.needsYou ?? 0) + (m?.stats?.codex?.needsYou ?? 0);
  const ping = m?.ping?.ms != null ? `${m.ping.direct ? "" : "↯ "}${m.ping.ms} ms` : "";
  return (
    <button className="flex w-full items-center gap-[7px] px-3 py-1 text-left text-[11px] text-[#b9bbc1] hover:bg-hover" onClick={onOpen} data-testid={`machine-line-${name}`} title={name}>
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${macDot(m)}`} />
      <MacChip glyph={glyph} color={color} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="h-1 w-9 flex-none overflow-hidden rounded-sm bg-chip" title={m?.stats ? `CPU ${m.stats.cpu.percent}%` : undefined}>
        <span className="block h-full bg-muted" style={{ width: `${Math.max(0, Math.min(100, m?.stats?.cpu.percent ?? 0))}%` }} />
      </span>
      <span className="w-[50px] flex-none text-right font-mono text-[10px] text-[#7d8087]">{m?.online === false ? "offline" : ping}</span>
      {needs > 0 && <span className="flex-none rounded-[7px] bg-needs px-[5px] text-[10px] font-bold leading-[14px] text-[#1a1405]">{needs}</span>}
    </button>
  );
}
