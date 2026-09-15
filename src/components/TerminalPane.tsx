import { useEffect, useRef, useState } from "react";
import { useStore, terminalColor } from "../store";
import { attach, fitAndFocus } from "../lib/xtermRegistry";
import { EMPTY_SETTINGS, needsRemoteFolder, startupLine, startupSummary, tintBackground } from "../lib/workspace";
import { RemoteDirPicker } from "./RemoteDirPicker";

/** How long the "Copied" pill stays after a selection is copied. */
export const COPIED_FLASH_MS = 1000;

export function TerminalPane({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.terminals[id]);
  const color = useStore((s) => terminalColor(s, id));
  const focused = useStore((s) => s.focusedTerminalId === id);
  const restart = useStore((s) => s.restartTerminal);
  const [restartError, setRestartError] = useState<string | null>(null);
  const pending = useStore((s) => s.startupPending[id] === true);
  const settings = useStore((s) => s.settings[id] ?? EMPTY_SETTINGS);
  const note = useStore((s) => s.startupNotes[id]);
  const runStartup = useStore((s) => s.runStartup);
  const skipStartup = useStore((s) => s.skipStartup);
  const closeTerminal = useStore((s) => s.closeTerminal);
  const machines = useStore((s) => s.machines);
  const connecting = useStore((s) => s.sshConnecting[id] === true);
  const connected = useStore((s) => s.sshConnected[id] === true);
  const cancelConnecting = useStore((s) => s.cancelConnecting);
  const chooseRemoteDir = useStore((s) => s.chooseRemoteDir);
  const copiedAt = useStore((s) => s.copiedAt[id]);
  const [copiedVisible, setCopiedVisible] = useState(false);
  const [picking, setPicking] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  // No terminal id: the card is for the reader, and `SWARMZ_TERMINAL_ID=<uuid>` in front of the
  // remote claude line is plumbing for the hook script, not something to explain here.
  const line = startupLine(settings);
  const summary = startupSummary(settings, machines);
  const needsFolder = connected && needsRemoteFolder(settings);
  // Exactly one overlay renders at a time; connecting takes precedence over needing a folder,
  // which takes precedence over the pending connect card. The card covers the whole tile and
  // hides the shell until the user chooses; the other two are thin bars above a visible shell.
  const overlay: "connecting" | "folder" | "pending" | null = connecting
    ? "connecting"
    : needsFolder
      ? "folder"
      : pending && line
        ? "pending"
        : null;
  const bar = overlay === "pending" ? null : overlay;

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

  useEffect(() => {
    if (!copiedAt) return;
    setCopiedVisible(true);
    const t = setTimeout(() => setCopiedVisible(false), COPIED_FLASH_MS);
    return () => clearTimeout(t);
  }, [copiedAt]);

  return (
    <div className="relative h-full w-full" style={{ backgroundColor: tintBackground("#0f1115", color) }}>
      {color && <div className="absolute inset-x-0 top-0 z-20 h-0.5" style={{ backgroundColor: color }} />}
      {overlay === "pending" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
          <div
            role="dialog"
            aria-label="Connect"
            className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-neutral-700 bg-neutral-900/95 p-5 text-sm text-neutral-200 shadow-xl"
          >
            <div className="text-base font-medium text-neutral-100">{summary ?? "Run startup"}</div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-400" title={line ?? undefined}>{line}</pre>
            {note && <div className="text-xs text-amber-300">{note}</div>}
            <div className="flex items-center gap-2 pt-1">
              <button className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-500" onClick={() => void runStartup(id)}>Connect</button>
              <button className="rounded px-3 py-1.5 text-neutral-300 hover:bg-neutral-800" onClick={() => skipStartup(id)} title="Open a plain local shell instead">Skip</button>
              <span className="flex-1" />
              <button className="rounded px-3 py-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-red-300" onClick={() => closeTerminal(id).catch(() => {})} title="Remove this terminal from the workspace">Close</button>
            </div>
          </div>
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
      {copiedVisible && (
        <div className="pointer-events-none absolute right-3 top-3 z-20 rounded bg-neutral-800/95 px-2 py-0.5 text-xs text-neutral-200 shadow">Copied</div>
      )}
      <div ref={ref} data-testid="terminal-mount" className={`absolute inset-0 p-1 ${bar ? "pt-9" : ""} ${overlay === "pending" ? "invisible" : ""}`} />
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
