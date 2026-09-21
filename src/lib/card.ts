import type { AgentState } from "./agentState";

/** A tile's conversation card (conversation cards spec §2), as stored on its workspace entry. */
export interface Card {
  title?: string | null;
  recap?: string | null;
  updatedAt: string;
  by: "agent" | "user";
}

export const TITLE_MAX = 60;

/** One line, whitespace collapsed, control characters dropped, cut at `TITLE_MAX`; null when empty. */
export function cleanTitle(s: string): string | null {
  const joined = s
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!joined) return null;
  return Array.from(joined).slice(0, TITLE_MAX).join("").trimEnd();
}

/** Reads a card off a workspace entry's fields; anything but an object is no card. */
export function cardOf(v: unknown): Card | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  return { title: str("title"), recap: str("recap"), updatedAt: str("updatedAt") ?? "", by: o.by === "user" ? "user" : "agent" };
}

/**
 * The card after the user typed a title (spec §5): the title is theirs; an empty one removes it
 * and hands the title back to the agent or the fallback, keeping the recap. Mirrors
 * `card::with_user_title` in the tool.
 */
export function withUserTitle(existing: Card | null, title: string, now: string): Card | null {
  const cleaned = cleanTitle(title);
  const recap = existing?.recap ?? null;
  if (cleaned === null && !recap) return null;
  return { ...(cleaned !== null ? { title: cleaned } : {}), ...(recap ? { recap } : {}), updatedAt: now, by: cleaned !== null ? "user" : "agent" };
}

/** What a row or tab shows: the card's title, else the session's first prompt, else the name. */
export function displayTitle(card: Card | null | undefined, agent: AgentState | undefined, name: string): string {
  return card?.title || agent?.title || name;
}

/** Whether the row shows something other than the plain name, so the name moves to the second line. */
export function hasTitle(card: Card | null | undefined, agent: AgentState | undefined): boolean {
  return !!(card?.title || agent?.title);
}
