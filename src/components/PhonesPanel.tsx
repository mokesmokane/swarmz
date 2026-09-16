import { useEffect, useState } from "react";
import { ipc, type MachineResult, type PhoneKey } from "../lib/ipc";

/** The phones paired with this Mac (their keys run only swarmz commands). */
export function PhonesPanel({ onClose }: { onClose: () => void }) {
  const [phones, setPhones] = useState<PhoneKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<MachineResult[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      setPhones(await ipc.phones());
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (device: string) => {
    setBusy(device);
    try {
      const r = await ipc.revokePhone(device);
      setFailures(r.machines.filter((m) => !m.ok));
      await load();
    } catch (e) {
      // The tool revokes locally before it fans out, so the key is gone even when this
      // rejects (a fan-out failure): reload the list, then restore the error message load()
      // may have cleared.
      await load();
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-b border-neutral-800 p-2 text-xs">
      <div className="mb-1 flex items-center justify-between text-neutral-400">
        <span>Phones</span>
        <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose} title="Close">×</button>
      </div>
      {error && <div className="text-red-400">{error}</div>}
      {phones && phones.length === 0 && <div className="text-neutral-500">No phones paired</div>}
      {phones?.map((p) => (
        <div key={`${p.device}-${p.keyEnd}`} className="flex items-center gap-2 py-0.5">
          <span className="flex-1 truncate text-neutral-200">{p.device}</span>
          <span className="text-neutral-600">…{p.keyEnd}</span>
          <button
            className="rounded border border-neutral-700 px-1.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void revoke(p.device)}
          >
            Revoke
          </button>
        </div>
      ))}
      {failures.map((f) => (
        <div key={f.machine} className="text-amber-300">
          {`${f.machine}: ${f.error ?? "not updated"}`}
        </div>
      ))}
    </div>
  );
}
