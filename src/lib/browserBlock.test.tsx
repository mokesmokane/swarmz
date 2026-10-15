// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useBlocksBrowsers, useBrowserBlock } from "./browserBlock";

function Blocker({ on }: { on: boolean }) {
  useBlocksBrowsers(on);
  return null;
}

describe("useBlocksBrowsers", () => {
  it("counts open blockers and lets go on close and unmount", () => {
    const a = render(<Blocker on />);
    const b = render(<Blocker on={false} />);
    expect(useBrowserBlock.getState().count).toBe(1);
    b.rerender(<Blocker on />);
    expect(useBrowserBlock.getState().count).toBe(2);
    b.rerender(<Blocker on={false} />);
    a.unmount();
    expect(useBrowserBlock.getState().count).toBe(0);
  });
});
