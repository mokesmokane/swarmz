import { useMemo, useState } from "react";
import { useStore } from "../store";
import { displayTitle } from "../lib/card";
import { machineLabel } from "../lib/workspace";
import { openTileSet } from "../lib/windowMirror";

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * An empty slot a preset left (windows and layouts spec §7): pick a tile for it, tiles not open
 * in any window first, then tiles open elsewhere (which move here), or start a local shell.
 */
export function EmptySlot({ groupId }: { groupId: string }) {
  const order = useStore((s) => s.order);
  const terminals = useStore((s) => s.terminals);
  const settings = useStore((s) => s.settings);
  const agentState = useStore((s) => s.agentState);
  const machines = useStore((s) => s.machines);
  const selfMachine = useStore((s) => s.selfMachine);
  const openKey = useStore((s) => [...openTileSet(s)].sort().join("\n"));
  const open = useMemo(() => new Set(openKey ? openKey.split("\n") : []), [openKey]);
  const moveTerminal = useStore((s) => s.moveTerminal);
  const newInSlot = useStore((s) => s.newInSlot);
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const all = order
      .filter((id) => terminals[id])
      .map((id) => {
        const t = terminals[id];
        const st = settings[id];
        const machine = st?.ssh?.machine ?? (st?.foreign ? st.origin : null) ?? selfMachine;
        return {
          id,
          title: displayTitle(st?.card, agentState[id], t.name),
          where: `${machine ? machineLabel(machine, machines[machine]) : "this Mac"} · ${basename(st?.ssh?.cwd ?? st?.foreign?.cwd ?? t.cwd)}`,
          open: open.has(id),
        };
      });
    const q = filter.trim().toLowerCase();
    const shown = q ? all.filter((r) => r.title.toLowerCase().includes(q) || r.where.toLowerCase().includes(q)) : all;
    return [...shown.filter((r) => !r.open), ...shown.filter((r) => r.open)];
  }, [order, terminals, settings, agentState, machines, selfMachine, open, filter]);

  return (
    <div className="flex h-full items-center justify-center p-4" data-testid={`empty-slot-${groupId}`}>
      <div className="flex max-h-full w-full max-w-sm flex-col gap-2 rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 p-3 text-sm">
        <div className="font-medium text-neutral-200">Choose a tile for this slot</div>
        <input
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-blue-500"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter tiles"
        />
        <ul className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Tiles">
          {rows.length === 0 && <li className="px-2 py-1 text-xs text-neutral-500">No tiles match.</li>}
          {rows.map((r) => (
            <li key={r.id}>
              <button
                role="option"
                aria-selected={false}
                data-testid={`slot-pick-${r.id}`}
                className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-neutral-800"
                onClick={() => moveTerminal(r.id, groupId)}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-100">{r.title}</span>
                <span className="shrink-0 text-[10px] text-neutral-500">{r.open ? "open elsewhere" : "not open"}</span>
              </button>
              <div className="-mt-1 truncate px-2 pb-1 text-[10px] text-neutral-500">{r.where}</div>
            </li>
          ))}
        </ul>
        <button className="self-start rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800" onClick={() => void newInSlot(groupId)}>
          New shell here
        </button>
      </div>
    </div>
  );
}
