import { useEffect, useState } from "react";
import { machineColor, useStore } from "../store";
import { machineHost, machineLabel } from "../lib/workspace";
import { RemoteDirPicker } from "./RemoteDirPicker";
import { MachineSettings } from "./MachineSettings";
import { ipc } from "../lib/ipc";

/**
 * Inline form for creating a terminal that connects to a machine on your tailnet.
 * Lists Tailscale peers (online first), lets you set an alias/username/colour inline,
 * and picks the remote folder after connecting (or reuses the machine's last folder).
 */
export function NewRemoteTerminal({ onClose }: { onClose: () => void }) {
  const createRemoteTerminal = useStore((s) => s.createRemoteTerminal);
  const tailscale = useStore((s) => s.tailscale);
  const tailscaleError = useStore((s) => s.tailscaleError);
  const machines = useStore((s) => s.machines);
  const refresh = useStore((s) => s.refreshTailscale);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [claudeOn, setClaudeOn] = useState(false);
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"form" | "connecting" | "pick">("form");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const chooseRemoteDir = useStore((s) => s.chooseRemoteDir);
  const runStartup = useStore((s) => s.runStartup);
  const connected = useStore((s) => (createdId ? s.sshConnected[createdId] === true : false));
  const connecting = useStore((s) => (createdId ? s.sshConnecting[createdId] === true : false));
  const rearmed = useStore((s) => (createdId ? s.startupPending[createdId] === true : false));
  const connectNote = useStore((s) => (createdId ? s.startupNotes[createdId] : undefined));
  const remembered = selected ? (machines[selected]?.cwd ?? null) : null;
  const host = selected ? machineHost(selected, machines[selected], tailscale?.user ?? "") : "";

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (stage === "connecting" && connected) setStage("pick");
  }, [stage, connected]);

  const connect = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      // Try to open the shared connection without any prompt (keys/agent). If that
      // works there is no terminal yet: the folder is picked first, then the tile
      // opens straight into it. Otherwise the tile opens now for authentication.
      const headless = await ipc.sshOpenMaster(host).catch(() => false);
      if (headless) {
        setStage("pick");
        return;
      }
      const id = await createRemoteTerminal({ machine: selected, cwd: null, claude: claudeOn ? { skipPermissions: skip } : null });
      setCreatedId(id);
      setStage("connecting");
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (stage === "connecting" && createdId) {
    return (
      <div className="border-b border-neutral-800 p-2 text-xs text-neutral-300">
        {rearmed ? (
          <>
            <div className="text-amber-300">{connectNote ?? "Connection not detected."}</div>
            <div className="mt-2 flex justify-end gap-2">
              <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Close</button>
              <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void runStartup(createdId)}>Retry</button>
            </div>
          </>
        ) : (
          <>
            <div>Connecting to {host}… {connecting ? "authenticate in the terminal if prompted." : ""}</div>
            <div className="mt-1 text-[10px] text-neutral-500">The folder browser opens here once connected.</div>
            <div className="mt-2 flex justify-end">
              <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (stage === "pick" && selected) {
    return (
      <div className="border-b border-neutral-800 p-2 text-xs">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Choose the folder on {machineLabel(selected, machines[selected])}</div>
        <div className="relative h-72">
          <RemoteDirPicker
            host={host}
            initialPath={remembered}
            onPick={(p) => {
              const done = createdId
                ? chooseRemoteDir(createdId, p)
                : createRemoteTerminal({ machine: selected, cwd: p, claude: claudeOn ? { skipPermissions: skip } : null }).then(() => undefined);
              done.catch(() => {}).finally(() => onClose());
            }}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }

  if (!tailscale || !tailscale.running) {
    return (
      <div className="border-b border-neutral-800 p-2 text-xs text-neutral-300">
        <div className="text-amber-300">{tailscale?.message ?? tailscaleError ?? "Checking Tailscale…"}</div>
        {error && <div className="mt-1 text-red-400">{error}</div>}
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
          <button
            className="rounded px-2 py-0.5 text-neutral-300 hover:bg-neutral-800"
            onClick={() => {
              setError(null);
              ipc.tailscaleOpen().catch((e) => setError(typeof e === "string" ? e : String(e)));
            }}
          >
            Open Tailscale
          </button>
          <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void refresh()}>Retry</button>
        </div>
      </div>
    );
  }
  return (
    <div className="border-b border-neutral-800 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-neutral-500">
        <span>Machines on your tailnet</span>
        <button className="text-neutral-500 hover:text-neutral-200" title="Refresh" onClick={() => void refresh()}>↻</button>
      </div>
      {tailscale.peers.length === 0 && <div className="px-1 py-2 text-neutral-500">No other machines yet. Install Tailscale on them with the same account.</div>}
      <ul role="listbox" className="max-h-48 overflow-y-auto rounded border border-neutral-800">
        {tailscale.peers.map((p) => {
          const cfg = machines[p.name];
          const isSel = selected === p.name;
          return (
            <li key={p.name} role="option" aria-selected={isSel}>
              <div
                className={`flex cursor-default items-center gap-2 px-2 py-1 ${isSel ? "bg-neutral-800" : "hover:bg-neutral-800/60"} ${p.online ? "" : "opacity-60"}`}
                onClick={() => setSelected(p.name)}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-neutral-600" style={{ backgroundColor: machineColor(useStore.getState(), p.name) }} />
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.online ? "bg-emerald-500" : "bg-neutral-600"}`} title={p.online ? "online" : "offline"} />
                <span className="min-w-0 flex-1 truncate text-neutral-200">
                  {machineLabel(p.name, cfg)}
                  {cfg?.alias?.trim() && <span className="ml-1 text-neutral-500">{p.name}</span>}
                  {cfg?.cwd && <span className="ml-1 text-neutral-500">{cfg.cwd}</span>}
                </span>
                <button
                  className="text-neutral-500 hover:text-neutral-200"
                  title="Machine settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(editing === p.name ? null : p.name);
                  }}
                >
                  ⚙
                </button>
              </div>
              {editing === p.name && <MachineSettings name={p.name} onClose={() => setEditing(null)} />}
            </li>
          );
        })}
      </ul>
      {selected && (
        <>
          <label className="mt-2 flex items-center gap-2 text-neutral-300">
            <input type="checkbox" checked={claudeOn} onChange={(e) => setClaudeOn(e.target.checked)} />
            Run Claude
          </label>
          <label className="mt-1 flex items-center gap-2 text-neutral-300">
            <input type="checkbox" checked={skip} disabled={!claudeOn} onChange={(e) => setSkip(e.target.checked)} />
            Skip permissions <span className="text-red-400">(dangerous)</span>
          </label>
        </>
      )}
      {error && <div className="mt-1 text-red-400">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-50" onClick={() => void connect()} disabled={busy || !selected}>Connect</button>
      </div>
    </div>
  );
}
