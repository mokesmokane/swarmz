import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { attach, fitAndFocus } from "../lib/xtermRegistry";

export function TerminalPane({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.terminals[id]);
  const focused = useStore((s) => s.focusedTerminalId === id);
  const restart = useStore((s) => s.restartTerminal);
  const [restartError, setRestartError] = useState<string | null>(null);

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
      <div ref={ref} className="absolute inset-0 p-1" />
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
