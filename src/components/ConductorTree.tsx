import { useState, type DragEvent, type ReactNode } from "react";
import { useStore } from "../store";
import { DRAG_MIME } from "./TabGroup";
import { buildConductorTree, descendants, dropAction, loadCollapsed, saveCollapsed, type TreeNode } from "../lib/conductorTree";
import { displayTitle } from "../lib/card";
import type { RowInfo } from "../lib/sidebarGroups";

const message = (e: unknown) => (typeof e === "string" ? e : String(e));

/**
 * The sidebar's Tree view (conductor tree spec §6): the sidebar's own rows, nested under the
 * conductor each answers to, with conductors that fold shut (and still say what needs you inside),
 * and drag and drop to rearrange: a row onto a conductor puts it there, a conductor onto another
 * moves it with everything under it. Dragging a row into a pane still opens it there, as in every
 * other view. Every change goes through the tool.
 */
export function ConductorTree({ order, infos, renderRow }: { order: string[]; infos: Map<string, RowInfo>; renderRow: (id: string) => ReactNode }) {
  const top = useStore((s) => s.conductor);
  const subs = useStore((s) => s.conductors);
  const tree = buildConductorTree(order, top, subs);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const [error, setError] = useState<string | null>(null);

  if (!tree) {
    return (
      <div>
        <div className="mx-1 mb-1 rounded border border-dashed border-neutral-700 px-2 py-1.5 text-xs text-neutral-500" data-testid="tree-no-conductor">
          No conductor yet. Hover a Claude row and use 🎛 to make one; its tiles then nest under it here.
        </div>
        {order.map((id) => (
          <div key={id}>{renderRow(id)}</div>
        ))}
      </div>
    );
  }

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  };

  return (
    <div data-testid="conductor-tree">
      {error && (
        <div className="mx-1 mb-1 flex items-start gap-2 rounded bg-red-950/40 px-2 py-1 text-xs text-red-300">
          <span className="flex-1">{error}</span>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <Node node={tree} tree={tree} depth={0} infos={infos} collapsed={collapsed} onToggle={toggle} onError={setError} renderRow={renderRow} />
    </div>
  );
}

interface NodeProps {
  node: TreeNode;
  tree: TreeNode;
  depth: number;
  infos: Map<string, RowInfo>;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onError: (e: string | null) => void;
  renderRow: (id: string) => ReactNode;
}

function Node(p: NodeProps) {
  const { node, tree, depth } = p;
  const id = node.id;
  const dragging = useStore((s) => s.draggingTerminalId);
  const setSubConductor = useStore((s) => s.setSubConductor);
  const assignTile = useStore((s) => s.assignTile);
  const title = useStore((s) => {
    const t = s.terminals[id];
    return t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : id;
  });
  const [over, setOver] = useState(false);
  const isCollapsed = node.conductor && p.collapsed.has(id);
  const below = node.conductor ? descendants(node) : [];
  const needs = below.filter((d) => p.infos.get(d)?.status === "needs you").length;
  const action = dragging ? dropAction(tree, dragging, id) : null;

  // The innermost conductor under the pointer decides, even when it refuses: a drop must never
  // bubble up to a conductor further out (a tile dropped where it already is would move up).
  const onDragOver = (e: DragEvent) => {
    if (!dragging) return;
    e.stopPropagation();
    if (!action) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!over) setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    const dragged = e.dataTransfer?.getData(DRAG_MIME) || dragging;
    if (!dragged) return;
    e.stopPropagation();
    const act = dropAction(tree, dragged, id);
    setOver(false);
    if (!act) return;
    e.preventDefault();
    useStore.getState().setDragging(null);
    p.onError(null);
    (act === "move" ? setSubConductor(dragged, id) : assignTile(dragged, id)).catch((err) => p.onError(message(err)));
  };

  return (
    <div
      data-testid={`tree-node-${id}`}
      onDragOver={node.conductor ? onDragOver : undefined}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={node.conductor ? onDrop : undefined}
      className={`rounded ${over && action ? "bg-amber-900/25 ring-1 ring-amber-600/70" : ""}`}
    >
      <div className="flex items-start">
        {node.conductor ? (
          <button
            className="mt-1.5 w-4 shrink-0 text-[10px] leading-4 text-neutral-500 hover:text-neutral-200"
            onClick={() => p.onToggle(id)}
            title={isCollapsed ? `Show the ${below.length} under ${title}` : `Fold ${title}`}
            aria-label={isCollapsed ? `Expand ${title}` : `Collapse ${title}`}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">{p.renderRow(id)}</div>
      </div>
      {node.conductor && isCollapsed && below.length > 0 && (
        <button
          className="ml-6 flex items-center gap-1.5 pb-1 text-[11px] text-neutral-500 hover:text-neutral-300"
          onClick={() => p.onToggle(id)}
          data-testid={`tree-folded-${id}`}
        >
          <span>{`${below.length} under it`}</span>
          {needs > 0 && <span className="rounded bg-red-900/60 px-1 text-red-200">{`${needs} need${needs === 1 ? "s" : ""} you`}</span>}
        </button>
      )}
      {node.conductor && !isCollapsed && (
        <div className="ml-2 border-l border-neutral-800 pl-1.5">
          {node.children.map((c) => (
            <Node key={c.id} {...p} node={c} depth={depth + 1} />
          ))}
          {node.children.length === 0 && id !== tree.id && (
            <div className="my-0.5 ml-4 rounded border border-dashed border-neutral-700 px-2 py-1 text-[11px] text-neutral-500" data-testid={`tree-empty-${id}`}>
              Drag tiles here
            </div>
          )}
        </div>
      )}
    </div>
  );
}
