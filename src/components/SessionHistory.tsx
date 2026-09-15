import { useStore } from "../store";

const MAX_ROWS = 5;

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Previous Claude sessions of one tile, newest first, current one excluded. Empty when none. */
export function SessionHistory({ id, onPick }: { id: string; onPick?: () => void }) {
  const sessions = useStore((s) => s.settings[id]?.sessions);
  const current = useStore((s) => s.settings[id]?.claude?.sessionId ?? null);
  const selectSession = useStore((s) => s.selectSession);
  const rows = (sessions ?? []).filter((r) => r.sessionId !== current).slice(0, MAX_ROWS);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs uppercase tracking-wide text-neutral-500">Previous sessions in this tile</div>
      {rows.map((r) => (
        <button
          key={r.sessionId}
          data-testid={`session-row-${r.sessionId}`}
          title={r.cwd}
          className="flex items-center gap-2 rounded px-2 py-1 text-left text-sm text-neutral-200 hover:bg-neutral-800"
          onClick={() => {
            void selectSession(id, r.sessionId, { connect: true });
            onPick?.();
          }}
        >
          <span className="min-w-0 flex-1 truncate">{basename(r.cwd)}</span>
          {r.skipPermissions && <span className="rounded bg-red-900/60 px-1 text-[10px] text-red-300">skip-perms</span>}
          <span className="shrink-0 text-xs text-neutral-500">{relative(r.lastActiveAt)}</span>
        </button>
      ))}
    </div>
  );
}
