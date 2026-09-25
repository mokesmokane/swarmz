import { useEffect, useRef, useState } from "react";
import { PRESETS, presetDrawing, slotCount, type Rect } from "../lib/presets";

/** A layout drawn small (windows and layouts spec §6): its slots as rounded boxes, numbered. */
export function LayoutThumb({ rects, width = 72, height = 46, active = false }: { rects: Rect[]; width?: number; height?: number; active?: boolean }) {
  const pad = 2;
  const gap = 2;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {rects.map((r) => {
        const x = pad + r.x * (width - 2 * pad) + gap / 2;
        const y = pad + r.y * (height - 2 * pad) + gap / 2;
        const w = Math.max(1, r.w * (width - 2 * pad) - gap);
        const h = Math.max(1, r.h * (height - 2 * pad) - gap);
        return (
          <g key={r.n}>
            <rect x={x} y={y} width={w} height={h} rx={2.5} className={active ? "fill-blue-500/30 stroke-blue-400" : "fill-neutral-700/60 stroke-neutral-500"} strokeWidth={1} />
            {w > 10 && h > 10 && (
              <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="central" className={active ? "fill-blue-100" : "fill-neutral-300"} fontSize={Math.min(10, h / 2)}>
                {r.n}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The gallery of preset layouts (spec §6, §8): a card per preset with its drawing, name and slot
 * count. `fit` marks the presets with exactly that many slots (the tiles to arrange).
 */
export function LayoutGallery({ onPick, fit, compact = false }: { onPick: (presetId: string) => void; fit?: number; compact?: boolean }) {
  return (
    <div className={`grid gap-1.5 ${compact ? "grid-cols-3" : "grid-cols-3"}`} role="listbox" aria-label="Layouts" data-testid="layout-gallery">
      {PRESETS.map((p) => {
        const n = slotCount(p);
        const fits = fit !== undefined && n === fit;
        return (
          <button
            key={p.id}
            role="option"
            aria-selected={fits}
            data-testid={`preset-${p.id}`}
            className={`flex flex-col items-center gap-1 rounded-md border p-1.5 text-[10px] transition-colors ${
              fits ? "border-blue-500/70 bg-blue-500/10 text-blue-100" : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
            }`}
            title={`${p.name}: ${n} ${n === 1 ? "slot" : "slots"}`}
            onClick={() => onPick(p.id)}
          >
            <LayoutThumb rects={presetDrawing(p)} width={compact ? 56 : 72} height={compact ? 36 : 46} active={fits} />
            <span className="max-w-full truncate">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The ▦ button in a tab strip, with the gallery in a popover; choosing arranges the window's tiles. */
export function GalleryButton({ onPick, count }: { onPick: (presetId: string) => void; count: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        className={`rounded px-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 ${open ? "bg-neutral-800 text-neutral-200" : ""}`}
        title="Arrange this window's tiles in a layout"
        aria-label="Layouts"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ▦
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-72 rounded-lg border border-neutral-700 bg-neutral-950 p-2 shadow-2xl">
          <div className="mb-1.5 flex items-baseline justify-between px-0.5 text-xs">
            <span className="font-medium text-neutral-200">Layouts</span>
            <span className="text-neutral-500">{`${count} ${count === 1 ? "tile" : "tiles"} in this window`}</span>
          </div>
          <LayoutGallery
            fit={count}
            onPick={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        </div>
      )}
    </div>
  );
}
