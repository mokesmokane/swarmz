import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import { attach, fitAndFocus } from "../lib/xtermRegistry";
import { clampRect, defaultRect, scratchIdFor, type ScratchRect } from "../lib/scratch";

/** A tile's scratch shell, floating over the agent's output (scratch terminal spec §1). */
export function ScratchWindow({ tileId }: { tileId: string }) {
  const st = useStore((s) => s.scratch[tileId]);
  const hide = useStore((s) => s.hideScratch);
  const end = useStore((s) => s.endScratch);
  const setRect = useStore((s) => s.setScratchRect);
  const typeIt = useStore((s) => s.typeScratchCommand);
  const dismiss = useStore((s) => s.dismissScratchRequest);
  const box = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0 });
  const id = scratchIdFor(tileId);
  const visible = !!st?.started && st.open;

  // The pane this window floats in is its parent: watch its size.
  useEffect(() => {
    const pane = box.current?.parentElement;
    if (!pane) return;
    const measure = () => setBounds({ w: pane.clientWidth, h: pane.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [visible]);

  useEffect(() => {
    const el = mount.current;
    if (!visible || !el) return;
    const { fit } = attach(id, el);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible, id]);

  // Take the keyboard only when asked (the token went up), never just because the window shows
  // again: an agent reopening it must not pull the user's typing out of another tile.
  // Starts at the token the pane mounts with, so a remount (switching back to the tab) does not
  // take it either.
  const handledToken = useRef(st?.focusToken ?? 0);
  useEffect(() => {
    const token = st?.focusToken ?? 0;
    if (!visible || token <= handledToken.current) return;
    handledToken.current = token;
    fitAndFocus(id);
  }, [visible, st?.focusToken, id]);

  if (!visible || !st) return <div ref={box} hidden />;
  const rect: ScratchRect = bounds.w > 0 ? clampRect(st.rect ?? defaultRect(bounds), bounds) : { x: 0, y: 0, w: 0, h: 0 };

  // Drag by the title bar (move) or the corner (resize), kept inside the tile.
  const drag = (mode: "move" | "size") => (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, r: rect };
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      const next = mode === "move" ? { ...start.r, x: start.r.x + dx, y: start.r.y + dy } : { ...start.r, w: start.r.w + dx, h: start.r.h + dy };
      setRect(tileId, clampRect(next, bounds));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const iconButton = "rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100";
  return (
    <div ref={box}>
      <div
        data-testid="scratch-window"
        className="absolute z-30 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-neutral-950 shadow-2xl"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        <div className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300" onPointerDown={drag("move")}>
          <span className="min-w-0 flex-1 truncate font-mono" title={st.label}>
            {`scratch · ${st.label}`}
            {st.inHome ? " (folder missing, opened in ~)" : ""}
          </span>
          <button type="button" className={iconButton} aria-label="Hide scratch shell" title="Hide (keeps the shell)" onPointerDown={(e) => e.stopPropagation()} onClick={() => hide(tileId)}>
            –
          </button>
          <button type="button" className={`${iconButton} hover:text-exited`} aria-label="End scratch shell" title="End the shell" onPointerDown={(e) => e.stopPropagation()} onClick={() => void end(tileId)}>
            ✕
          </button>
        </div>
        {st.request && (
          <div className="flex shrink-0 flex-col gap-1 border-b border-neutral-700 bg-neutral-900/80 px-2 py-1.5 text-xs text-neutral-300">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium text-neutral-100">{st.request.agent} asks:</span> {st.request.note ?? ""}
              </span>
              <button type="button" className={iconButton} aria-label="Dismiss request" onClick={() => dismiss(tileId)}>
                ✕
              </button>
            </div>
            {st.request.command && (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-neutral-950 px-1.5 py-0.5 font-mono text-neutral-200" title={st.request.command}>
                  {st.request.command}
                </code>
                <button type="button" className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => typeIt(tileId)}>
                  Type it
                </button>
              </div>
            )}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <div ref={mount} data-testid="scratch-mount" className="absolute inset-0 overflow-hidden" />
        </div>
        <div className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize" onPointerDown={drag("size")} aria-hidden="true" />
      </div>
    </div>
  );
}
