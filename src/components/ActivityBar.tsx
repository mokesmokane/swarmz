import type { ReactNode } from "react";
import { useStore } from "../store";
import type { SideView } from "../lib/activityBar";
import { rowStatus } from "../lib/sidebarGroups";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    {children}
  </svg>
);
const TerminalsIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
    <path d="M7 9l3 3-3 3M12 15h5" {...stroke} />
  </Icon>
);
const MachinesIcon = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="6" rx="1.5" {...stroke} />
    <rect x="4" y="14" width="16" height="6" rx="1.5" {...stroke} />
    <path d="M8 7h.01M8 17h.01" {...stroke} strokeWidth={2.4} />
  </Icon>
);
const ConductorsIcon = () => (
  <Icon>
    <path d="M6 4v16M12 4v16M18 4v16" {...stroke} />
    <rect x="4" y="13" width="4" height="3" rx="1" {...stroke} />
    <rect x="10" y="7" width="4" height="3" rx="1" {...stroke} />
    <rect x="16" y="11" width="4" height="3" rx="1" {...stroke} />
  </Icon>
);
const PhonesIcon = () => (
  <Icon>
    <rect x="7" y="3" width="10" height="18" rx="2" {...stroke} />
    <path d="M11 17h2" {...stroke} />
  </Icon>
);
const BellIcon = () => (
  <Icon>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20a2 2 0 0 0 4 0" {...stroke} />
  </Icon>
);

/**
 * VS Code's activity bar for swarmz (activity bar and machines spec §2): views on top (Terminals,
 * Machines), the rest at the bottom (Conductors, which opens its dialog, Phones, Notifications).
 * The active view is lit with a bar on its left; clicking it again folds the side bar away.
 */
export function ActivityBar({ view, folded, onPick }: { view: SideView; folded: boolean; onPick: (v: SideView) => void }) {
  // Badges: tiles that need you (when the terminal list is not showing), and a Mac in trouble.
  const needs = useStore((s) =>
    s.order.filter((id) => {
      const t = s.terminals[id];
      return t && rowStatus(s.agentState[id], t.exited) === "needs you";
    }).length,
  );
  const trouble = useStore((s) => Object.values(s.machineStats).some((m) => !m.online || (m.stats?.disk.freePercent ?? 100) < 5));
  const openConductors = () => useStore.getState().setConductorsPanel(true);

  const button = (v: SideView | null, label: string, icon: ReactNode, badge: ReactNode, onClick: () => void) => {
    const active = v !== null && v === view && !folded;
    return (
      <button
        key={label}
        className={`relative flex h-12 w-full items-center justify-center ${active ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-200"}`}
        onClick={onClick}
        title={label}
        aria-label={label}
        aria-pressed={v === null ? undefined : active}
      >
        {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded bg-neutral-100" />}
        {icon}
        {badge}
      </button>
    );
  };

  return (
    <nav className="flex h-full w-11 shrink-0 flex-col justify-between border-r border-neutral-800 bg-neutral-950" aria-label="Views" data-testid="activity-bar">
      <div>
        {button(
          "terminals",
          "Terminals",
          <TerminalsIcon />,
          needs > 0 && (view !== "terminals" || folded) ? (
            <span className="absolute right-1.5 top-2 min-w-4 rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white" data-testid="badge-needs">
              {needs}
            </span>
          ) : null,
          () => onPick("terminals"),
        )}
        {button(
          "machines",
          "Machines",
          <MachinesIcon />,
          trouble ? <span className="absolute right-2.5 top-3 h-2 w-2 rounded-full bg-amber-500" data-testid="badge-machines" /> : null,
          () => onPick("machines"),
        )}
      </div>
      <div>
        {button(null, "Conductors", <ConductorsIcon />, null, openConductors)}
        {button("phones", "Phones", <PhonesIcon />, null, () => onPick("phones"))}
        {button("notifications", "Notifications", <BellIcon />, null, () => onPick("notifications"))}
      </div>
    </nav>
  );
}
