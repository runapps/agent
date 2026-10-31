# Node and the command line

The core (`@runappsai/agent`) runs in Node as it is. What a browser gives it for free — IndexedDB to keep things, dialogs to ask the user — `@runappsai/agent/node` provides for Node 18+:

| | |
|---|---|
| `nodeFS(folder, options)` | A folder on disk as the workspace's directory. |
| `nodeStore(folder)` | The workspace's storage on disk: sessions, the user's skills, meta data (and the files, when there is no `dir`). |
| `terminalUI(options)` | Confirmations, choices and questions in the terminal. |
| `lineReader(options)` | One queued reader of the terminal's lines, shared by your prompt loop and `terminalUI`. |
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

Paths cannot leave the folder: `/../x` is refused, and so is a path that goes through a symbolic link pointing outside it (links are not listed either). `nodeFS("/")` makes the whole disk the folder. A file reads as text when it is UTF-8 without control characters, as bytes otherwise.

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

Any storage works the same way: implement `WorkspaceStoreFactory` (`open(dbName, space)` → a `WorkspaceStore`) and pass it as `store` — a database, a cloud bucket. `nodeStore` in `src/node.ts` is a complete example; its optional `stat` and `listStats` let the workspace list and check files without reading their contents. Ids are percent-encoded into names (dots too), so no id can point outside its folder.

## `terminalUI(options)`

```js
terminalUI()                                    // process.stdin / process.stdout (through lineReader)
terminalUI({ input, output })                   // other streams
terminalUI({ ask: reader.ask })                 // the reader your own prompt loop uses
terminalUI({ ask: (prompt, signal) => … })      // any input of yours: write prompt, resolve the line (null: dismissed)
terminalUI({ rl })                              // a readline interface (its question(); lines typed ahead are lost)
```

- `confirm` — `Delete /notes.md? … [y/N]`; only y / yes counts.
- `select` — a numbered list; a number (or several, comma-separated, when multiple answers are allowed), or free text when the question allows it.
- `input` — a line; multi-line answers end with a blank line.
- `notify` — a line with `i`, `!` or `✗`.

A question whose run is stopped is dismissed.

### Reading lines: `lineReader`

readline's own `question()` loses a line that arrives while nobody is asking — typed ahead while the agent works, or piped in. `lineReader()` queues them: each `ask(prompt)` gets the next line, whenever it came, and questions asked at the same time (two tools asking at once) are answered in turn. There is one reader per input stream, so your prompt loop and `terminalUI` take turns on the same queue. The prompt goes through readline, so it stays on screen while the user edits the line. A terminal keeps being read between questions — Ctrl+C reaches the reader's `rl` "SIGINT" event even while the agent runs — without keeping the process alive; a pipe is paused between questions.

```js
import { lineReader, terminalUI } from "@runappsai/agent/node";

const reader = lineReader();                   // process.stdin / stdout
const ui = terminalUI({ ask: reader.ask });    // the agent's questions read from the same queue
reader.rl.on("SIGINT", () => agent.busy ? agent.abort() : process.exit(0));   // Ctrl+C

for (;;) {
  const line = await reader.ask("› ");
  if (line === null) break;                    // the input ended
  await agent.prompt(line);
}
reader.close();
```

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
