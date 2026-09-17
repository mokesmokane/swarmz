import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
// One version, from package.json: `npm run version` keeps it, tauri.conf.json and the Android
// build in step. The UI shows it, so a build can never claim a version the release does not have.
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
}));
