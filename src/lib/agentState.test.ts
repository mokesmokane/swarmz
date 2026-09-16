// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAgentEvent, BLOCKING_NOTIFICATIONS, dotPresentation, OFFLINE, statusClasses, type AgentEvent, type AgentState } from "./agentState";

const ev = (event: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  ts: "2026-09-15T10:00:00Z", terminal: "t", event, sessionId: "s1", notificationType: null, source: null, cwd: null, permissionMode: null, ...extra,
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

describe("dotPresentation", () => {
  it("exited beats everything: grey, no background, no title", () => {
    expect(dotPresentation(true, undefined, "#f59e0b")).toEqual({
      className: "bg-neutral-600",
      backgroundColor: undefined,
      title: undefined,
    });
  });

  it("exited beats an unseen blocked agent", () => {
    const blocked: AgentState = { ...OFFLINE, status: "blocked", unseen: true };
    expect(dotPresentation(true, blocked, "#f59e0b")).toEqual({
      className: "bg-neutral-600",
      backgroundColor: undefined,
      title: undefined,
    });
  });

  it("a non-offline agent state beats the machine colour: status classes, no background, status · lastEvent title", () => {
    const working: AgentState = { ...OFFLINE, status: "working", lastEvent: "UserPromptSubmit" };
    expect(dotPresentation(false, working, "#f59e0b")).toEqual({
      className: statusClasses(working),
      backgroundColor: undefined,
      title: "working · UserPromptSubmit",
    });
  });

  it("an offline agent state is treated as no agent: falls through to machine colour", () => {
    const offline: AgentState = { ...OFFLINE };
    expect(dotPresentation(false, offline, "#f59e0b")).toEqual({
      className: "",
      backgroundColor: "#f59e0b",
      title: undefined,
    });
  });

  it("no agent, with a machine colour: empty class, inline background, no title", () => {
    expect(dotPresentation(false, undefined, "#f59e0b")).toEqual({
      className: "",
      backgroundColor: "#f59e0b",
      title: undefined,
    });
  });

  it("no agent, no machine colour: emerald default, no background, no title", () => {
    expect(dotPresentation(false, undefined, null)).toEqual({
      className: "bg-emerald-500",
      backgroundColor: undefined,
      title: undefined,
    });
  });
});

describe("shared status fixture", () => {
  type FixtureEvent = { ts: string; event: string; input: Record<string, unknown> };
  type Case = { name: string; events: FixtureEvent[]; expect: { status: string; sessionId: string | null } };
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
          },
          true,
        );
        if (next) state = next;
      }
      expect(state?.status ?? "offline").toBe(c.expect.status);
      expect(state?.sessionId ?? null).toBe(c.expect.sessionId);
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
