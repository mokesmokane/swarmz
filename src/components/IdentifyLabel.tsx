import { useStore, tileMachine } from "../store";
import { displayTitle } from "../lib/card";
import { machineLabel } from "../lib/workspace";

/** What tile `id` shows while identified: its number (Identify all), "●" (Identify), or null. */
export function identifyMark(s: { identify: { ids: string[]; numbered: boolean } | null }, id: string): string | null {
  const v = s.identify;
  if (!v) return null;
  const i = v.ids.indexOf(id);
  if (i < 0) return null;
  return v.numbered ? String(i + 1) : "●";
}

/**
 * The label over an identified tile's pane (identify spec): a big number when all are numbered,
 * else the tile's title with its Mac and folder, so the user sees which pane it is.
 */
export function IdentifyLabel({ id }: { id: string }) {
  const mark = useStore((s) => identifyMark(s, id));
  const title = useStore((s) => {
    const t = s.terminals[id];
    return t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : id;
  });
  const where = useStore((s) => {
    const m = tileMachine(s, id);
    const folder = (s.settings[id]?.ssh?.cwd ?? s.terminals[id]?.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
    return [m ? machineLabel(m, s.machines[m]) : null, folder].filter(Boolean).join(" · ");
  });
  if (!mark) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/30" data-testid={`identify-${id}`}>
      <div className="flex max-w-[80%] flex-col items-center gap-1 rounded-2xl border-2 border-amber-400 bg-neutral-950/90 px-6 py-4 text-center shadow-2xl">
        {mark !== "●" && <div className="text-6xl font-bold leading-none text-amber-300">{mark}</div>}
        <div className="max-w-full truncate text-lg font-semibold text-neutral-100">{title}</div>
        {where && <div className="max-w-full truncate text-sm text-neutral-400">{where}</div>}
      </div>
    </div>
  );
}
