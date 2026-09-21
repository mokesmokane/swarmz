// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAgentEvent, BLOCKING_NOTIFICATIONS, dotPresentation, needsYou, OFFLINE, statusColor, STATUS_COLORS, type AgentEvent, type AgentState } from "./agentState";

const ev = (event: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  ts: "2026-09-15T10:00:00Z", terminal: "t", event, sessionId: "s1", notificationType: null, source: null, cwd: null, permissionMode: null, ...extra,
});

describe("applyAgentEvent", () => {
  it("SessionStart makes an idle state with the session id, never unseen", () => {
    const s = applyAgentEvent(undefined, ev("SessionStart", { source: "startup" }), false)!;
    expect(s).toEqual<AgentState>({ status: "idle", sessionId: "s1", since: "2026-09-15T10:00:00Z", lastEvent: "SessionStart", unseen: false, title: null, firstPrompt: null });
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

describe("statusColor", () => {
  it("maps states to the phone's colours", () => {
    expect(statusColor(undefined)).toBeNull();
    expect(statusColor({ ...OFFLINE })).toBeNull();
    expect(statusColor({ ...OFFLINE, status: "working" })).toBe("#25BF35");
    expect(statusColor({ ...OFFLINE, status: "blocked" })).toBe("#FFB21B");
    expect(statusColor({ ...OFFLINE, status: "idle", unseen: true })).toBe("#FFB21B");
    expect(statusColor({ ...OFFLINE, status: "idle" })).toBe("#475569");
    expect(needsYou({ ...OFFLINE, status: "idle", unseen: true })).toBe(true);
    expect(needsYou({ ...OFFLINE, status: "working", unseen: true })).toBe(false);
  });
});

describe("dotPresentation", () => {
  it("a clean exit is grey whatever the agent said", () => {
    const blocked: AgentState = { ...OFFLINE, status: "blocked", unseen: true };
    expect(dotPresentation(0, blocked, "#f59e0b")).toEqual({ className: "bg-neutral-600", backgroundColor: undefined, title: undefined });
  });

  it("an exit with an error is red and says so", () => {
    expect(dotPresentation(2, undefined, null)).toEqual({ className: "", backgroundColor: STATUS_COLORS.error, title: "exited with code 2" });
    expect(dotPresentation(-1, undefined, null).title).toBe("ended unexpectedly");
  });

  it("an agent state beats the machine colour, with a ring when it needs you", () => {
    const working: AgentState = { ...OFFLINE, status: "working", lastEvent: "UserPromptSubmit" };
    expect(dotPresentation(null, working, "#f59e0b")).toEqual({ className: "", backgroundColor: "#25BF35", title: "working · UserPromptSubmit" });
    const blocked: AgentState = { ...OFFLINE, status: "blocked", lastEvent: "PermissionRequest" };
    expect(dotPresentation(null, blocked, null)).toEqual({ className: "ring-2 ring-amber-300/60", backgroundColor: "#FFB21B", title: "blocked · PermissionRequest" });
  });

  it("offline or no agent falls through to the machine colour, then the default", () => {
    expect(dotPresentation(null, { ...OFFLINE }, "#f59e0b")).toEqual({ className: "", backgroundColor: "#f59e0b", title: undefined });
    expect(dotPresentation(null, undefined, null)).toEqual({ className: "bg-emerald-500", backgroundColor: undefined, title: undefined });
  });
});

describe("shared status fixture", () => {
  type FixtureEvent = { ts: string; event: string; input: Record<string, unknown> };
  type Case = { name: string; events: FixtureEvent[]; expect: { status: string; sessionId: string | null; title?: string | null } };
  const cases: Case[] = JSON.parse(readFileSync(new URL("../../tests/fixtures/agent-status.json", import.meta.url), "utf8"));
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  for (const c of cases) {
    it(c.name, () => {
      let state: AgentState | undefined;
      for (const e of c.events) {
        const next = applyAgentEvent(
          state,
          {
            ts: e.ts, terminal: "t1", event: e.event,
            sessionId: str(e.input.session_id), notificationType: str(e.input.notification_type),
            source: str(e.input.source), cwd: str(e.input.cwd), permissionMode: str(e.input.permission_mode),
            prompt: str(e.input.prompt),
          },
          true,
        );
        if (next) state = next;
      }
      expect(state?.status ?? "offline").toBe(c.expect.status);
      expect(state?.sessionId ?? null).toBe(c.expect.sessionId);
      expect(state?.title ?? null).toBe(c.expect.title ?? null);
    });
  }
});

describe("permission events", () => {
  it("PermissionRequest blocks and is unseen when not focused", () => {
    const working: AgentState = { ...OFFLINE, status: "working", sessionId: "s1" };
    const s = applyAgentEvent(working, ev("PermissionRequest"), false)!;
    expect(s.status).toBe("blocked");
    expect(s.unseen).toBe(true);
  });
  it("PostToolUse unblocks, and is ignored otherwise", () => {
    const blocked: AgentState = { ...OFFLINE, status: "blocked", unseen: true, sessionId: "s1" };
    const s = applyAgentEvent(blocked, ev("PostToolUse"), false)!;
    expect(s.status).toBe("working");
    expect(s.unseen).toBe(false);
    expect(applyAgentEvent({ ...OFFLINE, status: "working", sessionId: "s1" }, ev("PostToolUse"), false)).toBeNull();
  });
});
