# @runappsai/agent — agent harness

The model ↔ tool loop for web apps, with any model provider — [RunApps](https://www.runapps.ai) or any OpenAI-compatible endpoint — and no runtime dependencies: streaming, tool calls checked against JSON Schema, a workspace of files in IndexedDB with skills unpacked from a zip, sessions, pi-style compaction, memory notes, prompt templates, dialogs, and a JavaScript sandbox. Modelled on [pi](https://pi.dev) (MIT; the compaction prompts, edit matching, template arguments and skills wording are copied from it).

**Status: test phase.** The package is separate from the SDK so it can change freely; nothing in the SDK depends on it, and it needs nothing from the SDK.

## Install

```html
<script src="https://www.runapps.ai/sdk/agent-latest.js"></script>
<script>
  const provider = RunAppsAgent.openAIProvider({ baseURL: "https://api.openai.com/v1", apiKey: KEY });
  const agent = RunAppsAgent.createAgent(provider, { model: "gpt-4.1", /* … */ });
</script>
```

With a bundler: `npm i @runappsai/agent` and `import { createAgent, openWorkspace, defineTool, openAIProvider } from "@runappsai/agent"`.

## Providers

The agent calls models through a **`ModelProvider`** — an object with one required method:

```ts
interface ModelProvider {
  stream(params, { signal }): AsyncIterable<ChatCompletionChunk>;   // required: one streamed Chat Completions call
  complete?(params, { signal }): Promise<ChatCompletion>;            // whole reply (compaction); else stream() is collected
  models?(): Promise<ModelInfo[]>;   // catalogue: id, is_default, max_input_tokens, max_tokens, options.inputs.reasoning_effort
  readFile?(path, { etag }): Promise<{ bytes, etag } | null>;        // `files:` skills sources
  name?: string;                     // names the app's IndexedDB storage when no `project` is given
}
```

`params` is OpenAI's Chat Completions request (`model` — absent when the agent names none —, `messages` with `tool` messages and `image_url` parts, `tools`, `max_tokens`, sometimes `reasoning_effort`); the chunks are OpenAI's (`delta.content`, `delta.reasoning_content` or `reasoning`, `delta.tool_calls` by `index`, `finish_reason`, `usage`, with `usage.total_cost` in USD when the provider knows it). Throw a `ProviderError(status, message, { code, retryAfter })` (or anything with a numeric `status`/`statusCode`) for a failed call: 408, 429, 5xx and 0 (no answer) are retried with backoff, honouring `retryAfter`; the rest end the run with the error. Without `models()` the agent assumes a 128 k window and 8 k replies, and the settings menu offers no model list.

Two come with the package:

- **`openAIProvider({ baseURL, apiKey?, headers?, models?, fetch?, name? })`** — any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, a local server, your own proxy) with plain `fetch` and SSE. `models` is a fixed `ModelInfo[]`, `"fetch"` for `GET /models` (ids, plus limits and capability where the endpoint lists them, as the RunApps gateway does), or nothing. In a browser, put the key behind your own proxy (`baseURL: "/api/llm"`, no `apiKey`) rather than in the page.
- **`runappsProvider(client)`** — the RunApps SDK client: users sign in with RunApps and pay for their own usage, the catalogue comes from the gateway, `files:` sources read the user's RunApps storage, the client's project names the storage. Passing the client itself (`createAgent(client)`, `renderChat({ client })`, `openWorkspace(client)`) does the same.

Or write your own: wrap another SDK, your server's endpoint, a local model — anything that can produce the chunks.

`createAgent(provider)` runs the model ↔ tool loop for you: it streams the reply, re-assembles tool calls, checks their arguments against your schema, asks the user before destructive steps, runs the tools, feeds the results back and repeats until the model answers. Your app provides what is its own — tools, a workspace of files and skills, and (optionally) its dialogs.

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

const workspace = await openWorkspace(provider, { skills: "/skills.zip" });   // see Skills below
const agent = createAgent(provider, {
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

**The loop.** One `prompt()` is a run. Each turn is a model call followed by its tool calls, run one after another (`parallelTools: true` runs them at once), until the model replies without tools, `maxTurns` (default 100; pi and opencode have no cap, this is a safety net) is reached, or the run is stopped. Steer a running agent with `agent.steer(text)` (as in pi: checked after each tool call; the rest of the batch is skipped with a "skipped" result so the model sees the instruction at once, and it joins the next turn) or queue a message with `agent.followUp(text)`; `agent.abort()` stops it, giving pending tool calls a "skipped" result so the conversation stays valid. A tool that throws returns its message to the model as an error; the model fixes the call or explains. A reply cut by `maxTokens` runs none of its tool calls: each gets pi's "re-issue with complete arguments" result. Repeated identical tool batches are warned about and then stopped. Each call's `max_tokens` is the model's maximum output from the catalogue (`maxTokens: "auto"`, the default; a number pins it), and the context budget its `max_input_tokens` — `agent.limits()` reports both; the system prompt tells the model to write a file longer than one reply in parts (write_file, then edit_file to append).

**Tools.** `defineTool({ name, description, parameters, execute })` — `parameters` is a JSON Schema (close objects with `additionalProperties: false` and list `required`): the model's arguments are checked against it and a mismatch goes back to the model as a readable error. `execute(args, ctx)` returns a string, content parts (an image), any JSON value, or `{ content, details }` (only `content` reaches the model). `ctx` has `signal`, `ui`, `workspace`, `agent` and `update(text)` for progress. Mark a tool `destructive: true`, or give it `confirm: (args) => "Delete 3 files?"`, and the agent asks the user first under `permissions: "ask"` (the default); `"auto"` never asks and a function decides per call. `onToolCall` can block any call. `guidelines` adds a sentence to the system prompt.

**Built-in tools.** `ask_user` lets the model put one to three questions to the user, with options or free text, when a request is ambiguous. `run_js` runs JavaScript the model writes in a Worker — no DOM, no network, a captured console, and `fs` bound to the workspace — so it computes, parses and transforms data instead of guessing, and can run a skill's scripts. Both are on by default (`askUser: false`, `sandbox: false` to remove; `sandbox: { timeoutMs, network }` to configure). With a workspace: `list_files`, `read_file` (2000 lines / 50 KB a call, `offset` and `limit` to continue), `write_file`, `edit_file` (one or more exact replacements per call, matched like pi's: exact first, then tolerant of smart quotes, dashes and trailing spaces), `delete_file` (asks), `search_files`; choose a subset with `fileTools: ["read_file", "list_files"]`.

**Workspace and skills.** `openWorkspace(provider, { id, skills, skillsDir, dir })` is the directory the agent works in: by default a virtual file tree kept in IndexedDB — one database per app, in which every `id` is a separate directory (default `"default"`; the same id continues across reloads and tabs). Give each conversation its own directory by opening the workspace under the session's id: `renderChat` does that when `workspace` is a function, `workspace: (id) => openWorkspace(provider, { id, skills: "/skills.zip" })` — a new chat starts in an empty directory that already has the skills, resuming a session reopens its directory, and `workspace.sessions.list()` still lists every session of the app (each naming its `workspace`). Skills live in two places. **`/.agent/skills/` (`skillsDir`) is virtual and read-only:** generated in memory when the workspace opens, and again whenever the user's skills change, with one folder per skill — the agent reads them there, nothing is stored there. It is made from (1) **the app's skills**, the `skills` option: zips as URLs / bundle paths (`/skills.zip`), `files:<path>` in the user's RunApps storage, Blobs / Files / Uint8Arrays, or `{ name, data }` — read in place each time the page opens them (a URL is fetched once per page; `refreshSkills()` fetches again), never stored, and not removable by the user (`Skill.builtin`). **Lazy skills** load only when used: give `{ name, description, load }` instead of a zip — the name and description go into the prompt, the skills menu and `/` at once, and `load()` (returning a Blob, ArrayBuffer, Uint8Array or a URL / `files:` path) runs the first time the agent reads a file of that skill or the user types `/skill:name` (once per page; a failed load is reported to the agent and tried again next time; `Skill.lazy`). `skills` may also be a function returning the list (sync or async), called at open and by `refreshSkills()` — so an app with many skills, or skills kept on its server, starts without downloading any:

```js
openWorkspace(provider, {
  skills: async () => (await fetch("/api/skills").then((r) => r.json())).map((s) => ({
    name: s.name, description: s.description,
    load: () => fetch(`/api/skills/${s.name}.zip`).then((r) => r.blob()),
  })),
});
```

And and (2) **the user's skills in `/skills/` (`userSkillsDir`)**, one folder shared by every directory of the app (IndexedDB) and visible in the files panel: zips there are read in place — never unpacked (an entry is inflated the first time it is read, then kept in memory) — and folders `/skills/<name>/SKILL.md` are ordinary files, which is where the agent writes a skill it makes (the prompt tells it so). A user's skill of the same name takes the app's place. `workspace.installSkill(zipFileOrURL, { name })` saves a zip as `/skills/<name>.zip` (the same name replaces it; `unpack: true` writes its skill folders instead, to be edited), `removeSkill(name)` deletes the user's zip (with every skill in it) or folder, and `Skill.from` says which. A change in one directory or tab shows in the others at once. A zip with SKILL.md at its root is one skill named after the zip; otherwise each folder with a SKILL.md is one. Directories from before this layout have their own skill files moved to `/skills/` (copies of the app's zips are dropped) on open. `workspace.skills()` lists them all. **`userSkills: false`** (or `userSkillsDir: false`) turns the user's skills off: only the app's `skills` are there — no `/skills/`, nothing to upload, remove or write (the Skills menu shows no upload button, delete buttons or drop zone; `installSkill` refuses), and the agent is not told it may make skills. To work in a real folder instead of IndexedDB, pass `dir`: `directoryFS(await showDirectoryPicker())` (Chromium's File System Access API; `navigator.storage.getDirectory()` works too) or any `AgentFS` — files and the agent's edits then land in that folder (its own `.agent/skills/<name>/` folders count as skills too), while sessions and `/skills/` stay in IndexedDB. A skill is a folder with a `SKILL.md`:

```markdown
---
name: unit-convert
description: Convert between units with exact factors. Use whenever the user asks to convert a quantity.
---
1. Read `references/factors.md` for the factor.
2. Run `scripts/convert.js` with run_js (fs.read it, pass `input = { value, factor }`).
3. Answer with the result and the factor used.
```

The system prompt lists every skill's name and description (pi's `<available_skills>` block); the model reads the body with `read_file` when a task matches — the same way pi and Claude Code load skills (opencode does the same through a `skill` tool). Only the name, description and path are in the prompt; bodies and reference files are read on demand, so a large skill costs nothing until it is used.

**Writing the description.** It is the only thing the model sees before deciding whether to load the skill, so it decides whether the skill triggers. Say *what the skill does* and *when to use it* — the situations, the kinds of request, the words a user would use — in one to three sentences, in the language users will write in. Compare:

```yaml
# triggers rarely: a feature list, no situations
description: Novel writing engine with character, plot and dialogue tools.

# triggers reliably: scope, situations, user phrasing
description: 网文爽文写作引擎，男频女频都支持（古言、穿越、系统、玄幻、都市……）。用户给出大纲、剧情单元或章节要求让 AI 写正文、起书名、写简介、改稿（"不够爽""不够好笑"）时使用；也负责批量生成金句和按题材出单元方案。
```

A skill's scripts run only as JavaScript (`run_js`, a Worker sandbox: no shell, Python or network); the prompt tells the model that a script in another language is to be read, ported to JavaScript with the same inputs and outputs and run that way, and to say when something needs what the sandbox lacks — so a skill written for Claude Code or pi with Python helpers still works when its logic is portable. Keep the first sentence self-contained (some models skim), name the concrete triggers rather than "helps with writing", and leave out how the skill works inside — that belongs in the body. If a skill should never fire on its own (a destructive workflow, a template the user invokes), set `disable-model-invocation: true` and call it with `/skill:name`. `disable-model-invocation: true` hides a skill from the model; typing `/skill:name …` as the prompt loads one explicitly, and `agent.useSkill(name)` does the same from code. Mount your own files with `workspace.mount("/doc", fs)`, where `fs` implements `AgentFS` (`list`, `read`, optional `write`/`delete`) — the app's document becomes files the model can read and edit; `memoryFS()` is a ready-made one. A mount is the host's live data, not storage: a `memoryFS` holds only what the page put in it and starts over on every open, so files meant to last belong in the directory itself (IndexedDB), where nested folders persist like top-level files. Everything the model writes to the directory persists; `clearWork()` empties it but keeps the skills.

Three more files in the workspace have a meaning: `/AGENTS.md` is added to the system prompt as project instructions; `/memory/notes.md` is the model's memory — the prompt tells it to append a line there to remember something across conversations, and shows the notes at the start of every one; `/prompts/<name>.md` are prompt templates, expanded when the prompt is `/name args` (`$1`, `$@`, `${2:-default}`, `${@:2}`, frontmatter `description` and `argument-hint`; `listTemplates(workspace)` lists them for a menu).

**Sessions.** With a workspace, an agent saves its conversation under its `id` after every turn, in the same IndexedDB database (one store per workspace, so workspaces never see each other's sessions). `createAgent(provider, { id: "chat-1", workspace })` continues the session of that id when one exists — call `await agent.ready()` before reading `agent.messages` — and `workspace.sessions.list()` / `get(id)` / `delete(id)` manage them (a session's `title` is its first message). `persist: false` keeps a conversation in memory only; `agent.export()` and `createAgent(provider, { restore })` still work for apps with their own storage.

**Compaction.** When the transcript comes within about 16 k tokens of the model's window (from the catalogue; `maxInputTokens` overrides), the older turns are summarised by the model into pi's structured checkpoint (goal, constraints, progress, decisions, next steps, critical context) and replaced by it; the newest ~20 k tokens of turns stay verbatim and the summary is updated, not rewritten, the next time. A `compaction` event reports it (`summary: true`, tokens before and after). `compaction: { reserveTokens, keepRecentTokens }` tunes it, a function writes the summary itself, `false` falls back to eliding old tool results and dropping old turns, which is also what happens when the summariser fails. `agent.compact(focus?)` does it on demand: every turn before the latest may be summarised (even when they would all fit), and `focus` — what the user wants kept above all — is added to the summariser's prompt (and is `plan.focus` for a `compaction` function).

**Dialogs.** The agent's `confirm`, `select`, `input` and `notify` come from `domUI()`: plain `<dialog>`s that follow the page's language and colour scheme. Pass your own object implementing `AgentUI` to use the app's design.

**Cost and extras.** `agent.usage.total_cost` sums the gateway's `total_cost` of every call, the summariser's included (before the platform's markup and your app's fee). A private prompt (`prompt: { id, vars }`) is forwarded on every request and `extra` carries any other chat parameter.


## Chat UI

`renderChat(target, options)` turns an element into a chat with an agent: Markdown replies with a streaming cursor, the model's thinking folded away, tool calls folded into one quiet line per run of calls, worded from the tools themselves ("Editing plan.md" with a spinner while one runs, "read 2 files, edited 1 file, ran 1 snippet" when done, failures counted in red; turns that only think and call tools stay in one row, their thinking inside the group; opening it shows a card per call with icon, arguments, result, duration and status), questions the agent asks (`ask_user`, confirmations) answered inline above the composer, a "Chats" menu (the open conversation first, marked Current — also before it is saved — then the others, newest first, to resume or delete; "delete all" deletes every one and starts a new chat; the button shows how many conversations there are once there is more than one; titles are the user's first words — what they typed for a command, never a compaction summary or an attachment list — and stay after compaction) and "new chat" when there is a workspace, attachments, and a cost line. Plain DOM, no framework; the styles are injected once (a Claude-like palette: ivory and warm charcoal, a coral accent, neutral user bubbles, blue links; light and dark) and the markup follows the harness app's chat. Give the element a height.

```html
<div id="assistant" style="height: 600px"></div>
<script>
  // Any provider: RunApps (users sign in and pay), or your own OpenAI-compatible endpoint.
  const provider = RunAppsAgent.runappsProvider(new RunApps({ project: "my-app" }));
  // const provider = RunAppsAgent.openAIProvider({ baseURL: "/api/llm" });
  const chat = RunAppsAgent.renderChat(document.getElementById("assistant"), {
    provider,                     // or client: a RunApps SDK client
    workspace: (sessionId) => RunAppsAgent.openWorkspace(provider, { id: sessionId, skills: "/skills.zip" }),
    appName: "My app",
    instructions: "You are the assistant inside My app.",
    tools: [myTool],
    suggestions: ["Summarise the open document", "/skill:review"],
  });
  await chat.ready;
  chat.prompt("Hello");          // as if typed; chat.agent is the Agent underneath
</script>
```

Every `AgentOptions` field is accepted (`model`, `tools`, `permissions`, `compaction`, …); `workspace` is a `Workspace` shared by all sessions or a function `(sessionId) => Workspace` for a directory per session (see Workspace below). Plus: `resume` (`true`, the default, reopens the session this app last had open in this browser — so a page reload or a re-render continues the conversation; a string names one; `false` starts fresh), `title` (header; `false` hides it), `placeholder`, `emptyState`, `suggestions` (starter prompts), `sessions` (the history / new-chat menu; default on with a workspace), `attachments` (default on) and `uploadsDir` (default `/uploads`), `locale` (`"zh"` / `"en"`, default the document's), `theme` (`"auto"` / `"light"` / `"dark"`), `palette`, `vars`, `className` (see Look below), `debug` (see Debug below), `showUsage` (cost, tokens, calls and how full the model's context is, under the composer), `onOpenFile(path)` (a tool card's path becomes a link), `onSession(agent)` (each session's agent as it opens). The handle has `agent`, `ready`, `element`, `ui` (the inline dialogs, usable by the host's own tools), `prompt(text)`, `setInput(text)`, `newSession()`, `resume(id)`, `deleteSession(id)`, `refresh()`, `setAppearance({ theme, palette, vars })`, `setDebug(on)` and `unmount()` (which stops an agent the chat made). The queue box under the composer lists steering and follow-ups waiting, each removable (`agent.dequeue(message)`). Pass `agent` instead of `client` to show an agent the host built itself (its own `ui` then answers questions, and the session menu is off).

In the composer, Enter sends and Shift+Enter breaks a line; while the agent runs, Enter steers (as in pi: checked after each tool, the rest of the batch is skipped so the model sees it at once, and it joins the next turn) and ⌘↵ on a Mac / Ctrl+↵ elsewhere (either modifier works on any platform, Alt+↵ and Win+↵ too — Windows itself binds Win+Enter to Narrator, so Ctrl+↵ is what is shown there) queues a follow-up (runs after the current run ends) — the placeholder and the hint under the box say so with the platform's own key. Waiting messages sit in a card on top of the box: one shows whole, with send now (a queued follow-up becomes a steer), edit (back into the box) and remove; several fold into "N messages queued · Next: …", and a click lists them, each with the same actions. `/` lists the workspace's prompt templates and skills. The box is a fixed height and typing touches nothing but the `/` popover, so nothing jumps while you type. Files come in through the paperclip, drag and drop onto the chat, or paste: each is saved in the session's directory under `uploadsDir` and listed in the message (`[attachments]` block with path, type and size), so the agent reads it with `read_file`; a PNG/JPEG/GIF/WebP is also sent to the model as a picture; without a workspace, text files up to 64 KB go inline. Limit 20 MB per file.

**Replies.** A reply runs the chat's full width, no avatar. While the agent works its thinking, tool calls (one folded line per chain) and text along the way show as they come; when the run ends, all of that folds into one line — "Worked for 6m 38s ›" — with the answer below it (a reply that is only an answer has nothing to fold; one that ended without an answer folds whole). A steer closes the reply before it the same way. Saved transcripts fold alike, timed from the user message's `ts` to the last assistant message's (sessions saved before assistant messages carried `ts` say "Work").

**Skills button.** The header's "Skills" button (on with a workspace; `skillsMenu: false` hides it) lists the skills — built-in (the app's), zip or folder (the user's, in `/skills/`), manual-only ones marked — with view (SKILL.md; a user's folder opens editable), download (the zip, or the folder zipped) and delete (the user's only, confirmed; a zip of several skills says which go with it); a click on a skill puts `/skill:name` in the composer. "Upload zip" (several at once) or a zip dropped on the menu saves it to `/skills/`.

**How a run ended.** A run that did not finish leaves a line under it — "Stopped.", the turn-limit pill with Continue, an error with Retry — and it stays there across reloads and reopening the session (the agent keeps it as `agent.lastEnd`, saved with the session as `ended`) until the next run starts.

**Waiting and time.** While the agent works, the end of the reply says what it is doing: a shimmering label — "Thinking" from the moment a message is sent (and again whenever the model is asked after tool results, a steer or a retry), "Running code", "Reading plan.md", … — and under it a few lines that scroll as they grow: the latest of the model's thinking (its folded "Thought process" block appears once the thought is complete), the code being run or the text being written, a tool's progress. Text the model writes replaces it; while a summary is being written it says "Compacting the context" (a `compaction_start` event), and `/compact` puts the chat in its busy state — Stop aborts it, and messages sent meanwhile queue and run after it. A centred time — "Today 22:15", "Yesterday 09:02", a date further back — sits above a user message that opens the conversation or comes 15 minutes or more after the last message.

**Dropdowns.** The settings menu uses the chat's own dropdown, `selectBox(host, { options, value })` (a trigger with the chevron inside, a list with ticks and side notes, a filter past ten options, arrows / Enter / Escape; it fires `change` like a select). A page can give its own `<select>`s the same look with `enhanceSelect(select, host)`: the select stays, hidden and in step, so its `value` and `change` handlers work as before. `host` positions the list — a positioned element with the class `ra-ui`, which carries the chat's colour tokens (dark follows the system unless `data-scheme="light"`; `data-palette` picks a palette).

**Commands.** Typing `/` lists the built-in commands first, then the directory's templates and skills; Enter or a click runs a command that takes no argument (or one typed out in full), Tab fills it in. They run in the chat and send nothing to the model: `/help`, `/new` (alias `/clear`), `/resume` (the history menu), `/compact [focus]`, `/continue` (a run that stopped at the turn limit or on an error), `/model [name]` (exact id, else a unique part of one; no name opens the settings; saved like a settings change), `/effort [level]` (no level lists the model's levels, `default` clears it), `/context` (model, context use, spending, when auto-compaction starts, the directory), `/export` (the conversation as Markdown: messages and the tools each turn called), `/files`, `/settings` and `/debug` (each only where its button shows). A built-in name wins over a template of the same name.

**Files.** The header's "Files" button opens the session's directory as a layer over the transcript's right edge (the whole width on narrow screens) — the chat underneath never reflows, modelled on the harness app's sidebar and editor pane: a tree (folders fold, the agent's changes get an orange dot) in the side panel, and, when a file is opened, an editor in place of the transcript (text with ⌘S to save, word wrap on by default and remembered, a Markdown preview for `.md` files rendered by the same renderer as the chat's replies, a preview for pictures, download, delete; close it to get the chat back), plus upload (picker or drop into the panel, into the selected folder) and new file. In a reply, a `code` span naming a file of the directory (for example `/uploads/report.csv`) becomes a link that opens it there, with a download button; `[name](/path)` links do the same; every tool card for a file has "open" and "download". The agent is told this in its instructions, so it names the files it produces. The host's `onOpenFile` takes over opening when given. Read-only places (the generated `/.agent/skills/`, a read-only mount) show a lock and no download or delete, and their files open marked read-only, with no download, delete or editing; uploads and new files aimed at them go to the top instead.

**Sessions keep running.** Starting a new chat or resuming another while the agent works does not stop it: the session goes on in the background (its agent object is kept, its questions wait until you come back, the history menu marks it "running" and the History button shows a dot, a notice appears when it ends). Up to three may run in the background; past that the chat asks you to stop one first. `unmount()` stops them all.

**Settings.** The gear in the header (on when the chat owns its agent; `settings: false` hides it) sets the model (with its context / output limits from the catalogue), the thinking level when the model offers one (the catalogue's `options.inputs.reasoning_effort` levels and default; models without it, such as Claude, show no choice) — sent as `reasoning_effort`, and a thinking model's `reasoning_content` is kept on the turn and sent back with tool-calling turns, as DeepSeek requires — the max turns per run, the max output per reply (the model's maximum, or a number) and tool permissions (ask / allow everything); model, turns and output are kept per app in localStorage and applied to every session over the host's options (`agent.settings` / `agent.configure(patch)`). A run that hits the turn limit says so with a "Continue" button, and an error card has "Retry": both call `agent.continue()`, which resumes the conversation as it stands — no new user message, a fresh turn count (pi's `continue`).

**PDFs.** `read_file` (and `fs.read` in `run_js`) reads a PDF as the text of its pages, each under a `--- page N ---` line, with the usual offset/limit; a PDF with no text layer (a scan) says so. The text comes from Mozilla's pdf.js, loaded from jsDelivr the first time a PDF is read (about 500 KB gzip, worker included; nothing is added to this package) and parsed in a worker; the result is cached with the directory until the file changes (`workspace.readAsText(path)`). `configurePdf({ url, workerUrl })` points at a copy you host, `configurePdf({ load: () => import("pdfjs-dist") })` uses a bundled one; `extractPdfText(bytes)` and `isPdf()` are exported. The files panel shows a PDF in the browser's own viewer; a PDF attached in a chat without a directory goes into the message as text.

**Files, live.** The directory reports every write and delete (`workspace.onChange(fn)` → `{path, kind, remote}`), whoever did it — the agent's tools, `fs.write` in `run_js`, the host's own code — and relays changes from other tabs of the app over a BroadcastChannel (`remote: true`). The files panel refreshes on it (bursts redraw once) and reloads the open file when it changes under the editor, unless there are unsaved edits.

**Files, zipped.** A folder row's download icon, or the icon in the panel's header for the whole directory, builds a zip in the browser (`buildZip`, deflate through `CompressionStream` when available) and hands it to the browser to save.

**Rewind.** Under each user message sit the time it was sent, a copy button and "rewind to here": the conversation after that message is dropped (`agent.rewind(index)`), the message (and its attachments) goes back into the composer, and, when the session has a directory of its own in IndexedDB (the per-session `workspace` factory, not a shared workspace or a `dir` folder), its files can be put back as they were when the message was sent. The chat snapshots the work files (not skills, not mounts, files up to 2 MB, 32 MB in all; files left out are recorded and never deleted by a restore) at every prompt, keeps the newest 30 with the directory (`workspace.putData`) and drops those of rewound messages. User messages carry `ts` (when sent; assistant messages carry when they ended) and, for an expanded slash command, `typed` (what was written) in the saved session; the model sees neither.

**Scrolling.** The transcript follows new output while you are at the bottom; scrolling up stops that, and a small round button fades in above the composer to jump back to the latest.

The transcript is a virtual list (`VirtualList`, also exported): a row is built the first time it scrolls into view and only the rows around the viewport are in the DOM, so a session with thousands of messages opens at once; rows keep their element, so an opened tool card stays open when it scrolls back in. Streaming text is re-rendered at most every 100 ms and the list follows the end until you scroll up.

**Debug.** `debug: true` (or `chat.setDebug(true)`) adds a Debug button before Files. Its panel, modelled on the harness app's DebugPanel, records each session the chat opens (background runs too): **Calls** is the execution chain, run by run and turn by turn (the model, its time and finish reason), with each tool call's arguments, result, status and duration; **Requests** lists every model call with what was sent (the full payload) and what came back (message, usage, cost, time); **Events** is the raw event log with a filter; **Context** shows the session and directory ids, model, usage, how full the context is, the system prompt and the messages sent to the model; **Tools** lists what is declared to the model with its schema. The agent emits `request` and `response` events around each model call for this.

**Look.** Every colour and font is a `--ra-*` custom property on `.ra-chat`: `bg`, `panel`, `subtle`, `muted`, `fg`, `fg-muted`, `border`, `accent`, `accent-fg`, `accent-subtle`, `accent-muted`, `user-bg`, `link`, `ok`, `red`, `red-subtle`, `warn-fg`, `warn-bg`, `warn-border`, `shadow`, `shadow-md`, plus `font` and `mono` (`CHAT_COLOR_TOKENS`, `CHAT_SHARED_TOKENS`). Built-in palettes (`CHAT_PALETTES`): `claude` (default: ivory and warm charcoal, coral accent), `violet`, `slate` (neutral, blue accent) and `forest`, each with a light and a dark set. Three ways to restyle, from simplest:

```js
renderChat(el, { provider, palette: "slate", theme: "dark" });                 // a built-in palette
renderChat(el, { provider, vars: { accent: "#e11d48", font: "Inter, sans-serif" } }); // override tokens
renderChat(el, { provider, palette: { light: { accent: "#0a7" }, dark: { accent: "#3c9" } } }); // your own palette
chat.setAppearance({ palette: "forest", theme: "light" });                    // live, no remount
```

`vars` also takes `{ light, dark }`. A host stylesheet works too, with no weight games: the token rules sit in `:where()` (zero specificity) and the chat's stylesheet is inserted first in `<head>`, so `.ra-chat { --ra-accent: #e11d48 }` wins, and `.ra-chat[data-scheme=dark] { … }` targets dark only (`data-theme` is what was asked: auto/light/dark; `data-scheme` is what applies; `data-palette` names the palette). Component rules keep their own selectors, so a host's generic `button {}` or `input {}` does not leak in; to restyle a part, select it under `.ra-chat` (`.ra-chat .ra-chip { … }`), and `className` adds classes to the root. `examples/chat/index.html` is a complete page (serve the package root and open `/examples/chat/index.html`).

## Reference

| | |
|---|---|
| `openAIProvider(opts)`, `runappsProvider(client)` → `ModelProvider` | see Providers; `ProviderError`, `toProvider`, `sseData` |
| `createAgent(provider, opts)` → `Agent` | `prompt`, `steer`, `followUp`, `continue`, `dequeue`, `clearQueue`, `abort`, `rewind`, `configure`, `settings`, `limits`, `context`, `on`, `ready`, `useSkill`, `compact`, `systemPrompt`, `export`, `reset`; `messages`, `usage`, `busy`, `model`, `id`, `provider`, `lastEnd` |
| `openWorkspace(provider, opts)` → `Workspace` | `list`, `read`, `readText`, `readAsText`, `write`, `delete`, `stat`, `exists`, `isFolder`, `mount`, `unmount`, `mountOf`, `isSkillPath`, `isReadOnly`, `getData`, `putData`, `deleteData`, `onChange`, `close`, `skills`, `skillBody`, `installSkill`, `removeSkill`, `refreshSkills`, `clearWork`, `destroy`; `sessions.list/get/save/delete/clear` — sessions are kept per directory (`[space, id]`): `get(id)` reads this directory's session, else the one in the directory named after it; deleting a session saved from a directory of its own id drops that directory too |
| Tools | `defineTool`, `fileTools`, `sandboxTool`, `runInSandbox`, `askUserTool` |
| UI | `domUI`, `nullUI`; implement `AgentUI` for your own (a question's `opts.signal` aborts when the run is stopped: close it as dismissed) |
| Files | `memoryFS`; implement `AgentFS` to mount your document |
| Events | `run_start` (`message` null for `continue()`), `turn_start`, `request` / `response` (each model call), `steered` (queued steering entered the history), `queued`, `text_delta`, `reasoning_delta`, `tool_start`/`tool_update`/`tool_end`, `compaction`, `rewind`, `session_saved`, `run_end` |
| Helpers | `buildZip`, `listZip`, `readZipEntry`, `parseSkill`, `listTemplates`, `expandSlash`, `applyEdits`, `planCut`, `collectCompletion`, `buildSystemPrompt`, `estimateTokens`, `validateSchema` |

`examples/agent-demo.html` is a page to try everything against a local backend or a key. Tests: `npm test` (node:test on the built output, fetch mocked).

## License

MIT
