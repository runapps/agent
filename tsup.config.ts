import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("./package.json", "utf8")).version as string;

// CJS for require(); IIFE for <script> tags — it reads the SDK from the
// global `RunApps` that https://www.runapps.ai/sdk/latest.js defines and
// exposes itself as `RunAppsAgent`.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    sourcemap: true,
    clean: false,
    target: "es2020",
    platform: "neutral",
    external: ["@runappsai/sdk"],
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    entry: { agent: "src/index.ts" },
    format: ["iife"],
    globalName: "RunAppsAgent",
    banner: { js: `/* @runappsai/agent ${version} */` },
    sourcemap: true,
    minify: true,
    clean: false,
    target: "es2020",
    platform: "browser",
    external: ["@runappsai/sdk"],
    esbuildOptions(options) {
      // The SDK is the page's global, not bundled.
      options.alias = { "@runappsai/sdk": "./scripts/sdk-global.js" };
    },
    outExtension: () => ({ js: ".umd.js" }),
  },
]);
