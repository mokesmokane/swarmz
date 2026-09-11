import { useEffect, useState } from "react";
import { ipc, type RemoteListing } from "../lib/ipc";

export function RemoteDirPicker({
  host,
  initialPath,
  onPick,
  onClose,
}: {
  host: string;
  initialPath: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (path: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const l = await ipc.sshListDir(host, path);
      setListing(l);
      setPathInput(l.path);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const enter = (name: string) => {
    if (!listing) return;
    const base = listing.path === "/" ? "" : listing.path;
    void load(`${base}/${name}`);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-950/95 p-3 text-xs text-neutral-200" onMouseDown={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-neutral-400">Folder on {host}</span>
        <button className="ml-auto rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
      </div>
      <div className="mb-2 flex gap-1">
        <input
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(pathInput.trim() || null);
          }}
        />
        <button className="rounded border border-neutral-700 px-2 hover:bg-neutral-800" onClick={() => void load(pathInput.trim() || null)} title="Go">Go</button>
        <button className="rounded border border-neutral-700 px-2 hover:bg-neutral-800" onClick={() => void load(null)} title="Home">~</button>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-2 text-red-400">
          <span className="flex-1">{error}</span>
          <button className="rounded border border-neutral-700 px-2 text-neutral-300 hover:bg-neutral-800" onClick={() => void load(listing?.path ?? initialPath)}>Retry</button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-800">
        {loading && <div className="px-2 py-1 text-neutral-500">Loading…</div>}
        {!loading && listing && (
          <ul>
            {listing.parent !== null && (
              <li className="cursor-default px-2 py-1 hover:bg-neutral-800" onDoubleClick={() => void load(listing.parent)}>
                ..
              </li>
            )}
            {listing.dirs.map((d) => (
              <li
                key={d}
                className={`cursor-default px-2 py-1 hover:bg-neutral-800 ${d.startsWith(".") ? "text-neutral-500" : ""}`}
                onDoubleClick={() => enter(d)}
                title="Double-click to open"
              >
                {d}/
              </li>
            ))}
            {listing.dirs.length === 0 && <li className="px-2 py-1 text-neutral-500">No subfolders</li>}
          </ul>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-neutral-400" title={listing?.path ?? ""}>{listing?.path ?? ""}</span>
        <button
          className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={!listing || loading}
          onClick={() => listing && onPick(listing.path)}
        >
          Use this folder
        </button>
      </div>
    </div>
  );
}
