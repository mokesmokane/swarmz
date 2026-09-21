import { describe, expect, it } from "vitest";
import { OFFLINE } from "./agentState";
import { cardOf, cleanTitle, displayTitle, hasTitle, withUserTitle, TITLE_MAX } from "./card";

describe("card", () => {
  it("cleans a title to one collapsed line within the limit", () => {
    expect(cleanTitle("  Phone:\tanswer   questions\nfrom the screen ")).toBe("Phone: answer questions from the screen");
    expect(cleanTitle("\x1b[31m red \x07")).toBe("[31m red");
    expect(cleanTitle("   ")).toBeNull();
    expect(Array.from(cleanTitle("x".repeat(100))!).length).toBe(TITLE_MAX);
  });

  it("reads a card off an entry and rejects junk", () => {
    expect(cardOf(undefined)).toBeNull();
    expect(cardOf("junk")).toBeNull();
    expect(cardOf({ title: "T", recap: "R", updatedAt: "t", by: "user" })).toEqual({ title: "T", recap: "R", updatedAt: "t", by: "user" });
    expect(cardOf({ title: 3, by: "robot" })).toEqual({ title: null, recap: null, updatedAt: "", by: "agent" });
  });

  it("a user title is marked, an empty one hands the title back and keeps the recap", () => {
    const agent = { title: "Theirs", recap: "r", updatedAt: "t0", by: "agent" as const };
    expect(withUserTitle(agent, " Mine ", "t1")).toEqual({ title: "Mine", recap: "r", updatedAt: "t1", by: "user" });
    expect(withUserTitle({ ...agent, by: "user" }, "", "t2")).toEqual({ recap: "r", updatedAt: "t2", by: "agent" });
    expect(withUserTitle(null, "", "t3")).toBeNull();
    expect(withUserTitle(null, "Fresh", "t4")).toEqual({ title: "Fresh", updatedAt: "t4", by: "user" });
  });

  it("shows the card's title, else the first prompt, else the name", () => {
    const prompted = { ...OFFLINE, title: "fix the build", firstPrompt: "fix the build" };
    expect(displayTitle({ title: "Card", updatedAt: "t", by: "agent" }, prompted, "api")).toBe("Card");
    expect(displayTitle({ recap: "r", updatedAt: "t", by: "agent" }, prompted, "api")).toBe("fix the build");
    expect(displayTitle(null, prompted, "api")).toBe("fix the build");
    expect(displayTitle(null, OFFLINE, "api")).toBe("api");
    expect(displayTitle(undefined, undefined, "api")).toBe("api");
    expect(hasTitle(null, OFFLINE)).toBe(false);
    expect(hasTitle(null, prompted)).toBe(true);
  });
});
