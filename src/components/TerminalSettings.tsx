import { useState } from "react";
import { useStore } from "../store";
import { EMPTY_SETTINGS, startupLine, validateHost, type TerminalSettings as Settings } from "../lib/workspace";
import { RemoteDirPicker } from "./RemoteDirPicker";

export function TerminalSettings({ id, onClose }: { id: string; onClose: () => void }) {
  const info = useStore((s) => s.terminals[id]);
  const current = useStore((s) => s.settings[id] ?? EMPTY_SETTINGS);
  const updateSettings = useStore((s) => s.updateSettings);
  const renameTerminal = useStore((s) => s.renameTerminal);
  const connected = useStore((s) => s.sshConnected[id] === true);

  const [name, setName] = useState(info?.name ?? "");
  const [host, setHost] = useState(current.ssh?.host ?? "");
  const [remoteCwd, setRemoteCwd] = useState(current.ssh?.cwd ?? "");
  const [claudeOn, setClaudeOn] = useState(current.claude?.enabled ?? false);
  const [skip, setSkip] = useState(current.claude?.skipPermissions ?? false);
  const [command, setCommand] = useState(current.command ?? "");
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  if (!info) return null;

  const draft: Settings = {
    ssh: host.trim()
      ? { host: host.trim(), cwd: remoteCwd.trim() || null, ...(current.ssh?.machine ? { machine: current.ssh.machine } : {}) }
      : null,
    claude: claudeOn
      ? { enabled: true, sessionId: current.claude?.sessionId ?? "", skipPermissions: skip, started: current.claude?.started ?? false }
      : current.claude
        ? { ...current.claude, enabled: false }
        : null,
    command: command.trim() || null,
  };
  const preview = startupLine({ ...draft, claude: draft.claude ? { ...draft.claude, sessionId: draft.claude.sessionId || "new-session" } : null });

  const save = async () => {
    if (host.trim()) {
      const hostErr = validateHost(host);
      if (hostErr) {
        setError(hostErr);
        return;
      }
    }
    if (name.trim() !== info.name) {
      const renameErr = await renameTerminal(id, name);
      if (renameErr) {
        setError(renameErr);
        return;
      }
    }
    updateSettings(id, draft);
    setError(null);
    onClose();
  };

  const field = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-blue-500";
  const label = "mt-2 block text-[10px] uppercase tracking-wide text-neutral-500";

  return (
    <div className="mx-1 mb-1 rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs" onClick={(e) => e.stopPropagation()}>
      <label className={label}>Name</label>
      <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      <label className={label}>Directory</label>
      <div className="truncate rounded border border-neutral-800 px-1.5 py-0.5 text-neutral-400" title="Close and create a new terminal to change the directory">
        {info.cwd}
      </div>
      <label className={label}>SSH host (optional)</label>
      {current.ssh?.machine ? (
        <>
          <div className="truncate rounded border border-neutral-800 px-1.5 py-0.5 text-neutral-400">{current.ssh.host}</div>
          <div className="mt-0.5 text-[10px] text-neutral-500">managed by the machine's settings</div>
        </>
      ) : (
        <input className={field} placeholder="user@host" value={host} onChange={(e) => setHost(e.target.value)} />
      )}
      <label className={label}>Remote directory (optional)</label>
      <div className="flex gap-1">
        <input className={field} placeholder="/path/on/remote" value={remoteCwd} onChange={(e) => setRemoteCwd(e.target.value)} disabled={!host.trim()} />
        <button
          className="rounded border border-neutral-700 px-2 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          disabled={!connected || host.trim() !== (current.ssh?.host ?? "")}
          title={
            !connected
              ? "Connect first"
              : host.trim() !== (current.ssh?.host ?? "")
                ? "Save the new host and connect first"
                : "Browse folders on the remote host"
          }
          onClick={() => setPicking(true)}
        >
          Browse…
        </button>
      </div>
      <label className="mt-2 flex items-center gap-2 text-neutral-300">
        <input type="checkbox" checked={claudeOn} onChange={(e) => setClaudeOn(e.target.checked)} />
        Run Claude
      </label>
      <label className="mt-1 flex items-center gap-2 text-neutral-300">
        <input type="checkbox" checked={skip} disabled={!claudeOn} onChange={(e) => setSkip(e.target.checked)} />
        Skip permissions <span className="text-red-400">(dangerous)</span>
      </label>
      <label className={label}>Startup command (overrides the above)</label>
      <input className={field} placeholder="e.g. npm run dev" value={command} onChange={(e) => setCommand(e.target.value)} />
      <div className="mt-2 truncate font-mono text-[10px] text-neutral-500" title={preview ?? ""}>
        {preview ? `Runs: ${preview}` : "No startup command"}
      </div>
      {error && <div className="mt-1 text-red-400">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void save()}>Save</button>
      </div>
      {picking && (
        <div className="relative h-64">
          <RemoteDirPicker
            host={current.ssh?.host ?? ""}
            initialPath={remoteCwd.trim() || null}
            onPick={(p) => {
              setRemoteCwd(p);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        </div>
      )}
    </div>
  );
}
