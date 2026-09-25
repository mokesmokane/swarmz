import { useEffect, useRef, useState } from "react";
import { groupRows, triage, loadGroupBy, relativeActivity, rowInfo, saveGroupBy, type GroupBy, type RowInfo } from "../lib/sidebarGroups";
import { open } from "@tauri-apps/plugin-dialog";
import { conductorFor, isConductorTile, layoutsOf, useStore } from "../store";
import { ConductorMenu } from "./ConductorMenu";
import { ConductorTree } from "./ConductorTree";
import { ipc } from "../lib/ipc";
import { endTabDrag, startTerminalDrag } from "./TabGroup";
import { windowOfTile } from "../lib/windowLayouts";
import { SelectionTray } from "./SelectionTray";
import { Caret, ClaimCard, GroupHeader, MachinesFooter, MacChip, NeedsCard, Notices, SectionHeader, ViewPicker } from "./sidebar/Parts";
import { identifyMark } from "./IdentifyLabel";
import { CaretIcon, CheckIcon, CloseIcon, HistoryIcon, MoreIcon, PlusIcon, ReloadIcon, TreeIcon } from "./sidebar/icons";
import { NewRemoteTerminal } from "./NewRemoteTerminal";
import { displayTitle, hasTitle } from "../lib/card";
import { SessionHistory } from "./SessionHistory";
import { loadFoldedSections, saveFoldedSections } from "../lib/activityBar";
import { buildConductorTree, descendants, findNode } from "../lib/conductorTree";

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

/** A clock that ticks every `everyMs`, for the relative times in the list (sidebar groups spec §2). */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
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
  const isTop = useStore((s) => s.conductor === id);
  const sub = useStore((s) => (s.conductor !== id && isConductorTile(s, id) ? s.conductors[id] : null));
  const owner = useStore((s) => conductorFor(s, id));
  const ownerTitle = useStore((s) => {
    if (!owner) return "";
    const o = s.terminals[owner];
    return o ? displayTitle(s.settings[owner]?.card, s.agentState[owner], o.name) : owner;
  });
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
      {isTop && <div className="text-amber-300">🎛 Conductor · acts on the tiles under it</div>}
      {sub && <div className="text-amber-300">{`🎛 Conductor · answers to ${ownerTitle}`}</div>}
      {!isTop && !sub && owner && <div className="text-neutral-500">{`Answers to 🎛 ${ownerTitle}`}</div>}
      <div className="mt-1 whitespace-pre-wrap break-words text-neutral-300">{body ?? "No recap yet"}</div>
      {card?.updatedAt && (
        <div className="mt-1 text-neutral-500">{`updated ${relativeTime(card.updatedAt)} by ${card.by === "user" ? "you" : "Claude"}`}</div>
      )}
    </div>
  );
}




/** What the Tree view adds to a row: its fold caret and, folded, a summary of what is under it. */
export interface RowTree {
  caret: boolean;
  folded: boolean;
  onFold: () => void;
  summary: string | null;
  summaryNeeds: string | null;
}

export function Row({ id, info, now, visible, depth = 0, tree }: { id: string; info: RowInfo | undefined; now: number; visible: string[]; depth?: number; tree?: RowTree }) {
  const t = useStore((s) => s.terminals[id]);
  const anySelected = useStore((s) => s.selectedTiles.length > 0);
  // Open in some window on this Mac, or only here in the list (windows and layouts spec §2, §3).
  const shownIn = useStore((s) => windowOfTile(layoutsOf(s), id));
  const selected = useStore((s) => s.selectedTiles.includes(id));
  const selectTile = useStore((s) => s.selectTile);
  const settings = useStore((s) => s.settings[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
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
  const isConductor = useStore((s) => isConductorTile(s, id));
  const [roleOpen, setRoleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mark = useStore((s) => identifyMark(s, id));
  const identifyTile = useStore((s) => s.identifyTile);
  const identifyAll = useStore((s) => s.identifyAll);
  const openInNewWindow = useStore((s) => s.openInNewWindow);
  // A conductor's tiles, for "Select it and its tiles" (windows and layouts spec §8).
  const underKey = useStore((s) => {
    if (!isConductorTile(s, id)) return "";
    const tree = buildConductorTree(s.order, s.conductor, s.conductors);
    const node = tree ? findNode(tree, id) : null;
    return node ? descendants(node).join("\n") : "";
  });
  useEffect(() => {
    if (!menuOpen) return;
    const off = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
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

  const needs = info?.status === "needs you";
  const exited = info?.status.startsWith("exited") ? info.status : null;
  const state = info?.status ?? "stopped";
  const dotColor = needs ? "var(--color-needs)" : state === "working" ? "var(--color-working)" : exited ? "var(--color-exited)" : state === "idle" ? "var(--color-muted)" : "var(--color-faint)";
  const hollow = state === "stopped";
  const unseen = agent?.unseen === true && !needs;
  const pad = 8 + depth * 16;
  const machineColor = info?.machine.color ?? "#525252";
  const machineOffline = info?.machine.online === false;
  const skip = !!(settings?.claude?.enabled && settings.claude.skipPermissions);
  const showName = hasTitle(card, agent) && info && t.name !== info.folder;
  const tip = `${state === "needs you" ? "Needs you" : state[0].toUpperCase() + state.slice(1)}${info?.since ? ` · ${relativeActivity(info.since, now)}` : ""}${shownIn ? "" : " · running, not open in any window"}`;
  const stopClick = (e: { stopPropagation(): void }) => e.stopPropagation();
  const iconBtn = "flex h-5 w-[22px] items-center justify-center rounded text-[#a4a7ae] hover:bg-[#2e3137] hover:text-ink";

  // One tile (sidebar redesign spec, TileRow): a dot that turns into a checkbox, the title with the
  // status word and age (actions on hover), and a second line with the Mac chip and the folder.
  const row = (
    <div
      draggable={!editing}
      onDragStart={(e) => startTerminalDrag(e, id)}
      onDragEnd={(e) => void endTabDrag(id, e)}
      onClick={(e) => {
        // Cmd/Ctrl-click picks, Shift-click picks the rows in between; a plain click opens.
        if (e.metaKey || e.ctrlKey) selectTile(id, "toggle", visible);
        else if (e.shiftKey) selectTile(id, "range", visible);
        else {
          focusTerminal(id);
          if (anySelected) useStore.getState().clearSelection();
        }
      }}
      onDoubleClick={() => startEditing("name")}
      onMouseEnter={() => {
        if (editing) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setHovering(true), HOVER_CARD_MS);
      }}
      onMouseLeave={stopHover}
      onKeyDown={stopHover}
      data-testid={`row-${id}`}
      aria-selected={selected}
      title={tip}
      data-machine-state={machineName ? (online === true ? "online" : online === false ? "offline" : "unknown") : undefined}
      data-open={shownIn ? "true" : "false"}
      className={`group relative flex cursor-default select-none items-start gap-2 py-[5px] pr-2 ${
        mark
          ? "bg-needs/15 ring-2 ring-inset ring-needs"
          : selected
            ? "bg-pick/16 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-pick)_50%,transparent)]"
            : focused && shownIn
              ? "bg-focus"
              : needs
                ? "bg-needs/[0.07] hover:bg-hover"
                : "hover:bg-hover"
      }`}
      style={{ paddingLeft: pad }}
    >
      {Array.from({ length: depth }, (_, i) => (
        <div key={i} className="absolute inset-y-0 w-px bg-[#2b2d33]" style={{ left: 8 + i * 16 + 7 }} />
      ))}
      <div className={`absolute inset-y-0 left-0 w-0.5 ${needs ? "bg-needs" : selected ? "bg-pick" : ""}`} />
      <div
        className="relative flex h-[18px] w-3.5 flex-none items-center justify-center"
        onClick={(e) => {
          e.stopPropagation();
          selectTile(id, "toggle", visible);
        }}
      >
        <div
          className={`${anySelected ? "flex" : "hidden group-hover:flex"} h-3 w-3 items-center justify-center rounded-[3px] border-[1.5px] ${selected ? "border-pick bg-pick" : "border-[#7d8087]"}`}
          role="checkbox"
          aria-checked={selected}
          aria-label="Pick for a layout"
          data-testid={`row-check-${id}`}
        >
          {selected && <CheckIcon />}
        </div>
        <span
          data-testid={`agent-dot-${id}`}
          className={`${anySelected ? "hidden" : "block group-hover:hidden"} h-2 w-2 rounded-full border-[1.5px]`}
          style={{
            borderColor: dotColor,
            backgroundColor: hollow ? "transparent" : dotColor,
            boxShadow: needs ? "0 0 0 3px color-mix(in oklch, var(--color-needs) 22%, transparent)" : unseen ? `0 0 0 2px var(--color-panel), 0 0 0 3.5px ${dotColor}` : undefined,
          }}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
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
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-1 text-[13px] text-ink outline-none focus:border-pick"
            />
            {error && <div className="mt-0.5 text-xs text-exited">{error}</div>}
          </div>
        ) : (
          <>
            <div className="flex h-[18px] items-center gap-[5px]">
              {tree?.caret && (
                <button
                  className="-ml-[3px] flex h-3.5 w-3.5 flex-none items-center justify-center text-muted"
                  style={{ transform: tree.folded ? "rotate(-90deg)" : undefined }}
                  onClick={(e) => {
                    e.stopPropagation();
                    tree.onFold();
                  }}
                  aria-label={tree.folded ? "Expand" : "Collapse"}
                  aria-expanded={!tree.folded}
                  data-testid={`tree-fold-${id}`}
                >
                  <CaretIcon />
                </button>
              )}
              {mark && mark !== "●" && <span className="shrink-0 rounded bg-needs px-1 text-[10px] font-bold text-[#1a1405]" data-testid={`row-mark-${id}`}>{mark}</span>}
              {isConductor && (
                <span className="flex-none text-needs" aria-label="Conductor" title="Conductor">
                  <TreeIcon size={13} strokeWidth={1.4} />
                </span>
              )}
              <div
                className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] ${needs ? "font-semibold" : "font-medium"} ${shownIn ? "text-ink" : "text-[#7d8087]"}`}
                data-testid={`title-${id}`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startEditing("title");
                }}
              >
                {displayTitle(card, agent, t.name)}
              </div>
              {mark && !shownIn && <span className="shrink-0 text-[10px] text-needs" data-testid={`row-not-open-${id}`}>not open in a window</span>}
              <div className={`flex flex-none items-baseline gap-1.5 text-[11px] ${menuOpen ? "hidden" : "group-hover:hidden"}`}>
                {(needs || exited) && (
                  <span className={`font-semibold ${needs ? "text-needs" : "text-exited"}`} data-testid={`status-${id}`}>{needs ? "needs you" : exited}</span>
                )}
                <span className="font-mono text-[10.5px] text-faint">{relativeActivity(info?.since ?? null, now)}</span>
              </div>
              <div className={`-my-0.5 -mr-1 flex-none gap-px ${menuOpen ? "flex" : "hidden group-hover:flex"}`}>
                {settings?.claude?.enabled && (
                  <button
                    className={`${iconBtn} ${isConductor ? "text-needs" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRoleOpen((v) => !v);
                    }}
                    title="Conductor role"
                    aria-label="Conductor role"
                  >
                    <TreeIcon size={13} strokeWidth={1.4} />
                  </button>
                )}
                {hasHistory && (
                  <button
                    className={iconBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setHistoryOpen((v) => !v);
                    }}
                    title="Previous sessions"
                    aria-label="Previous sessions"
                  >
                    <HistoryIcon />
                  </button>
                )}
                <button
                  className={iconBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen((v) => !v);
                  }}
                  onMouseDown={stopClick}
                  title="Tile settings: identify, open in a new window, rename…"
                  aria-label="Tile settings"
                  aria-expanded={menuOpen}
                >
                  <MoreIcon />
                </button>
                <button
                  className="flex h-5 w-[22px] items-center justify-center rounded text-[#a4a7ae] hover:bg-exited/20 hover:text-exited"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(id).catch(() => {});
                  }}
                  title="Stop and remove from the workspace"
                  aria-label="Stop and remove"
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            <div className="flex h-4 items-center gap-1.5 text-[11px] text-muted" data-testid={`line2-${id}`}>
              <span
                className="flex h-3.5 min-w-3.5 flex-none items-center justify-center rounded-[3px] px-0.5 text-[8.5px] font-bold"
                style={machineOffline ? { border: `1px solid ${machineColor}`, color: machineColor } : { backgroundColor: machineColor, color: "#101114" }}
                title={`${info?.machine.alias ? `${info.machine.alias} · ` : ""}${info?.machine.label ?? ""}${machineOffline ? " · offline" : info?.machine.online ? " · online" : ""}`}
                data-testid="machine-glyph"
              >
                {info?.machine.glyph ?? "?"}
              </span>
              <span className="min-w-0 flex-1 truncate">{info ? info.folder : basename(t.cwd)}</span>
              {tree?.summary && <span className="flex-none">{tree.summary}</span>}
              {tree?.summaryNeeds && <span className="flex-none font-semibold text-needs">{tree.summaryNeeds}</span>}
              {showName && !tree?.summary && (
                <span className="max-w-[45%] flex-none truncate font-mono text-[10px] text-[#7d8087]" title="Tile name">{t.name}</span>
              )}
              {skip && (
                <span className="flex-none rounded-[3px] border border-exited/50 px-[3px] font-mono text-[9.5px] leading-[13px] text-exited" title="Claude runs with --dangerously-skip-permissions">
                  no-prompt
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative">
      {row}
      {hovering && !historyOpen && !roleOpen && !menuOpen && !editing && <HoverCard id={id} />}
      {menuOpen && (
        <div
          role="menu"
          aria-label="Tile settings"
          data-testid={`tile-menu-${id}`}
          className="absolute right-2 z-40 mt-1 w-56 rounded-md border border-neutral-700 bg-neutral-950 p-1 text-xs shadow-2xl"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {(
            [
              ["Identify", "Show where this tile is: its window comes forward and a label flashes over it", () => identifyTile(id)],
              ["Identify all tiles", "Number every tile's pane and its row here alike", () => identifyAll(visible)],
              ...(underKey ? ([["Select it and its tiles", "Pick this conductor and everything under it, to show them in a layout", () => useStore.getState().selectTiles([id, ...underKey.split("\n")])]] as const) : []),
              ["Open in a new window", "Move it into a window of its own", () => void openInNewWindow([id], null)],
              ["Rename…", "The tile's name", () => startEditing("name")],
              ["Edit title…", "The card's title (empty gives it back to the agent)", () => startEditing("title")],
            ] as const
          ).map(([label, hint, act]) => (
            <button
              key={label}
              role="menuitem"
              title={hint}
              className="block w-full rounded px-2 py-1 text-left text-neutral-200 hover:bg-neutral-800"
              onClick={() => {
                setMenuOpen(false);
                act();
              }}
            >
              {label}
            </button>
          ))}
          <div className="my-1 border-t border-neutral-800" />
          <button
            role="menuitem"
            className="block w-full rounded px-2 py-1 text-left text-red-300 hover:bg-red-950/60"
            onClick={() => {
              setMenuOpen(false);
              closeTerminal(id).catch(() => {});
            }}
          >
            Stop and remove
          </button>
        </div>
      )}
      {roleOpen && (
        <div className="absolute left-2 right-2 z-30 mt-1 rounded border border-neutral-700 bg-neutral-900 p-1 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <ConductorMenu
            id={id}
            onClose={() => setRoleOpen(false)}
            onOpenTree={() => {
              setRoleOpen(false);
              useStore.getState().setConductorsPanel(true);
            }}
          />
        </div>
      )}
      {historyOpen && (
        <div className="absolute left-2 right-2 z-30 mt-1 rounded border border-neutral-700 bg-neutral-900 p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <SessionHistory id={id} onPick={() => setHistoryOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function Sidebar({ width = 256, onShowMachines }: { width?: number; onShowMachines?: () => void } = {}) {
  const order = useStore((s) => s.order);
  const lastCwd = useStore((s) => s.lastCwd);
  const createTerminal = useStore((s) => s.createTerminal);
  const createConductorTerminal = useStore((s) => s.createConductorTerminal);
  const reloadWorkspace = useStore((s) => s.reloadWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "ssh">("closed");
  // Triage's Quiet section folds, per Mac (sidebar redesign spec).
  const [quietFolded, setQuietFolded] = useState(() => loadFoldedSections().has("triage.quiet"));
  const toggleQuiet = () =>
    setQuietFolded((prev) => {
      const next = loadFoldedSections();
      if (prev) next.delete("triage.quiet");
      else next.add("triage.quiet");
      saveFoldedSections(next);
      return !prev;
    });
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
  const groups = groupRows(order, infos, groupBy, now);
  const tri = triage(order, infos);
  // The rows in the order they are listed, for Shift-click ranges (spec §8).
  const visible = groupBy === "conductor" ? order : groupBy === "triage" ? [...tri.needs, ...tri.working, ...tri.quiet] : groups.flatMap((g) => g.ids);
  const selectTiles = useStore((s) => s.selectTiles);
  const clearSelection = useStore((s) => s.clearSelection);
  const anySelected = useStore((s) => s.selectedTiles.length > 0);

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

  // Conductor spec §6: a local Claude tile in a folder of the user's choosing, `~/.swarmz/conductor`
  // (created with its CLAUDE.md) by default, made the conductor at once.
  const addConductor = async () => {
    setMenu("closed");
    setBusy(true);
    setError(null);
    try {
      const dir = await ipc.conductorDir();
      const picked = await open({ directory: true, multiple: false, defaultPath: dir });
      if (typeof picked === "string") await createConductorTerminal(picked);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const headerBtn = "flex h-6 w-[26px] items-center justify-center rounded-[5px] text-[#a4a7ae] hover:bg-[#24262b] hover:text-ink disabled:opacity-50";
  const renderRow = (id: string, extra?: { depth?: number; tree?: RowTree }) => (
    <Row key={id} id={id} info={infos.get(id)} now={now} visible={visible} depth={extra?.depth} tree={extra?.tree} />
  );
  const claimOpen = useStore((s) => s.conductorClaim !== null);

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-line bg-panel"
      style={{ width }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && anySelected) clearSelection();
      }}
    >
      <div className="flex h-9 flex-none items-center gap-0.5 pl-3 pr-1.5">
        <span className="flex-1 text-[11px] font-semibold tracking-[0.07em] text-ink-3">TERMINALS</span>
        <button className={headerBtn} onClick={() => useStore.getState().setConductorsPanel(true)} title="Arrange conductors: who answers to whom" aria-label="Conductors">
          <TreeIcon />
        </button>
        <button className={headerBtn} onClick={() => void reloadWorkspace()} title="Reload ~/.swarmz/workspace.json" aria-label="Reload workspace">
          <ReloadIcon />
        </button>
        <button className={headerBtn} onClick={() => setMenu((m) => (m === "closed" ? "open" : "closed"))} disabled={busy} title="New terminal" aria-label="New terminal" aria-expanded={menu !== "closed"}>
          <PlusIcon />
        </button>
      </div>
      {menu === "open" && (
        <div className="mx-2 mb-1 flex flex-none flex-col gap-0.5 rounded-md border border-chip p-1 text-xs">
          {(
            [
              ["Local terminal…", "A shell on this Mac, in a folder you pick", () => void addTerminal()],
              ["Remote terminal…", "A shell on another Mac on your tailnet", () => setMenu("ssh")],
              ["Conductor…", "A Claude tile that acts on the other tiles, in ~/.swarmz/conductor or a folder you pick", () => void addConductor()],
            ] as const
          ).map(([label, hint, act]) => (
            <button key={label} className="rounded px-2 py-1 text-left text-ink-2 hover:bg-hover hover:text-ink" title={hint} onClick={act}>
              {label}
            </button>
          ))}
        </div>
      )}
      {menu === "ssh" && <NewRemoteTerminal onClose={() => setMenu("closed")} />}
      <Notices localError={error} onClearLocalError={() => setError(null)} />
      {order.length > 0 && (
        <ViewPicker
          value={groupBy}
          onChange={(v) => {
            setGroupBy(v);
            saveGroupBy(v);
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groupBy === "triage" && (
          <>
            {(tri.needs.length > 0 || claimOpen) && (
              <>
                <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-2 text-[10.5px] font-semibold tracking-[0.05em] text-needs" data-testid="triage-needs">
                  <span>NEEDS YOU</span>
                  <span className="rounded-[7px] bg-needs px-[5px] text-[10px] font-bold leading-[14px] text-[#1a1405]">{tri.needs.length + (claimOpen ? 1 : 0)}</span>
                </div>
                <div className="flex flex-col gap-1.5 px-2">
                  <ClaimCard />
                  {tri.needs.map((id) => (
                    <NeedsCard key={id} id={id} info={infos.get(id)} now={now} />
                  ))}
                </div>
              </>
            )}
            {tri.working.length > 0 && (
              <>
                <SectionHeader testId="triage-working">
                  <span className="h-[7px] w-[7px] rounded-full bg-working" />
                  <span>WORKING</span>
                  <span className="font-medium text-faint">{tri.working.length}</span>
                </SectionHeader>
                {tri.working.map((id) => renderRow(id))}
              </>
            )}
            {tri.quiet.length > 0 && (
              <>
                <SectionHeader testId="triage-quiet" onClick={toggleQuiet} expanded={!quietFolded}>
                  <Caret folded={quietFolded} />
                  <span>QUIET</span>
                  <span className="font-medium text-faint">{tri.quiet.length}</span>
                  {tri.exited > 0 && <span className="font-medium tracking-normal text-exited">{`${tri.exited} exited`}</span>}
                </SectionHeader>
                {!quietFolded && tri.quiet.map((id) => renderRow(id))}
              </>
            )}
          </>
        )}
        {groupBy !== "triage" && claimOpen && (
          <div className="px-2 pt-2">
            <ClaimCard />
          </div>
        )}
        {groupBy === "conductor" && <ConductorTree order={order} infos={infos} renderRow={renderRow} />}
        {groupBy !== "conductor" &&
          groupBy !== "triage" &&
          groups.map((g) => (
            <div key={g.key}>
              <GroupHeader
                label={g.title}
                count={g.ids.length}
                needs={g.ids.filter((id) => infos.get(id)?.status === "needs you").length}
                chip={groupBy === "machine" ? <MacChip glyph={g.glyph ?? "?"} color={g.color ?? null} offline={g.online === false} /> : undefined}
                onSelectAll={() => selectTiles(g.ids)}
                testId={`group-${g.key}`}
              />
              {g.ids.map((id) => renderRow(id))}
            </div>
          ))}
        {order.length === 0 && <div className="px-3 py-4 text-xs text-muted">No terminals yet. + starts one.</div>}
      </div>
      {anySelected && <SelectionTray />}
      <MachinesFooter onOpen={() => onShowMachines?.()} />
    </aside>
  );
}
