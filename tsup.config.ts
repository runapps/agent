import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import type { Plugin } from "esbuild";

const version = JSON.parse(readFileSync("./package.json", "utf8")).version as string;

// The UI and Node entries reach the core through "./index.js". In their
// CommonJS builds that import stays an import — of the core's own file —
// so require("@runappsai/agent") and require("@runappsai/agent/ui") share
// one core (one Agent class, one Workspace) instead of each bundling a copy.
const coreExternal: Plugin = {
  name: "core-external",
  setup(build) {
    build.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: "./index.cjs", external: true }));
  },
};

// ESM is tsc's per-file output (dist/*.js). Here: CJS for require(), and
// IIFE scripts for <script> tags, exposed as `RunAppsAgent`.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    clean: false,
    target: "es2020",
    platform: "neutral",
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    entry: { ui: "src/ui.ts" },
    format: ["cjs"],
    clean: false,
    target: "es2020",
    platform: "browser",
    esbuildPlugins: [coreExternal],
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    entry: { node: "src/node.ts" },
    format: ["cjs"],
    clean: false,
    target: "es2022",
    platform: "node",
    esbuildPlugins: [coreExternal],
    outExtension: () => ({ js: ".cjs" }),
  },
  // The core and the chat UI in one script; and the core alone.
  ...[
    { name: "agent", entry: "src/browser.ts" },
    { name: "agent-core", entry: "src/index.ts" },
  ].map(({ name, entry }) => ({
    entry: { [name]: entry },
    format: ["iife" as const],
    globalName: "RunAppsAgent",
    banner: { js: `/* @runappsai/agent ${version}${name === "agent-core" ? " (core)" : ""} */` },
    minify: true,
    clean: false,
    target: "es2020",
    platform: "browser" as const,
    outExtension: () => ({ js: ".umd.js" }),
  })),
]);
