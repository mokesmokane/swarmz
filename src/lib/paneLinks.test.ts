import { describe, expect, it } from "vitest";
import { findPaths, findUrls, resolvePath } from "./paneLinks";

describe("findPaths", () => {
  it("finds the shapes Claude prints, without their wrapping", () => {
    const row = "Edited `src/store.ts:2612` and (README.md), see /Users/me/.swarmz/workspace.json.";
    const found = findPaths(row).map((p) => [p.path, p.line, row.slice(p.start, p.end)]);
    expect(found).toEqual([
      ["src/store.ts", 2612, "src/store.ts:2612"],
      ["README.md", null, "README.md"],
      ["/Users/me/.swarmz/workspace.json", null, "/Users/me/.swarmz/workspace.json"],
    ]);
  });

  it("takes home, dot and column suffixes, and keeps a URL out of the paths", () => {
    const row = "at ~/x/y.rs:12:5 or ./a/b.txt or ../up.md, more at https://example.com/path/file.ts:9 ok";
    expect(findPaths(row).map((p) => [p.path, p.line, p.col])).toEqual([
      ["~/x/y.rs", 12, 5],
      ["./a/b.txt", null, null],
      ["../up.md", null, null],
    ]);
    expect(findUrls(row).map((u) => u.url)).toEqual(["https://example.com/path/file.ts:9"]);
  });

  it("does not take versions, counts, decimals, words with dots or the inside of longer words", () => {
    expect(findPaths("v0.4.4 shipped; 31/34 tests; 1.5 s; e.g. this, i.e. that; node.js-ish")).toEqual([]);
    expect(findPaths("email me@host.com").map((p) => p.path)).toEqual([]);
    expect(findPaths("foo.store.ts").map((p) => p.path)).toEqual(["foo.store.ts"]);
  });

  it("takes a long relative path with an unknown extension when it has a slash", () => {
    expect(findPaths("see node_modules/x/y.weird and Cargo.toml").map((p) => p.path)).toEqual(["node_modules/x/y.weird", "Cargo.toml"]);
  });

  it("strips a trailing period, comma or bracket but keeps inner ones", () => {
    expect(findPaths("open src/a.ts.").map((p) => p.path)).toEqual(["src/a.ts"]);
    expect(findPaths("(src/a.ts:3),").map((p) => [p.path, p.line])).toEqual([["src/a.ts", 3]]);
    expect(findPaths("\"docs/x.y.md\"").map((p) => p.path)).toEqual(["docs/x.y.md"]);
  });
});

describe("resolvePath", () => {
  it("leaves absolute and home paths, resolves relative ones against the folder, and folds dots", () => {
    expect(resolvePath("/a/b.txt", "/proj")).toBe("/a/b.txt");
    expect(resolvePath("~/x.txt", "/proj")).toBe("~/x.txt");
    expect(resolvePath("~", "/proj")).toBe("~");
    expect(resolvePath("src/a.ts", "/proj")).toBe("/proj/src/a.ts");
    expect(resolvePath("./src/a.ts", "/proj/")).toBe("/proj/src/a.ts");
    expect(resolvePath("../other/a.ts", "/proj/sub")).toBe("/proj/other/a.ts");
    expect(resolvePath("a.ts", null)).toBe("~/a.ts");
    expect(resolvePath("../a.ts", "~")).toBe("~/a.ts");
    expect(resolvePath("/a/../b/./c", null)).toBe("/b/c");
  });
});
