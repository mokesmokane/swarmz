#!/usr/bin/env node
// One place decides the release version.
//
//   npm run version -- 0.2.0
//
// sets it in package.json, src-tauri/tauri.conf.json and android/app/build.gradle.kts (name and
// code). Called with no argument it takes the version already in package.json, so it also works
// as npm's `version` lifecycle hook (`npm version 0.2.0` bumps package.json, then runs this).
//
// The files are edited as text, one line each, so formatting, comments and key order survive.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

/** Parses `0.2.0` (or `v0.2.0`) into its parts, rejecting anything the release cannot carry. */
export function parseVersion(input) {
  const raw = String(input ?? "").trim();
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(raw);
  if (!m) throw new Error(`not a plain MAJOR.MINOR.PATCH version: "${raw}"`);
  const [major, minor, patch] = m.slice(1).map(Number);
  // The Android versionCode packs the three parts into one integer; it only stays ordered (and
  // Play only ever accepts an increase) while minor and patch fit in their two digits.
  if (minor > 99 || patch > 99) throw new Error(`minor and patch must stay under 100: "${raw}"`);
  return { major, minor, patch };
}

export function androidVersionCode({ major, minor, patch }) {
  return major * 10000 + minor * 100 + patch;
}

export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Replaces the first `"version": "<number…>"` of a JSON document, leaving every other byte alone.
 * The value must start with a digit so package.json's own `"version": "node scripts/version.mjs"`
 * script entry can never be mistaken for it.
 */
const JSON_VERSION = /^(\s*"version"\s*:\s*")(\d[^"]*)(")/m;

export function setJsonVersion(text, version) {
  if (!JSON_VERSION.test(text)) throw new Error("no top-level version field to set");
  return text.replace(JSON_VERSION, `$1${version}$3`);
}

export function setGradleVersion(text, version, code) {
  const codeRe = /^(\s*versionCode\s*=\s*)\d+$/m;
  const nameRe = /^(\s*versionName\s*=\s*")[^"]*(")/m;
  if (!codeRe.test(text)) throw new Error("no versionCode to set");
  if (!nameRe.test(text)) throw new Error("no versionName to set");
  return text.replace(codeRe, `$1${code}`).replace(nameRe, `$1${version}$2`);
}

/** The version each file currently declares, for the drift check in the tests and in CI. */
export function currentVersions({ pkg, tauri, gradle }) {
  const json = (text, what) => {
    const m = /^\s*"version"\s*:\s*"(\d[^"]*)"/m.exec(text);
    if (!m) throw new Error(`${what}: no version field`);
    return m[1];
  };
  const name = /^\s*versionName\s*=\s*"([^"]*)"/m.exec(gradle);
  const code = /^\s*versionCode\s*=\s*(\d+)$/m.exec(gradle);
  if (!name || !code) throw new Error("android: no versionName/versionCode");
  return { pkg: json(pkg, "package.json"), tauri: json(tauri, "tauri.conf.json"), androidName: name[1], androidCode: Number(code[1]) };
}

const TARGETS = [
  ["package.json", setJsonVersion],
  ["src-tauri/tauri.conf.json", setJsonVersion],
];

function main(argv) {
  const root = new URL("../", import.meta.url);
  const pkgPath = new URL("package.json", root);
  const asked = argv.find((a) => !a.startsWith("-"));
  const parsed = parseVersion(asked ?? JSON.parse(readFileSync(pkgPath, "utf8")).version);
  const version = formatVersion(parsed);
  const code = androidVersionCode(parsed);

  for (const [rel, apply] of TARGETS) {
    const path = new URL(rel, root);
    writeFileSync(path, apply(readFileSync(path, "utf8"), version));
    console.log(`${rel}: ${version}`);
  }
  const gradlePath = new URL("android/app/build.gradle.kts", root);
  writeFileSync(gradlePath, setGradleVersion(readFileSync(gradlePath, "utf8"), version, code));
  console.log(`android/app/build.gradle.kts: ${version} (versionCode ${code})`);
  console.log(`\nNext: commit, then \`git tag v${version} && git push origin v${version}\` (see docs/RELEASING.md).`);
}

// Only when run as the script, so the tests can import the pure helpers.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`version: ${e.message}`);
    process.exit(1);
  }
}
