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
    case "PermissionRequest":
      return next("blocked", !focused);
    case "PostToolUse":
      // Fires after a tool ran: the permission the tile was blocked on has been answered.
      return cur.status === "blocked" ? next("working", false) : null;
    case "SessionEnd":
      return next("offline", false, null);
    default:
      return null;
  }
}

/** The phone's status colours, used everywhere (phone spec §4.6). */
export const STATUS_COLORS = { working: "#25BF35", needsYou: "#FFB21B", idle: "#475569", error: "#FF0303" } as const;

/** Blocked, or finished while nobody was looking. */
export function needsYou(state: AgentState | undefined): boolean {
  return !!state && (state.status === "blocked" || (state.status === "idle" && state.unseen));
}

/** The dot colour for an agent state, or null when there is no live session. */
export function statusColor(state: AgentState | undefined): string | null {
  if (!state || state.status === "offline") return null;
  if (state.status === "working") return STATUS_COLORS.working;
  return needsYou(state) ? STATUS_COLORS.needsYou : STATUS_COLORS.idle;
}

export interface DotPresentation {
  className: string;
  backgroundColor: string | undefined;
  title: string | undefined;
}

/**
 * A terminal dot's colour and title, shared by the sidebar row and the tab. Precedence: an exit
 * (red with a title when it failed, grey when clean) beats a live agent state (status colour, a
 * ring when it needs you, "<status> · <lastEvent>") beats the machine's colour beats the emerald
 * default.
 */
export function dotPresentation(exitCode: number | null, agent: AgentState | undefined, machineColor: string | null): DotPresentation {
  if (exitCode !== null) {
    if (exitCode === 0) return { className: "bg-neutral-600", backgroundColor: undefined, title: undefined };
    return { className: "", backgroundColor: STATUS_COLORS.error, title: exitCode < 0 ? "ended unexpectedly" : `exited with code ${exitCode}` };
  }
  const color = statusColor(agent);
  if (color && agent) {
    return { className: needsYou(agent) ? "ring-2 ring-amber-300/60" : "", backgroundColor: color, title: `${agent.status} · ${agent.lastEvent}` };
  }
  if (machineColor) return { className: "", backgroundColor: machineColor, title: undefined };
  return { className: "bg-emerald-500", backgroundColor: undefined, title: undefined };
}

// Tailwind class inventory (scanned, never executed):
// bg-neutral-600 bg-emerald-500 ring-2 ring-amber-300/60
