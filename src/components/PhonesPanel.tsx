import { useEffect, useMemo, useState } from "react";
import { ipc, type HostKeys, type MachineResult, type PhoneKey } from "../lib/ipc";
import { pairUri, qrSvg } from "../lib/pairing";

const message = (e: unknown) => (typeof e === "string" ? e : String(e));

/** The phones paired with this Mac (their keys run only swarmz commands). */
export function PhonesPanel({ onClose }: { onClose: () => void }) {
  const [phones, setPhones] = useState<PhoneKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<MachineResult[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const load = async () => {
    try {
      setPhones(await ipc.phones());
      setError(null);
    } catch (e) {
      setError(message(e));
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
      setError(message(e));
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
      <button
        className="mt-1.5 w-full rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800"
        onClick={() => setLinking(true)}
      >
        Link a device
      </button>
      {linking && <LinkDeviceDialog onClose={() => setLinking(false)} />}
    </div>
  );
}

/**
 * The pairing QR code: this Mac's name, login user and ssh host key fingerprints. The code holds
 * no secret — host keys are public — so a photograph of it gives nobody access; the phone still
 * needs this Mac's password once. Pinning the fingerprints in advance turns the phone's first
 * connection from "trust whichever key answers" into a checked one.
 */
function LinkDeviceDialog({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<HostKeys | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    ipc.hostKeys().then(
      (k) => live && setKeys(k),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const uri = keys && pairUri(keys);
  // The markup is a path built from the URI's bits, never from the URI's text, so nothing in it
  // can reach the DOM as markup.
  const svg = useMemo(() => (uri === null ? null : qrSvg(uri)), [uri]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Link a device"
        className="w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-xs shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-neutral-400">Link a device</div>
        {error && <div className="text-red-400">{error}</div>}
        {!keys && !error && <div className="text-neutral-500">Reading this Mac's host keys…</div>}
        {keys && uri && svg && (
          <>
            <div
              role="img"
              aria-label={`Pairing code for ${keys.host}`}
              title={uri}
              className="mx-auto h-64 w-64 rounded bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <div className="mt-3 text-center">
              <div className="font-mono text-sm text-neutral-100">{keys.host}</div>
              <div className="font-mono text-neutral-400">{keys.user}</div>
            </div>
            <p className="mt-2 text-neutral-500">
              Scan this in the swarmz app on your phone. You will still need this Mac's password once.
            </p>
          </>
        )}
        <button
          className="mt-3 w-full rounded border border-neutral-700 px-1.5 py-1 text-neutral-300 hover:bg-neutral-800"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
