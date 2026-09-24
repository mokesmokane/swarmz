import { useEffect, useState, type DragEvent } from "react";
import { conductorFor, isConductorTile, useStore } from "../store";
import { displayTitle } from "../lib/card";
import { hostLabel, liveSubs, machineLabel } from "../lib/workspace";
import { ConductorBadge } from "./ConductorBadge";
import { useConductorChoices } from "./ConductorMenu";

const message = (e: unknown) => (typeof e === "string" ? e : String(e));
const DRAG_TYPE = "application/x-swarmz-tile";

interface TreeNode {
  id: string;
  children: TreeNode[];
}

/**
 * The conductor tree as `parent\0child` lines (a primitive, so the selector is stable): each
 * live sub-conductor under its parent, then every other tile under the conductor it answers to.
 */
function useTreeEdges(): string {
  return useStore((s) => {
    if (!s.conductor) return "";
    const live = liveSubs(s.conductor, s.conductors);
    const lines: string[] = [];
    for (const id of s.order) {
      if (id === s.conductor || !s.terminals[id]) continue;
      const parent = live[id] ? live[id].parent : conductorFor(s, id);
      if (parent) lines.push(`${parent}\u0000${id}`);
    }
    return lines.join("\n");
  });
}

function buildTree(top: string, edges: string): TreeNode {
  const kids = new Map<string, string[]>();
  for (const line of edges ? edges.split("\n") : []) {
    const [p, c] = line.split("\u0000");
    kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  const seen = new Set<string>();
  const node = (id: string): TreeNode => {
    seen.add(id);
    return { id, children: (kids.get(id) ?? []).filter((c) => !seen.has(c)).map(node) };
  };
  return node(top);
}

/**
 * The conductor tree, arranged by hand (conductor tree spec §4): every tile under the conductor
 * it answers to. Drag a tile onto a conductor to put it under that conductor (a conductor
 * dragged moves with everything under it); each row can also be moved with its menu, made a
 * conductor where it stands, or, for a conductor, turned back into a tile.
 */
export function ConductorsPanel() {
  const open = useStore((s) => s.conductorsPanel);
  const close = useStore((s) => s.setConductorsPanel);
  const top = useStore((s) => s.conductor);
  const edges = useTreeEdges();
  const claudeIds = useStore((s) => s.order.filter((id) => s.settings[id]?.claude?.enabled).join("\n"));
  const setConductor = useStore((s) => s.setConductor);
  const setSubConductor = useStore((s) => s.setSubConductor);
  const assignTile = useStore((s) => s.assignTile);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const run = (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    what()
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };

  /** A tile dropped on a conductor: a conductor is re-parented, any other tile assigned. */
  const moveUnder = (tile: string, conductor: string) => {
    if (tile === conductor || tile === top) return;
    const s = useStore.getState();
    run(() => (isConductorTile(s, tile) ? setSubConductor(tile, conductor) : assignTile(tile, conductor)));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={() => close(false)} data-testid="conductors-panel">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Conductors"
        className="flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-neutral-700 bg-neutral-900 text-xs shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span className="flex-1 text-sm font-medium text-neutral-100">🎛 Conductors</span>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={() => close(false)} title="Close (Esc)" aria-label="Close">×</button>
        </div>
        <div className="border-b border-neutral-800 px-3 py-2 text-neutral-500">
          Drag a tile onto a conductor to put it under that conductor. A conductor acts only on the tiles directly under it, and can glance at every screen below it.
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {!top && <NoTop ids={claudeIds ? claudeIds.split("\n") : []} busy={busy} onMake={(id) => run(() => setConductor(id))} />}
          {top && (
            <Node
              node={buildTree(top, edges)}
              depth={0}
              top={top}
              dragging={dragging}
              over={over}
              busy={busy}
              onDragStart={setDragging}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onOver={setOver}
              onDrop={(conductor) => {
                if (dragging) moveUnder(dragging, conductor);
                setDragging(null);
                setOver(null);
              }}
              onMove={moveUnder}
              run={run}
            />
          )}
        </div>
        {error && <div className="border-t border-neutral-800 px-3 py-2 text-red-400">{error}</div>}
      </div>
    </div>
  );
}

function NoTop({ ids, busy, onMake }: { ids: string[]; busy: boolean; onMake: (id: string) => void }) {
  return (
    <div className="p-2">
      <div className="mb-2 text-neutral-400">No conductor yet. Pick the Claude tile that should look after the others:</div>
      {ids.length === 0 && <div className="text-neutral-500">No Claude tiles open.</div>}
      {ids.map((id) => (
        <div key={id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-neutral-800">
          <TileLabel id={id} />
          <button className="rounded border border-amber-700 px-2 py-0.5 text-amber-100 hover:bg-amber-900/60 disabled:opacity-50" disabled={busy} onClick={() => onMake(id)}>
            Make conductor
          </button>
        </div>
      ))}
    </div>
  );
}

/** A tile's title, with its name and Mac underneath. */
function TileLabel({ id }: { id: string }) {
  const title = useStore((s) => {
    const t = s.terminals[id];
    return t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : id;
  });
  const name = useStore((s) => s.terminals[id]?.name ?? "");
  const where = useStore((s) => {
    const ssh = s.settings[id]?.ssh;
    if (!ssh?.host) return "this Mac";
    return ssh.machine ? machineLabel(ssh.machine, s.machines[ssh.machine]) : hostLabel(ssh.host);
  });
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-neutral-100">{title}</span>
      <span className="block truncate text-neutral-500">{`${name} · ${where}`}</span>
    </span>
  );
}

interface NodeProps {
  node: TreeNode;
  depth: number;
  top: string;
  dragging: string | null;
  over: string | null;
  busy: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onOver: (id: string | null) => void;
  onDrop: (conductor: string) => void;
  onMove: (tile: string, conductor: string) => void;
  run: (what: () => Promise<void>) => void;
}

function Node(p: NodeProps) {
  const { node, depth, top } = p;
  const id = node.id;
  const isTop = id === top;
  const isConductor = useStore((s) => isConductorTile(s, id));
  const isClaude = useStore((s) => !!s.settings[id]?.claude?.enabled);
  const owner = useStore((s) => conductorFor(s, id));
  const choices = useConductorChoices(isConductor ? id : null);
  const setSubConductor = useStore((s) => s.setSubConductor);
  const removeSubConductor = useStore((s) => s.removeSubConductor);
  const setConductor = useStore((s) => s.setConductor);
  const target = isConductor && p.dragging !== null && p.dragging !== id;
  const highlighted = target && p.over === id;

  const onDragOver = (e: DragEvent) => {
    if (!target) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (p.over !== id) p.onOver(id);
  };

  return (
    <div>
      <div
        data-testid={`tree-row-${id}`}
        draggable={!isTop}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer?.setData(DRAG_TYPE, id);
          e.dataTransfer?.setData("text/plain", id);
          p.onDragStart(id);
        }}
        onDragEnd={p.onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={() => p.over === id && p.onOver(null)}
        onDrop={(e) => {
          if (!target) return;
          e.preventDefault();
          p.onDrop(id);
        }}
        style={{ paddingLeft: 8 + depth * 20 }}
        className={`group flex items-center gap-2 rounded py-1 pr-2 ${highlighted ? "bg-amber-900/40 ring-1 ring-amber-600" : "hover:bg-neutral-800"} ${
          p.dragging === id ? "opacity-40" : ""
        } ${isTop ? "" : "cursor-grab"}`}
      >
        {depth > 0 && <span className="text-neutral-700">└</span>}
        {isConductor ? <ConductorBadge /> : <span className="w-4" />}
        <TileLabel id={id} />
        {isTop && <span className="shrink-0 rounded bg-amber-900/50 px-1.5 text-amber-200">top</span>}
        {!isTop && (
          <select
            aria-label={`Move ${id} under`}
            className="shrink-0 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-300 opacity-60 group-hover:opacity-100"
            disabled={p.busy}
            value={owner ?? top}
            onChange={(e) => p.onMove(id, e.target.value)}
            title="Answers to"
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.id === top ? `${c.title} (top)` : c.title}</option>
            ))}
          </select>
        )}
        {!isTop && !isConductor && isClaude && owner && (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 text-neutral-400 opacity-0 hover:bg-neutral-700 hover:text-amber-200 group-hover:opacity-100 disabled:opacity-50"
            disabled={p.busy}
            onClick={() => p.run(() => setSubConductor(id, owner))}
            title="Make it a conductor where it stands"
            aria-label={`Make ${id} a conductor`}
          >
            🎛+
          </button>
        )}
        {!isTop && isConductor && (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 text-neutral-400 opacity-0 hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100 disabled:opacity-50"
            disabled={p.busy}
            onClick={() => p.run(() => removeSubConductor(id))}
            title="Not a conductor: its tiles go up a level"
            aria-label={`Not a conductor: ${id}`}
          >
            🎛−
          </button>
        )}
        {isTop && (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 text-neutral-400 opacity-0 hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100 disabled:opacity-50"
            disabled={p.busy}
            onClick={() => p.run(() => setConductor(null))}
            title="Clear the top conductor"
          >
            Clear
          </button>
        )}
      </div>
      {node.children.map((c) => (
        <Node key={c.id} {...p} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}
