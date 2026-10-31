# Node and the command line

The core (`@runappsai/agent`) runs in Node as it is. What a browser gives it for free — IndexedDB to keep things, dialogs to ask the user — `@runappsai/agent/node` provides for Node 18+:

| | |
|---|---|
| `nodeFS(folder, options)` | A folder on disk as the workspace's directory. |
| `nodeStore(folder)` | The workspace's storage on disk: sessions, the user's skills, meta data (and the files, when there is no `dir`). |
| `terminalUI(options)` | Confirmations, choices and questions in the terminal. |
| `nodePdf()` | PDFs read with the `pdfjs-dist` package. |

## A command-line agent

```js
import { createAgent, openAIProvider, openWorkspace } from "@runappsai/agent";
import { nodeFS, nodeStore, terminalUI } from "@runappsai/agent/node";

const provider = openAIProvider({
  baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  models: "fetch",
});

const workspace = await openWorkspace(provider, {
  project: "my-cli",               // names the storage
  id: `dir:${process.cwd()}`,      // one set of sessions per folder
  dir: nodeFS(process.cwd()),      // the agent reads and writes this folder
  store: nodeStore(),              // ~/.runapps-agent/…
});

const agent = createAgent(provider, {
  workspace,
  ui: terminalUI(),
  instructions: "You are a coding assistant in the user's project. Be brief.",
});

agent.on("text_delta", (e) => process.stdout.write(e.delta));
agent.on("tool_start", (e) => process.stdout.write(`\n⚙ ${e.name}`));
agent.on("tool_end", (e) => process.stdout.write(e.status === "ok" ? " ✓" : ` ${e.status}`));

const result = await agent.prompt(process.argv.slice(2).join(" ") || "What is in this folder?");
console.log(`\n${result.reason} · ${agent.usage.calls} calls`);
```

`examples/cli.mjs` is a complete terminal chat built this way: a prompt loop, streaming thinking and text, tool lines, `/new`, `/sessions`, `/resume <id>`, `/compact`, `--resume` to continue the last conversation in a folder, and Ctrl+C to stop the running task.

```sh
OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_API_KEY=sk-… node examples/cli.mjs --dir ./my-project
```

## `nodeFS(folder, options)`

```js
nodeFS("/path/to/project", {
  description: "the user's project",     // what the model is told the folder is
  readonly: false,                       // true: no write or delete
  ignore: [".git", "node_modules"],      // folder names left out of listings and searches (the default)
})
```

Paths cannot leave the folder (`/../x` is refused). A file reads as text when it is UTF-8 without control characters, as bytes otherwise.

## `nodeStore(folder)`

```js
nodeStore()                         // ~/.runapps-agent
nodeStore("./.agent-data")          // somewhere of your own
```

Without a store, a workspace in Node keeps everything in memory, and it is gone when the process ends. With one, the layout is:

```
<folder>/<app>/spaces/<directory id>/files/…        the directory's files (when there is no `dir`)
<folder>/<app>/spaces/<directory id>/meta/*.json    its meta data
<folder>/<app>/spaces/%00skills/files/…             the user's skills (/skills/)
<folder>/<app>/sessions/<directory id>/<session>.json
```

Files are written to a temporary name and renamed, so a crash never leaves half a file. It is meant for one process at a time per folder.

Any storage works the same way: implement `WorkspaceStoreFactory` (`open(dbName, space)` → a `WorkspaceStore`) and pass it as `store` — a database, a cloud bucket. `nodeStore` in `src/node.ts` is a complete example.

## `terminalUI(options)`

```js
terminalUI()                                    // process.stdin / process.stdout
terminalUI({ input, output })                   // other streams
terminalUI({ rl })                              // a readline interface you already have
terminalUI({ ask: (prompt, signal) => … })      // your own input loop: write prompt, resolve the line (null: dismissed)
```

- `confirm` — `Delete /notes.md? … [y/N]`; only y / yes counts.
- `select` — a numbered list; a number (or several, comma-separated, when multiple answers are allowed), or free text when the question allows it.
- `input` — a line; multi-line answers end with a blank line.
- `notify` — a line with `i`, `!` or `✗`.

A question whose run is stopped is dismissed. If your program reads input itself, give `terminalUI` the same reader through `ask` — readline drops lines that arrive while nobody is waiting, so one queue for both (as in `examples/cli.mjs`) keeps typed-ahead or piped input.

## PDFs

The browser loads pdf.js from a CDN; Node cannot. Install it and switch to it once at start-up:

```sh
npm i pdfjs-dist
```

```js
import { nodePdf } from "@runappsai/agent/node";
nodePdf();
```

## The sandbox

`run_js` runs in Node through `worker_threads`, with the same limits as in a browser: no network, a time limit, `fs` bound to the workspace. Remove it with `sandbox: false`.
