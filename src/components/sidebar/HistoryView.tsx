import { useEffect, useState } from "react";
import { knownMacs, useStore } from "../../store";
import { machineAccent } from "../../lib/themes";
import { rowInfo } from "../../lib/sidebarGroups";
import { displayTitle } from "../../lib/card";
import { historyRows } from "../../lib/board";
import { relativeActivity, type RowInfo } from "../../lib/sidebarGroups";
import { MacChip } from "./Parts";

/**
 * The sidebar's History view (tile board spec §5, as amended): every conversation of every tile,
 * closed ones included, newest activity first. Each row is the conversation's title (its board's
 * goal, else its folder), the tile it ran in, and when it was last active; where it got to is the
 * tooltip. A click opens the tile, going back to that conversation when it is not the live one.
 */
export function HistoryView({ infos, now }: { infos: Map<string, RowInfo>; now: number }) {
  const load = useStore((s) => s.loadConversationBoards);
  const boards = useStore((s) => s.conversationBoards);
  const tilesKey = useStore((s) =>
    JSON.stringify(
      s.order
        .filter((id) => s.settings[id]?.claude?.enabled && !s.settings[id]?.command?.trim())
        .map((id) => ({ id, current: s.settings[id]?.claude?.sessionId ?? null, sessions: s.settings[id]?.sessions ?? [] })),
    ),
  );
  const titles = useStore((s) => JSON.stringify(Object.fromEntries(s.order.map((id) => [id, s.terminals[id] ? displayTitle(s.settings[id]?.card, s.agentState[id], s.terminals[id].name) : id]))));
  const selectSession = useStore((s) => s.selectSession);
  const focusTerminal = useStore((s) => s.focusTerminal);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = historyRows(JSON.parse(tilesKey), boards);
  const tileTitle: Record<string, string> = JSON.parse(titles);
  if (rows.length === 0) return <div className="px-3 py-4 text-xs text-muted">No conversations yet.</div>;
  return (
    <div role="list" aria-label="Conversations" data-testid="history-view">
      {rows.map((r) => {
        const info = infos.get(r.tile);
        return (
          <button
            key={`${r.tile}:${r.sessionId}`}
            role="listitem"
            data-testid={`history-${r.sessionId}`}
            className="flex w-full flex-col gap-px px-3 py-[5px] text-left hover:bg-hover"
            title={r.detail ?? undefined}
            onMouseEnter={() => useStore.getState().hoverTile(r.tile)}
            onMouseLeave={() => useStore.getState().hoveredTile === r.tile && useStore.getState().hoverTile(null)}
            onClick={() => {
              if (r.current) focusTerminal(r.tile);
              else void selectSession(r.tile, r.sessionId, { connect: true }).then(() => focusTerminal(r.tile));
            }}
          >
            <div className="flex h-[18px] items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{r.title}</span>
              {r.current && <span className="flex-none rounded bg-working/20 px-1 text-[10px] font-semibold text-working">live</span>}
              <span className="flex-none font-mono text-[10.5px] text-faint">{relativeActivity(r.lastActive, now) || "—"}</span>
            </div>
            <div className="flex h-4 items-center gap-1.5 text-[11px] text-muted">
              <MacChip glyph={info?.machine.glyph ?? "?"} color={info?.machine.color ?? null} offline={info?.machine.online === false} />
              <span className="min-w-0 flex-1 truncate">{tileTitle[r.tile] ?? r.tile}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * History as its own side bar view (activity bar): a header and the list, working out each
 * tile's Mac chip the way the Terminals list does.
 */
export function HistoryPanel() {
  const order = useStore((s) => s.order);
  const terminals = useStore((s) => s.terminals);
  const settings = useStore((s) => s.settings);
  const agentState = useStore((s) => s.agentState);
  const selfMachine = useStore((s) => s.selfMachine);
  const machines = useStore((s) => s.machines);
  const peers = useStore((s) => s.tailscale?.peers ?? null);
  const knownKey = useStore((s) => knownMacs(s).join("\n"));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const known = knownKey ? knownKey.split("\n") : [];
  const online: Record<string, boolean> = {};
  for (const p of peers ?? []) online[p.name] = p.online;
  const infos = new Map<string, RowInfo>();
  for (const id of order) {
    const t = terminals[id];
    if (!t) continue;
    const st = settings[id];
    infos.set(id, rowInfo({ id, name: t.name, cwd: t.cwd, exited: t.exited, ssh: st?.ssh ?? null, foreign: st?.foreign ?? null, sessions: st?.sessions, agent: agentState[id] }, { selfMachine, machines, online, colorOf: (m) => machineAccent(m, machines[m], known) }));
  }
  return (
    <div className="flex h-full flex-col bg-panel" data-testid="history-panel">
      <div className="flex h-9 flex-none items-center pl-3 pr-1.5">
        <span className="flex-1 text-[11px] font-semibold tracking-[0.07em] text-ink-3">HISTORY</span>
        <button className="flex h-6 w-[26px] items-center justify-center rounded-[5px] text-[#a4a7ae] hover:bg-[#24262b] hover:text-ink" onClick={() => void useStore.getState().loadConversationBoards()} title="Ask every Mac again" aria-label="Refresh history">
          ↻
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <HistoryView infos={infos} now={now} />
      </div>
    </div>
  );
}
