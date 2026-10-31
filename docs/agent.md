# The agent

`createAgent(provider, options)` returns an `Agent`: it sends the conversation to the model, runs the tools the model calls, feeds the results back, and repeats until the model answers.

```js
import { createAgent, openWorkspace } from "@runappsai/agent";

const workspace = await openWorkspace(provider, { id: "notes-app" });
const agent = createAgent(provider, {
  model: "gpt-4.1",
  appName: "Notes",
  instructions: "You help the user keep their notes tidy.",
  tools: [searchNotes, createNote],
  workspace,
});

const result = await agent.prompt("Summarise this week's meeting notes into /summary.md");
// result: { runId, reason: "done" | "aborted" | "max_turns" | "error", text, usage, error? }
```

## Runs and turns

One `prompt()` is a **run**. A run is made of **turns**: one model call, then the tool calls it asked for. The run ends when:

- the model answers without calling tools — `reason: "done"`, `text` is the answer;
- `maxTurns` model calls were made (default 100) — `"max_turns"`; `agent.continue()` carries on;
- you call `agent.abort()` — `"aborted"`;
- a call failed for good — `"error"`, with `error`.

`prompt()` resolves with the result; it does not throw for these. Calling `prompt()` while a run is active queues the message like `followUp()`.

Tool calls in a turn run one after another; `parallelTools: true` runs them at once. A tool that throws sends its message back to the model as an error, so the model can fix the call. A reply cut short by `max_tokens` runs none of its tool calls (each is told to re-issue with complete arguments). Rounds of tool calls that bring nothing new — the same results, lines already read, the same errors — get a warning to the model after three in a row and stop the run after six ([Calls that go nowhere](tools.md#calls-that-go-nowhere)).

## Talking to a running agent

```js
agent.prompt("Clean up /notes");          // starts a run

agent.steer("Skip the archive folder");   // insert into the current run
agent.followUp("Then email me a summary"); // run after the current run ends
await agent.abort();                      // stop now
```

- **`steer(content)`** — checked after each tool call. The rest of that batch is skipped (each skipped call gets a "skipped" result), and the message joins the next turn, so the model sees it at once. When the agent is idle it starts a run like `prompt()`.
- **`followUp(content)`** — waits until the current run ends, then starts a run of its own. Returns that run's promise.
- **`agent.queued`** lists what waits (`{ kind: "steer" | "followUp", message }`); `dequeue(message)` takes one out, `clearQueue()` all of them.
- **`abort()`** — stops the run; pending tool calls get a "skipped" result so the conversation stays valid, and open dialogs close as dismissed.
- **`continue()`** — carries on from where the conversation stands, without a new user message: after `max_turns`, or to retry after an error.
- **`rewind(index)`** — drops the messages from `index` on (`agent.messages[index]` is usually a user message).

Content is a string or content parts:

```js
agent.prompt([
  { type: "text", text: "What is in this picture?" },
  { type: "image_url", image_url: { url: "data:image/png;base64,…" } },
]);
```

## Events

`agent.on(name, handler)` returns a function that unsubscribes. `agent.on("*", (name, event) => …)` receives everything.

```js
agent.on("run_start", ({ message }) => drawUserMessage(message));      // message is null for continue()
agent.on("reasoning_delta", ({ text }) => thinkingBox.textContent = text);
agent.on("text_delta", ({ text }) => answerBox.innerHTML = markdown(text));
agent.on("message_reset", () => answerBox.textContent = "");          // a retried call: drop what was shown
agent.on("tool_call_delta", ({ index, name, arguments: json }) => draftCard(index, name, json));   // arguments as they stream
agent.on("tool_start", ({ id, name, args }) => addCard(id, name, args));
agent.on("tool_update", ({ id, content }) => cardProgress(id, content));
agent.on("tool_end", ({ id, status, result, durationMs }) => finishCard(id, status, result));
agent.on("run_end", ({ reason, error, usage }) => setBusy(false));
```

| Event | Payload | When |
|---|---|---|
| `run_start` | `runId`, `message` | A run starts (`message` null for `continue()`) |
| `turn_start` / `turn_end` | `runId`, `turn`, (`usage`) | Around each model call and its tools |
| `request` / `response` | the request sent; timing, finish reason, usage, message; `purpose: "compaction"` for summary calls | Each model call (debug views, counting calls) |
| `reasoning_delta` | `delta`, `text` | Thinking streams in |
| `text_delta` | `delta`, `text` | Answer text streams in |
| `message_reset` | `reason` | A call is retried after it streamed: discard what was shown |
| `message_end` | `message`, `truncated` | An assistant message is complete |
| `tool_call_delta` | `index`, `id`, `name`, `delta`, `arguments` | A tool call's arguments stream in (raw JSON so far, cut anywhere); nothing runs before the reply ends |
| `tool_start` / `tool_update` / `tool_end` | `id`, `name`, `args` / `content` / `status`, `result`, `details`, `durationMs` | Tool calls |
| `queued` | `kind`, `message` | `steer()` or `followUp()` added to the queue |
| `steered` | `messages` | Queued steering entered the conversation (draw it now) |
| `compaction_start` / `compaction` | `runId?`; `summary`, `tokensBefore`, `tokensAfter`, … | Older turns are being / were summarised |
| `rewind` | `index` | `rewind()` dropped messages (`clear()`: index 0) |
| `session_saved` | `id` | The session was written to the workspace |
| `run_end` | `RunResult` | A run ended |

`status` of a tool call is `"ok"`, `"error"`, `"declined"` (the user said no), `"blocked"` (`onToolCall` refused it) or `"skipped"` (stopped or steered past).

## Permissions and dialogs

Tools marked `destructive: true`, or with a `confirm()`, ask the user before they run:

```js
createAgent(provider, {
  tools,
  permissions: "ask",          // default: ask for destructive tools
  // permissions: "auto",      // never ask
  // permissions: ({ name, args, tool }) => name !== "delete_file" || confirmInMyUI(args),
  onToolCall: ({ name, args }) => (name === "send_email" && !args.to.endsWith("@mycompany.com") ? { block: true, reason: "Only internal addresses." } : undefined),
});
```

Questions go through the agent's **`ui`**: `confirm`, `select`, `input` and `notify`. The default, `domUI()`, uses plain `<dialog>`s in the page's language and colour scheme; the chat UI answers them inline above its composer. To use your app's own dialogs, pass an object implementing `AgentUI`:

```js
const ui = {
  async confirm(title, message, { ok, cancel, danger, signal } = {}) {
    return myDialogs.confirm({ title, message, ok, cancel, danger, signal });   // true / false
  },
  async select(title, options, { message, multi, allowOther, signal } = {}) {
    return myDialogs.pick({ title, options, message, multi, allowOther, signal }); // string[] or null
  },
  async input(title, { message, placeholder, multiline, initial, signal } = {}) {
    return myDialogs.prompt({ title, message, placeholder, multiline, initial, signal }); // string or null
  },
  notify(message, level = "info") { myToasts.show(message, level); },
};
createAgent(provider, { ui });
```

When `signal` aborts (the user stopped the run), close the dialog as dismissed. `nullUI()` answers nothing (every question is declined) — for agents without a person in the loop.

## Sessions

With a workspace, an agent saves its conversation after every turn, under its `id`, in the workspace's IndexedDB database. An agent created with the id of a saved session continues it:

```js
const agent = createAgent(provider, { id: "chat-42", workspace });
await agent.ready();                  // the saved session is loaded
console.log(agent.messages.length);

const list = await workspace.sessions.list();   // [{ id, title, messages, createdAt, savedAt, … }], newest first
await workspace.sessions.delete("chat-41");
```

- A session's `title` is the user's first words (what they typed, for a slash command), kept once known.
- `persist: false` keeps a conversation in memory only.
- `agent.export()` returns the session (`SessionData`) for storage of your own; `createAgent(provider, { restore: data })` continues it.
- `agent.lastEnd` says how the last run ended when it did not finish (`{ reason, error?, at }`), and is saved with the session until the next run starts.
- `agent.clear()` starts the conversation over under the same id — stops a run, drops the queue, messages, title, usage — and saves that; the workspace's files stay. `agent.reset()` forgets the messages in memory only (not while running).

## Context and compaction

The agent knows the model's window and longest reply from the provider's catalogue (`agent.limits()` → `{ input, output }`; `agent.context()` → `{ used, window }`). Each call asks for the model's longest reply (`maxTokens: "auto"`).

The window counts everything a request carries: the system prompt, the tools' schemas and the conversation. When the conversation comes within about 16k tokens of the window, the older turns are **summarised by the model** into a structured checkpoint (goal, constraints, progress, decisions, next steps, critical context) and replaced by it; the newest ~20k tokens stay as they were. The next compaction updates the summary rather than rewriting it; a history too long for one request (after switching to a model with a smaller window, say) is summarised piece by piece, each piece updating the summary so far. A summary call asks for at most 80% of `reserveTokens`, never the model's whole output. If the summary fails, old tool results are shortened and old turns dropped instead. Summary calls appear as `request` / `response` events with `purpose: "compaction"`. Files whose contents were summarised away must be read again before they are changed; files read or written in the kept turns stay read.

```js
createAgent(provider, {
  compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },  // tune
  // compaction: false,                                             // only shorten/drop, never summarise
  // compaction: async (plan, agent) => mySummary(plan.toSummarize, plan.previousSummary, plan.focus),
});

await agent.compact("keep every API name we discussed");   // now, with a focus
```

## Pictures and models that see them

Some models see pictures, some only read text. The agent asks the catalogue (`input_modalities`, see [Providers](providers.md#telling-the-agent-about-models)) and acts on the answer:

| The model in use | |
|---|---|
| sees pictures | Pictures in messages and tool results go to it. `read_file` on a PNG, JPEG, GIF or WebP shows the picture (up to 5 MB). Tools marked `vision: true` are offered. |
| is text-only | No picture is ever sent to it: each one becomes a line saying a picture was there and the model cannot see it (it says so to the user instead of guessing). `vision` tools are not offered. |
| unknown (no catalogue, or not listed) | Pictures are sent as they are; `vision` tools are not offered. |

```js
await agent.accepts("image");        // true / false / undefined (also "video", "audio")
await agent.modelInfo();             // the catalogue's entry for the model in use
createAgent(provider, { vision: true });   // you know better: true offers vision tools, false never sends pictures
```

A tool result's pictures go to the model in a user message after the batch's results (OpenAI's format keeps tool messages to text); only the latest two batches' pictures are sent again on later turns. The chat UI marks the models that see pictures in its model list, and when the current one cannot, keeps attached pictures as files and tells the user.

## Memory and project instructions

With a workspace that has the file tools, two files mean something:

- **`/AGENTS.md`** — your instructions for the project, added to the system prompt.
- **`/memory/notes.md`** — the agent's own notes. The prompt tells it to append a line there to remember something for later, and shows the notes at the start of every conversation.

Both live in the workspace's directory: shared by every conversation that uses the same directory. When the directory is the user's own project — their app's files, a folder on disk — the agent should not put notes of its own there, nor take instructions from a file someone else wrote: `memoryFile: false` and `instructionsFile: false` turn them off, or name other paths (`memoryFile: "/.notes/agent.md"`).

## Options

| Option | Default | |
|---|---|---|
| `model` | provider's default | Model id. |
| `instructions` | | Your system instructions (a function is re-read every turn). |
| `appName` | | Your app's name, used in the system prompt. |
| `tools` | `[]` | Tools from `defineTool`. |
| `workspace` | `null` | A `Workspace`: files, skills, sessions. |
| `fileTools` | all | `false`, or a subset: `["read_file", "list_files"]` for a read-only agent. |
| `readBeforeWrite` | `true` | Refuse to overwrite or edit an existing file the model has not read, or that changed since it read it (see [Tools](tools.md#read-before-write)). |
| `sandbox` | on | The `run_js` tool; `false` removes it, `{ timeoutMs, network }` configures it. |
| `askUser` | on | The `ask_user` tool. |
| `ui` | `domUI()` | Dialogs (`AgentUI`). |
| `permissions` | `"ask"` | `"ask"`, `"auto"`, or a function per call. |
| `onToolCall` | | Return `{ block: true, reason }` to refuse a call. |
| `maxTurns` | `100` | Model calls per run. |
| `maxTokens` | `"auto"` | `max_tokens` per call: the model's maximum, or a number. |
| `maxInputTokens` | `"auto"` | The context budget: the model's window, or a number. |
| `parallelTools` | `false` | Run a turn's tool calls at once. |
| `keepTurns` | `4` | Turns kept intact when old turns have to be dropped. |
| `vision` | from the catalogue | Whether the model sees pictures; see [Pictures](#pictures-and-models-that-see-them). |
| `memoryFile` | `"/memory/notes.md"` | The memory notes file; `false` for none. |
| `instructionsFile` | `"/AGENTS.md"` | The project instructions file; `false` for none. |
| `loopGuard` | `{ warn: 3, stop: 6 }` | Rounds without anything new before the model is warned / the run stops; `false` turns it off. |
| `temperature`, `top_p` | | Sent as is. |
| `extra` | | Any other request field (`reasoning_effort`, …). |
| `compaction` | on | See above. |
| `id` | random | Session id. |
| `persist` | `true` with a workspace | Save after every turn. |
| `restore` | | A `SessionData` to continue. |
| `prompt` | | RunApps private prompt reference (`{ id, vars }`), sent with every request. |
| `serverTools` | | RunApps only: `["web_search", "web_fetch"]` run by the gateway, for an agent with no tools of its own. |

Change settings on a live agent with `agent.configure({ model, maxTurns, maxTokens, permissions, reasoningEffort })`; `agent.settings` reads them back.
