import { useEffect, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { allGroups, type GroupNode, type Side } from "../lib/layout";
import { useStore, terminalColor, isConductorTile, type Placement } from "../store";
import { machineLabel } from "../lib/workspace";
import { windowNames } from "../lib/windowMirror";
import { MAIN } from "../lib/windowLayouts";
import { GalleryButton } from "./LayoutGallery";
import { EmptySlot } from "./EmptySlot";
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
 * A drag of a tab (or a sidebar row) that no drop zone took (windows and layouts spec §4): over
 * another swarmz window the tile goes where the pointer is there, outside every window it opens
 * in a new window there. `screenX/Y` are the pointer's screen position in CSS pixels, the same
 * space as the windows' logical bounds.
 */
export async function endTabDrag(id: string, e: { dataTransfer: DataTransfer; screenX: number; screenY: number }): Promise<void> {
  endTerminalDrag();
  if (e.dataTransfer.dropEffect !== "none") return;
  const s = useStore.getState();
  await s.dropOutside(id, { x: e.screenX, y: e.screenY }, s.windowLabel);
}

/** A tab's right-click menu (spec §4): move it to another window or a new one, close it, or stop it. */
function TabMenu({ id, at, onClose }: { id: string; at: { x: number; y: number }; onClose: () => void }) {
  const here = useStore((s) => s.windowLabel);
  const namesKey = useStore((s) => JSON.stringify(windowNames(s)));
  const names = JSON.parse(namesKey) as { label: string; name: string }[];
  const moveToWindow = useStore((s) => s.moveToWindow);
  const closeTab = useStore((s) => s.closeTab);
  const closeTerminal = useStore((s) => s.closeTerminal);
  useEffect(() => {
    const off = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const item = (label: string, act: () => void, danger = false) => (
    <button
      key={label}
      role="menuitem"
      className={`block w-full rounded px-2 py-1 text-left text-xs ${danger ? "text-red-300 hover:bg-red-950/60" : "text-neutral-200 hover:bg-neutral-800"}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        onClose();
        act();
      }}
    >
      {label}
    </button>
  );
  const others = names.filter((w) => w.label !== here);
  return (
    <div role="menu" data-testid={`tab-menu-${id}`} className="fixed z-50 w-56 rounded-md border border-neutral-700 bg-neutral-950 p-1 shadow-2xl" style={{ left: at.x, top: at.y }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-neutral-500">Move to</div>
      {others.map((w) => item(w.label === MAIN ? "Main window" : w.name, () => void moveToWindow(id, w.label)))}
      {item("New window", () => void moveToWindow(id, "new"))}
      <div className="my-1 border-t border-neutral-800" />
      {item("Close tab (keeps running)", () => closeTab(id))}
      {item("Stop and remove from the workspace", () => void closeTerminal(id).catch(() => {}), true)}
    </div>
  );
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
  const focusedGroupId = useStore((s) => s.focusedGroupId);
  const dragging = useStore((s) => s.draggingTerminalId);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const focusGroup = useStore((s) => s.focusGroup);
  const closeTab = useStore((s) => s.closeTab);
  const openInNewWindow = useStore((s) => s.openInNewWindow);
  const moveGroupToNewWindow = useStore((s) => s.moveGroupToNewWindow);
  const applyPreset = useStore((s) => s.applyPreset);
  const toggleZoom = useStore((s) => s.toggleZoom);
  const removeSlot = useStore((s) => s.removeSlot);
  const zoomed = useStore((s) => s.zoomed[s.windowLabel] === group.id);
  const windowTiles = useStore((s) => allGroups(s.layout).reduce((n, g) => n + g.tabs.length, 0));
  const soleGroup = useStore((s) => s.windowLabel !== MAIN && allGroups(s.layout).length === 1);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
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

  const empty = group.tabs.length === 0;
  const openMenu = (id: string) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id, at: { x: e.clientX, y: e.clientY } });
  };

  return (
    <div
      className={`flex h-full w-full flex-col ${isFocused ? "ring-1 ring-inset ring-blue-500/40" : ""}`}
      onMouseDown={() => focusGroup(group.id)}
      data-drop-group={group.id}
    >
      <div
        className="flex h-8 shrink-0 items-stretch border-b border-neutral-800 bg-neutral-900"
        onDragOver={allowDrop}
        onDrop={dropOnTabs}
        data-drop-strip=""
      >
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {empty && (
          <div className="group flex select-none items-center gap-2 border-r border-neutral-800 px-3 text-xs italic text-neutral-500" data-testid={`slot-tab-${group.id}`}>
            Empty slot
            <button
              className="rounded px-1 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200"
              onClick={(e) => {
                e.stopPropagation();
                removeSlot(group.id);
              }}
              title="Remove this slot"
              aria-label="Remove this slot"
            >
              ×
            </button>
          </div>
        )}
        {group.tabs.map((id) => {
          const t = terminals[id];
          const active = group.active === id;
          return (
            <div
              key={id}
              draggable
              onDragStart={(e) => startTerminalDrag(e, id)}
              onDragEnd={(e) => void endTabDrag(id, e)}
              onClick={() => focusTerminal(id)}
              onContextMenu={openMenu(id)}
              data-testid={`tab-${id}`}
              className={`group flex shrink-0 cursor-default select-none items-center gap-2 border-r border-neutral-800 px-3 text-xs ${
                active ? "bg-[#0f1115] text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              <TabDot id={id} exitCode={t?.exited ?? null} />
              {isConductorTile({ conductor, conductors }, id) && <ConductorBadge />}
              <span className="max-w-[160px] truncate" title={t?.name ?? id}>{t ? displayTitle(settings[id]?.card, agentState[id], t.name) : id}</span>
              <button
                className="ml-1 rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void openInNewWindow([id], null);
                }}
                title="Move to a new window (or drag the tab out; right-click for more)"
                aria-label="Move to a new window"
              >
                ↗
              </button>
              <button
                className="ml-1 rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id);
                }}
                title="Close tab (keeps running; remove it from the sidebar to stop it)"
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          );
        })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
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
          <GalleryButton count={windowTiles} onPick={(presetId) => applyPreset(group.id, presetId)} />
          {!soleGroup && !empty && (
            <button
              className="rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title="Move this group, every tab of it, to a new window"
              aria-label="Move group to a new window"
              onClick={() => void moveGroupToNewWindow(group.id)}
            >
              ⧉
            </button>
          )}
          <button
            className={`rounded px-1.5 hover:bg-neutral-800 hover:text-neutral-200 ${zoomed ? "text-blue-300" : "text-neutral-500"}`}
            title={zoomed ? "Put it back (⌘⇧↩)" : "Zoom: fill the window (⌘⇧↩)"}
            aria-label={zoomed ? "Unzoom" : "Zoom"}
            aria-pressed={zoomed}
            onClick={() => toggleZoom(group.id)}
          >
            {zoomed ? "⤡" : "⤢"}
          </button>
        </div>
      </div>
      {menu && <TabMenu id={menu.id} at={menu.at} onClose={() => setMenu(null)} />}
      <div className="relative min-h-0 flex-1" data-drop-pane="">
        {empty ? <EmptySlot groupId={group.id} /> : <TerminalPane key={group.active} id={group.active} />}
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
