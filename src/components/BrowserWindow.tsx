import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import { ipc } from "../lib/ipc";
import { useBrowserBlock } from "../lib/browserBlock";
import { addressFor, BLANK, defaultBrowserRect, LOAD_STALL_MS, queued } from "../lib/browser";
import { clampRect, defaultRect, type ScratchRect } from "../lib/scratch";

/** The native page sits this far inside the frame's page box, so the frame stays clickable. */
const INSET = 2;

function overlaps(a: ScratchRect, b: ScratchRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A tile's built-in browser, floating over the agent's output (tile browser spec §1). */
export function BrowserWindow({ tileId, blocked }: { tileId: string; blocked: boolean }) {
  const st = useStore((s) => s.browser[tileId]);
  const windowLabel = useStore((s) => s.windowLabel);
  const dragging = useStore((s) => s.draggingTerminalId !== null);
  const overlays = useBrowserBlock((s) => s.count);
  const scratch = useStore((s) => s.scratch[tileId]);
  const hide = useStore((s) => s.hideBrowser);
  const close = useStore((s) => s.closeBrowser);
  const setRect = useStore((s) => s.setBrowserRect);
  const navigate = useStore((s) => s.navigateBrowser);
  const go = useStore((s) => s.browserGo);
  const dismiss = useStore((s) => s.dismissBrowserRequest);
  const setError = useStore((s) => s.setBrowserError);
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [bounds, setBounds] = useState({ w: 0, h: 0 });
  const [typed, setTyped] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [retries, setRetries] = useState(0);
  const open = !!st?.open;

  // The pane this window floats in is its parent: watch its size.
  useEffect(() => {
    const pane = box.current?.parentElement;
    if (!pane) return;
    const measure = () => setBounds({ w: pane.clientWidth, h: pane.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [open]);

  // Place the native page over the page box whenever anything about it changes; hide it otherwise.
  const rect: ScratchRect | null = st && bounds.w > 0 ? clampRect(st.rect ?? defaultBrowserRect(bounds), bounds) : null;
  // The tile's scratch window floats in the same pane, under the native page where they meet.
  const scratchRect = scratch?.started && scratch.open && bounds.w > 0 ? clampRect(scratch.rect ?? defaultRect(bounds), bounds) : null;
  const underScratch = !!rect && !!scratchRect && overlaps(rect, scratchRect);
  // The native page is drawn above everything this window draws: it shows only while nothing
  // of ours should be on top of it (spec §3).
  const showing = open && !blocked && !dragging && overlays === 0 && !underScratch;
  const url = st?.url ?? "";
  const exists = !!st;
  useEffect(() => {
    if (!exists) return;
    let sent = "";
    const measure = () => {
      const r = page.current?.getBoundingClientRect();
      return r ? { x: r.left + INSET, y: r.top + INSET, w: Math.max(r.width - 2 * INSET, 1), h: Math.max(r.height - 2 * INSET, 1) } : null;
    };
    const place = () => {
      const r = measure();
      const at = r ?? { x: 0, y: 0, w: 1, h: 1 };
      sent = JSON.stringify(at);
      void queued(tileId, () =>
        ipc.browserShow(tileId, windowLabel, url, at, showing && !!r).catch((e) => {
          if (showing) setError(tileId, typeof e === "string" ? e : String(e));
          throw e;
        }),
      );
    };
    place();
    // The pane moves under the frame for many reasons (the board header, the sidebar, split
    // dividers): while the page shows, follow its box every frame and send only real moves.
    let frame = 0;
    const follow = () => {
      const r = measure();
      if (r && JSON.stringify(r) !== sent) place();
      frame = requestAnimationFrame(follow);
    };
    if (showing) frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
    // `url` is left out: it is only the address a view not created yet starts on.
  }, [tileId, windowLabel, showing, rect?.x, rect?.y, rect?.w, rect?.h, exists, retries]);

  // Leaving the pane (tab switch, zoom, another window) hides the page; it keeps running.
  useEffect(() => () => void queued(tileId, () => ipc.browserShow(tileId, windowLabel, BLANK, { x: 0, y: 0, w: 1, h: 1 }, false)), [tileId, windowLabel]);

  // Take the keyboard only when asked (the token went up), like the scratch window.
  const handledToken = useRef(st?.focusToken ?? 0);
  useEffect(() => {
    const token = st?.focusToken ?? 0;
    if (!showing || token <= handledToken.current) return;
    handledToken.current = token;
    if (url === BLANK) address.current?.focus();
    else void queued(tileId, () => ipc.browserGo(tileId, "focus"));
  }, [showing, st?.focusToken, tileId, url]);

  // A load that never finishes shows the strip (as ruled: wry reports no failures).
  useEffect(() => {
    if (!st?.loading || st.loadingSince === null) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(LOAD_STALL_MS - (Date.now() - st.loadingSince), 0) + 50);
    return () => clearTimeout(t);
  }, [st?.loading, st?.loadingSince]);

  if (!open || !st) return <div ref={box} hidden />;
  const r = rect ?? { x: 0, y: 0, w: 0, h: 0 };
  const stalled = st.loading && st.loadingSince !== null && Date.now() - st.loadingSince >= LOAD_STALL_MS;
  const problem = refused ?? st.error ?? (stalled ? "This page hasn't finished loading" : null);

  // Drag by the title bar (move) or the corner (resize), kept inside the tile.
  const drag = (mode: "move" | "size") => (e: ReactPointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, r };
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      const next = mode === "move" ? { ...start.r, x: start.r.x + dx, y: start.r.y + dy } : { ...start.r, w: start.r.w + dx, h: start.r.h + dy };
      setRect(tileId, clampRect(next, bounds));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const submit = () => {
    const a = addressFor(typed ?? st.url);
    if (!a) return;
    if ("error" in a) {
      setRefused(a.error);
      return;
    }
    setRefused(null);
    setTyped(null);
    navigate(tileId, a.url);
  };

  const iconButton = "rounded px-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100";
  return (
    <div ref={box}>
      <div
        data-testid="browser-window"
        className="absolute z-30 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-neutral-950 shadow-2xl"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        onKeyDown={(e) => {
          if (e.metaKey && e.key.toLowerCase() === "l") {
            e.preventDefault();
            address.current?.select();
          }
        }}
      >
        <div className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300" onPointerDown={drag("move")}>
          <span className="min-w-0 flex-1 truncate" title={st.title || st.url}>
            {st.title || "Browser"}
          </span>
          <button type="button" className={iconButton} aria-label="Hide browser" title="Hide (keeps the page)" onPointerDown={(e) => e.stopPropagation()} onClick={() => hide(tileId)}>
            –
          </button>
          <button type="button" className={`${iconButton} hover:text-exited`} aria-label="Close browser" title="Close the browser" onPointerDown={(e) => e.stopPropagation()} onClick={() => close(tileId)}>
            ✕
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs">
          <button type="button" className={iconButton} aria-label="Back" onClick={() => go(tileId, "back")}>
            ‹
          </button>
          <button type="button" className={iconButton} aria-label="Forward" onClick={() => go(tileId, "forward")}>
            ›
          </button>
          <button type="button" className={iconButton} aria-label="Reload" onClick={() => go(tileId, "reload")}>
            ↻
          </button>
          <input
            ref={address}
            aria-label="Address"
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
            value={typed ?? (st.url === BLANK ? "" : st.url)}
            placeholder="Search or enter an address"
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setTyped(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setTyped(null);
            }}
          />
          <button type="button" className={iconButton} aria-label="Open in Safari" title="Open in Safari" onClick={() => go(tileId, "safari")}>
            ⤴
          </button>
        </div>
        {st.request && (
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-700 bg-neutral-900/80 px-2 py-1.5 text-xs text-neutral-300">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-neutral-100">{st.request.agent} asks:</span> {st.request.note ?? ""}
              {st.request.url !== st.url && <span className="ml-1 font-mono text-neutral-500">{st.request.url}</span>}
            </span>
            {st.request.url !== st.url && (
              <button type="button" className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => navigate(tileId, st.request!.url)}>
                Go there
              </button>
            )}
            <button type="button" className={iconButton} aria-label="Dismiss request" onClick={() => dismiss(tileId)}>
              ✕
            </button>
          </div>
        )}
        {problem && (
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-needs">
            <span className="min-w-0 flex-1">{problem}</span>
            <button
              type="button"
              className={iconButton}
              onClick={() => {
                // The address asked for, not `reload` (which reloads the page before a stalled
                // load), and placement again, which creates a view that failed to be made.
                setRefused(null);
                setError(tileId, null);
                setRetries((n) => n + 1);
                navigate(tileId, st.url);
              }}
            >
              Retry
            </button>
            <button type="button" className={iconButton} onClick={() => go(tileId, "safari")}>
              Open in Safari
            </button>
          </div>
        )}
        <div ref={page} data-testid="browser-page" className="relative min-h-0 flex-1 bg-white" />
        {/* Below the page, which the native view covers: the corner must stay reachable. */}
        <div data-testid="browser-footer" className="relative h-3 shrink-0 bg-neutral-900">
          <div data-testid="browser-resize" className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize" onPointerDown={drag("size")} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
