import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { filterSshHosts, validateHost } from "../lib/workspace";
import { RemoteDirPicker } from "./RemoteDirPicker";
import { ipc } from "../lib/ipc";

const field = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-blue-500";
const label = "mt-2 block text-[10px] uppercase tracking-wide text-neutral-500";

/**
 * Inline form for creating a terminal that connects to a remote host on creation.
 * The host field doubles as a picker for recent hosts; the remote folder is chosen
 * after connecting (or reused from history when the host was used before).
 */
export function NewSshTerminal({ onClose }: { onClose: () => void }) {
  const createSshTerminal = useStore((s) => s.createSshTerminal);
  const history = useStore((s) => s.sshHistory);
  const forget = useStore((s) => s.forgetSshHost);
  const [host, setHost] = useState("");
  // Recents are shown immediately so a previous connection is one click away.
  const [open, setOpen] = useState(true);
  const [highlight, setHighlight] = useState(0);
  const [claudeOn, setClaudeOn] = useState(false);
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"form" | "connecting" | "pick">("form");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chooseRemoteDir = useStore((s) => s.chooseRemoteDir);
  const runStartup = useStore((s) => s.runStartup);
  const connected = useStore((s) => (createdId ? s.sshConnected[createdId] === true : false));
  const connecting = useStore((s) => (createdId ? s.sshConnecting[createdId] === true : false));
  const rearmed = useStore((s) => (createdId ? s.startupPending[createdId] === true : false));
  const connectNote = useStore((s) => (createdId ? s.startupNotes[createdId] : undefined));
  const remembered = history[host.trim()]?.cwd ?? null;

  useEffect(() => {
    if (stage === "connecting" && connected) setStage("pick");
  }, [stage, connected]);

  const matches = filterSshHosts(history, host);
  const showList = open && matches.length > 0;

  useEffect(() => {
    setHighlight(0);
  }, [host]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const choose = (h: string) => {
    setHost(h);
    setOpen(false);
    setError(null);
  };

  const connect = async () => {
    const hostErr = validateHost(host);
    if (hostErr) {
      setError(hostErr);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Try to open the shared connection without any prompt (keys/agent). If that
      // works there is no terminal yet: the folder is picked first, then the tile
      // opens straight into it. Otherwise the tile opens now for authentication.
      const headless = await ipc.sshOpenMaster(host.trim()).catch(() => false);
      if (headless) {
        setStage("pick");
        return;
      }
      const id = await createSshTerminal({ host: host.trim(), cwd: null, claude: claudeOn ? { skipPermissions: skip } : null });
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
            <div>Connecting to {host.trim()}… {connecting ? "authenticate in the terminal if prompted." : ""}</div>
            <div className="mt-1 text-[10px] text-neutral-500">The folder browser opens here once connected.</div>
            <div className="mt-2 flex justify-end">
              <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (stage === "pick") {
    return (
      <div className="border-b border-neutral-800 p-2 text-xs">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Choose the folder on {host.trim()}</div>
        <div className="relative h-72">
          <RemoteDirPicker
            host={host.trim()}
            initialPath={remembered}
            onPick={(p) => {
              const done = createdId
                ? chooseRemoteDir(createdId, p)
                : createSshTerminal({ host: host.trim(), cwd: p, claude: claudeOn ? { skipPermissions: skip } : null }).then(() => undefined);
              done.catch(() => {}).finally(() => onClose());
            }}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="border-b border-neutral-800 p-2 text-xs">
      <label className={label}>SSH host</label>
      <div className="relative">
        <input
          autoFocus
          className={field}
          placeholder="user@host"
          value={host}
          role="combobox"
          aria-expanded={showList}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setHost(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (showList && e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((i) => Math.min(i + 1, matches.length - 1));
              return;
            }
            if (showList && e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (showList && matches[highlight] && matches[highlight].host !== host.trim()) choose(matches[highlight].host);
              else void connect();
              return;
            }
            if (e.key === "Escape") {
              if (showList) setOpen(false);
              else onClose();
            }
          }}
        />
        {showList && (
          <ul
            role="listbox"
            className="absolute inset-x-0 top-full z-20 mt-0.5 max-h-40 overflow-y-auto rounded border border-neutral-700 bg-neutral-900 shadow-lg"
          >
            {matches.map((r, i) => (
              <li
                key={r.host}
                role="option"
                aria-selected={i === highlight}
                className={`flex items-center gap-2 px-2 py-1 ${i === highlight ? "bg-neutral-800" : "hover:bg-neutral-800/60"}`}
                onMouseEnter={() => setHighlight(i)}
              >
                <button
                  className="min-w-0 flex-1 truncate text-left text-neutral-200"
                  title={r.cwd ?? "no folder yet"}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r.host)}
                >
                  {r.host}
                  {r.cwd && <span className="ml-1 text-neutral-500">{r.cwd}</span>}
                </button>
                <button
                  className="text-neutral-500 hover:text-neutral-200"
                  title="Forget this host"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    forget(r.host);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
