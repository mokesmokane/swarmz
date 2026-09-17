import { useStore } from "../store";

/**
 * The updater's whole UI, in the sidebar next to the sync line: never a modal, never blocking.
 * `UpdateNotice` appears only when there is something to say about an update; `UpdateVersionLine`
 * is the permanent footer that names the running version and checks on demand.
 */
export function UpdateNotice() {
  const status = useStore((s) => s.update.status);
  const version = useStore((s) => s.update.version);
  const error = useStore((s) => s.update.error);
  const manual = useStore((s) => s.update.manual);
  const dismissed = useStore((s) => s.update.dismissed);
  const downloaded = useStore((s) => s.update.downloaded);
  const contentLength = useStore((s) => s.update.contentLength);
  const install = useStore((s) => s.installUpdate);
  const dismiss = useStore((s) => s.dismissUpdate);

  if (dismissed) return null;

  // A background check that could not reach the endpoint is not news: the app is fine, and the
  // next check is 30 minutes away. Only a check the user asked for reports itself.
  if (status === "failed" && !version && !manual) return null;
  if (status === "idle" || status === "checking") return null;

  const pct = contentLength && contentLength > 0 ? Math.min(100, Math.round((downloaded / contentLength) * 100)) : null;

  const line =
    status === "available"
      ? `swarmz ${version} is ready`
      : status === "downloading"
        ? `Downloading swarmz ${version}${pct === null ? "…" : ` · ${pct}%`}`
        : status === "ready"
          ? error
            ? `swarmz ${version} is installed. Quit and reopen swarmz to use it.`
            : `swarmz ${version} is installed · restarting…`
          : version
            ? `Could not update to swarmz ${version}`
            : "Could not check for updates";

  const failed = status === "failed";

  return (
    <div
      data-testid="update-notice"
      className={`flex items-start gap-2 border-b border-neutral-800 px-3 py-1.5 text-xs ${failed ? "text-amber-300" : "text-neutral-300"}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate" title={error ?? undefined}>
          {line}
        </div>
        {status === "available" && <div className="text-[10px] text-neutral-500">Your terminals keep running.</div>}
        {error && <div className="truncate text-[10px] text-neutral-500">{error}</div>}
      </div>
      {(status === "available" || failed) && (
        <button
          className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-200 hover:bg-neutral-800"
          onClick={() => void install()}
          disabled={failed && !version}
        >
          {failed ? "Retry" : "Update and restart"}
        </button>
      )}
      <button className="shrink-0 text-neutral-500 hover:text-neutral-200" onClick={dismiss}>
        {status === "available" ? "Later" : "×"}
      </button>
    </div>
  );
}

export function UpdateVersionLine() {
  const status = useStore((s) => s.update.status);
  const manual = useStore((s) => s.update.manual);
  const checkedAt = useStore((s) => s.update.checkedAt);
  const check = useStore((s) => s.checkForUpdates);
  const checking = status === "checking";
  // "You are up to date" answers a question the user asked; a quiet background check says nothing.
  const upToDate = status === "idle" && manual && checkedAt !== null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-neutral-800 px-3 py-1 text-[10px] text-neutral-500">
      <span className="truncate">{upToDate ? `You are up to date · swarmz ${__APP_VERSION__}` : `swarmz ${__APP_VERSION__}`}</span>
      <button
        className="shrink-0 hover:text-neutral-200 disabled:opacity-50"
        onClick={() => void check({ manual: true })}
        disabled={checking}
      >
        {checking ? "Checking…" : "Check for updates"}
      </button>
    </div>
  );
}
