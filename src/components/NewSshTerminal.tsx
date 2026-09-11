import { useState } from "react";
import { useStore } from "../store";
import { validateHost } from "../lib/workspace";

const field = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-blue-500";
const label = "mt-2 block text-[10px] uppercase tracking-wide text-neutral-500";

/** Inline form for creating a terminal that connects to a remote host on creation. */
export function NewSshTerminal({ onClose }: { onClose: () => void }) {
  const createSshTerminal = useStore((s) => s.createSshTerminal);
  const [host, setHost] = useState("");
  const [remoteCwd, setRemoteCwd] = useState("");
  const [claudeOn, setClaudeOn] = useState(false);
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    const hostErr = validateHost(host);
    if (hostErr) {
      setError(hostErr);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSshTerminal({
        host: host.trim(),
        cwd: remoteCwd.trim() || null,
        claude: claudeOn ? { skipPermissions: skip } : null,
      });
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-neutral-800 p-2 text-xs">
      <label className={label}>SSH host</label>
      <input
        autoFocus
        className={field}
        placeholder="user@host"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void connect();
          if (e.key === "Escape") onClose();
        }}
      />
      <label className={label}>Remote directory (optional)</label>
      <input className={field} placeholder="/path/on/remote" value={remoteCwd} onChange={(e) => setRemoteCwd(e.target.value)} />
      <label className="mt-2 flex items-center gap-2 text-neutral-300">
        <input type="checkbox" checked={claudeOn} onChange={(e) => setClaudeOn(e.target.checked)} />
        Run Claude
      </label>
      <label className="mt-1 flex items-center gap-2 text-neutral-300">
        <input type="checkbox" checked={skip} disabled={!claudeOn} onChange={(e) => setSkip(e.target.checked)} />
        Skip permissions <span className="text-red-400">(dangerous)</span>
      </label>
      {error && <div className="mt-1 text-red-400">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-50" onClick={() => void connect()} disabled={busy}>
          Connect
        </button>
      </div>
    </div>
  );
}
