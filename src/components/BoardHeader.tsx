import { useEffect, useState } from "react";
import { useStore, tileMachine } from "../store";
import { displayTitle } from "../lib/card";
import { machineLabel } from "../lib/workspace";
import { BOARD_TABS, historyRows, loadBoardPrefs, NEEDS_COLOR, saveBoardPrefs, schemeColors, schemeOf, type Board, type BoardTab, type HistoryRow } from "../lib/board";
import { ipc } from "../lib/ipc";
import { relativeActivity } from "../lib/sidebarGroups";

const mono = { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace" };

/**
 * The board over a tile's pane (tile board spec §1, design 3a): a 30 px line (dot, title, Mac,
 * scheme with ↻, caret) that opens five tabs: where we are, the plan, the changes, questions and
 * the swarm. Written by the tile's agent (`swarmz board`); a tile with no board shows nothing.
 */
export function BoardHeader({ id }: { id: string }) {
  const entry = useStore((s) => s.boards[id]);
  const loadBoard = useStore((s) => s.loadBoard);
  const title = useStore((s) => {
    const t = s.terminals[id];
    return t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : id;
  });
  const machine = useStore((s) => {
    const m = tileMachine(s, id);
    return m ? machineLabel(m, s.machines[m]) : "";
  });
  // A Claude tile with past conversations keeps its History reachable before it writes a board.
  const hasPast = useStore((s) => {
    const st = s.settings[id];
    return !!st?.claude?.enabled && !st.command?.trim() && (st.sessions?.length ?? 0) > 0;
  });
  const [prefs, setPrefs] = useState(() => loadBoardPrefs()[id] ?? {});
  useEffect(() => {
    if (!entry) void loadBoard(id);
  }, [entry, id, loadBoard]);
  const board = entry?.board ?? null;
  if (!board && !hasPast) return null;

  const scheme = schemeOf(id, board?.scheme, prefs.scheme);
  const c = schemeColors(scheme.hue);
  const open = prefs.open === true;
  const tabs = board ? BOARD_TABS : BOARD_TABS.filter(([k]) => k === "history");
  const tab: BoardTab = board ? (prefs.tab ?? (board.questions?.length ? "questions" : "overview")) : "history";
  const update = (patch: typeof prefs) => setPrefs(saveBoardPrefs(id, patch)[id] ?? {});
  const needs = board?.overview?.needsYou === true || (board?.questions?.length ?? 0) > 0;

  return (
    <div className="flex-none border-b text-[11px]" style={{ background: c.headBg, borderColor: c.border }} data-testid={`board-${id}`}>
      <div className="flex h-[30px] cursor-default items-center gap-2 px-2.5" style={mono} onClick={() => update({ open: !open })} role="button" aria-expanded={open} aria-label={open ? "Close the board" : "Open the board"}>
        <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: needs ? NEEDS_COLOR : c.acc }} />
        <span className="min-w-0 truncate text-[#dfe6e1]">{title}</span>
        <span className="flex-none text-[#6c7872]">{machine}</span>
        {!open && board?.overview?.now && <span className="min-w-0 flex-1 truncate text-[#8c9892]" title={board.overview.now}>{`· ${board.overview.now}`}</span>}
        {!open && !board && <span className="min-w-0 flex-1 truncate text-[#6c7872]">· no board yet · history</span>}
        <div className="ml-auto flex flex-none items-center gap-1.5 text-[#8c9892]">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.acc }} />
          <span>{scheme.name}</span>
          <button
            className="px-1 text-[#b9c4be] hover:text-white"
            title="Another colour scheme for this tile"
            aria-label="Swap colour scheme"
            onClick={(e) => {
              e.stopPropagation();
              update({ scheme: scheme.index + 1 });
            }}
          >
            ↻
          </button>
          <span className="w-3 text-center" style={{ transform: open ? undefined : "rotate(-90deg)" }}>▾</span>
        </div>
      </div>
      {open && (
        <div className="flex flex-col border-t" style={{ borderColor: c.border }}>
          <div className="flex gap-[18px] overflow-x-auto border-b px-4" style={{ borderColor: c.border }} role="tablist">
            {tabs.map(([k, label]) => {
              const on = tab === k;
              const n = k === "questions" ? (board?.questions?.length ?? 0) : 0;
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={on}
                  className="-mb-px flex flex-none items-center gap-1.5 border-b-2 pb-2 pt-[9px] text-xs font-medium"
                  style={{ color: on ? "#eef2ef" : "#8c9892", borderColor: on ? c.acc : "transparent" }}
                  onClick={() => update({ tab: k })}
                >
                  {label}
                  {n > 0 && (
                    <span className="flex h-[15px] min-w-[15px] items-center justify-center rounded-lg px-1 text-[10px] font-semibold text-[#1a1206]" style={{ background: NEEDS_COLOR }}>
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="max-h-[45vh] min-h-[120px] overflow-y-auto px-[18px] pb-[18px] pt-4">
            {tab === "history" || !board ? <HistoryTab id={id} c={c} /> : <TabBody id={id} tab={tab} board={board} c={c} />}
          </div>
        </div>
      )}
    </div>
  );
}

const label = "text-[10px] tracking-[0.1em] text-[#7d8a83]";

/**
 * Every conversation this tile has had, closed ones too (tile board spec §5): its title (the
 * board's goal, else its folder) and when it was last active, newest first; where it got to is the
 * row's tooltip. A click goes back to that conversation.
 */
function HistoryTab({ id, c }: { id: string; c: ReturnType<typeof schemeColors> }) {
  const sessionsKey = useStore((s) => JSON.stringify(s.settings[id]?.sessions ?? []));
  const current = useStore((s) => s.settings[id]?.claude?.sessionId ?? null);
  const machine = useStore((s) => s.settings[id]?.ssh?.machine ?? null);
  const selectSession = useStore((s) => s.selectSession);
  const [boards, setBoards] = useState<{ sessionId: string; at: string; board: unknown }[]>([]);
  useEffect(() => {
    let live = true;
    ipc.boardHistory(id, machine).then(
      (r) => live && setBoards(Array.isArray(r?.history) ? r.history : []),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, machine]);
  const rows: HistoryRow[] = historyRows(JSON.parse(sessionsKey), boards, current);
  const now = Date.now();
  if (rows.length === 0) return <div className="text-sm text-[#a3afa8]">No conversations in this tile yet.</div>;
  return (
    <div className="flex flex-col" role="list" aria-label="Conversations in this tile">
      {rows.map((r) => (
        <button
          key={r.sessionId}
          role="listitem"
          data-testid={`history-${r.sessionId}`}
          className="flex items-baseline gap-3 border-b py-2 text-left last:border-b-0 hover:bg-white/5 disabled:cursor-default disabled:hover:bg-transparent"
          style={{ borderColor: c.border }}
          title={r.detail ?? undefined}
          disabled={r.current}
          onClick={() => void selectSession(id, r.sessionId, { connect: true })}
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-[#eef2ef]">{r.title}</span>
          {r.current && (
            <span className="flex-none rounded px-1.5 text-[10px] font-semibold" style={{ background: c.soft, color: c.acc }}>
              now
            </span>
          )}
          <span className="w-10 flex-none text-right text-[11px] text-[#8c9892]" style={mono}>{relativeActivity(r.lastActive, now) || "—"}</span>
        </button>
      ))}
    </div>
  );
}

function TabBody({ id, tab, board, c }: { id: string; tab: BoardTab; board: Board; c: ReturnType<typeof schemeColors> }) {
  const answer = useStore((s) => s.answerBoard);
  const [sent, setSent] = useState<string | null>(null);
  if (tab === "overview") {
    const o = board.overview ?? {};
    return (
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <div className="flex flex-col gap-1.5">
          <div className={label}>GOAL</div>
          <div className="text-base font-semibold leading-snug text-[#eef2ef]">{o.goal ?? "—"}</div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className={label}>WHERE IT IS NOW</div>
          <div className="text-[13px] leading-normal text-[#c9d1cc]">{o.now ?? "—"}</div>
        </div>
        <div className="flex flex-col gap-1.5 rounded-md px-3 py-2.5" style={{ background: c.soft }}>
          <div className="text-[10px] tracking-[0.1em]" style={{ color: o.needsYou ? NEEDS_COLOR : c.acc }}>{o.needsYou ? "NEXT · NEEDS YOU" : "NEXT"}</div>
          <div className="text-[13px] leading-normal text-[#eef2ef]">{o.next ?? "—"}</div>
        </div>
      </div>
    );
  }
  if (tab === "plan") {
    const steps = board.plan?.steps ?? [];
    const done = steps.filter((s) => s.s === "done").length;
    return (
      <div className="flex flex-col gap-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-base font-semibold text-[#eef2ef]">{board.plan?.title ?? "Plan"}</div>
          <div className="flex-none text-xs text-[#8c9892]">{`${done} of ${steps.length} done`}</div>
        </div>
        <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(110px, 1fr))` }}>
          {steps.map((s, i) => (
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-b-md"
              style={{
                borderTop: `3px solid ${s.s === "done" ? c.acc : s.s === "current" ? c.current : "#2a3630"}`,
                background: s.s === "current" ? c.soft : "transparent",
                padding: s.s === "current" ? "10px 12px 12px" : "10px 0 0",
              }}
            >
              <div className="text-xs font-semibold leading-snug" style={{ color: s.s === "todo" ? "#8c9892" : s.s === "current" ? c.currentTitle : "#e6ece8" }}>{s.t}</div>
              {s.d && <div className="text-[11px] leading-normal text-[#a3afa8]">{s.d}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (tab === "changes") {
    const ch = board.changes ?? {};
    const rows = ch.rows ?? [];
    const max = Math.max(1, ...rows.map((r) => (r.a ?? 0) + (r.r ?? 0)));
    return (
      <div className="grid gap-[22px]" style={{ gridTemplateColumns: "minmax(140px, 190px) 1fr" }}>
        <div className="flex flex-col gap-[7px]">
          <div className="break-all text-xs" style={{ ...mono, color: c.acc }}>{ch.branch ?? "—"}</div>
          {ch.base && <div className="text-xs text-[#8c9892]">{ch.base}</div>}
          <div className="flex flex-wrap gap-1.5">
            {(ch.flags ?? []).map((f) => (
              <span key={f} className="rounded-[3px] border px-[7px] py-px text-[11px] text-[#c9d1cc]" style={{ borderColor: c.border }}>
                {f}
              </span>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {rows.map((r) => {
            const a = r.a ?? 0;
            const rm = r.r ?? 0;
            const pct = a + rm > 0 ? Math.round((a / (a + rm)) * 100) : 100;
            return (
              <div key={r.p} className="grid items-center gap-2.5 text-[11px]" style={{ ...mono, gridTemplateColumns: "minmax(0, 180px) 1fr 72px" }}>
                <span className="truncate text-[#c9d1cc]" title={r.p}>{r.p}</span>
                <div className="h-1.5 rounded-[1px]" style={{ width: `${Math.max(4, Math.round(((a + rm) / max) * 100))}%`, background: `linear-gradient(90deg, ${c.acc} ${pct}%, oklch(0.66 0.15 25) 0)` }} />
                <span className="text-right text-[#8c9892]">{`+${a} −${rm}`}</span>
              </div>
            );
          })}
          {ch.note && <div className="text-[13px] leading-normal text-[#a3afa8]">{ch.note}</div>}
        </div>
      </div>
    );
  }
  if (tab === "questions") {
    const qs = board.questions ?? [];
    if (qs.length === 0) return <div className="text-sm text-[#a3afa8]">Nothing to answer right now. Claude isn't waiting on you.</div>;
    return (
      <div className="flex flex-col gap-3">
        {qs.map((q) => (
          <div key={q.q} className="grid items-center gap-3.5 border-b pb-3" style={{ gridTemplateColumns: "minmax(0,1fr) auto", borderColor: c.border }}>
            <div className="text-sm leading-snug text-[#eef2ef]">{q.q}</div>
            <div className="flex flex-wrap justify-end gap-1.5">
              {(q.o ?? []).map((o) => (
                <button
                  key={o}
                  className="rounded border bg-[#0e1411] px-[11px] py-[5px] text-xs text-[#dfe6e1] hover:border-[#8c9892] disabled:opacity-50"
                  style={{ borderColor: c.border }}
                  disabled={sent === `${q.q}\n${o}`}
                  title={`Type "${o}" into the tile`}
                  onClick={() => {
                    setSent(`${q.q}\n${o}`);
                    void answer(id, o).catch(() => setSent(null));
                  }}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  const sw = board.swarm ?? {};
  return (
    <div className="grid grid-cols-2 gap-[22px]">
      <div className="flex flex-col gap-2">
        <div className={label}>TILES IT'S TALKING TO</div>
        {(sw.tiles ?? []).map((x) => (
          <div key={x.n} className="flex flex-col gap-px">
            <span className="text-xs" style={{ ...mono, color: x.bad ? "oklch(0.7 0.15 25)" : c.acc }}>{x.n}</span>
            {x.d && <span className="text-xs text-[#a3afa8]">{x.d}</span>}
          </div>
        ))}
        {(sw.tiles ?? []).length === 0 && <div className="text-xs text-[#a3afa8]">None.</div>}
      </div>
      <div className="flex flex-col gap-2">
        <div className={label}>{`BACKGROUND AGENTS · ${(sw.agents ?? []).length}`}</div>
        {(sw.agents ?? []).map((a) => (
          <div key={a.n} className="grid gap-2 text-[11px]" style={{ ...mono, gridTemplateColumns: "1fr 54px 48px" }}>
            <span className="truncate text-[#dfe6e1]">{a.n}</span>
            <span className="text-[#8c9892]">{a.t ?? ""}</span>
            <span className="text-right text-[#8c9892]">{a.k ?? ""}</span>
          </div>
        ))}
        {(sw.agents ?? []).length === 0 && <div className="text-xs text-[#a3afa8]">No background agents running.</div>}
      </div>
    </div>
  );
}
