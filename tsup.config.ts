import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("./package.json", "utf8")).version as string;

// CJS for require(); IIFE for <script> tags, exposed as `RunAppsAgent`.
// No SDK is bundled or required: model calls go through a ModelProvider.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    sourcemap: false,
    clean: false,
    target: "es2020",
    platform: "neutral",
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    entry: { agent: "src/index.ts" },
    format: ["iife"],
    globalName: "RunAppsAgent",
    banner: { js: `/* @runappsai/agent ${version} */` },
    sourcemap: false,
    minify: true,
    clean: false,
    target: "es2020",
    platform: "browser",
    outExtension: () => ({ js: ".umd.js" }),
  },
]);
