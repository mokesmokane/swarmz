import { useStore } from "../store";

/**
 * The updater's whole UI, in the sidebar next to the sync line: never a modal, never blocking.
 * `UpdateNotice` appears only when there is something to say about an update; `UpdateVersionLine`
 * is the permanent footer that names the running version and checks on demand.
 */
export function UpdateNotice() {
  const status = useStore((s) => s.update.status);
  const failedAt = useStore((s) => s.update.failedAt);
  const version = useStore((s) => s.update.version);
  const error = useStore((s) => s.update.error);
  const manual = useStore((s) => s.update.manual);
  const dismissed = useStore((s) => s.update.dismissed);
  const downloaded = useStore((s) => s.update.downloaded);
  const contentLength = useStore((s) => s.update.contentLength);
  const install = useStore((s) => s.installUpdate);
  const check = useStore((s) => s.checkForUpdates);
  const dismiss = useStore((s) => s.dismissUpdate);

  if (dismissed) return null;

  // A background check that could not reach the endpoint is not news, whether or not an earlier
  // check left a version behind: the app is fine. Only a check the user asked for reports itself.
  if (status === "failed" && failedAt === "check" && !manual) return null;
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
          : failedAt === "install"
            ? `Could not update to swarmz ${version}`
            : "Could not check for updates";

  const failed = status === "failed";
  // Retrying the step that failed: installing again resumes a broken download, but after a check
  // that never got an answer there is nothing to install, so the button checks again.
  const retryCheck = failed && failedAt !== "install";

  return (
    <div
      data-testid="update-notice"
      className={`mx-2 mt-1 flex flex-none items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${failed ? "border-needs/40 text-needs" : "border-pick/50 bg-pick/10 text-ink-2"}`}
    >
      <span className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${failed ? "bg-needs" : "bg-pick"}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate" title={error ?? undefined}>
          {line}
        </div>
        {status === "available" && <div className="text-[10px] text-neutral-500">Your terminals keep running.</div>}
        {error && <div className="truncate text-[10px] text-neutral-500">{error}</div>}
      </div>
      {(status === "available" || failed) && (
        <button
          className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${failed ? "border border-neutral-700 text-ink-2 hover:bg-hover" : "bg-pick text-white hover:brightness-110"}`}
          onClick={() => void (retryCheck ? check({ manual: true }) : install())}
        >
          {retryCheck ? "Try again" : failed ? "Retry" : "Update and restart"}
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
