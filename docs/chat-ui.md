# Chat UI

`renderChat(element, options)` turns an element into a complete chat with an agent. Plain DOM, no framework; its styles are injected once. Give the element a height.

```html
<div id="assistant" style="height: 100vh"></div>
<script type="module">
  import { renderChat, openWorkspace, openAIProvider } from "@runappsai/agent";

  const provider = openAIProvider({ baseURL: "/api/llm", models: "fetch" });
  const chat = renderChat(document.getElementById("assistant"), {
    provider,
    appName: "Acme Docs",
    instructions: "You help users write and edit their documents.",
    tools: [myTool],
    workspace: (sessionId) => openWorkspace(provider, { id: sessionId }),
    suggestions: ["Summarise the open document", "/skill:review"],
  });
  await chat.ready;
</script>
```

## What the user gets

- **Replies** — streaming Markdown (code blocks with copy, tables, links). While the agent works, the end of the reply shows what it is doing — *Thinking*, *Running code*, *Reading plan.md* — over a few lines that scroll as it goes: its latest thinking, the code being run, a tool's progress. When the run ends, its thinking and tool calls fold into one line, *Worked for 1m 12s ›*, above the answer.
- **Tool calls** — one quiet line per chain of calls, worded from the tools ("read 2 files, edited 1 file"), opening to a card per call with arguments, result, duration and status.
- **Questions** — `ask_user` and confirmations appear inline above the composer.
- **The composer** — Enter sends, Shift+Enter breaks a line. While the agent runs, Enter **steers** (inserts into the current task) and ⌘↵ / Ctrl+↵ **queues** a follow-up; queued messages sit in a card above the box with *send now*, *edit* and *remove*.
- **Attachments** — paperclip, drag and drop, or paste. Files are saved under `/uploads/` in the conversation's directory and named in the message; pictures also go to the model as images. 20 MB per file.
- **Files** — the header's *Files* button opens the directory: a tree, an editor (⌘S, word wrap, Markdown preview), picture and PDF previews, upload, new file, download (folders as zip). File paths in replies open there. Live: changes by the agent show at once.
- **Skills** — the *Skills* button lists the skills (with a count), uploads zips, removes the user's own.
- **Chats** — the conversation list (the open one first), new chat, delete. Conversations keep running when you switch away (up to three in the background).
- **Settings** — the gear: model (with context and output limits), thinking level when the model has one, max turns, max output, tool permissions. Kept per app in the browser and applied to every conversation.
- **Rewind** — hover a user message: when it was sent, copy, *rewind to here* (the conversation after it is dropped, the message goes back into the composer, and the directory's files can be restored to that moment).
- **How a run ended** — *Stopped.*, the turn limit with *Continue*, an error with *Retry*; kept across reloads until the next run.
- **Context** — a ring under the composer shows how full the model's window is; older turns are summarised automatically.
- **Time** — "Today 22:15" above messages that start a conversation or follow a pause.

## Slash commands

Typing `/` lists the built-in commands, then the directory's prompt templates and skills.

| Command | |
|---|---|
| `/help` | The commands |
| `/new` (`/clear`) | A new conversation |
| `/resume` | The conversation list |
| `/compact [focus]` | Summarise older turns now, keeping `focus` above all |
| `/continue` | Carry on after the turn limit or an error |
| `/model [name]` | Switch model (no name: open the settings) |
| `/effort [level]` | Set the thinking level (no level: list them) |
| `/context` | Model, context use, cost, the directory |
| `/export` | Download the conversation as Markdown |
| `/files`, `/settings`, `/debug` | Open those panels |
| `/name args` | A prompt template from `/prompts/name.md` |
| `/skill:name args` | Use a skill |

## Options

`renderChat` takes every [agent option](agent.md#options) (`model`, `tools`, `instructions`, `permissions`, `compaction`, …) plus:

| Option | Default | |
|---|---|---|
| `provider` | | A `ModelProvider` (or a RunApps client). |
| `client` | | A RunApps client — the same as `provider: runappsProvider(client)`. |
| `workspace` | | A `Workspace` shared by every conversation, or `(sessionId) => Workspace` for a directory per conversation. |
| `agent` | | Show an `Agent` you built yourself instead (its own `ui` answers questions; no conversation list). |
| `resume` | `true` | Reopen the conversation this app last had open in this browser; a session id; or `false` for a new one. |
| `title` | `appName` | Header title; `false` hides the whole header. |
| `placeholder` | | Composer placeholder. |
| `emptyState` | | Text or element shown while the conversation is empty. |
| `suggestions` | | Starter prompts shown in the empty state. |
| `sessions` | on with a workspace | The conversation list and *New chat*. |
| `skillsMenu` | on with a workspace | The *Skills* button. |
| `settings` | on | The settings gear. |
| `attachments` | on | Paperclip, drop and paste. |
| `uploadsDir` | `/uploads` | Where attachments are saved. |
| `showUsage` | on | Cost, tokens and the context ring under the composer. |
| `locale` | the document's | `"en"` or `"zh"`. |
| `theme` | `"auto"` | `"auto"`, `"light"`, `"dark"`. |
| `palette` | `"claude"` | `"claude"`, `"violet"`, `"slate"`, `"forest"`, or your own. |
| `vars` | | Colour and font overrides (see Theming). |
| `className` | | Extra classes on the chat's root. |
| `debug` | `false` | The *Debug* panel. |
| `onOpenFile(path)` | | Open file links yourself instead of in the files panel. |
| `onSession(agent)` | | Called with each conversation's agent as it opens. |

## The handle

```js
const chat = renderChat(el, options);
await chat.ready;              // the first conversation is open

chat.agent;                    // the open conversation's Agent (events, messages, usage…)
chat.prompt("Hello");          // send as if typed
chat.setInput("Draft: ");      // fill the composer
await chat.newSession();
await chat.resume(id);
await chat.deleteSession(id);
await chat.refresh();          // re-read skills and templates for the / menu
chat.setDebug(true);
chat.setAppearance({ theme: "dark", palette: "slate" });
chat.ui;                       // the inline dialogs — your own tools can use them
chat.unmount();                // remove it; agents the chat made are stopped
```

`onSession` is the place to attach your own listeners, since every new or resumed conversation has a new agent:

```js
renderChat(el, {
  provider,
  onSession: (agent) => {
    agent.on("tool_end", (e) => analytics.track("tool", { name: e.name, status: e.status }));
  },
});
```

## Using your own agent

```js
const agent = createAgent(provider, { tools, workspace, ui: myDialogs });
renderChat(el, { agent });
```

The chat shows that agent; it does not make new ones (no conversation list or *New chat*).

## Theming

Every colour and font is a CSS custom property on the chat's root: `--ra-bg`, `--ra-panel`, `--ra-subtle`, `--ra-muted`, `--ra-fg`, `--ra-fg-muted`, `--ra-border`, `--ra-accent`, `--ra-accent-fg`, `--ra-accent-subtle`, `--ra-accent-muted`, `--ra-user-bg`, `--ra-link`, `--ra-ok`, `--ra-red`, `--ra-red-subtle`, `--ra-warn-fg`, `--ra-warn-bg`, `--ra-warn-border`, `--ra-shadow`, `--ra-shadow-md`, `--ra-font`, `--ra-mono`.

```js
renderChat(el, { provider, palette: "slate", theme: "dark" });                        // a built-in palette
renderChat(el, { provider, vars: { accent: "#e11d48", font: "Inter, sans-serif" } }); // override some tokens
renderChat(el, { provider, vars: { light: { bg: "#fff" }, dark: { bg: "#0b0b0c" } } }); // per scheme
renderChat(el, { provider, palette: { light: { accent: "#0a7" }, dark: { accent: "#3c9" } } }); // your own palette
chat.setAppearance({ palette: "forest", theme: "light" });                             // live
```

Or from your stylesheet — the chat's own rules weigh nothing, so yours win:

```css
.ra-chat { --ra-accent: #e11d48; --ra-font: "Inter", sans-serif; }
.ra-chat[data-scheme="dark"] { --ra-bg: #0b0b0c; }
.ra-chat .ra-bubble { border-radius: 8px; }     /* restyle a part */
```

## Dropdowns for your page

The settings menu uses the chat's own dropdown. Use it in your page too:

```js
import { selectBox, enhanceSelect } from "@runappsai/agent";

// Give an existing <select> the same look; its .value and change events keep working.
enhanceSelect(document.querySelector("#language"), document.querySelector("aside"));

// Or build one.
const box = selectBox(document.querySelector("aside"), {
  options: [{ value: "en", label: "English" }, { value: "zh", label: "中文", note: "Chinese" }],
  value: "en",
});
box.el.addEventListener("change", () => console.log(box.value));
container.append(box.el);
```

The second argument is where the list opens: a positioned element (`position: relative`) with the class **`ra-ui`**, which gives it the chat's colours (dark follows the system unless `data-scheme="light"`; `data-palette` picks a palette).

## Debug

`debug: true` (or `chat.setDebug(true)`) adds a *Debug* button: the call chain run by run and turn by turn, every request sent to the model and what came back, the event log, the context (system prompt, messages, limits) and the tools declared to the model.
