import { describe, expect, it } from "vitest";
import { addressFor, defaultBrowserRect, queued } from "./browser";

describe("addressFor", () => {
  it("keeps web addresses and adds a scheme to hosts", () => {
    expect(addressFor("https://appstoreconnect.apple.com")).toEqual({ url: "https://appstoreconnect.apple.com" });
    expect(addressFor("  example.com/a?b=1 ")).toEqual({ url: "https://example.com/a?b=1" });
    expect(addressFor("localhost:1420")).toEqual({ url: "http://localhost:1420" });
    expect(addressFor("192.168.1.4:8080/x")).toEqual({ url: "http://192.168.1.4:8080/x" });
  });
  it("searches anything else and refuses other schemes", () => {
    expect(addressFor("what is swarmz")).toEqual({ url: "https://duckduckgo.com/?q=what%20is%20swarmz" });
    expect(addressFor("swarmz")).toEqual({ url: "https://duckduckgo.com/?q=swarmz" });
    expect(addressFor("file:///etc/passwd")).toHaveProperty("error");
    expect(addressFor("javascript:alert(1)")).toHaveProperty("error");
    expect(addressFor("   ")).toBeNull();
  });
});

describe("defaultBrowserRect", () => {
  it("sits top-right, two thirds wide and 60% tall", () => {
    expect(defaultBrowserRect({ w: 900, h: 600 })).toEqual({ x: 288, y: 12, w: 600, h: 360 });
  });
});

describe("queued", () => {
  it("runs a tile's calls in order, past a failure", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const first = queued("t1", () => new Promise<void>((r) => (release = () => { seen.push("show"); r(); })));
    const second = queued("t1", async () => { seen.push("close"); });
    const failing = queued("t2", async () => { throw new Error("x"); });
    const after = queued("t2", async () => { seen.push("t2 next"); });
    await Promise.all([failing, after]);
    expect(seen).toEqual(["t2 next"]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(["t2 next", "show", "close"]);
  });
});
