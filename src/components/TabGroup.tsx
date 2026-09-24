import { useState, type DragEvent } from "react";
import type { GroupNode, Side } from "../lib/layout";
import { useStore, terminalColor, breakoutHooks, isConductorTile, type Placement } from "../store";
import { pointerOutside } from "../lib/breakouts";
import { machineLabel } from "../lib/workspace";
import { dotPresentation } from "../lib/agentState";
import { displayTitle } from "../lib/card";
import { TerminalPane } from "./TerminalPane";
import { ConductorBadge } from "./ConductorBadge";

export const DRAG_MIME = "application/x-swarmz-terminal";

export function startTerminalDrag(e: DragEvent, id: string) {
  e.dataTransfer.setData(DRAG_MIME, id);
  e.dataTransfer.effectAllowed = "move";
  useStore.getState().setDragging(id);
}

export function endTerminalDrag() {
  useStore.getState().setDragging(null);
}

/**
 * A tab drag that ended with no drop, with the pointer outside the main window: the tile opens
 * in its own window there (breakout windows spec §5). `screenX/Y` are the pointer's screen
 * position in CSS pixels, the same space as the window's logical bounds.
 */
export async function endTabDrag(id: string, e: { dataTransfer: DataTransfer; screenX: number; screenY: number }): Promise<void> {
  endTerminalDrag();
  if (e.dataTransfer.dropEffect !== "none") return;
  const bounds = await breakoutHooks.mainBounds();
  if (!bounds) return;
  const at = { x: e.screenX, y: e.screenY };
  if (pointerOutside(at, bounds)) await useStore.getState().breakoutTerminal(id, at);
}

const ZONES: { side: Side; className: string }[] = [
  { side: "left", className: "left-0 top-0 h-full w-1/4" },
  { side: "right", className: "right-0 top-0 h-full w-1/4" },
  { side: "top", className: "left-1/4 top-0 h-1/4 w-1/2" },
  { side: "bottom", className: "left-1/4 bottom-0 h-1/4 w-1/2" },
];

/** Reads this one tab's colour without re-rendering the whole tab strip on every colour change. */
function TabDot({ id, exitCode }: { id: string; exitCode: number | null }) {
  const color = useStore((s) => terminalColor(s, id));
  const agent = useStore((s) => s.agentState[id]);
  const dot = dotPresentation(exitCode, agent, color);
  return (
    <span
      data-testid={`tab-dot-${id}`}
      className={`h-2 w-2 rounded-full ${dot.className}`}
      style={{ backgroundColor: dot.backgroundColor }}
      title={dot.title}
    />
  );
}

export function TabGroup({ group }: { group: GroupNode }) {
  const terminals = useStore((s) => s.terminals);
  const settings = useStore((s) => s.settings);
  const agentState = useStore((s) => s.agentState);
  const conductors = useStore((s) => s.conductors);
  const conductor = useStore((s) => s.conductor);
  const breakouts = useStore((s) => s.breakouts);
  const breakoutTerminal = useStore((s) => s.breakoutTerminal);
  const returnTerminal = useStore((s) => s.returnTerminal);
  const focusedGroupId = useStore((s) => s.focusedGroupId);
  const dragging = useStore((s) => s.draggingTerminalId);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const focusGroup = useStore((s) => s.focusGroup);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const moveTerminal = useStore((s) => s.moveTerminal);
  const splitTerminal = useStore((s) => s.splitTerminal);
  const createTerminal = useStore((s) => s.createTerminal);
  const createSshTerminal = useStore((s) => s.createSshTerminal);
  const activeSsh = useStore((s) => s.settings[group.active]?.ssh ?? null);
  const activeClaude = useStore((s) => s.settings[group.active]?.claude ?? null);
  const activeMachine = useStore((s) => s.settings[group.active]?.ssh?.machine ?? null);
  const machines = useStore((s) => s.machines);
  const [hoverZone, setHoverZone] = useState<Side | "center" | null>(null);

  const isFocused = focusedGroupId === group.id;
  const activeCwd = terminals[group.active]?.cwd;
  // A new terminal spawned from an SSH tile connects to the same host; otherwise it
  // opens a local shell in the same directory.
  const openWith = (placement: Placement) => {
    if (activeSsh?.host) {
      const claude = activeClaude?.enabled ? { skipPermissions: activeClaude.skipPermissions } : null;
      createSshTerminal(
        {
          host: activeSsh.host,
          cwd: activeSsh.cwd ?? null,
          claude,
          machine: activeMachine,
          name: activeMachine ? machineLabel(activeMachine, machines[activeMachine]) : undefined,
        },
        placement,
      ).catch(() => {});
      return;
    }
    if (!activeCwd) return;
    createTerminal(activeCwd, placement).catch(() => {});
  };
  const openBeside = (side: Side) => openWith({ kind: "split", groupId: group.id, side });
  const openTab = () => openWith({ kind: "tab", groupId: group.id });
  const showZones = dragging !== null && !(group.tabs.length === 1 && group.tabs[0] === dragging);

  const allowDrop = (e: DragEvent) => {
    if (dragging) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const dropOnTabs = (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_MIME) || dragging;
    if (id) moveTerminal(id, group.id);
    endTerminalDrag();
    setHoverZone(null);
  };

  const dropOnZone = (side: Side | "center") => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(DRAG_MIME) || dragging;
    if (id) {
      if (side === "center") moveTerminal(id, group.id);
      else splitTerminal(id, group.id, side);
    }
    endTerminalDrag();
    setHoverZone(null);
  };

  return (
    <div
      className={`flex h-full w-full flex-col ${isFocused ? "ring-1 ring-inset ring-blue-500/40" : ""}`}
      onMouseDown={() => focusGroup(group.id)}
    >
      <div
        className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-neutral-800 bg-neutral-900"
        onDragOver={allowDrop}
        onDrop={dropOnTabs}
      >
        {group.tabs.map((id) => {
          const t = terminals[id];
          const active = group.active === id;
          const out = breakouts[id] === true;
          return (
            <div
              key={id}
              draggable={!out}
              onDragStart={(e) => startTerminalDrag(e, id)}
              onDragEnd={(e) => void endTabDrag(id, e)}
              onClick={() => (out ? breakoutTerminal(id, null) : focusTerminal(id))}
              data-testid={`tab-${id}`}
              data-breakout={out ? "true" : undefined}
              title={out ? "In its own window · click to bring it forward" : undefined}
              className={`group flex cursor-default select-none items-center gap-2 border-r border-neutral-800 px-3 text-xs ${
                active ? "bg-[#0f1115] text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"
              } ${out ? "italic opacity-60" : ""}`}
            >
              <TabDot id={id} exitCode={t?.exited ?? null} />
              {isConductorTile({ conductor, conductors }, id) && <ConductorBadge />}
              <span className="max-w-[160px] truncate" title={t?.name ?? id}>{t ? displayTitle(settings[id]?.card, agentState[id], t.name) : id}</span>
              {out && <span className="text-[10px] text-neutral-500">↗ own window</span>}
              {!out && (
                <button
                  className="ml-1 rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    void breakoutTerminal(id, null);
                  }}
                  title="Open in its own window (or drag the tab out of the window)"
                  aria-label="Open in its own window"
                >
                  ↗
                </button>
              )}
              <button
                className="ml-1 rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(id).catch(() => {});
                }}
                title="Close"
              >
                ×
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 px-1">
          <button
            className="rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title="New tab in this tile (same directory or host)"
            onClick={openTab}
          >
            +
          </button>
          <button
            className="rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title="Split right: new terminal in a tile to the right (⌘\\)"
            onClick={() => openBeside("right")}
          >
            ◫
          </button>
          <button
            className="rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title="Split down: new terminal in a tile below (⌘⇧\\)"
            onClick={() => openBeside("bottom")}
          >
            ⊟
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {breakouts[group.active] ? (
          // The pane lives in the tile's own window; this stands in for it (breakout windows spec §2).
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-400" data-testid={`placeholder-${group.active}`}>
            <div>{terminals[group.active] ? displayTitle(settings[group.active]?.card, agentState[group.active], terminals[group.active].name) : group.active} is in its own window</div>
            <div className="flex gap-2">
              <button className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800" onClick={() => void breakoutTerminal(group.active, null)}>Bring it forward</button>
              <button className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800" onClick={() => returnTerminal(group.active)}>Return here</button>
            </div>
          </div>
        ) : (
          <TerminalPane key={group.active} id={group.active} />
        )}
        {showZones && (
          <div className="absolute inset-0 z-10" onDragOver={allowDrop} onDrop={dropOnZone("center")}>
            {ZONES.map(({ side, className }) => (
              <div
                key={side}
                className={`absolute ${className} ${hoverZone === side ? "bg-blue-500/30" : "bg-blue-500/5"} transition-colors`}
                onDragOver={(e) => {
                  allowDrop(e);
                  setHoverZone(side);
                }}
                onDragLeave={() => setHoverZone(null)}
                onDrop={dropOnZone(side)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
