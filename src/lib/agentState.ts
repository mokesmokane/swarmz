export type AgentStatus = "offline" | "working" | "idle" | "blocked";

export interface AgentState {
  status: AgentStatus;
  sessionId: string | null;
  since: string;
  lastEvent: string;
  unseen: boolean;
}

/** One line of ~/.swarmz/agents/events.log as parsed by the core. */
export interface AgentEvent {
  ts: string;
  terminal: string;
  event: string;
  sessionId: string | null;
  notificationType: string | null;
  source: string | null;
  cwd: string | null;
  permissionMode: string | null;
}

export const OFFLINE: AgentState = { status: "offline", sessionId: null, since: "", lastEvent: "", unseen: false };

export const BLOCKING_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
  "elicitation_dialog",
  "elicitation_url_dialog",
]);

/**
 * Folds one hook event into a terminal's state. Returns null when the event changes nothing.
 * `focused` is whether the terminal is the focused one in a focused window: a transition to idle
 * (from working) or to blocked while not focused is marked `unseen` until the tile is looked at.
 */
export function applyAgentEvent(prev: AgentState | undefined, ev: AgentEvent, focused: boolean): AgentState | null {
  const cur = prev ?? OFFLINE;
  const next = (status: AgentStatus, unseen: boolean, sessionId: string | null = cur.sessionId): AgentState => ({
    status,
    sessionId,
    since: ev.ts,
    lastEvent: ev.event,
    unseen,
  });
  switch (ev.event) {
    case "SessionStart":
      return next("idle", false, ev.sessionId);
    case "UserPromptSubmit":
      return next("working", false);
    case "Stop":
    case "StopFailure":
      return next("idle", cur.status === "working" && !focused);
    case "Notification":
      if (!ev.notificationType || !BLOCKING_NOTIFICATIONS.has(ev.notificationType)) return null;
      return next("blocked", !focused);
    case "SessionEnd":
      return next("offline", false, null);
    default:
      return null;
  }
}

const COLOR: Record<AgentStatus, string> = {
  offline: "neutral-500",
  working: "amber-400",
  idle: "green-500",
  blocked: "red-500",
};

/** Tailwind classes for a status dot. */
export function statusClasses(state: AgentState | undefined): string {
  const s = state ?? OFFLINE;
  const c = COLOR[s.status];
  return s.unseen ? `bg-${c} ring-2 ring-${c}/50` : `bg-${c}`;
}

export interface DotPresentation {
  className: string;
  backgroundColor: string | undefined;
  title: string | undefined;
}

/**
 * Decides a terminal dot's colour and title, shared by the sidebar row dot and the tab dot.
 * Precedence: exited (grey, no title) beats a non-offline agent state (status colour + ring,
 * "<status> · <lastEvent>" title) beats the machine's configured colour (inline background, no
 * title) beats the emerald "has activity, no colour" default.
 */
export function dotPresentation(exited: boolean, agent: AgentState | undefined, machineColor: string | null): DotPresentation {
  if (exited) return { className: "bg-neutral-600", backgroundColor: undefined, title: undefined };
  const hasAgent = !!agent && agent.status !== "offline";
  if (hasAgent) return { className: statusClasses(agent), backgroundColor: undefined, title: `${agent.status} · ${agent.lastEvent}` };
  if (machineColor) return { className: "", backgroundColor: machineColor, title: undefined };
  return { className: "bg-emerald-500", backgroundColor: undefined, title: undefined };
}

// Tailwind class inventory (scanned, never executed):
// bg-neutral-500 bg-amber-400 bg-green-500 bg-red-500
// ring-2 ring-neutral-500/50 ring-amber-400/50 ring-green-500/50 ring-red-500/50
