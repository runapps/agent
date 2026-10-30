# @runappsai/agent — agent harness for RunApps apps

The model ↔ tool loop for apps built on [RunApps](https://www.runapps.ai), on top of [`@runappsai/sdk`](https://github.com/runapps/sdk-js): streaming, tool calls checked against JSON Schema, a workspace of files in IndexedDB with skills unpacked from a zip, sessions, pi-style compaction, memory notes, prompt templates, dialogs, and a JavaScript sandbox. Modelled on [pi](https://pi.dev) (MIT; the compaction prompts, edit matching, template arguments and skills wording are copied from it).

**Status: test phase.** The package is separate from the SDK so it can change freely; nothing in the SDK depends on it.

## Install

In a bundle, after the SDK:

```html
<script src="https://www.runapps.ai/sdk/latest.js"></script>
<script src="https://www.runapps.ai/sdk/agent-latest.js"></script>
<script>
  const client = new RunApps({ project: "<slug>" });
  const agent = RunAppsAgent.createAgent(client, { /* … */ });
</script>
```

With a bundler: `npm i @runappsai/sdk @runappsai/agent` and `import { createAgent, openWorkspace, defineTool } from "@runappsai/agent"`.

`createAgent(client)` runs the model ↔ tool loop for you: it streams the reply, re-assembles tool calls, checks their arguments against your schema, asks the user before destructive steps, runs the tools, feeds the results back and repeats until the model answers. Your app provides what is its own — tools, a workspace of files and skills, and (optionally) its dialogs.

```ts
import { createAgent, openWorkspace, defineTool } from "@runappsai/agent";

const addTodo = defineTool({
  name: "add_todo",
  description: "Add an item to the user's todo list.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" }, due: { type: "string", description: "YYYY-MM-DD" } },
    required: ["text"],
    additionalProperties: false,
  },
  execute: async ({ text, due }) => { await db.todos.add({ text, due }); return `Added "${text}".`; },
});

const workspace = await openWorkspace(client, { skills: "/skills.zip" });   // see Skills below
const agent = createAgent(client, {
  model: "Claude Sonnet 4.6",            // the platform default when omitted
  appName: "Todos",
  instructions: "You manage the user's todo list.",
  tools: [addTodo],
  workspace,
});

agent.on("text_delta", (e) => bubble.textContent = e.text);
agent.on("tool_start", (e) => log(`${e.name}…`));
agent.on("tool_end", (e) => log(`${e.name}: ${e.status}`));

const result = await agent.prompt("Add 'ship v2' for next Friday and show me what is due this week");
console.log(result.reason, result.text, result.usage.total_cost);
```

**The loop.** One `prompt()` is a run. Each turn is a model call followed by its tool calls, run one after another (`parallelTools: true` runs them at once), until the model replies without tools, `maxTurns` (default 20) is reached, or the run is stopped. Steer a running agent with `agent.steer(text)` (lands after the current tool batch; the batch itself is never cut short) or queue a message with `agent.followUp(text)`; `agent.abort()` stops it, giving pending tool calls a "skipped" result so the conversation stays valid. A tool that throws returns its message to the model as an error; the model fixes the call or explains. A reply cut by `maxTokens` runs none of its tool calls: each gets pi's "re-issue with complete arguments" result. Repeated identical tool batches are warned about and then stopped.

**Tools.** `defineTool({ name, description, parameters, execute })` — `parameters` is a JSON Schema (close objects with `additionalProperties: false` and list `required`): the model's arguments are checked against it and a mismatch goes back to the model as a readable error. `execute(args, ctx)` returns a string, content parts (an image), any JSON value, or `{ content, details }` (only `content` reaches the model). `ctx` has `signal`, `ui`, `workspace`, `agent` and `update(text)` for progress. Mark a tool `destructive: true`, or give it `confirm: (args) => "Delete 3 files?"`, and the agent asks the user first under `permissions: "ask"` (the default); `"auto"` never asks and a function decides per call. `onToolCall` can block any call. `guidelines` adds a sentence to the system prompt.

**Built-in tools.** `ask_user` lets the model put one to three questions to the user, with options or free text, when a request is ambiguous. `run_js` runs JavaScript the model writes in a Worker — no DOM, no network, a captured console, and `fs` bound to the workspace — so it computes, parses and transforms data instead of guessing, and can run a skill's scripts. Both are on by default (`askUser: false`, `sandbox: false` to remove; `sandbox: { timeoutMs, network }` to configure). With a workspace: `list_files`, `read_file` (2000 lines / 50 KB a call, `offset` and `limit` to continue), `write_file`, `edit_file` (one or more exact replacements per call, matched like pi's: exact first, then tolerant of smart quotes, dashes and trailing spaces), `delete_file` (asks), `search_files`; choose a subset with `fileTools: ["read_file", "list_files"]`.

**Workspace and skills.** `openWorkspace(client, { skills, id })` is a virtual file tree kept in IndexedDB, one per app and `id` (default `"default"`; a different id is a separate tree, the same id continues across reloads and tabs). `skills` names one or more zips — a path in your bundle (`/skills.zip`), a file in the user's RunApps storage (`files:packs/design.zip`) or any URL — unpacked under `/skills` and re-fetched only when the server's ETag changes. A skill is a folder with a `SKILL.md`:

```markdown
---
name: unit-convert
description: Convert between units with exact factors. Use whenever the user asks to convert a quantity.
---
1. Read `references/factors.md` for the factor.
2. Run `scripts/convert.js` with run_js (fs.read it, pass `input = { value, factor }`).
3. Answer with the result and the factor used.
```

The system prompt lists every skill's name and description (pi's `<available_skills>` block); the model reads the body with `read_file` when a task matches — the same way pi and Claude Code load skills. `disable-model-invocation: true` hides a skill from the model; typing `/skill:name …` as the prompt loads one explicitly, and `agent.useSkill(name)` does the same from code. Mount your own files with `workspace.mount("/doc", fs)`, where `fs` implements `AgentFS` (`list`, `read`, optional `write`/`delete`) — the app's document becomes files the model can read and edit; `memoryFS()` is a ready-made one. `/skills` is read-only; everything else the model writes persists.

Three more files in the workspace have a meaning: `/AGENTS.md` is added to the system prompt as project instructions; `/memory/notes.md` is the model's memory — the prompt tells it to append a line there to remember something across conversations, and shows the notes at the start of every one; `/prompts/<name>.md` are prompt templates, expanded when the prompt is `/name args` (`$1`, `$@`, `${2:-default}`, `${@:2}`, frontmatter `description` and `argument-hint`; `listTemplates(workspace)` lists them for a menu).

**Sessions.** With a workspace, an agent saves its conversation under its `id` after every turn, in the same IndexedDB database (one store per workspace, so workspaces never see each other's sessions). `createAgent(client, { id: "chat-1", workspace })` continues the session of that id when one exists — call `await agent.ready()` before reading `agent.messages` — and `workspace.sessions.list()` / `get(id)` / `delete(id)` manage them (a session's `title` is its first message). `persist: false` keeps a conversation in memory only; `agent.export()` and `createAgent(client, { restore })` still work for apps with their own storage.

**Compaction.** When the transcript comes within about 16 k tokens of the model's window (from the catalogue; `maxInputTokens` overrides), the older turns are summarised by the model into pi's structured checkpoint (goal, constraints, progress, decisions, next steps, critical context) and replaced by it; the newest ~20 k tokens of turns stay verbatim and the summary is updated, not rewritten, the next time. A `compaction` event reports it (`summary: true`, tokens before and after). `compaction: { reserveTokens, keepRecentTokens }` tunes it, a function writes the summary itself, `false` falls back to eliding old tool results and dropping old turns, which is also what happens when the summariser fails. `agent.compact()` does it on demand.

**Dialogs.** The agent's `confirm`, `select`, `input` and `notify` come from `domUI()`: plain `<dialog>`s that follow the page's language and colour scheme. Pass your own object implementing `AgentUI` to use the app's design.

**Cost and extras.** `agent.usage.total_cost` sums the gateway's `total_cost` of every call, the summariser's included (before the platform's markup and your app's fee). A private prompt (`prompt: { id, vars }`) is forwarded on every request and `extra` carries any other chat parameter.


## Reference

| | |
|---|---|
| `createAgent(client, opts)` → `Agent` | `prompt`, `steer`, `followUp`, `abort`, `on`, `ready`, `useSkill`, `compact`, `systemPrompt`, `export`, `reset`; `messages`, `usage`, `busy`, `model`, `id` |
| `openWorkspace(client, opts)` → `Workspace` | `list`, `read`, `readText`, `write`, `delete`, `stat`, `exists`, `isFolder`, `mount`, `unmount`, `skills`, `skillBody`, `refreshSkills`, `clearWork`, `destroy`; `sessions.list/get/save/delete` |
| Tools | `defineTool`, `fileTools`, `sandboxTool`, `runInSandbox`, `askUserTool` |
| UI | `domUI`, `nullUI`; implement `AgentUI` for your own |
| Files | `memoryFS`; implement `AgentFS` to mount your document |
| Helpers | `parseSkill`, `listTemplates`, `expandSlash`, `applyEdits`, `planCut`, `collectCompletion`, `buildSystemPrompt`, `estimateTokens`, `validateSchema` |

`examples/agent-demo.html` is a page to try everything against a local backend or a key. Tests: `npm test` (node:test on the built output, fetch mocked).

## License

MIT
