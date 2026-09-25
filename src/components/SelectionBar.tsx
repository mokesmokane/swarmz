import { useState } from "react";
import { useStore } from "../store";
import { LayoutGallery } from "./LayoutGallery";

/**
 * The tiles picked in the sidebar (windows and layouts spec §8): how many, the preset drawings
 * (those that fit that many marked), where to show them, and Clear.
 */
export function SelectionBar() {
  const count = useStore((s) => s.selectedTiles.length);
  const arrange = useStore((s) => s.arrangeSelection);
  const clear = useStore((s) => s.clearSelection);
  const [target, setTarget] = useState<"new" | "main">("new");
  return (
    <div className="shrink-0 border-t border-blue-900/60 bg-neutral-900/80 p-2" data-testid="selection-bar">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        <span className="font-medium text-blue-100">{`${count} selected`}</span>
        <span className="flex-1" />
        <div className="flex overflow-hidden rounded border border-neutral-700" role="radiogroup" aria-label="Show them in">
          {(["new", "main"] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={target === t}
              className={`px-1.5 py-0.5 ${target === t ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800"}`}
              onClick={() => setTarget(t)}
              title={t === "new" ? "Show them in a new window" : "Show them in the main window; the tiles it shows now close there and keep running"}
            >
              {t === "new" ? "New window" : "Main window"}
            </button>
          ))}
        </div>
        <button className="rounded px-1 text-neutral-500 hover:text-neutral-200" onClick={clear} title="Clear the selection (Esc)" aria-label="Clear selection">
          ×
        </button>
      </div>
      <LayoutGallery compact fit={count} onPick={(id) => void arrange(id, target)} />
      <div className="mt-1 px-0.5 text-[10px] text-neutral-500">⌘-click adds or removes a tile, ⇧-click adds a range.</div>
    </div>
  );
}
