#!/usr/bin/env node
// Builds the session holder / tool binary that `bundle.macOS.files` copies into the app as
// Contents/MacOS/swarmz-tool, and signs it when there is an identity to sign it with.
//
// It has to be signed HERE, before the bundler copies it: every Mach-O inside a notarised app
// needs a Developer ID signature, a secure timestamp and the hardened runtime, and signing the
// inner binary after Tauri has signed the .app would invalidate the outer signature. Apple
// rejected notarisation of v0.2.0 for exactly these three things on this one file.
//
// Without APPLE_SIGNING_IDENTITY it just builds, so a local build is unchanged.
import { spawnSync } from "node:child_process";
import process from "node:process";

export const TOOL_BINARY = "src-tauri/target/release/swarmz-tool";

export function shouldSign(env) {
  return typeof env.APPLE_SIGNING_IDENTITY === "string" && env.APPLE_SIGNING_IDENTITY.trim() !== "";
}

export function signArgs({ identity, keychain, binary }) {
  const args = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
  // Without this, codesign searches the default keychain list. That is enough on the CI runner —
  // the import step puts the temporary keychain on that list, which is how Tauri's own signing
  // finds the same identity — but naming it removes the question.
  if (keychain) args.push("--keychain", keychain);
  args.push(binary);
  return args;
}

/**
 * Reads `codesign -dv --verbose=4` output (which codesign writes to stderr) and throws unless the
 * binary has the three things notarisation checks for. The messages deliberately echo Apple's.
 */
export function checkSignature(text, { binary = "the binary" } = {}) {
  const authority = /^Authority=(.+)$/m.exec(text)?.[1] ?? null;
  const timestamp = /^Timestamp=(.+)$/m.exec(text)?.[1] ?? null;
  // e.g. `CodeDirectory v=20500 size=28499 flags=0x10000(runtime) hashes=885+2 location=embedded`
  const flags = /\bflags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? "";

  const problems = [];
  if (!authority?.startsWith("Developer ID Application:")) {
    problems.push("it is not signed with a valid Developer ID Application certificate");
  }
  // `Signed Time` is the local clock and Apple does not accept it; only `Timestamp` comes from
  // Apple's timestamp server, which is what `--timestamp` asks for.
  if (!timestamp) problems.push("the signature does not include a secure timestamp");
  if (!flags.split(",").includes("runtime")) problems.push("the hardened runtime is not enabled");

  if (problems.length > 0) {
    throw new Error(`${binary} would fail notarisation:\n  - ${problems.join("\n  - ")}\n\n${text.trim()}`);
  }
  return { authority, timestamp };
}

function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} exited with ${r.status ?? "a signal"}`);
  return r;
}

function main(env) {
  run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml", "-p", "swarmz-tool"]);

  if (!shouldSign(env)) {
    console.log("build-tool: no APPLE_SIGNING_IDENTITY, leaving swarmz-tool unsigned");
    return;
  }

  const identity = env.APPLE_SIGNING_IDENTITY.trim();
  const keychain = env.APPLE_SIGNING_KEYCHAIN?.trim() || null;
  run("codesign", signArgs({ identity, keychain, binary: TOOL_BINARY }));

  // -dv writes to stderr; capture both so a future codesign that moves it still reads.
  const shown = spawnSync("codesign", ["-dv", "--verbose=4", TOOL_BINARY], { encoding: "utf8" });
  if (shown.error) throw shown.error;
  const { authority, timestamp } = checkSignature(`${shown.stdout ?? ""}${shown.stderr ?? ""}`, { binary: TOOL_BINARY });
  console.log(`build-tool: signed swarmz-tool with ${authority}, timestamped ${timestamp}, hardened runtime on`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.env);
  } catch (e) {
    console.error(`build-tool: ${e.message}`);
    process.exit(1);
  }
}
