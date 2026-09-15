import { describe, expect, it } from "vitest";
import { applyAgentEvent, BLOCKING_NOTIFICATIONS, OFFLINE, statusClasses, type AgentEvent, type AgentState } from "./agentState";

const ev = (event: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  ts: "2026-09-15T10:00:00Z", terminal: "t", event, sessionId: "s1", notificationType: null, source: null, ...extra,
});

describe("applyAgentEvent", () => {
  it("SessionStart makes an idle state with the session id, never unseen", () => {
    const s = applyAgentEvent(undefined, ev("SessionStart", { source: "startup" }), false)!;
    expect(s).toEqual<AgentState>({ status: "idle", sessionId: "s1", since: "2026-09-15T10:00:00Z", lastEvent: "SessionStart", unseen: false });
  });
  it("UserPromptSubmit sets working and clears unseen", () => {
    const idle: AgentState = { ...OFFLINE, status: "idle", unseen: true, sessionId: "s1" };
    const s = applyAgentEvent(idle, ev("UserPromptSubmit"), false)!;
    expect(s.status).toBe("working");
    expect(s.unseen).toBe(false);
  });
  it("Stop after working is idle and unseen when not focused", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    expect(applyAgentEvent(working, ev("Stop"), false)!.unseen).toBe(true);
    expect(applyAgentEvent(working, ev("Stop"), true)!.unseen).toBe(false);
    expect(applyAgentEvent(working, ev("StopFailure"), false)!.status).toBe("idle");
  });
  it("Stop after idle is not a new unseen", () => {
    const idle: AgentState = { ...OFFLINE, status: "idle", sessionId: "s1" };
    expect(applyAgentEvent(idle, ev("Stop"), false)!.unseen).toBe(false);
  });
  it("blocking notifications set blocked and unseen when not focused", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    for (const type of BLOCKING_NOTIFICATIONS) {
      const s = applyAgentEvent(working, ev("Notification", { notificationType: type }), false)!;
      expect(s.status).toBe("blocked");
      expect(s.unseen).toBe(true);
    }
    expect(applyAgentEvent(working, ev("Notification", { notificationType: "permission_prompt" }), true)!.unseen).toBe(false);
  });
  it("other notifications are ignored", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    expect(applyAgentEvent(working, ev("Notification", { notificationType: "auth_success" }), false)).toBeNull();
    expect(applyAgentEvent(working, ev("Notification", { notificationType: null }), false)).toBeNull();
  });
  it("SessionEnd is offline with no session", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    const s = applyAgentEvent(working, ev("SessionEnd"), false)!;
    expect(s.status).toBe("offline");
    expect(s.sessionId).toBeNull();
    expect(s.unseen).toBe(false);
  });
  it("unknown events are ignored", () => {
    expect(applyAgentEvent(undefined, ev("PreToolUse"), false)).toBeNull();
  });
  it("records since and lastEvent from the event", () => {
    const s = applyAgentEvent(undefined, ev("UserPromptSubmit", { ts: "2026-09-15T11:00:00Z" }), true)!;
    expect(s.since).toBe("2026-09-15T11:00:00Z");
    expect(s.lastEvent).toBe("UserPromptSubmit");
  });
});

describe("statusClasses", () => {
  it("maps each status to a colour and adds a ring when unseen", () => {
    expect(statusClasses(undefined)).toBe("bg-neutral-500");
    expect(statusClasses({ ...OFFLINE, status: "working" })).toBe("bg-amber-400");
    expect(statusClasses({ ...OFFLINE, status: "idle" })).toBe("bg-green-500");
    expect(statusClasses({ ...OFFLINE, status: "blocked" })).toBe("bg-red-500");
    expect(statusClasses({ ...OFFLINE, status: "blocked", unseen: true })).toBe("bg-red-500 ring-2 ring-red-500/50");
    expect(statusClasses({ ...OFFLINE, status: "idle", unseen: true })).toBe("bg-green-500 ring-2 ring-green-500/50");
  });
});
