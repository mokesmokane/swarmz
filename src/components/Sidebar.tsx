import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore, terminalColor } from "../store";
import { endTerminalDrag, startTerminalDrag } from "./TabGroup";
import { NewRemoteTerminal } from "./NewRemoteTerminal";
import { dotPresentation } from "../lib/agentState";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function SyncLine() {
  const enabled = useStore((s) => s.sync.enabled);
  const error = useStore((s) => s.sync.error);
  const peersOk = useStore((s) => s.sync.peersOk);
  const peersTotal = useStore((s) => s.sync.peersTotal);
  const lastPullAt = useStore((s) => s.sync.lastPullAt);
  const running = useStore((s) => s.tailscale?.running ?? false);
  const pull = useStore((s) => s.pullWorkspace);
  const ago = lastPullAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(lastPullAt)) / 1000))} s ago` : "not yet";
  const text = !running ? "Sync off · Tailscale not running" : !enabled ? "Sync off" : error ? `Sync error · ${error}` : `Synced · ${peersOk}/${peersTotal} machines · ${ago}`;
  return (
    <button
      className={`w-full truncate border-b border-neutral-800 px-3 py-1 text-left text-[10px] ${error ? "text-amber-300" : "text-neutral-500"} hover:bg-neutral-800/60`}
      title={error ?? "Click to sync now"}
      onClick={() => void pull()}
    >
      {text}
    </button>
  );
}

function Row({ id }: { id: string }) {
  const t = useStore((s) => s.terminals[id]);
  const settings = useStore((s) => s.settings[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  // Select primitives only (a plain string/boolean/null): machineFor/its cfg return a fresh
  // object on every call, and with zustand 5's default (no) equality check a hook selector that
  // returns a new object every render re-renders forever. terminalColor is safe because it
  // already narrows machineFor's result down to a primitive.
  const color = useStore((s) => terminalColor(s, id));
  const agent = useStore((s) => s.agentState[id]);
  const machineName = useStore((s) => s.settings[id]?.ssh?.machine ?? null);
  const machineCwd = useStore((s) => s.settings[id]?.ssh?.cwd ?? "");
  const online = useStore((s) =>
    machineName ? (s.tailscale?.peers.find((p) => p.name === machineName)?.online ?? null) : null,
  );
  const focusTerminal = useStore((s) => s.focusTerminal);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suppressBlur = useRef(false);

  if (!t) return null;
  const exited = t.exited !== null;

  const commit = async () => {
    const err = await renameTerminal(id, draft);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    suppressBlur.current = true;
    setEditing(false);
  };

  const row = (
    <div
      draggable={!editing}
      onDragStart={(e) => startTerminalDrag(e, id)}
      onDragEnd={endTerminalDrag}
      onClick={() => focusTerminal(id)}
      onDoubleClick={() => {
        suppressBlur.current = false;
        setDraft(t.name);
        setEditing(true);
        setError(null);
      }}
      className={`group flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm ${
        focused ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
      }`}
      style={{ borderLeft: color ? `2px solid ${color}` : undefined }}
      title={
        machineName
          ? `${online === true ? "online on Tailscale" : online === false ? "offline" : "Tailscale status unknown"} · ${t.cwd}`
          : t.cwd
      }
    >
      {(() => {
        const dot = dotPresentation(exited, agent, color);
        const title = dot.title ? `${dot.title} · ${relativeTime(agent!.since)}` : undefined;
        return (
          <span
            data-testid={`agent-dot-${id}`}
            className={`h-2 w-2 shrink-0 rounded-full ${dot.className}`}
            style={{ backgroundColor: dot.backgroundColor }}
            title={title}
          />
        );
      })()}
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
                  suppressBlur.current = true;
                  setEditing(false);
                  setError(null);
                }
              }}
              onBlur={() => {
                if (suppressBlur.current) {
                  suppressBlur.current = false;
                  return;
                }
                void commit();
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              className="w-full rounded border border-neutral-600 bg-neutral-900 px-1 text-sm text-neutral-100 outline-none focus:border-blue-500"
            />
            {error && <div className="mt-0.5 text-xs text-red-400">{error}</div>}
          </div>
        ) : (
          <>
            <div className="truncate">
              {t.name}
              {settings?.claude?.enabled && settings.claude.skipPermissions && (
                <span
                  className="ml-1 rounded bg-red-900/60 px-1 text-[10px] font-semibold text-red-300"
                  title="Claude runs with --dangerously-skip-permissions"
                >
                  ⚠ skip-perms
                </span>
              )}
            </div>
            <div className="truncate text-xs text-neutral-500">
              {machineName
                ? `${machineName}${machineCwd ? ` · ${machineCwd}` : ""}`
                : settings?.ssh?.host
                  ? `ssh ${settings.ssh.host}`
                  : basename(t.cwd)}
            </div>
          </>
        )}
      </div>
      <button
        className="rounded px-1 text-neutral-500 opacity-0 hover:bg-neutral-700 hover:text-neutral-200 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminal(id).catch(() => {});
        }}
        title="Close terminal"
      >
        ×
      </button>
    </div>
  );

  return row;
}

export function Sidebar() {
  const order = useStore((s) => s.order);
  const lastCwd = useStore((s) => s.lastCwd);
  const createTerminal = useStore((s) => s.createTerminal);
  const reloadWorkspace = useStore((s) => s.reloadWorkspace);
  const persistError = useStore((s) => s.persistError);
  const dismiss = useStore((s) => s.dismissPersistError);
  const agentHooksError = useStore((s) => s.agentHooksError);
  const installAgentHooks = useStore((s) => s.installAgentHooks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "ssh">("closed");

  const addTerminal = async () => {
    setMenu("closed");
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
        <div className="flex items-center gap-1">
          <button
            className="rounded px-1.5 text-sm leading-none text-neutral-400 hover:bg-neutral-800"
            onClick={() => void reloadWorkspace()}
            title="Reload ~/.swarmz/workspace.json"
          >
            ↻
          </button>
          <button
            className="rounded px-2 text-base leading-none text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            onClick={() => setMenu((m) => (m === "closed" ? "open" : "closed"))}
            disabled={busy}
            title="New terminal"
          >
            +
          </button>
        </div>
      </div>
      <SyncLine />
      {menu === "open" && (
        <div className="flex gap-1 border-b border-neutral-800 p-2 text-xs">
          <button
            className="flex-1 rounded border border-neutral-700 px-2 py-1 text-neutral-200 hover:bg-neutral-800"
            onClick={() => void addTerminal()}
          >
            Local terminal…
          </button>
          <button
            className="flex-1 rounded border border-neutral-700 px-2 py-1 text-neutral-200 hover:bg-neutral-800"
            onClick={() => setMenu("ssh")}
          >
            Remote terminal…
          </button>
        </div>
      )}
      {menu === "ssh" && <NewRemoteTerminal onClose={() => setMenu("closed")} />}
      {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
      {persistError && (
        <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
          <span className="flex-1">{persistError}</span>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={dismiss} title="Dismiss">×</button>
        </div>
      )}
      {agentHooksError && (
        <div className="flex items-start gap-2 px-3 py-1 text-xs text-amber-300">
          <span className="flex-1">{agentHooksError}</span>
          <button className="text-neutral-400 hover:text-neutral-100" onClick={() => void installAgentHooks()}>Retry</button>
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {order.map((id) => (
          <Row key={id} id={id} />
        ))}
        {order.length === 0 && <div className="px-2 py-4 text-xs text-neutral-500">No terminals</div>}
      </div>
    </aside>
  );
}
