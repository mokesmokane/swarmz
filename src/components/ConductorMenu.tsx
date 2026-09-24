import { useState } from "react";
import { conductorFor, isConductorTile, useStore } from "../store";
import { displayTitle } from "../lib/card";
import { liveSubs, scopeFolder } from "../lib/workspace";

const message = (e: unknown) => (typeof e === "string" ? e : String(e));

/** A tile's title as the sidebar shows it, for naming conductors. */
function useTitle(id: string | null): string {
  return useStore((s) => {
    if (!id) return "";
    const t = s.terminals[id];
    return t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : id;
  });
}

/**
 * A Claude row's conductor role (conductor spec §6, conductor tree spec §4): make it the top
 * conductor, a sub-conductor for some folders under a conductor above it, or an ordinary tile
 * again. Everything goes through the tool, which tells the tiles concerned.
 */
export function ConductorMenu({ id, onClose }: { id: string; onClose: () => void }) {
  const top = useStore((s) => s.conductor);
  const isTop = top === id;
  const isSub = useStore((s) => !isTop && isConductorTile(s, id));
  const sub = useStore((s) => s.conductors[id] ?? null);
  const topTitle = useTitle(top);
  const parentTitle = useTitle(sub?.parent ?? null);
  const owner = useStore((s) => conductorFor(s, id));
  const folderHere = useStore((s) => scopeFolder(s.settings[id], s.terminals[id]?.cwd) ?? "");
  // The conductors this tile could answer to: the top and every live sub-conductor but itself.
  const parents = useStore((s) => {
    const ids = [s.conductor, ...Object.keys(liveSubs(s.conductor, s.conductors))].filter((x): x is string => !!x && x !== id);
    return ids.map((c) => `${c}\u0000${s.terminals[c] ? displayTitle(s.settings[c]?.card, s.agentState[c], s.terminals[c].name) : c}`).join("\n");
  });
  const parentList = parents ? parents.split("\n").map((l) => ({ id: l.split("\u0000")[0], title: l.split("\u0000")[1] })) : [];
  const setConductor = useStore((s) => s.setConductor);
  const setSubConductor = useStore((s) => s.setSubConductor);
  const removeSubConductor = useStore((s) => s.removeSubConductor);
  const [form, setForm] = useState(false);
  const [folders, setFolders] = useState(folderHere);
  const [parent, setParent] = useState<string>(owner ?? top ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    what()
      .then(onClose)
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  const item = "block w-full rounded px-2 py-1 text-left text-neutral-200 hover:bg-neutral-800 disabled:opacity-50";

  return (
    <div className="text-xs" data-testid={`conductor-menu-${id}`}>
      {isTop && (
        <>
          <div className="px-2 pb-1 text-amber-300">🎛 The top conductor</div>
          <button className={item} disabled={busy} onClick={() => run(() => setConductor(null))}>Not the conductor</button>
        </>
      )}
      {isSub && sub && (
        <>
          <div className="px-2 pb-1 text-amber-300">{`🎛 Conductor for ${sub.folders.join(", ")} · answers to ${parentTitle}`}</div>
          <button className={item} disabled={busy} onClick={() => run(() => removeSubConductor(id))}>Not a conductor</button>
        </>
      )}
      {!isTop && !isSub && !form && (
        <>
          <button className={item} disabled={busy} onClick={() => run(() => setConductor(id))}>
            {top ? `Make top conductor (instead of ${topTitle})` : "Make conductor"}
          </button>
          {top && (
            <button className={item} disabled={busy} onClick={() => setForm(true)}>
              Make sub-conductor…
            </button>
          )}
        </>
      )}
      {form && (
        <div className="space-y-1 p-1" data-testid="sub-conductor-form">
          <label className="block">
            <span className="text-neutral-400">Folders it looks after, one per line (a prefix: …/certifyip covers certifyip_services too)</span>
            <textarea
              aria-label="Folders"
              rows={3}
              className="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
              value={folders}
              onChange={(e) => setFolders(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-neutral-400">Answers to</span>
            <select
              aria-label="Answers to"
              className="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-100"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              {parentList.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-1">
            <button
              className="rounded border border-amber-700 px-2 py-0.5 text-amber-100 hover:bg-amber-900/60 disabled:opacity-50"
              disabled={busy || !parent}
              onClick={() => run(() => setSubConductor(id, parent, folders.split("\n")))}
            >
              Make sub-conductor
            </button>
            <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={() => setForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <div className="px-2 pt-1 text-red-400">{error}</div>}
    </div>
  );
}
