import { describe, expect, it } from "vitest";
import { checkSignature, shouldSign, signArgs, TOOL_BINARY } from "./build-tool.mjs";

// Real `codesign -dv --verbose=4` output, captured on macOS rather than invented, trimmed of the
// hash lines that say nothing about the three things notarisation rejected us for.

/** A Developer ID signature with the hardened runtime and a secure timestamp: what Apple wants. */
const DEVELOPER_ID = `Executable=/opt/homebrew/bin/android
Identifier=android
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=28499 flags=0x10000(runtime) hashes=885+2 location=embedded
Signature size=8990
Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=15 Jul 2026 at 08:39:06
Info.plist=not bound
TeamIdentifier=EQHXZ8M8AV
Runtime Version=15.5.0`;

/** `codesign -s -`: no certificate, no timestamp, no runtime. What the tool shipped as. */
const AD_HOC = `Executable=/private/tmp/cstest/adhoc
Identifier=adhoc-555549449ed687f1a04f342c93b84a96e5fff097
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=263 flags=0x2(adhoc) hashes=2+2 location=embedded
Signature=adhoc
Info.plist=not bound`;

/** `codesign -s - --options runtime`: the runtime flag alone is not enough. */
const AD_HOC_RUNTIME = `Executable=/private/tmp/cstest/adhocrt
Identifier=adhocrt-1f0e3dad99908345f7439f8ffabdffc4
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=273 flags=0x10002(adhoc,runtime) hashes=2+2 location=embedded
Signature=adhoc
Info.plist=not bound`;

const UNSIGNED = "unsigned: code object is not signed at all";

describe("shouldSign", () => {
  it("signs when an identity is set", () => {
    expect(shouldSign({ APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (ABCDE12345)" })).toBe(true);
  });

  it("does nothing without one, so a local build is unchanged", () => {
    expect(shouldSign({})).toBe(false);
    expect(shouldSign({ APPLE_SIGNING_IDENTITY: "" })).toBe(false);
    expect(shouldSign({ APPLE_SIGNING_IDENTITY: "   " })).toBe(false);
  });
});

describe("signArgs", () => {
  it("asks for the hardened runtime and a secure timestamp", () => {
    expect(signArgs({ identity: "Developer ID Application: Me (X)", binary: TOOL_BINARY })).toEqual([
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      "Developer ID Application: Me (X)",
      TOOL_BINARY,
    ]);
  });

  it("names the keychain when it is given one", () => {
    const args = signArgs({ identity: "Me", keychain: "/tmp/build.keychain-db", binary: "bin" });
    expect(args).toContain("--keychain");
    expect(args[args.indexOf("--keychain") + 1]).toBe("/tmp/build.keychain-db");
    expect(args[args.length - 1]).toBe("bin");
  });

  it("leaves the keychain out otherwise, so the default search list is used", () => {
    expect(signArgs({ identity: "Me", binary: "bin" })).not.toContain("--keychain");
  });
});

describe("checkSignature", () => {
  it("accepts a Developer ID signature with a timestamp and the hardened runtime", () => {
    expect(checkSignature(DEVELOPER_ID)).toEqual({
      authority: "Developer ID Application: Google LLC (EQHXZ8M8AV)",
      timestamp: "15 Jul 2026 at 08:39:06",
    });
  });

  it("rejects an ad-hoc signature, naming all three things Apple would", () => {
    expect(() => checkSignature(AD_HOC)).toThrow(/Developer ID/);
    expect(() => checkSignature(AD_HOC)).toThrow(/secure timestamp/);
    expect(() => checkSignature(AD_HOC)).toThrow(/hardened runtime/);
  });

  it("rejects an ad-hoc signature that has only the runtime flag", () => {
    expect(() => checkSignature(AD_HOC_RUNTIME)).toThrow(/Developer ID/);
    expect(() => checkSignature(AD_HOC_RUNTIME)).toThrow(/secure timestamp/);
    expect(() => checkSignature(AD_HOC_RUNTIME)).not.toThrow(/hardened runtime/);
  });

  it("rejects an unsigned binary", () => {
    expect(() => checkSignature(UNSIGNED)).toThrow(/Developer ID/);
  });

  it("rejects a Developer ID signature without the hardened runtime", () => {
    const noRuntime = DEVELOPER_ID.replace("flags=0x10000(runtime)", "flags=0x0(none)");
    expect(() => checkSignature(noRuntime)).toThrow(/hardened runtime/);
  });

  it("rejects a signature whose time is not a secure timestamp", () => {
    // Without --timestamp codesign records the local clock as `Signed Time`, which Apple does
    // not accept; only `Timestamp=` comes from Apple's timestamp server.
    const signedTime = DEVELOPER_ID.replace(/^Timestamp=.*$/m, "Signed Time=15 Jul 2026 at 08:39:06");
    expect(() => checkSignature(signedTime)).toThrow(/secure timestamp/);
  });

  it("rejects an authority that is not a Developer ID Application certificate", () => {
    const dev = DEVELOPER_ID.replace("Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)", "Authority=Apple Development: Someone (ABCDE12345)");
    expect(() => checkSignature(dev)).toThrow(/Developer ID/);
  });

  it("names the binary in the message", () => {
    expect(() => checkSignature(AD_HOC, { binary: "target/release/swarmz-tool" })).toThrow(/target\/release\/swarmz-tool/);
  });
});
