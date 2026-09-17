import { describe, expect, it } from "vitest";
import { pairUri, qrSvg } from "./pairing";

const FP_ED = "SHA256:r1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD/hh6U";
const FP_RSA = "SHA256:7CQ/ldJqhjJfG5HDFdkweMu4jkmliY+CecbtNbpO8J0";

describe("pairUri", () => {
  it("carries the name, the user and one fp per host key", () => {
    expect(pairUri({ host: "mini", user: "me", fingerprints: [FP_ED, FP_RSA] })).toBe(
      "swarmz://pair?host=mini&user=me" +
        "&fp=SHA256%3Ar1nwggW9AHsthrbnxzGUx9I3q9Wcckmfv27XgD%2Fhh6U" +
        "&fp=SHA256%3A7CQ%2FldJqhjJfG5HDFdkweMu4jkmliY%2BCecbtNbpO8J0" +
        "&v=1",
    );
  });

  it("percent-encodes every value, so nothing can add a parameter of its own", () => {
    const uri = pairUri({ host: "mini.tail-net.ts.net", user: "a b&fp=evil", fingerprints: ["a+b/c=", "x y"] });
    expect(uri).toBe("swarmz://pair?host=mini.tail-net.ts.net&user=a%20b%26fp%3Devil&fp=a%2Bb%2Fc%3D&fp=x%20y&v=1");
    // The parameters are exactly host, user, two fps and v: nothing smuggled in.
    const params = new URL(uri).searchParams;
    expect([...params.keys()]).toEqual(["host", "user", "fp", "fp", "v"]);
    expect(params.get("user")).toBe("a b&fp=evil");
    expect(params.getAll("fp")).toEqual(["a+b/c=", "x y"]);
  });

  it("still names the Mac when it offers no host key", () => {
    expect(pairUri({ host: "mini", user: "me", fingerprints: [] })).toBe("swarmz://pair?host=mini&user=me&v=1");
  });
});

describe("qrSvg", () => {
  it("draws a square, scalable code whose size grows with the payload", () => {
    const small = qrSvg("swarmz://pair?host=a&user=b&v=1");
    expect(small.startsWith("<svg")).toBe(true);
    expect(small).toContain('preserveAspectRatio="xMinYMin meet"');
    // Scalable: no pixel size on the <svg>, so the dialog's box decides how big it is drawn.
    expect(/^<svg[^>]*width="\d+px"/.test(small)).toBe(false);
    const box = (svg: string) => {
      const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      if (!m) throw new Error(`no viewBox in ${svg.slice(0, 80)}`);
      return [Number(m[1]), Number(m[2])];
    };
    const [w, h] = box(small);
    expect(w).toBe(h);
    const big = qrSvg(pairUri({ host: "mini", user: "me", fingerprints: [FP_ED, FP_RSA] }));
    expect(box(big)[0]).toBeGreaterThan(w);
  });
});
