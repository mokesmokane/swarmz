import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  androidVersionCode,
  currentVersions,
  parseVersion,
  setCargoLockVersion,
  setCargoVersion,
  setGradleVersion,
  setJsonVersion,
} from "./version.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("parseVersion", () => {
  it("accepts a plain three-part version", () => {
    expect(parseVersion("0.2.0")).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(parseVersion("12.34.56")).toEqual({ major: 12, minor: 34, patch: 56 });
  });

  it("accepts a leading v", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("rejects anything else", () => {
    for (const bad of ["", "1.2", "1.2.3.4", "1.2.3-beta.1", "1.2.x", "01.2.3", " 1.2.3 ".trim() + "!"]) {
      expect(() => parseVersion(bad), bad).toThrow();
    }
  });

  it("rejects a minor or patch that would break the versionCode", () => {
    // major * 10000 + minor * 100 + patch only stays ordered while minor and patch stay under 100.
    expect(() => parseVersion("1.100.0")).toThrow(/under 100/);
    expect(() => parseVersion("1.0.100")).toThrow(/under 100/);
  });
});

describe("androidVersionCode", () => {
  it("is major * 10000 + minor * 100 + patch", () => {
    expect(androidVersionCode(parseVersion("0.1.0"))).toBe(100);
    expect(androidVersionCode(parseVersion("0.2.0"))).toBe(200);
    expect(androidVersionCode(parseVersion("1.0.0"))).toBe(10000);
    expect(androidVersionCode(parseVersion("2.13.7"))).toBe(21307);
  });

  it("increases with the version", () => {
    const codes = ["0.1.0", "0.1.9", "0.2.0", "0.10.0", "1.0.0"].map((v) => androidVersionCode(parseVersion(v)));
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("setJsonVersion", () => {
  it("replaces only the top-level version and keeps the rest byte for byte", () => {
    const before = '{\n  "name": "swarmz",\n  "private": true,\n  "version": "0.1.0",\n  "type": "module"\n}\n';
    const after = setJsonVersion(before, "0.2.0");
    expect(after).toBe('{\n  "name": "swarmz",\n  "private": true,\n  "version": "0.2.0",\n  "type": "module"\n}\n');
  });

  it("does not touch a nested version", () => {
    const before = '{\n  "version": "0.1.0",\n  "dependencies": {\n    "x": "0.1.0"\n  }\n}\n';
    expect(setJsonVersion(before, "9.9.9")).toContain('"x": "0.1.0"');
  });

  it("sets every occurrence when asked, for package-lock.json's two copies", () => {
    const before = '{\n  "name": "swarmz",\n  "version": "0.1.0",\n  "packages": {\n    "": {\n      "name": "swarmz",\n      "version": "0.1.0",\n      "dependencies": {}\n    },\n    "node_modules/x": {\n      "version": "0.1.0"\n    }\n  }\n}\n';
    const after = setJsonVersion(before, "0.2.0", { count: 2 });
    expect(after.match(/"version": "0\.2\.0"/g)).toHaveLength(2);
    expect(after).toContain('"node_modules/x": {\n      "version": "0.1.0"\n    }');
  });

  it("refuses when there are not as many versions as asked for", () => {
    expect(() => setJsonVersion('{\n  "version": "0.1.0"\n}\n', "0.2.0", { count: 2 })).toThrow(/2/);
  });

  it("refuses a file with no version", () => {
    expect(() => setJsonVersion('{\n  "name": "x"\n}\n', "0.2.0")).toThrow(/version/);
  });
});

describe("setGradleVersion", () => {
  it("sets versionCode and versionName", () => {
    const before = "    defaultConfig {\n        versionCode = 100\n        versionName = \"0.1.0\"\n    }\n";
    expect(setGradleVersion(before, "0.2.0", 200)).toBe(
      "    defaultConfig {\n        versionCode = 200\n        versionName = \"0.2.0\"\n    }\n",
    );
  });

  it("refuses a file without both", () => {
    expect(() => setGradleVersion("versionCode = 1\n", "0.2.0", 200)).toThrow(/versionName/);
    expect(() => setGradleVersion('versionName = "0.1.0"\n', "0.2.0", 200)).toThrow(/versionCode/);
  });
});

describe("setCargoVersion", () => {
  it("sets the [package] version and nothing else", () => {
    const before = '[package]\nname = "swarmz"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nlibc = "0.2"\n';
    expect(setCargoVersion(before, "0.2.0")).toBe(
      '[package]\nname = "swarmz"\nversion = "0.2.0"\nedition = "2021"\n\n[dependencies]\nlibc = "0.2"\n',
    );
  });

  it("refuses a manifest with no version", () => {
    expect(() => setCargoVersion('[package]\nname = "swarmz"\n', "0.2.0")).toThrow(/version/);
  });
});

describe("setCargoLockVersion", () => {
  it("sets only the swarmz entry, never swarmz-tool or anything else", () => {
    const before = [
      "[[package]]",
      'name = "swarmz"',
      'version = "0.1.0"',
      "dependencies = [",
      "]",
      "",
      "[[package]]",
      'name = "swarmz-tool"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "serde"',
      'version = "0.1.0"',
      "",
    ].join("\n");
    const after = setCargoLockVersion(before, "0.2.0");
    expect(after).toContain('name = "swarmz"\nversion = "0.2.0"');
    expect(after).toContain('name = "swarmz-tool"\nversion = "0.1.0"');
    expect(after).toContain('name = "serde"\nversion = "0.1.0"');
  });

  it("refuses a lockfile with no swarmz entry", () => {
    expect(() => setCargoLockVersion('[[package]]\nname = "serde"\nversion = "1.0.0"\n', "0.2.0")).toThrow(/swarmz/);
  });
});

describe("the repo's versions", () => {
  it("agree across package.json, tauri.conf.json and the Android build", () => {
    const v = currentVersions({
      pkg: read("package.json"),
      lock: read("package-lock.json"),
      tauri: read("src-tauri/tauri.conf.json"),
      cargo: read("src-tauri/Cargo.toml"),
      cargoLock: read("src-tauri/Cargo.lock"),
      gradle: read("android/app/build.gradle.kts"),
    });
    expect(v.tauri).toBe(v.pkg);
    expect(v.lock).toBe(v.pkg);
    expect(v.cargo).toBe(v.pkg);
    expect(v.cargoLock).toBe(v.pkg);
    expect(v.androidName).toBe(v.pkg);
    expect(v.androidCode).toBe(androidVersionCode(parseVersion(v.pkg)));
  });
});
