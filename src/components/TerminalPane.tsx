import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { attach, fitAndFocus } from "../lib/xtermRegistry";
import { EMPTY_SETTINGS, needsRemoteFolder, startupLine } from "../lib/workspace";
import { RemoteDirPicker } from "./RemoteDirPicker";

export function TerminalPane({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.terminals[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  const restart = useStore((s) => s.restartTerminal);
  const [restartError, setRestartError] = useState<string | null>(null);
  const pending = useStore((s) => s.startupPending[id] === true);
  const settings = useStore((s) => s.settings[id] ?? EMPTY_SETTINGS);
  const note = useStore((s) => s.startupNotes[id]);
  const runStartup = useStore((s) => s.runStartup);
  const skipStartup = useStore((s) => s.skipStartup);
  const connecting = useStore((s) => s.sshConnecting[id] === true);
  const connected = useStore((s) => s.sshConnected[id] === true);
  const cancelConnecting = useStore((s) => s.cancelConnecting);
  const chooseRemoteDir = useStore((s) => s.chooseRemoteDir);
  const [picking, setPicking] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const line = startupLine(settings);
  const needsFolder = connected && needsRemoteFolder(settings);
  // Exactly one bar renders at a time; connecting takes precedence over needing a folder, which
  // takes precedence over the pending (Run/Skip) bar.
  const bar: "connecting" | "folder" | "pending" | null = connecting
    ? "connecting"
    : needsFolder
      ? "folder"
      : pending && line
        ? "pending"
        : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { fit } = attach(id, el);
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // ignore fit errors during layout thrash
        }
      });
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    refit();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [id]);

  useEffect(() => {
    if (focused) fitAndFocus(id);
  }, [focused, id]);

  return (
    <div className="relative h-full w-full bg-[#0f1115]">
      {bar === "pending" && (
        <div className="absolute inset-x-0 top-0 z-10 flex max-h-24 items-start gap-2 overflow-y-auto border-b border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-300">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono" title={line ?? undefined}>{line}</span>
          {note && <span className="truncate text-amber-300" title={note}>{note}</span>}
          <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void runStartup(id)}>Run</button>
          <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={() => skipStartup(id)}>Skip</button>
        </div>
      )}
      {bar === "connecting" && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-300">
          <span className="flex-1">Connecting… authenticate in the terminal if prompted.</span>
          <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={() => cancelConnecting(id)}>Cancel</button>
        </div>
      )}
      {bar === "folder" && (
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-neutral-700 bg-neutral-900/95 px-3 py-1.5 text-xs text-neutral-300">
          <span className="shrink-0">Choose a folder for Claude:</span>
          <input
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-neutral-100 outline-none focus:border-blue-500"
            placeholder="/path/on/remote"
            value={typedPath}
            onChange={(e) => setTypedPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && typedPath.trim()) void chooseRemoteDir(id, typedPath.trim());
            }}
          />
          <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => setPicking(true)}>Browse…</button>
        </div>
      )}
      {picking && settings.ssh?.host && (
        <RemoteDirPicker
          host={settings.ssh.host}
          initialPath={settings.ssh.cwd ?? null}
          onPick={(p) => {
            setPicking(false);
            void chooseRemoteDir(id, p);
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <div ref={ref} className={`absolute inset-0 p-1 ${bar ? "pt-9" : ""}`} />
      {info?.exited !== null && info?.exited !== undefined && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-neutral-900/95 px-3 py-2 text-sm text-neutral-300 border-t border-neutral-700">
          <span>
            Process exited with code {info.exited}
            {info.error ? `: ${info.error}` : ""}
            {restartError && <span className="text-red-400"> — {restartError}</span>}
          </span>
          <button
            className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
            onClick={() =>
              restart(id)
                .then(() => setRestartError(null))
                .catch((e) => setRestartError(typeof e === "string" ? e : String(e)))
            }
          >
            Restart shell
          </button>
        </div>
      )}
    </div>
  );
}
