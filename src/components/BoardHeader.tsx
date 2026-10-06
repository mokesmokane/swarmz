import { useEffect, useState } from "react";
import { useStore, tileMachine, machineThemeId } from "../store";
import { isLightTheme } from "../lib/uiTheme";
import { displayTitle } from "../lib/card";
import { agentName, machineLabel } from "../lib/workspace";
import { ipc } from "../lib/ipc";
import { BOARD_TABS, loadBoardPrefs, NEEDS_COLOR, saveBoardPrefs, schemeColors, schemeOf, type Board, type BoardTab } from "../lib/board";

const mono = { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace" };

/**
 * The board over a tile's pane (tile board spec §1, design 3a): a 30 px line (dot, title, Mac,
 * scheme with ↻, caret) that opens five tabs: where we are, the plan, the changes, questions and
 * the swarm. Written by the tile's agent (`swarmz board`); a tile with no board shows nothing.
 */
export function BoardHeader({ id }: { id: string }) {
  const light = useStore((s) => isLightTheme(machineThemeId(s, s.selfMachine)));
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
  const [prefs, setPrefs] = useState(() => loadBoardPrefs()[id] ?? {});
  const machineName = useStore((s) => s.settings[id]?.ssh?.machine ?? null);
  // Refresh: asks the tile to rewrite its board, and says so, or why not.
  const [refresh, setRefresh] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  useEffect(() => {
    if (!refresh.note) return;
    const t = setTimeout(() => setRefresh((r) => ({ ...r, note: null })), 5000);
    return () => clearTimeout(t);
  }, [refresh.note]);
  const askForUpdate = () => {
    setRefresh({ busy: true, note: null });
    ipc.boardRequest(id, machineName).then(
      () => setRefresh({ busy: false, note: "Asked it to update its board" }),
      (e) => setRefresh({ busy: false, note: typeof e === "string" ? e : String(e) }),
    );
  };
  useEffect(() => {
    if (!entry) void loadBoard(id);
  }, [entry, id, loadBoard]);
  const board = entry?.board ?? null;
  if (!board) return null;

  const scheme = schemeOf(id, board.scheme, prefs.scheme);
  const c = schemeColors(scheme.hue, light);
  const open = prefs.open === true;
  const tabs = BOARD_TABS;
  const tab: BoardTab = prefs.tab && BOARD_TABS.some(([k]) => k === prefs.tab) ? prefs.tab : board.questions?.length ? "questions" : "overview";
  const update = (patch: typeof prefs) => setPrefs(saveBoardPrefs(id, patch)[id] ?? {});
  const needs = board.overview?.needsYou === true || (board.questions?.length ?? 0) > 0;

  return (
    <div className="flex-none border-b text-[11px]" style={{ background: c.headBg, borderColor: c.border }} data-testid={`board-${id}`}>
      <div className="flex h-[30px] cursor-default items-center gap-2 px-2.5" style={mono} onClick={() => update({ open: !open })} role="button" aria-expanded={open} aria-label={open ? "Close the board" : "Open the board"}>
        <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: needs ? NEEDS_COLOR : c.acc }} />
        <span className="min-w-0 truncate text-ink">{title}</span>
        <span className="flex-none text-faint">{machine}</span>
        {!open && board.overview?.now && <span className="min-w-0 flex-1 truncate text-muted" title={board.overview.now}>{`· ${board.overview.now}`}</span>}
        <div className="ml-auto flex flex-none items-center gap-1.5 text-muted">
          {refresh.note && <span className="max-w-[220px] truncate text-ink-2" title={refresh.note} data-testid={`board-refresh-note-${id}`}>{refresh.note}</span>}
          <button
            className="rounded px-1.5 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
            title="Ask the tile to update its board now"
            aria-label="Refresh the board"
            disabled={refresh.busy}
            onClick={(e) => {
              e.stopPropagation();
              askForUpdate();
            }}
          >
            {refresh.busy ? "asking…" : "Refresh"}
          </button>
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: c.acc }} />
          <span>{scheme.name}</span>
          <button
            className="px-1 text-ink-2 hover:text-ink"
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
              const n = k === "questions" ? (board.questions?.length ?? 0) : 0;
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={on}
                  className="-mb-px flex flex-none items-center gap-1.5 border-b-2 pb-2 pt-[9px] text-xs font-medium"
                  style={{ color: on ? "var(--ui-ink)" : "var(--ui-muted)", borderColor: on ? c.acc : "transparent" }}
                  onClick={() => update({ tab: k })}
                >
                  {label}
                  {n > 0 && (
                    <span className="flex h-[15px] min-w-[15px] items-center justify-center rounded-lg px-1 text-[10px] font-semibold text-[var(--ui-badge-ink)]" style={{ background: NEEDS_COLOR }}>
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="max-h-[45vh] min-h-[120px] overflow-y-auto px-[18px] pb-[18px] pt-4">
            <TabBody id={id} tab={tab} board={board} c={c} />
          </div>
        </div>
      )}
    </div>
  );
}

const label = "text-[10px] tracking-[0.1em] text-muted";

function TabBody({ id, tab, board, c }: { id: string; tab: BoardTab; board: Board; c: ReturnType<typeof schemeColors> }) {
  const answer = useStore((s) => s.answerBoard);
  const agent = useStore((s) => agentName(s.settings[id]?.claude));
  const [sent, setSent] = useState<string | null>(null);
  if (tab === "overview") {
    const o = board.overview ?? {};
    return (
      <div className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <div className="flex flex-col gap-1.5">
          <div className={label}>GOAL</div>
          <div className="text-base font-semibold leading-snug text-ink">{o.goal ?? "—"}</div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className={label}>WHERE IT IS NOW</div>
          <div className="text-[13px] leading-normal text-ink-2">{o.now ?? "—"}</div>
        </div>
        <div className="flex flex-col gap-1.5 rounded-md px-3 py-2.5" style={{ background: c.soft }}>
          <div className="text-[10px] tracking-[0.1em]" style={{ color: o.needsYou ? NEEDS_COLOR : c.acc }}>{o.needsYou ? "NEXT · NEEDS YOU" : "NEXT"}</div>
          <div className="text-[13px] leading-normal text-ink">{o.next ?? "—"}</div>
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
          <div className="text-base font-semibold text-ink">{board.plan?.title ?? "Plan"}</div>
          <div className="flex-none text-xs text-muted">{`${done} of ${steps.length} done`}</div>
        </div>
        <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(110px, 1fr))` }}>
          {steps.map((s, i) => (
            <div
              key={i}
              className="flex flex-col gap-1.5 rounded-b-md"
              style={{
                borderTop: `3px solid ${s.s === "done" ? c.acc : s.s === "current" ? c.current : "var(--ui-line)"}`,
                background: s.s === "current" ? c.soft : "transparent",
                padding: s.s === "current" ? "10px 12px 12px" : "10px 0 0",
              }}
            >
              <div className="text-xs font-semibold leading-snug" style={{ color: s.s === "todo" ? "var(--ui-muted)" : s.s === "current" ? c.currentTitle : "var(--ui-ink)" }}>{s.t}</div>
              {s.d && <div className="text-[11px] leading-normal text-ink-3">{s.d}</div>}
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
          {ch.base && <div className="text-xs text-muted">{ch.base}</div>}
          <div className="flex flex-wrap gap-1.5">
            {(ch.flags ?? []).map((f) => (
              <span key={f} className="rounded-[3px] border px-[7px] py-px text-[11px] text-ink-2" style={{ borderColor: c.border }}>
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
                <span className="truncate text-ink-2" title={r.p}>{r.p}</span>
                <div className="h-1.5 rounded-[1px]" style={{ width: `${Math.max(4, Math.round(((a + rm) / max) * 100))}%`, background: `linear-gradient(90deg, ${c.acc} ${pct}%, var(--ui-exited) 0)` }} />
                <span className="text-right text-muted">{`+${a} −${rm}`}</span>
              </div>
            );
          })}
          {ch.note && <div className="text-[13px] leading-normal text-ink-3">{ch.note}</div>}
        </div>
      </div>
    );
  }
  if (tab === "questions") {
    const qs = board.questions ?? [];
    if (qs.length === 0) return <div className="text-sm text-ink-3">{`Nothing to answer right now. ${agent} isn't waiting on you.`}</div>;
    return (
      <div className="flex flex-col gap-3">
        {qs.map((q) => (
          <div key={q.q} className="grid items-center gap-3.5 border-b pb-3" style={{ gridTemplateColumns: "minmax(0,1fr) auto", borderColor: c.border }}>
            <div className="text-sm leading-snug text-ink">{q.q}</div>
            <div className="flex flex-wrap justify-end gap-1.5">
              {(q.o ?? []).map((o) => (
                <button
                  key={o}
                  className="rounded border bg-well px-[11px] py-[5px] text-xs text-ink hover:border-muted disabled:opacity-50"
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
            <span className="text-xs" style={{ ...mono, color: x.bad ? "var(--ui-exited)" : c.acc }}>{x.n}</span>
            {x.d && <span className="text-xs text-ink-3">{x.d}</span>}
          </div>
        ))}
        {(sw.tiles ?? []).length === 0 && <div className="text-xs text-ink-3">None.</div>}
      </div>
      <div className="flex flex-col gap-2">
        <div className={label}>{`BACKGROUND AGENTS · ${(sw.agents ?? []).length}`}</div>
        {(sw.agents ?? []).map((a) => (
          <div key={a.n} className="grid gap-2 text-[11px]" style={{ ...mono, gridTemplateColumns: "1fr 54px 48px" }}>
            <span className="truncate text-ink">{a.n}</span>
            <span className="text-muted">{a.t ?? ""}</span>
            <span className="text-right text-muted">{a.k ?? ""}</span>
          </div>
        ))}
        {(sw.agents ?? []).length === 0 && <div className="text-xs text-ink-3">No background agents running.</div>}
      </div>
    </div>
  );
}
