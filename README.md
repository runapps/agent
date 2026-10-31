# @runappsai/agent

An agent harness for the browser: the model ↔ tool loop, a file workspace with skills, saved sessions, context compaction, a JavaScript sandbox — and a complete chat UI you can drop into any element. It works with any OpenAI-compatible model API ([RunApps](https://www.runapps.ai), OpenAI, DeepSeek, OpenRouter, your own proxy) and has no runtime dependencies.

Modelled on [pi](https://pi.dev) (MIT): the compaction prompts, edit matching, template arguments and skills wording come from it.

**Status: test phase** — the API may still change.

## Install

```html
<script src="https://www.runapps.ai/sdk/agent-latest.js"></script>
<!-- exposes window.RunAppsAgent -->
```

or

```sh
npm i @runappsai/agent
```

```js
import { renderChat, createAgent, openWorkspace, defineTool, openAIProvider } from "@runappsai/agent";
```

## Quick start: a chat in five minutes

```html
<div id="assistant" style="height: 640px"></div>

<script src="https://www.runapps.ai/sdk/agent-latest.js"></script>
<script type="module">
  const { renderChat, openWorkspace, openAIProvider, defineTool } = RunAppsAgent;

  // 1. Where the model calls go. Keep API keys on your server: point at your own proxy.
  const provider = openAIProvider({ baseURL: "/api/llm", models: "fetch" });

  // 2. A tool of your app's (optional).
  const getTime = defineTool({
    name: "get_time",
    description: "The current date and time in the user's timezone.",
    execute: () => new Date().toString(),
  });

  // 3. The chat. Each conversation gets its own directory of files in IndexedDB.
  const chat = renderChat(document.getElementById("assistant"), {
    provider,
    model: "gpt-4.1",
    appName: "My app",
    instructions: "You are the assistant inside My app. Be brief.",
    tools: [getTime],
    workspace: (sessionId) => openWorkspace(provider, { id: sessionId }),
    suggestions: ["What time is it?", "Write a haiku about Mondays"],
  });
  await chat.ready;
</script>
```

That is a full assistant: streaming Markdown replies, folded tool calls, a live "what it is doing" status, file attachments, a files panel, a skills menu, saved conversations, slash commands, settings (model, thinking level, limits), rewind, light/dark themes.

With [RunApps](https://www.runapps.ai) instead, users sign in and pay for their own usage — no proxy and no key on your side:

```html
<script src="https://www.runapps.ai/sdk/latest.js"></script>
<script src="https://www.runapps.ai/sdk/agent-latest.js"></script>
<script type="module">
  const client = new RunApps({ project: "my-app" });
  const chat = RunAppsAgent.renderChat(document.getElementById("assistant"), {
    client,
    workspace: (id) => RunAppsAgent.openWorkspace(client, { id }),
  });
</script>
```

## Quick start: an agent without the UI

```js
import { createAgent, defineTool, openAIProvider } from "@runappsai/agent";

const provider = openAIProvider({ baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_KEY });

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

const agent = createAgent(provider, {
  model: "deepseek-chat",
  instructions: "You manage the user's todo list.",
  tools: [addTodo],
  sandbox: false,        // no run_js
  askUser: false,        // no questions back to a user
});

agent.on("text_delta", (e) => process.stdout.write(e.delta));
const result = await agent.prompt("Add 'ship v2' for next Friday");
console.log(result.reason, result.usage);
```

## Documentation

| Guide | What is in it |
|---|---|
| [Providers](docs/providers.md) | Connecting a model API: `openAIProvider`, `runappsProvider`, writing your own, errors and retries |
| [The agent](docs/agent.md) | Runs, steering and queueing, stopping and continuing, events, permissions and dialogs, sessions, compaction, all options |
| [Tools](docs/tools.md) | `defineTool`, schemas, results, confirmations, progress, the built-in tools |
| [Workspace and files](docs/workspace.md) | The virtual directory, mounting your app's data, a real folder, memory and project notes, prompt templates, PDFs, change events |
| [Skills](docs/skills.md) | Skill folders and zips, the app's skills, lazy skills, the user's skills, writing descriptions |
| [Chat UI](docs/chat-ui.md) | `renderChat` options and handle, what the UI does, commands, theming, dropdowns, debug |
| [API reference](docs/reference.md) | Every export in one place |

`examples/chat/index.html` is a complete page using everything (serve the package root and open `/examples/chat/index.html`).

## Development

```sh
npm install
npm run build     # dist/index.cjs, dist/index.js (ESM), dist/agent.umd.js (browser, minified)
npm test          # node:test on the built output, model calls mocked
```

## License

MIT
