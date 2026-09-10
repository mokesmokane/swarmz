import { describe, expect, it } from "vitest";
import { splitShortcut } from "./shortcuts";

function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "\\", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...overrides } as KeyboardEvent;
}

describe("splitShortcut", () => {
  it("maps Cmd+\\ to a right split", () => {
    expect(splitShortcut(key({}))).toBe("right");
  });

  it("maps Cmd+Shift+\\ to a bottom split", () => {
    expect(splitShortcut(key({ shiftKey: true }))).toBe("bottom");
  });

  it("accepts Ctrl as the modifier", () => {
    expect(splitShortcut(key({ metaKey: false, ctrlKey: true }))).toBe("right");
  });

  it("ignores other keys and unmodified backslash", () => {
    expect(splitShortcut(key({ key: "a" }))).toBeNull();
    expect(splitShortcut(key({ metaKey: false }))).toBeNull();
    expect(splitShortcut(key({ altKey: true }))).toBeNull();
  });
});
