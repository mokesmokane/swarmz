import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { endTerminalDrag, startTerminalDrag } from "./TabGroup";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function Row({ id }: { id: string }) {
  const t = useStore((s) => s.terminals[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  const focusTerminal = useStore((s) => s.focusTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!t) return null;
  const exited = t.exited !== null;

  const commit = async () => {
    const err = await renameTerminal(id, draft);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setEditing(false);
  };

  return (
    <div
      draggable={!editing}
      onDragStart={(e) => startTerminalDrag(e, id)}
      onDragEnd={endTerminalDrag}
      onClick={() => focusTerminal(id)}
      onDoubleClick={() => {
        setDraft(t.name);
        setEditing(true);
      }}
      className={`group flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm ${
        focused ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
      }`}
      title={t.cwd}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${exited ? "bg-neutral-600" : "bg-emerald-500"}`} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
                if (e.key === "Escape") {
                  setEditing(false);
                  setError(null);
                }
              }}
              onBlur={() => void commit()}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-1 text-sm text-neutral-100 outline-none focus:border-blue-500"
            />
            {error && <div className="mt-0.5 text-xs text-red-400">{error}</div>}
          </div>
        ) : (
          <>
            <div className="truncate">{t.name}</div>
            <div className="truncate text-xs text-neutral-500">{basename(t.cwd)}</div>
          </>
        )}
      </div>
      <button
        className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          void closeTerminal(id);
        }}
        title="Close terminal"
      >
        ×
      </button>
    </div>
  );
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const lastCwd = useStore((s) => s.lastCwd);
  const createTerminal = useStore((s) => s.createTerminal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTerminal = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await open({ directory: true, multiple: false, defaultPath: lastCwd ?? undefined });
      if (typeof picked === "string") await createTerminal(picked);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex h-8 items-center justify-between border-b border-neutral-800 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <span>Terminals</span>
        <button
          className="rounded px-2 text-base leading-none text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          onClick={() => void addTerminal()}
          disabled={busy}
          title="New terminal"
        >
          +
        </button>
      </div>
      {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {order.map((id) => (
          <Row key={id} id={id} />
        ))}
        {order.length === 0 && <div className="px-2 py-4 text-xs text-neutral-500">No terminals</div>}
      </div>
    </aside>
  );
}
