import { useEffect, useRef, useState } from "react";
import { GROUP_BY_OPTIONS, groupRows, loadGroupBy, relativeActivity, rowInfo, saveGroupBy, type GroupBy, type RowInfo } from "../lib/sidebarGroups";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useStore, terminalColor } from "../store";
import { endTerminalDrag, startTerminalDrag } from "./TabGroup";
import { NewRemoteTerminal } from "./NewRemoteTerminal";
import { dotPresentation } from "../lib/agentState";
import { displayTitle, hasTitle } from "../lib/card";
import { SessionHistory } from "./SessionHistory";
import { PhonesPanel } from "./PhonesPanel";
import { UpdateNotice, UpdateVersionLine } from "./UpdateNotice";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** The status word's colour: attention amber, working green, the rest muted. */
function statusClass(status: string): string {
  if (status === "needs you") return "text-amber-300";
  if (status === "working") return "text-emerald-400";
  if (status.startsWith("exited")) return "text-red-400";
  return "text-neutral-500";
}

// Tailwind class inventory (scanned, never executed):
// text-amber-300 text-emerald-400 text-red-400 text-neutral-500

/** A clock that ticks every `everyMs`, for the relative times in the list (sidebar groups spec §2). */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/**
 * The machine badge of a row or a group header: a small square in the machine's colour carrying
 * its glyph (the icon from its settings, else a monogram of its name), hollow when the remote is
 * offline, then the machine's name.
 */
function MachineChip({ glyph, label, alias, color, online }: { glyph: string; label: string; alias?: string | null; color: string | null; online: boolean | null }) {
  const hollow = online === false;
  const state = online === false ? " · offline" : online === true ? " · online" : "";
  const bg = color ?? "#525252";
  return (
    <span className="inline-flex items-center gap-1" title={`${alias ? `${alias} · ` : ""}${label}${state}`}>
      <span
        className="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm px-0.5 text-[9px] font-bold leading-none"
        style={hollow ? { border: `1px solid ${bg}`, color: bg } : { backgroundColor: bg, color: "#0f1115" }}
        data-testid="machine-glyph"
      >
        {glyph}
      </span>
      <span>{label}</span>
    </span>
  );
}

/** How long a row is hovered before its card opens (conversation cards spec §5). */
export const HOVER_CARD_MS = 400;

/**
 * The hover card of a row: title; name, machine and folder; the recap, else the first prompt in
 * full, else "No recap yet"; and when the card was last set and by whom.
 */
function HoverCard({ id }: { id: string }) {
  const t = useStore((s) => s.terminals[id]);
  const card = useStore((s) => s.settings[id]?.card ?? null);
  const agent = useStore((s) => s.agentState[id]);
  const machineName = useStore((s) => s.settings[id]?.ssh?.machine ?? null);
  const machineCwd = useStore((s) => s.settings[id]?.ssh?.cwd ?? "");
  const online = useStore((s) => (machineName ? (s.tailscale?.peers.find((p) => p.name === machineName)?.online ?? null) : null));
  if (!t) return null;
  const where = machineName
    ? `${machineName}${online === true ? " · online" : online === false ? " · offline" : ""}${machineCwd ? ` · ${machineCwd}` : ""}`
    : t.cwd;
  const body = card?.recap || (card?.title ? null : agent?.firstPrompt) || null;
  return (
    <div
      data-testid={`hover-card-${id}`}
      role="tooltip"
      className="absolute left-2 right-2 z-30 mt-1 rounded border border-neutral-700 bg-neutral-900 p-2 text-xs shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="truncate text-sm font-medium text-neutral-100">{displayTitle(card, agent, t.name)}</div>
      <div className="truncate text-neutral-500">{`${t.name} · ${where}`}</div>
      <div className="mt-1 whitespace-pre-wrap break-words text-neutral-300">{body ?? "No recap yet"}</div>
      {card?.updatedAt && (
        <div className="mt-1 text-neutral-500">{`updated ${relativeTime(card.updatedAt)} by ${card.by === "user" ? "you" : "Claude"}`}</div>
      )}
    </div>
  );
}

function SyncLine() {
  const enabled = useStore((s) => s.sync.enabled);
  const error = useStore((s) => s.sync.error);
  const peersOk = useStore((s) => s.sync.peersOk);
  const peersTotal = useStore((s) => s.sync.peersTotal);
  const lastPullAt = useStore((s) => s.sync.lastPullAt);
  const running = useStore((s) => s.tailscale?.running ?? false);
  const pull = useStore((s) => s.pullWorkspace);
  const ago = lastPullAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(lastPullAt)) / 1000))} s ago` : "not yet";
  const text = !running ? "Sync off · Tailscale not running" : !enabled ? "Sync off" : error ? `Sync error · ${error}` : `Synced · ${peersOk}/${peersTotal} machines · ${ago}`;
  return (
    <button
      className={`w-full truncate border-b border-neutral-800 px-3 py-1 text-left text-[10px] ${error ? "text-amber-300" : "text-neutral-500"} hover:bg-neutral-800/60`}
      title={error ?? "Click to sync now"}
      onClick={() => void pull()}
    >
      {text}
    </button>
  );
}

function OutsideSessionsLine() {
  const ids = useStore((s) => s.outsideSessions);
  const closeAll = useStore((s) => s.closeOutsideSessions);
  const [error, setError] = useState<string | null>(null);
  if (ids.length === 0 && !error) return null;
  const onClose = async () => {
    const ok = await confirm(`End ${ids.length} shell${ids.length === 1 ? "" : "s"} that no tile shows? Anything running in them stops.`, {
      title: "Sessions outside this workspace",
    });
    if (ok) setError(await closeAll());
  };
  return (
    <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
      <span className="flex-1">{error ?? `${ids.length} session${ids.length === 1 ? "" : "s"} running outside this workspace`}</span>
      {ids.length > 0 && (
        <button className="text-neutral-400 hover:text-neutral-100" onClick={() => void onClose()}>
          Close them
        </button>
      )}
      {error && (
        <button className="text-neutral-500 hover:text-neutral-200" onClick={() => setError(null)} title="Dismiss">×</button>
      )}
    </div>
  );
}

function Row({ id, info, now }: { id: string; info: RowInfo | undefined; now: number }) {
  const t = useStore((s) => s.terminals[id]);
  const settings = useStore((s) => s.settings[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  // Select primitives only (a plain string/boolean/null): machineFor/its cfg return a fresh
  // object on every call, and with zustand 5's default (no) equality check a hook selector that
  // returns a new object every render re-renders forever. terminalColor is safe because it
  // already narrows machineFor's result down to a primitive.
  const color = useStore((s) => terminalColor(s, id));
  const agent = useStore((s) => s.agentState[id]);
  const machineName = useStore((s) => s.settings[id]?.ssh?.machine ?? null);
  const online = useStore((s) =>
    machineName ? (s.tailscale?.peers.find((p) => p.name === machineName)?.online ?? null) : null,
  );
  const focusTerminal = useStore((s) => s.focusTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const setCardTitle = useStore((s) => s.setCardTitle);
  const card = useStore((s) => s.settings[id]?.card ?? null);
  // What is being edited inline: the tile's name, or its card's title (spec §5).
  const [editing, setEditing] = useState<false | "name" | "title">(false);
  const [draft, setDraft] = useState("");
  const [hovering, setHovering] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suppressBlur = useRef(false);
  // Command tiles are never adopted and cannot go back (spec §4), so the button would open an
  // empty popover; SessionHistory hides itself for the same reason.
  const hasHistory = useStore(
    (s) => !s.settings[id]?.command?.trim() && (s.settings[id]?.sessions ?? []).some((r) => r.sessionId !== s.settings[id]?.claude?.sessionId),
  );
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!t) return null;

  const commit = async () => {
    if (editing === "title") {
      setCardTitle(id, draft);
    } else {
      const err = await renameTerminal(id, draft);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(null);
    suppressBlur.current = true;
    setEditing(false);
  };

  const startEditing = (what: "name" | "title") => {
    suppressBlur.current = false;
    setDraft(what === "name" ? t.name : (card?.title ?? ""));
    setEditing(what);
    setError(null);
    stopHover();
  };

  const stopHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHovering(false);
  };

  const row = (
    <div
      draggable={!editing}
      onDragStart={(e) => startTerminalDrag(e, id)}
      onDragEnd={endTerminalDrag}
      onClick={() => focusTerminal(id)}
      onDoubleClick={() => startEditing("name")}
      onMouseEnter={() => {
        if (editing) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setHovering(true), HOVER_CARD_MS);
      }}
      onMouseLeave={stopHover}
      onKeyDown={stopHover}
      className={`group flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm ${
        focused ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
      }`}
      style={{ borderLeft: color ? `2px solid ${color}` : undefined }}
      data-machine-state={machineName ? (online === true ? "online" : online === false ? "offline" : "unknown") : undefined}
    >
      {(() => {
        const dot = dotPresentation(t.exited, agent, color);
        const title = dot.title && agent && t.exited === null ? `${dot.title} · ${relativeTime(agent.since)}` : dot.title;
        return (
          <span
            data-testid={`agent-dot-${id}`}
            className={`h-2 w-2 shrink-0 rounded-full ${dot.className}`}
            style={{ backgroundColor: dot.backgroundColor }}
            title={title}
          />
        );
      })()}
      <div className="min-w-0 flex-1">
        {editing ? (
          <div>
            <input
              autoFocus
              value={draft}
              placeholder={editing === "title" ? "Title (empty: back to the agent's)" : "Name"}
              aria-label={editing === "title" ? "Title" : "Name"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
                if (e.key === "Escape") {
                  suppressBlur.current = true;
                  setEditing(false);
                  setError(null);
                }
              }}
              onBlur={() => {
                if (suppressBlur.current) {
                  suppressBlur.current = false;
                  return;
                }
                void commit();
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-1 text-sm text-neutral-100 outline-none focus:border-blue-500"
            />
            {error && <div className="mt-0.5 text-xs text-red-400">{error}</div>}
          </div>
        ) : (
          <>
            <div
              className="flex items-baseline gap-1.5"
              data-testid={`title-${id}`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEditing("title");
              }}
            >
              <span className="min-w-0 truncate">{displayTitle(card, agent, t.name)}</span>
              {hasTitle(card, agent) && info && t.name !== info.folder && (
                // The tile's name, when the title has taken its place and the folder does not already say it.
                <span className="shrink-0 rounded bg-neutral-800/80 px-1 font-mono text-[10px] text-neutral-400" title="Tile name">{t.name}</span>
              )}
              {settings?.claude?.enabled && settings.claude.skipPermissions && (
                <span
                  className="ml-1 rounded bg-red-900/60 px-1 text-[10px] font-semibold text-red-300"
                  title="Claude runs with --dangerously-skip-permissions"
                >
                  ⚠ skip-perms
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 truncate text-xs text-neutral-500" data-testid={`line2-${id}`}>
              {info ? (
                <>
                  <MachineChip glyph={info.machine.glyph} label={info.machine.label} alias={info.machine.alias} color={info.machine.color} online={info.machine.online} />
                  <span className="text-neutral-700">·</span>
                  <span className="min-w-0 truncate">{info.folder}</span>
                  <span className="text-neutral-700">·</span>
                  <span className={`shrink-0 ${statusClass(info.status)}`}>{info.status}</span>
                  {info.since && (
                    <>
                      <span className="text-neutral-700">·</span>
                      <span className="shrink-0 text-neutral-600">{relativeActivity(info.since, now)}</span>
                    </>
                  )}
                </>
              ) : (
                basename(t.cwd)
              )}
            </div>
          </>
        )}
      </div>
      {hasHistory && (
        <button
          className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setHistoryOpen((v) => !v);
          }}
          title="Previous sessions"
          aria-label="Previous sessions"
        >
          ↺
        </button>
      )}
      <button
        className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminal(id).catch(() => {});
        }}
        title="Close terminal"
      >
        ×
      </button>
    </div>
  );

  return (
    <div className="relative">
      {row}
      {hovering && !historyOpen && !editing && <HoverCard id={id} />}
      {historyOpen && (
        <div className="absolute left-2 right-2 z-30 mt-1 rounded border border-neutral-700 bg-neutral-900 p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <SessionHistory id={id} onPick={() => setHistoryOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function Sidebar({ width = 256 }: { width?: number } = {}) {
  const order = useStore((s) => s.order);
  const lastCwd = useStore((s) => s.lastCwd);
  const createTerminal = useStore((s) => s.createTerminal);
  const reloadWorkspace = useStore((s) => s.reloadWorkspace);
  const persistError = useStore((s) => s.persistError);
  const dismiss = useStore((s) => s.dismissPersistError);
  const agentHooksError = useStore((s) => s.agentHooksError);
  const installAgentHooks = useStore((s) => s.installAgentHooks);
  const ensureAgentWatchers = useStore((s) => s.ensureAgentWatchers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "ssh">("closed");
  const [phonesOpen, setPhonesOpen] = useState(false);
  // The list's grouping (sidebar groups spec §3), a per-machine preference.
  const [groupBy, setGroupBy] = useState<GroupBy>(() => loadGroupBy());
  const now = useNow(30_000);
  const terminals = useStore((s) => s.terminals);
  const settings = useStore((s) => s.settings);
  const agentState = useStore((s) => s.agentState);
  const selfMachine = useStore((s) => s.selfMachine);
  const machines = useStore((s) => s.machines);
  const peers = useStore((s) => s.tailscale?.peers ?? null);
  const online: Record<string, boolean> = {};
  for (const p of peers ?? []) online[p.name] = p.online;
  const infos = new Map<string, RowInfo>();
  for (const id of order) {
    const t = terminals[id];
    if (!t) continue;
    const s = settings[id];
    infos.set(id, rowInfo({ id, name: t.name, cwd: t.cwd, exited: t.exited, ssh: s?.ssh ?? null, foreign: s?.foreign ?? null, sessions: s?.sessions, agent: agentState[id] }, { selfMachine, machines, online }));
  }
  const groups = groupRows(order, infos, groupBy);

  const addTerminal = async () => {
    setMenu("closed");
    setBusy(true);
    setError(null);
    try {
      const picked = await open({ directory: true, multiple: false, defaultPath: lastCwd ?? undefined });
      if (typeof picked === "string") await createTerminal(picked);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full shrink-0 flex-col border-r border-neutral-800 bg-neutral-950" style={{ width }}>
      <div className="flex h-8 items-center justify-between border-b border-neutral-800 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <span>Terminals</span>
        <div className="flex items-center gap-1">
          <button
            className="rounded px-1.5 text-sm leading-none text-neutral-400 hover:bg-neutral-800"
            onClick={() => setPhonesOpen((o) => !o)}
            title="Phones"
          >
            📱
          </button>
          <button
            className="rounded px-1.5 text-sm leading-none text-neutral-400 hover:bg-neutral-800"
            onClick={() => void reloadWorkspace()}
            title="Reload ~/.swarmz/workspace.json"
          >
            ↻
          </button>
          <button
            className="rounded px-2 text-base leading-none text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            onClick={() => setMenu((m) => (m === "closed" ? "open" : "closed"))}
            disabled={busy}
            title="New terminal"
          >
            +
          </button>
        </div>
      </div>
      <SyncLine />
      <UpdateNotice />
      {phonesOpen && <PhonesPanel onClose={() => setPhonesOpen(false)} />}
      {menu === "open" && (
        <div className="flex gap-1 border-b border-neutral-800 p-2 text-xs">
          <button
            className="flex-1 rounded border border-neutral-700 px-2 py-1 text-neutral-200 hover:bg-neutral-800"
            onClick={() => void addTerminal()}
          >
            Local terminal…
          </button>
          <button
            className="flex-1 rounded border border-neutral-700 px-2 py-1 text-neutral-200 hover:bg-neutral-800"
            onClick={() => setMenu("ssh")}
          >
            Remote terminal…
          </button>
        </div>
      )}
      {menu === "ssh" && <NewRemoteTerminal onClose={() => setMenu("closed")} />}
      {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
      {persistError && (
        <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
          <span className="flex-1">{persistError}</span>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={dismiss} title="Dismiss">×</button>
        </div>
      )}
      {agentHooksError && (
        <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
          <span className="flex-1">{agentHooksError}</span>
          <button className="text-neutral-400 hover:text-neutral-100" onClick={() => void installAgentHooks().then(ensureAgentWatchers)}>Retry</button>
        </div>
      )}
      <OutsideSessionsLine />
      {order.length > 1 && (
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1 text-xs text-neutral-500">
          <label htmlFor="sidebar-group-by">Group by</label>
          <select
            id="sidebar-group-by"
            className="rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-neutral-300"
            value={groupBy}
            onChange={(e) => {
              const v = e.target.value as GroupBy;
              setGroupBy(v);
              saveGroupBy(v);
            }}
          >
            {GROUP_BY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {groups.map((g) => (
          <div key={g.key}>
            {g.title && (
              <div className="flex items-center gap-1 px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500" data-testid={`group-${g.key}`}>
                {groupBy === "machine" ? <MachineChip glyph={g.glyph ?? "?"} label={g.title} color={g.color ?? null} online={g.online ?? null} /> : <span>{g.title}</span>}
                <span className="text-neutral-600">{g.ids.length}</span>
                {groupBy === "machine" && g.online === false && <span className="text-neutral-600">· offline</span>}
              </div>
            )}
            {g.ids.map((id) => (
              <Row key={id} id={id} info={infos.get(id)} now={now} />
            ))}
          </div>
        ))}
        {order.length === 0 && <div className="px-2 py-4 text-xs text-neutral-500">No terminals</div>}
      </div>
      <UpdateVersionLine />
    </aside>
  );
}
