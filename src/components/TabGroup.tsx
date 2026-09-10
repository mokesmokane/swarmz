import { useState, type DragEvent } from "react";
import type { GroupNode, Side } from "../lib/layout";
import { useStore } from "../store";
import { TerminalPane } from "./TerminalPane";

export const DRAG_MIME = "application/x-swarmz-terminal";

export function startTerminalDrag(e: DragEvent, id: string) {
  e.dataTransfer.setData(DRAG_MIME, id);
  e.dataTransfer.effectAllowed = "move";
  useStore.getState().setDragging(id);
}

export function endTerminalDrag() {
  useStore.getState().setDragging(null);
}

const ZONES: { side: Side; className: string }[] = [
  { side: "left", className: "left-0 top-0 h-full w-1/4" },
  { side: "right", className: "right-0 top-0 h-full w-1/4" },
  { side: "top", className: "left-1/4 top-0 h-1/4 w-1/2" },
  { side: "bottom", className: "left-1/4 bottom-0 h-1/4 w-1/2" },
];

export function TabGroup({ group }: { group: GroupNode }) {
  const terminals = useStore((s) => s.terminals);
  const focusedGroupId = useStore((s) => s.focusedGroupId);
  const dragging = useStore((s) => s.draggingTerminalId);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const focusGroup = useStore((s) => s.focusGroup);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const moveTerminal = useStore((s) => s.moveTerminal);
  const splitTerminal = useStore((s) => s.splitTerminal);
  const [hoverZone, setHoverZone] = useState<Side | "center" | null>(null);

  const isFocused = focusedGroupId === group.id;
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
          return (
            <div
              key={id}
              draggable
              onDragStart={(e) => startTerminalDrag(e, id)}
              onDragEnd={endTerminalDrag}
              onClick={() => focusTerminal(id)}
              className={`group flex cursor-default select-none items-center gap-2 border-r border-neutral-800 px-3 text-xs ${
                active ? "bg-[#0f1115] text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${t?.exited !== null && t?.exited !== undefined ? "bg-neutral-600" : "bg-emerald-500"}`} />
              <span className="max-w-[160px] truncate">{t?.name ?? id}</span>
              <button
                className="ml-1 rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTerminal(id);
                }}
                title="Close"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalPane key={group.active} id={group.active} />
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
