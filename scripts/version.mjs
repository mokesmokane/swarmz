#!/usr/bin/env node
// One place decides the release version.
//
//   npm run version -- 0.2.0
//
// sets it in package.json (and package-lock.json's two copies), src-tauri/tauri.conf.json,
// src-tauri/Cargo.toml (and its Cargo.lock entry, so no cargo command dirties the tree) and
// android/app/build.gradle.kts (name and code). src-tauri/tool/Cargo.toml is deliberately left
// alone: the tool's version is compared against remote installs and is not the app's.
// Called with no argument it takes the version already in package.json, so it also works as
// npm's `version` lifecycle hook (`npm version 0.2.0` bumps package.json, then runs this).
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

export function setJsonVersion(text, version, { count = 1 } = {}) {
  let seen = 0;
  const out = text.replace(new RegExp(JSON_VERSION.source, "gm"), (whole, head, _old, tail) =>
    seen++ < count ? `${head}${version}${tail}` : whole,
  );
  // package-lock.json carries the version twice, at the root and under `packages[""]`, and they
  // are its first two; anything short of that means the file is not what we think it is.
  if (seen < count) throw new Error(`expected ${count} version field(s) to set, found ${seen}`);
  return out;
}

/** The `[package]` version of a Cargo manifest, without touching any dependency's. */
const CARGO_VERSION = /(\[package\][^[]*?\nversion = ")([^"]*)(")/;

export function setCargoVersion(text, version) {
  if (!CARGO_VERSION.test(text)) throw new Error("no [package] version to set");
  return text.replace(CARGO_VERSION, `$1${version}$3`);
}

/** The `swarmz` entry of Cargo.lock. The closing quote keeps it off `swarmz-tool`. */
const CARGO_LOCK_VERSION = /(\nname = "swarmz"\nversion = ")([^"]*)(")/;

export function setCargoLockVersion(text, version) {
  if (!CARGO_LOCK_VERSION.test(text)) throw new Error('no swarmz entry in the lockfile');
  return text.replace(CARGO_LOCK_VERSION, `$1${version}$3`);
}

export function setGradleVersion(text, version, code) {
  const codeRe = /^(\s*versionCode\s*=\s*)\d+$/m;
  const nameRe = /^(\s*versionName\s*=\s*")[^"]*(")/m;
  if (!codeRe.test(text)) throw new Error("no versionCode to set");
  if (!nameRe.test(text)) throw new Error("no versionName to set");
  return text.replace(codeRe, `$1${code}`).replace(nameRe, `$1${version}$2`);
}

/** The version each file currently declares, for the drift check in the tests and in CI. */
export function currentVersions({ pkg, lock, tauri, cargo, cargoLock, gradle }) {
  const json = (text, what) => {
    const m = /^\s*"version"\s*:\s*"(\d[^"]*)"/m.exec(text);
    if (!m) throw new Error(`${what}: no version field`);
    return m[1];
  };
  const name = /^\s*versionName\s*=\s*"([^"]*)"/m.exec(gradle);
  const code = /^\s*versionCode\s*=\s*(\d+)$/m.exec(gradle);
  if (!name || !code) throw new Error("android: no versionName/versionCode");
  const cargoV = CARGO_VERSION.exec(cargo);
  const lockV = CARGO_LOCK_VERSION.exec(cargoLock);
  if (!cargoV) throw new Error("src-tauri/Cargo.toml: no [package] version");
  if (!lockV) throw new Error("src-tauri/Cargo.lock: no swarmz entry");
  return {
    pkg: json(pkg, "package.json"),
    lock: json(lock, "package-lock.json"),
    tauri: json(tauri, "tauri.conf.json"),
    cargo: cargoV[2],
    cargoLock: lockV[2],
    androidName: name[1],
    androidCode: Number(code[1]),
  };
}

const TARGETS = [
  ["package.json", setJsonVersion],
  ["package-lock.json", (text, v) => setJsonVersion(text, v, { count: 2 })],
  ["src-tauri/tauri.conf.json", setJsonVersion],
  ["src-tauri/Cargo.toml", setCargoVersion],
  ["src-tauri/Cargo.lock", setCargoLockVersion],
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
