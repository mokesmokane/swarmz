import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store";
import { ipc } from "../lib/ipc";
import { attach, prepare } from "../lib/xtermRegistry";
import { relativeActivity } from "../lib/sidebarGroups";
import { tintBackground, type Machines, type TerminalSettings } from "../lib/workspace";
import type { AgentState } from "../lib/agentState";
import type { TileState } from "../lib/breakouts";

/** The tile this window shows, from its URL (`breakout.html?tile=<id>`). */
export function tileFromLocation(search: string): string | null {
  const id = new URLSearchParams(search).get("tile");
  return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

/**
 * A tile in its own window (breakout windows spec §4): a header with the sidebar's second line
 * and a Return button, the same terminal pane, and the exited banner. It owns no workspace: the
 * main window sends the tile's state and acts on Return and Restart.
 */
export function BreakoutApp({ tile = tileFromLocation(window.location.search) }: { tile?: string | null } = {}) {
  const [state, setState] = useState<TileState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tile) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await ipc.onTileState(tile, (st) => {
        setState(st);
        // The pane reads what it needs from the store, as in the main window.
        useStore.setState({
          terminals: { [tile]: { ...st.terminal, existed: true, startedAt: null } },
          settings: { [tile]: st.settings as TerminalSettings },
          agentState: st.agent ? { [tile]: st.agent as AgentState } : {},
          machines: st.machines as Machines,
          selfMachine: st.selfMachine,
        });
        void getCurrentWindow().setTitle(`${st.title} · swarmz`).catch(() => {});
      });
      if (cancelled) return;
      await prepare(tile);
      try {
        await ipc.openView(tile);
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
      }
      await ipc.breakoutHello(tile);
    })();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
      unlisten?.();
      void ipc.closeView(tile).catch(() => {});
    };
  }, [tile]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !tile) return;
    const { fit, term } = attach(tile, el);
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // not laid out yet
        }
      });
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    refit();
    term.focus();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [tile]);

  if (!tile) return <div className="p-4 text-sm text-neutral-400">No tile named in this window's address.</div>;
  const line = state?.line;
  const color = line?.color ?? null;
  const exited = state?.terminal.exited ?? null;
  return (
    <div className="flex h-full w-full flex-col" style={{ backgroundColor: tintBackground("#0f1115", color) }}>
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 text-xs"
        data-tauri-drag-region
        onDoubleClick={() => void ipc.breakoutAction({ id: tile, action: "focus-main" })}
      >
        {line && (
          <span
            className="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-sm px-0.5 text-[9px] font-bold leading-none"
            style={{ backgroundColor: color ?? "#525252", color: "#0f1115" }}
          >
            {line.glyph}
          </span>
        )}
        <span className="truncate font-medium text-neutral-100" data-testid="breakout-title">{state?.title ?? tile}</span>
        {line && (
          <span className="truncate text-neutral-500" data-testid="breakout-line">
            {`${line.machine} · ${line.folder} · ${line.status}${line.since ? ` · ${relativeActivity(line.since, now)}` : ""}`}
          </span>
        )}
        <span className="flex-1" />
        <button
          className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800"
          title="Back into the workbench (⌘⇧W)"
          onClick={() => void ipc.breakoutAction({ id: tile, action: "return" })}
        >
          Return to workspace
        </button>
      </div>
      {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
      <div className="relative min-h-0 flex-1">
        <div ref={ref} className="absolute inset-0 p-1" />
        {exited !== null && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-neutral-700 bg-neutral-900/95 px-3 py-2 text-sm text-neutral-300">
            <span>
              Process exited with code {exited}
              {state?.terminal.error ? `: ${state.terminal.error}` : ""}
            </span>
            <button
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
              onClick={() => void ipc.breakoutAction({ id: tile, action: "restart" })}
            >
              Restart shell
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
