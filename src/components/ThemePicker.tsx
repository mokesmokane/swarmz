import { useStore, machineThemeId } from "../store";
import { PLAIN, THEMES, themeById, type MachineTheme } from "../lib/themes";

/** A theme drawn small: its background, a prompt in its text colour, and its accents. */
export function ThemeSwatch({ theme, selected, label, onClick }: { theme: MachineTheme; selected: boolean; label: string; onClick: () => void }) {
  const t = theme.theme;
  return (
    <button
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={`${label}: ${theme.blurb}`}
      data-testid={`theme-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
      onClick={onClick}
      className={`flex w-[4.5rem] flex-col items-stretch gap-1 rounded-md border p-1 text-[10px] ${selected ? "border-blue-400 ring-1 ring-blue-400/60" : "border-neutral-700 hover:border-neutral-500"}`}
    >
      <span className="block rounded px-1 py-0.5 text-left font-mono leading-tight" style={{ backgroundColor: t.background, color: t.foreground }}>
        <span style={{ color: t.green ?? t.foreground }}>$</span> ls
        <span className="mt-0.5 flex gap-0.5">
          {[t.red, t.yellow, t.blue, t.magenta, t.cyan].map((c, i) => (
            <span key={i} className="h-1 flex-1 rounded-sm" style={{ backgroundColor: c ?? t.foreground }} />
          ))}
        </span>
      </span>
      <span className="truncate text-neutral-300">{label}</span>
    </button>
  );
}

/**
 * The terminal theme of Mac `name` (machine themes spec): Auto (chosen by its place among the
 * Macs), one of the five, or Plain. Saved to the shared workspace, so every Mac shows it alike.
 */
export function ThemePicker({ name }: { name: string }) {
  const picked = useStore((s) => s.machines[name]?.theme ?? null);
  const auto = useStore((s) => machineThemeId({ ...s, machines: { ...s.machines, [name]: { ...(s.machines[name] ?? { lastUsed: "" }), theme: null } } }, name));
  const updateMachine = useStore((s) => s.updateMachine);
  const pick = (theme: string | null) => void updateMachine(name, { theme });
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`Terminal theme for ${name}`} data-testid={`theme-picker-${name}`}>
      <ThemeSwatch theme={themeById(auto)} selected={picked === null} label={`Auto (${themeById(auto).name})`} onClick={() => pick(null)} />
      {THEMES.map((t) => (
        <ThemeSwatch key={t.id} theme={t} selected={picked === t.id} label={t.name} onClick={() => pick(t.id)} />
      ))}
      <ThemeSwatch theme={PLAIN} selected={picked === PLAIN.id} label={PLAIN.name} onClick={() => pick(PLAIN.id)} />
    </div>
  );
}
