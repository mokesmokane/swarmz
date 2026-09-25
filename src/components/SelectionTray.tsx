import { useState } from "react";
import { useStore } from "../store";
import { PRESETS, presetDrawing, slotCount } from "../lib/presets";

/**
 * The tiles picked in the sidebar (sidebar redesign spec, SelectionTray): how many, where to open
 * them, and the layouts drawn small; the ones with exactly that many slots are lit.
 */
export function SelectionTray() {
  const count = useStore((s) => s.selectedTiles.length);
  const arrange = useStore((s) => s.arrangeSelection);
  const clear = useStore((s) => s.clearSelection);
  const [target, setTarget] = useState<"new" | "main">("new");
  return (
    <div className="flex flex-none flex-col gap-2 border-t border-chip bg-[#17181b] px-2.5 pb-[9px] pt-2.5" data-testid="selection-bar">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-sm bg-pick" />
        <span className="flex-1 text-xs font-semibold text-ink">{`${count} selected`}</span>
        <button className="rounded px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-chip hover:text-ink" onClick={clear} title="Clear the selection (Esc)" aria-label="Clear selection">
          Clear
        </button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span>Open in</span>
        <div className="flex flex-1 gap-0.5 rounded-[5px] bg-[#0f1012] p-0.5" role="radiogroup" aria-label="Show them in">
          {(["new", "main"] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={target === t}
              className={`flex-1 rounded py-[3px] text-center ${target === t ? "bg-[#2e3137] text-ink" : "text-muted hover:text-ink-2"}`}
              onClick={() => setTarget(t)}
              title={t === "new" ? "Show them in a new window" : "Show them in the main window; the tiles it shows now close there and keep running"}
            >
              {t === "new" ? "New window" : "Main window"}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5" role="listbox" aria-label="Layouts" data-testid="layout-gallery">
        {PRESETS.map((p) => {
          const n = slotCount(p);
          const on = n === count;
          return (
            <button
              key={p.id}
              role="option"
              aria-selected={on}
              data-testid={`preset-${p.id}`}
              title={`${p.name}: ${n} ${n === 1 ? "slot" : "slots"}`}
              className={`relative aspect-[16/10] rounded border bg-[#0f1012] ${on ? "border-pick/80" : "border-[#2a2c31] opacity-55 hover:opacity-90"}`}
              onClick={() => void arrange(p.id, target)}
            >
              {presetDrawing(p).map((r) => (
                <span key={r.n} className="absolute box-border p-0.5" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}>
                  <span className={`block h-full w-full rounded-sm ${on ? "bg-pick/55" : "bg-[#2a2c31]"}`} />
                </span>
              ))}
            </button>
          );
        })}
      </div>
      <div className="text-[10.5px] text-faint">{`Pick a layout with ${count} slot${count === 1 ? "" : "s"} · ⌘-click or tick rows to add`}</div>
    </div>
  );
}
