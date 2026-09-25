import type { ReactNode } from "react";
import { useStore } from "../store";
import type { SideView } from "../lib/activityBar";
import { rowStatus } from "../lib/sidebarGroups";
import { BellIcon, PhoneIcon, TerminalIcon, TreeIcon } from "./sidebar/icons";

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
        className={`relative flex h-10 w-11 items-center justify-center ${active ? "text-ink" : "text-[#7d8087] hover:text-ink-2"}`}
        onClick={onClick}
        title={label}
        aria-label={label}
        aria-pressed={v === null ? undefined : active}
      >
        {active && <span className="absolute inset-y-2 left-0 w-0.5 bg-ink" />}
        {icon}
        {badge}
      </button>
    );
  };

  // Sidebar redesign spec: Terminals on top; Conductors, Phones and Notifications at the bottom.
  // The Machines view opens from the sidebar's Machines footer; a Mac in trouble still shows here.
  return (
    <nav className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-rail py-2" aria-label="Views" data-testid="activity-bar">
      {button(
        "terminals",
        "Terminals",
        <TerminalIcon />,
        needs > 0 && (view !== "terminals" || folded) ? (
          <span className="absolute right-1 top-1.5 min-w-4 rounded-full bg-needs px-1 text-[10px] font-bold leading-4 text-[#1a1405]" data-testid="badge-needs">
            {needs}
          </span>
        ) : trouble ? (
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-needs" data-testid="badge-machines" />
        ) : null,
        () => onPick("terminals"),
      )}
      <div className="flex-1" />
      {button(null, "Conductors", <TreeIcon size={18} strokeWidth={1.1} />, null, openConductors)}
      {button("phones", "Phones", <PhoneIcon />, null, () => onPick("phones"))}
      {button("notifications", "Notifications", <BellIcon />, null, () => onPick("notifications"))}
    </nav>
  );
}
