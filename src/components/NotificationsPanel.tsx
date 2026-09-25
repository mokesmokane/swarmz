import { useEffect, useState } from "react";
import { ipc, type TelegramInfo } from "../lib/ipc";
import { useStore, telegramFollowWanted } from "../store";
import { hostLabel, machineHost, machineLabel, validateHost } from "../lib/workspace";

const message = (e: unknown) => (typeof e === "string" ? e : String(e));

/**
 * Telegram (conductor spec §5, §6): the bot token and chat id, kept in `~/.swarmz/telegram.json`
 * here and pushed to every Mac a tile is connected to (the rest get it when their tiles connect,
 * with the hooks); a test message; and whether the follower runs on this Mac.
 */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushed, setPushed] = useState<Array<{ machine: string; ok: boolean; error?: string }>>([]);
  const setTelegramConfigured = useStore((s) => s.setTelegramConfigured);
  const following = useStore((s) => telegramFollowWanted(s));
  const conductor = useStore((s) => s.conductor);
  // The Macs whose Telegram setup is refreshed on Save: those with a connected tile, and every
  // other Mac online on the tailnet, since any conductor, wherever it runs, may message the user.
  const hosts = useStore((s) => {
    const out: Array<{ host: string; label: string }> = [];
    for (const id of s.order) {
      const ssh = s.settings[id]?.ssh;
      const host = ssh?.host?.trim();
      if (!host || !s.sshConnected[id] || out.some((h) => h.host === host)) continue;
      out.push({ host, label: ssh?.machine ? machineLabel(ssh.machine, s.machines[ssh.machine]) : hostLabel(host) });
    }
    for (const p of s.tailscale?.peers ?? []) {
      if (!p.online || p.os !== "macOS" || p.name === s.selfMachine) continue;
      const host = machineHost(p.name, s.machines[p.name], s.tailscale?.user ?? "");
      if (validateHost(host) !== null || out.some((h) => h.host === host)) continue;
      out.push({ host, label: machineLabel(p.name, s.machines[p.name]) });
    }
    return out.map((h) => `${h.host}\u0000${h.label}`).join("\n");
  });
  const hostList = hosts ? hosts.split("\n").map((line) => ({ host: line.split("\u0000")[0], label: line.split("\u0000")[1] })) : [];

  useEffect(() => {
    let live = true;
    ipc.telegramGet().then(
      (i) => {
        if (!live) return;
        setInfo(i);
        setChatId(i.chatId);
      },
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    setPushed([]);
    try {
      // An untouched token field keeps the token that is set.
      const i = await ipc.telegramSet(token.trim(), chatId.trim());
      setInfo(i);
      setToken("");
      setTelegramConfigured(i.configured);
      const results: typeof pushed = [];
      for (const h of hostList) {
        try {
          // Saving with nothing set up clears it here, and that is the user's removal too.
          await ipc.telegramPush(h.host, !i.configured);
          results.push({ machine: h.label, ok: true });
        } catch (e) {
          results.push({ machine: h.label, ok: false, error: message(e) });
        }
      }
      setPushed(results);
      setNote(i.configured ? "Saved" : "Removed");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setToken("");
    setChatId("");
    setBusy(true);
    setError(null);
    try {
      const i = await ipc.telegramSet("", "");
      setInfo(i);
      setTelegramConfigured(false);
      const results: typeof pushed = [];
      for (const h of hostList) {
        try {
          await ipc.telegramPush(h.host, true);
          results.push({ machine: h.label, ok: true });
        } catch (e) {
          results.push({ machine: h.label, ok: false, error: message(e) });
        }
      }
      setPushed(results);
      setNote("Removed");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await ipc.telegramTest();
      setNote("Sent; check Telegram");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-neutral-800 p-2 text-xs" data-testid="notifications-panel">
      <div className="mb-1 flex items-center justify-between text-neutral-400">
        <span>Notifications · Telegram</span>
        <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose} title="Close">×</button>
      </div>
      <div className="mb-1 text-neutral-500">
        Make a bot with @BotFather and paste its token; the chat id is your own (ask @userinfobot). The conductor messages you here, and what you write back reaches it.
      </div>
      <label className="mb-1 block">
        <span className="text-neutral-400">Bot token</span>
        <input
          className="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-100 outline-none focus:border-blue-500"
          type="password"
          autoComplete="off"
          placeholder={info?.configured ? `set (…${info.tokenEnd}); paste to replace` : "123456789:AA…"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Bot token"
        />
      </label>
      <label className="mb-1 block">
        <span className="text-neutral-400">Chat id</span>
        <input
          className="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-100 outline-none focus:border-blue-500"
          placeholder="123456789"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          aria-label="Chat id"
        />
      </label>
      <div className="flex items-center gap-1">
        <button className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-200 hover:bg-neutral-800 disabled:opacity-50" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button
          className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          disabled={busy || !info?.configured}
          onClick={() => void test()}
        >
          Send test
        </button>
        {info?.configured && (
          <button className="ml-auto rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
      {note && <div className="mt-1 text-emerald-300">{note}</div>}
      {error && <div className="mt-1 text-red-400">{error}</div>}
      {pushed.map((p) => (
        <div key={p.machine} className={p.ok ? "text-neutral-500" : "text-amber-300"}>
          {p.ok ? `${p.machine}: updated` : `${p.machine}: ${p.error ?? "not updated"}`}
        </div>
      ))}
      <div className="mt-1 text-neutral-500" data-testid="telegram-status">
        {info === null
          ? "…"
          : !info.configured
            ? "Not set up on this Mac"
            : following
              ? "Set up · listening for your messages here (the conductor runs on this Mac)"
              : conductor
                ? "Set up · the conductor's own Mac listens for your messages"
                : "Set up · make a tile the conductor to be able to write to it"}
      </div>
    </div>
  );
}
