import { useStore } from "../store";
import { displayTitle } from "../lib/card";

/**
 * The reminder after closing tabs or a window (windows and layouts spec §3): the tiles still run
 * until they are removed from the sidebar, with Undo to open them again where they were.
 */
export function ClosedNoticeBar() {
  const notice = useStore((s) => (s.closedNotice && s.closedNotice.window === s.windowLabel ? s.closedNotice : null));
  const first = useStore((s) => {
    const id = s.closedNotice?.ids[0];
    const t = id ? s.terminals[id] : undefined;
    return id && t ? displayTitle(s.settings[id]?.card, s.agentState[id], t.name) : null;
  });
  const undo = useStore((s) => s.undoClosed);
  const dismiss = useStore((s) => s.dismissClosedNotice);
  if (!notice) return null;
  const n = notice.ids.length;
  const what = n === 1 && first ? `“${first}” is` : `${n} tiles are`;
  return (
    <div
      role="status"
      data-testid="closed-notice"
      className="absolute bottom-3 left-1/2 z-40 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900/95 px-3 py-2 text-xs text-neutral-200 shadow-xl"
    >
      <span>
        {what} still running. Remove {n === 1 ? "it" : "them"} from the sidebar to stop {n === 1 ? "it" : "them"}.
      </span>
      <button className="rounded px-2 py-0.5 font-medium text-blue-300 hover:bg-neutral-800" onClick={() => void undo()}>
        Undo
      </button>
      <button className="rounded px-1 text-neutral-500 hover:text-neutral-200" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
        ×
      </button>
    </div>
  );
}
