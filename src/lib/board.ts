/**
 * A tile's board (tile board spec): the agent-written picture of its work shown in the header over
 * its pane. The tool keeps only known fields within limits; this reads them defensively (a board
 * can come from an older or newer tool) and works out the scheme's colours.
 */

export interface BoardStep {
  t: string;
  d?: string;
  s: "done" | "current" | "todo";
}

export interface Board {
  scheme?: string;
  overview?: { goal?: string; now?: string; next?: string; needsYou?: boolean };
  plan?: { title?: string; steps?: BoardStep[] };
  changes?: { branch?: string; base?: string; flags?: string[]; rows?: { p: string; a?: number; r?: number }[]; note?: string };
  questions?: { q: string; o?: string[] }[];
  swarm?: { tiles?: { n: string; d?: string; bad?: boolean }[]; agents?: { n: string; t?: string; k?: string }[] };
}

/** How many questions a tile's board asks the user; with any, the tile needs you. */
export function questionCount(entry: { board: Board | null } | undefined): number {
  return entry?.board?.questions?.length ?? 0;
}

/** What the store keeps per tile: the board (null: it has none) and when it was written. */
export interface BoardEntry {
  board: Board | null;
  at: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, 400) : undefined);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A board read defensively, or null when there is nothing in it. */
export function readBoard(v: unknown): Board | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = rec(v);
  const ov = rec(o.overview);
  const pl = rec(o.plan);
  const ch = rec(o.changes);
  const sw = rec(o.swarm);
  const b: Board = {};
  if (str(o.scheme)) b.scheme = str(o.scheme);
  if (Object.keys(ov).length) b.overview = { goal: str(ov.goal), now: str(ov.now), next: str(ov.next), needsYou: ov.needsYou === true };
  const steps = arr(pl.steps, 8).flatMap((x): BoardStep[] => {
    const s = rec(x);
    const t = str(s.t);
    if (!t) return [];
    const state = s.s === "done" || s.s === "current" ? s.s : "todo";
    return [{ t, d: str(s.d), s: state }];
  });
  if (str(pl.title) || steps.length) b.plan = { title: str(pl.title), steps };
  const rows = arr(ch.rows, 8).flatMap((x) => {
    const r = rec(x);
    const p = str(r.p);
    return p ? [{ p, a: typeof r.a === "number" ? r.a : undefined, r: typeof r.r === "number" ? r.r : undefined }] : [];
  });
  const flags = arr(ch.flags, 4).flatMap((f) => (str(f) ? [str(f)!] : []));
  if (str(ch.branch) || str(ch.base) || str(ch.note) || rows.length || flags.length) b.changes = { branch: str(ch.branch), base: str(ch.base), flags, rows, note: str(ch.note) };
  const questions = arr(o.questions, 4).flatMap((x) => {
    const q = rec(x);
    const text = str(q.q);
    return text ? [{ q: text, o: arr(q.o, 4).flatMap((y) => (str(y) ? [str(y)!] : [])) }] : [];
  });
  if (questions.length) b.questions = questions;
  const tiles = arr(sw.tiles, 6).flatMap((x) => {
    const t = rec(x);
    return str(t.n) ? [{ n: str(t.n)!, d: str(t.d), bad: t.bad === true }] : [];
  });
  const agents = arr(sw.agents, 8).flatMap((x) => {
    const a = rec(x);
    return str(a.n) ? [{ n: str(a.n)!, t: str(a.t), k: str(a.k) }] : [];
  });
  if (tiles.length || agents.length) b.swarm = { tiles, agents };
  return Object.keys(b).length ? b : null;
}

/** The colour schemes (tile board spec §1): name and hue. */
export const SCHEMES: [string, number][] = [
  ["Lagoon", 185],
  ["Heather", 300],
  ["Ember", 55],
  ["Moss", 135],
  ["Harbor", 240],
  ["Rosewood", 15],
];

/** The scheme a tile shows: the user's ↻ choice here, else the agent's, else one from the tile's id. */
export function schemeOf(tile: string, agentScheme: string | undefined, override: number | undefined): { index: number; name: string; hue: number } {
  let index: number;
  if (override !== undefined) index = ((override % SCHEMES.length) + SCHEMES.length) % SCHEMES.length;
  else {
    const named = SCHEMES.findIndex(([n]) => n.toLowerCase() === agentScheme?.toLowerCase());
    index = named >= 0 ? named : Array.from(tile).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SCHEMES.length;
  }
  return { index, name: SCHEMES[index][0], hue: SCHEMES[index][1] };
}

/** The scheme's colours, as the design derives them from its hue. */
export function schemeColors(hue: number) {
  return {
    acc: `oklch(0.8 0.12 ${hue})`,
    headBg: `oklch(0.185 0.028 ${hue})`,
    border: `oklch(0.32 0.045 ${hue})`,
    soft: `oklch(0.32 0.06 ${hue} / 0.4)`,
    current: `oklch(0.88 0.13 ${hue})`,
    currentTitle: `oklch(0.9 0.1 ${hue})`,
  };
}

export const NEEDS_COLOR = "oklch(0.82 0.14 60)";

export type BoardTab = "overview" | "plan" | "changes" | "questions" | "swarm";
export const BOARD_TABS: [BoardTab, string][] = [
  ["overview", "Where we are"],
  ["plan", "Plan"],
  ["changes", "Changes"],
  ["questions", "Questions"],
  ["swarm", "Swarm"],
];

/** One conversation in the sidebar's History view (tile board spec §5, as amended). */
export interface HistoryRow {
  tile: string;
  sessionId: string;
  title: string;
  lastActive: string;
  /** The tile's live conversation. */
  current: boolean;
  /** Where it got to (the board's now and next), for the row's tooltip. */
  detail: string | null;
}

/**
 * Every conversation of every tile, newest activity first: each tile's session records (closed
 * conversations included) joined with each conversation's board, titled by the board's goal,
 * else by its folder.
 */
export function historyRows(
  tiles: { id: string; current: string | null; sessions: { sessionId: string; cwd: string; lastActiveAt: string }[] }[],
  boards: Record<string, { sessionId: string; at: string; board: unknown }[]>,
): HistoryRow[] {
  const folder = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  const out: HistoryRow[] = [];
  for (const t of tiles) {
    const byId = new Map<string, HistoryRow>();
    for (const s of t.sessions) byId.set(s.sessionId, { tile: t.id, sessionId: s.sessionId, title: `Conversation in ${folder(s.cwd)}`, lastActive: s.lastActiveAt, current: s.sessionId === t.current, detail: null });
    for (const b of boards[t.id] ?? []) {
      const o = readBoard(b.board)?.overview;
      const row = byId.get(b.sessionId) ?? { tile: t.id, sessionId: b.sessionId, title: "Conversation", lastActive: b.at, current: b.sessionId === t.current, detail: null };
      const detail = [o?.now, o?.next ? `Next: ${o.next}` : null].filter(Boolean).join("\n") || null;
      byId.set(b.sessionId, { ...row, title: o?.goal ?? row.title, detail, lastActive: row.lastActive > b.at ? row.lastActive : b.at });
    }
    // Claude starts a new session when a conversation is cleared, compacted or resumed: rows of
    // one tile with the same title are one conversation to the user, shown once (the newest).
    const byTitle = new Map<string, HistoryRow>();
    for (const r of byId.values()) {
      const seen = byTitle.get(r.title);
      if (!seen) byTitle.set(r.title, r);
      else {
        const newer = seen.lastActive >= r.lastActive ? seen : r;
        byTitle.set(r.title, { ...newer, current: seen.current || r.current, sessionId: seen.current ? seen.sessionId : r.current ? r.sessionId : newer.sessionId, detail: newer.detail ?? seen.detail ?? r.detail });
      }
    }
    out.push(...byTitle.values());
  }
  return out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : 0));
}

/** Per tile on this Mac: whether its board is open, which tab, and a ↻ scheme choice. */
export interface BoardPrefs {
  open?: boolean;
  tab?: BoardTab;
  scheme?: number;
}
const KEY = "swarmz.boards";
const local = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

export function loadBoardPrefs(storage: Pick<Storage, "getItem"> | null = local()): Record<string, BoardPrefs> {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? "{}") as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, BoardPrefs>) : {};
  } catch {
    return {};
  }
}

export function saveBoardPrefs(id: string, patch: BoardPrefs, storage: Pick<Storage, "getItem" | "setItem"> | null = local()): Record<string, BoardPrefs> {
  const all = loadBoardPrefs(storage);
  all[id] = { ...all[id], ...patch };
  try {
    storage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: the choice holds for this run
  }
  return all;
}
