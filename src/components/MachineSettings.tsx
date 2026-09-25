import { useState } from "react";
import { useStore } from "../store";
import { MACHINE_COLORS, machineGlyph } from "../lib/workspace";
import { ThemePicker } from "./ThemePicker";

const field = "w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-blue-500";
const label = "mt-2 block text-[10px] uppercase tracking-wide text-neutral-500";

export function MachineSettings({ name, onClose }: { name: string; onClose: () => void }) {
  const cfg = useStore((s) => s.machines[name]);
  const defaultUser = useStore((s) => s.tailscale?.user ?? "");
  const updateMachine = useStore((s) => s.updateMachine);
  const [alias, setAlias] = useState(cfg?.alias ?? "");
  const [user, setUser] = useState(cfg?.user ?? "");
  const [color, setColor] = useState<string | null>(cfg?.color ?? null);
  const [icon, setIcon] = useState(cfg?.icon ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const err = await updateMachine(name, { alias: alias.trim() || null, user: user.trim() || null, color, icon: icon.trim() || null });
    if (err) {
      setError(err);
      return;
    }
    onClose();
  };

  return (
    <div className="mx-1 mb-1 rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="text-neutral-400">{name}</div>
      <label className={label}>Alias</label>
      <input className={field} placeholder={name} value={alias} onChange={(e) => setAlias(e.target.value)} />
      <label className={label}>Username</label>
      <input className={field} placeholder={defaultUser || "user"} value={user} onChange={(e) => setUser(e.target.value)} />
      <label className={label}>Icon</label>
      <input
        className={field}
        placeholder={`${machineGlyph(name, undefined)} (an emoji or two characters)`}
        value={icon}
        maxLength={8}
        onChange={(e) => setIcon(e.target.value)}
        aria-label="Icon"
      />
      <label className={label}>Colour</label>
      <div className="flex flex-wrap gap-1">
        <button
          className={`h-5 w-5 rounded-full border ${color === null ? "border-white" : "border-neutral-700"} bg-neutral-800`}
          title="None"
          aria-label="No colour"
          onClick={() => setColor(null)}
        />
        {MACHINE_COLORS.map((c) => (
          <button
            key={c}
            className={`h-5 w-5 rounded-full border ${color === c ? "border-white" : "border-transparent"}`}
            style={{ backgroundColor: c }}
            title={c}
            aria-label={`Colour ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <label className={label}>Terminal theme (applies at once)</label>
      <ThemePicker name={name} />
      {error && <div className="mt-1 text-red-400">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800" onClick={onClose}>Cancel</button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500" onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
