import { useState } from "react";
import { conductorFor, isConductorTile, useStore } from "../store";
import { displayTitle } from "../lib/card";
import { liveSubs } from "../lib/workspace";

const message = (e: unknown) => (typeof e === "string" ? e : String(e));

/** A tile's title as the sidebar shows it, for naming conductors. */
export function useTileTitle(id: string | null): string {
  return useStore((s) => {
    if (!id) return "";
    const t = s.terminals[id];
    return t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : id;
  });
}

/**
 * The conductors a tile could answer to, as `id\0title` lines (a primitive, so the selector is
 * stable): the top and every live sub-conductor but `except` and the conductors below it.
 */
export function useConductorChoices(except: string | null): Array<{ id: string; title: string }> {
  const lines = useStore((s) => {
    const live = liveSubs(s.conductor, s.conductors);
    const below = (c: string): boolean => {
      // Whether conductor `c` is `except` or sits under it (it would make a loop as a parent).
      let at: string | undefined = c;
      for (let i = 0; i <= Object.keys(live).length && at; i++) {
        if (at === except) return true;
        at = live[at]?.parent;
      }
      return false;
    };
    const ids = [s.conductor, ...Object.keys(live)].filter((x): x is string => !!x && !(except && below(x)));
    return ids.map((c) => `${c}\u0000${s.terminals[c] ? displayTitle(s.settings[c]?.card, s.agentState[c], s.terminals[c].name) : c}`).join("\n");
  });
  return lines ? lines.split("\n").map((l) => ({ id: l.split("\u0000")[0], title: l.split("\u0000")[1] })) : [];
}

/**
 * A Claude row's place in the conductor tree (conductor spec §6, conductor tree spec §4): the
 * conductor it answers to, whether it is a conductor itself, and a way into the full
 * hierarchy. Everything goes through the tool, which tells the tiles concerned.
 */
export function ConductorMenu({ id, onClose, onOpenTree }: { id: string; onClose: () => void; onOpenTree?: () => void }) {
  const top = useStore((s) => s.conductor);
  const isTop = top === id;
  const isSub = useStore((s) => !isTop && isConductorTile(s, id));
  const tileCount = useStore((s) => s.conductors[id]?.tiles.length ?? 0);
  const topTitle = useTileTitle(top);
  const owner = useStore((s) => conductorFor(s, id));
  const choices = useConductorChoices(isSub ? id : null);
  const setConductor = useStore((s) => s.setConductor);
  const setSubConductor = useStore((s) => s.setSubConductor);
  const assignTile = useStore((s) => s.assignTile);
  const removeSubConductor = useStore((s) => s.removeSubConductor);
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
  const select = "mt-0.5 w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-100";

  return (
    <div className="text-xs" data-testid={`conductor-menu-${id}`}>
      {isTop && <div className="px-2 pb-1 text-amber-300">🎛 The top conductor</div>}
      {isSub && <div className="px-2 pb-1 text-amber-300">{`🎛 A conductor with ${tileCount} tile${tileCount === 1 ? "" : "s"}`}</div>}
      {top && !isTop && (
        <label className="block px-2 pb-1">
          <span className="text-neutral-400">Answers to</span>
          <select
            aria-label="Answers to"
            className={select}
            disabled={busy}
            value={owner ?? top}
            onChange={(e) => {
              const to = e.target.value;
              run(() => (isSub ? setSubConductor(id, to) : assignTile(id, to)));
            }}
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.id === top ? `${c.title} (top)` : c.title}</option>
            ))}
          </select>
        </label>
      )}
      {isTop && <button className={item} disabled={busy} onClick={() => run(() => setConductor(null))}>Not the conductor</button>}
      {isSub && <button className={item} disabled={busy} onClick={() => run(() => removeSubConductor(id))}>Not a conductor (its tiles go up a level)</button>}
      {!isTop && !isSub && (
        <>
          {top && owner && (
            <button className={item} disabled={busy} onClick={() => run(() => setSubConductor(id, owner))}>
              Make it a conductor here
            </button>
          )}
          <button className={item} disabled={busy} onClick={() => run(() => setConductor(id))}>
            {top ? `Make top conductor (instead of ${topTitle})` : "Make conductor"}
          </button>
        </>
      )}
      {onOpenTree && (
        <button className={`${item} text-neutral-400`} onClick={onOpenTree}>
          Arrange conductors…
        </button>
      )}
      {error && <div className="px-2 pt-1 text-red-400">{error}</div>}
    </div>
  );
}
