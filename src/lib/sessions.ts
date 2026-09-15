export const SESSIONS_MAX = 20;

/** One Claude session that ran in a tile, and where. Newest first in `sessions`. */
export interface SessionRecord {
  sessionId: string;
  cwd: string;
  skipPermissions: boolean;
  startedAt: string;
  lastActiveAt: string;
}

export function isSafeFolder(p: string): boolean {
  return p.startsWith("/") && !/[\x00-\x1f\x7f]/.test(p);
}

export function upsertSession(
  list: SessionRecord[] | undefined,
  rec: { sessionId: string; cwd: string; skipPermissions: boolean },
  now: string,
): SessionRecord[] {
  const rest = (list ?? []).filter((r) => r.sessionId !== rec.sessionId);
  const prev = (list ?? []).find((r) => r.sessionId === rec.sessionId);
  const head: SessionRecord = { ...rec, startedAt: prev?.startedAt ?? now, lastActiveAt: now };
  return [head, ...rest].slice(0, SESSIONS_MAX);
}

export function bumpSession(list: SessionRecord[] | undefined, sessionId: string, now: string): SessionRecord[] | undefined {
  if (!list?.some((r) => r.sessionId === sessionId)) return undefined;
  return list.map((r) => (r.sessionId === sessionId ? { ...r, lastActiveAt: now } : r));
}

export function promoteSession(list: SessionRecord[], sessionId: string, now: string): SessionRecord[] {
  const hit = list.find((r) => r.sessionId === sessionId);
  if (!hit) return list;
  return [{ ...hit, lastActiveAt: now }, ...list.filter((r) => r.sessionId !== sessionId)];
}

export function removeSession(list: SessionRecord[] | undefined, sessionId: string): SessionRecord[] {
  return (list ?? []).filter((r) => r.sessionId !== sessionId);
}

function isRecord(v: unknown): v is SessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sessionId === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(o.sessionId) &&
    typeof o.cwd === "string" &&
    isSafeFolder(o.cwd) &&
    typeof o.skipPermissions === "boolean" &&
    typeof o.startedAt === "string" &&
    typeof o.lastActiveAt === "string"
  );
}

/** Records loaded from workspace.json: well-formed ones only, capped. Undefined when absent or not a list. */
export function sanitizeSessions(v: unknown): SessionRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(isRecord).slice(0, SESSIONS_MAX);
}
