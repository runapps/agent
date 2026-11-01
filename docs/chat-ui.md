# Chat UI

`renderChat(element, options)` turns an element into a complete chat with an agent. Plain DOM, no framework; its styles are injected once. Give the element a height. It comes from `@runappsai/agent/ui` (the browser script has it on `RunAppsAgent`), and runs on the core: the agent, workspace and providers are the ones from `@runappsai/agent`.

```html
<div id="assistant" style="height: 100vh"></div>
<script type="module">
  import { openWorkspace, openAIProvider } from "@runappsai/agent";
  import { renderChat } from "@runappsai/agent/ui";

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
- **Tool calls** — one quiet line per chain of calls, worded from the tools ("read 2 files, edited 1 file"), opening to a card per call with arguments, result (pictures a tool returned shown under it), duration and status.
- **Questions** — `ask_user` and confirmations appear inline above the composer; while one waits the composer folds to a line, and answering brings the view back to the latest output. A short chat (under 420 px) keeps its composer compact.
- **The composer** — Enter sends (the ↵ button appears once there is something to send), Shift+Enter breaks a line. While the agent runs, the ↵ becomes a stop square, Enter **steers** (inserts into the current task) and ⌘↵ / Ctrl+↵ **queues** a follow-up (with typed text, *Steer* and *Follow-up* buttons appear too); queued messages sit in a card above the box with *send now*, *edit* and *remove*.
- **Attachments** — paperclip, drag and drop, or paste. Files are saved under `/uploads/` in the conversation's directory and named in the message; pictures also go to the model as images — unless the model is known to be text-only: then they stay files and the user is told the model cannot see them. A video (25 MB at most) goes to the model as a video unless the model is known not to take one. Without a directory, a text file or a PDF's text goes into the message itself. 20 MB per file.
- **Files** — the header's *Files* button opens the directory: a tree, an editor (⌘S, word wrap, Markdown preview), picture and PDF previews, upload, new file, download (folders as zip). File paths in replies open there. Live: changes by the agent show at once.
- **Skills** — the *Skills* button lists the skills (with a count), uploads zips, removes the user's own.
- **Chats** — the conversation list (the open one first), new chat, delete. Conversations keep running when you switch away (up to three in the background).
- **Settings** — the gear: model (with context and output limits, and which models see pictures), thinking level when the model has one, max turns, max output, tool permissions. Kept per app in the browser and applied to every conversation.
- **Rewind** — hover a user message: when it was sent, copy, *rewind to here* (the conversation after it is dropped, the message goes back into the composer, and the directory's files can be restored to that moment).
- **How a run ended** — *Stopped.*, the turn limit with *Continue*, an error with *Retry*; kept across reloads until the next run.
- **Context and spending** — a ring in the header shows how full the model's window is; a click opens a panel with the figures (used / window, model), what the conversation has cost (cost, input and output tokens, calls), when it compacts on its own, and *Compact now*. Older turns are summarised automatically.
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
| `emptyState` | | What an empty conversation shows: text, your own element, or `{ icon, title, text, align }`. |
| `suggestions` | | Starter prompts shown in the empty state. |
| `sessions` | on with a workspace | The conversation list and *New chat*. `false` (or your own `agent`): one conversation, and a *Clear* button that starts it over. |
| `skillsMenu` | on with a workspace | The *Skills* button. |
| `settings` | on | The settings gear. |
| `attachments` | on | Paperclip, drop and paste. |
| `uploadsDir` | `/uploads` | Where attachments are saved (with a workspace and file tools; with `fileTools: false` a text file goes into the message itself, so the model can read it). |
| `showUsage` | on | The context ring in the header and its panel (context use, spending, *Compact now*). |
| `locale` | the document's | `"en"` or `"zh"`. |
| `theme` | `"auto"` | `"auto"`, `"light"`, `"dark"`. |
| `palette` | `"claude"` | `"claude"`, `"violet"`, `"slate"`, `"forest"`, or your own. |
| `vars` | | Colour and font overrides (see Theming). |
| `className` | | Extra classes on the chat's root. |
| `debug` | `false` | The *Debug* panel. |
| `onOpenFile(path)` | | Open file links yourself instead of in the files panel. |
| `onLink(href, text)` | | Called when a link in the conversation (a reply, its thinking, a tool card) is clicked, before the chat's own handling; return `true` when you handled it (e.g. your app's own documentation links open in your viewer). |
| `files` | on with a workspace | The *Files* button and panel; `false` for a host with its own file view (links go to `onOpenFile`). |
| `headerActions` | | Buttons of your own for the header, placed before the settings gear. |
| `headerEnd` | | Buttons of your own after the settings gear (a close button). |
| `composerActions` | | Buttons of your own in the composer's toolbar (see below). |
| `settingsTabs` | | Tabs of your own in the settings panel (see below). |
| `permissionsSetting` | on | The *Tool permissions* choice in the settings; `false` for an app that decides when to ask itself. |
| `rewindState` | | `{ label, take(), restore(value) }`: your app's own state (an editor's text, a form) snapshotted as each message is sent; rewinding offers `label` as a checkbox and calls `restore` with that snapshot. Needs a workspace. |
| `onSession(agent)` | | Called with each conversation's agent as it opens. |

## The empty conversation: a greeting and starter prompts

While a conversation is empty the chat shows a line of text and, under it, buttons of starter prompts. Both are yours:

```js
renderChat(el, {
  provider,
  emptyState: "What can I help you with?",          // the text (default "Start a conversation")
  suggestions: [                                    // the buttons; a click puts the text in the composer
    "Summarise the open document",
    "List what changed this week",
    "/skill:review",                                // a skill or a template works too
  ],
});
```

For an icon, a heading and a line under it, pass them as an object (`icon` is SVG markup or an element; `align: "start"` sets it to the left):

```js
renderChat(el, {
  provider,
  emptyState: { icon: '<svg viewBox="0 0 24 24">…</svg>', title: "Let's build something useful.", text: "Tell me what it should do.", align: "start" },
});
```

`emptyState` can also be an element of your own — any HTML: a logo, a paragraph, links — or `null` for nothing:

```js
const welcome = document.createElement("div");
welcome.innerHTML = `<img src="/logo.svg" width="40" alt=""><p>Ask about your orders, invoices or shipping.</p>`;
renderChat(el, { provider, emptyState: welcome, suggestions: ["Where is my last order?"] });
```

Leave `suggestions` out for no buttons. The text of a button goes into the composer rather than being sent, so the user can change it first; to send one at once from your own UI, call `chat.prompt(text)`.

## The handle

```js
const chat = renderChat(el, options);
await chat.ready;              // the first conversation is open

chat.agent;                    // the open conversation's Agent (events, messages, usage…)
chat.prompt("Hello");          // send as if typed
chat.setInput("Draft: ");      // fill the composer
chat.insertText("[12] Shot 3"); // put text at the cursor, keeping what was typed
chat.addContext({ id, label, text });  // a chip in the composer, sent with the next message (below)
await chat.newSession();
await chat.resume(id);
await chat.deleteSession(id);
await chat.clear();            // start the open conversation over (the Clear button)
await chat.refresh();          // re-read skills and templates for the / menu
chat.setDebug(true);
chat.setAppearance({ theme: "dark", palette: "slate" });
chat.ui;                       // the inline dialogs — your own tools can use them
chat.unmount();                // remove it; agents the chat made are stopped
```

### What `unmount()` releases

Everything the chat set up for itself: its element, the listeners it put on `document`, `window` and the colour-scheme query, its resize observer, timers and animation frames, open dropdowns and dialogs (a pending question is dismissed), the object URLs of attachment previews, the debug panel's subscriptions. Agents the chat made are aborted, and the workspaces it opened through a `workspace` function are closed (their database connections and the cross-tab channel). A conversation still running in the background is stopped too.

What stays, on purpose:

- **Yours.** An `agent` or a `workspace` you passed in is not aborted or closed — you made it, you release it (`workspace.close()`).
- **Shared by the page.** The injected `<style>` (one for every chat on the page); pdf.js and its worker once a PDF was read; the module's caches of parsed skill zips (at most 64) and fetched skill URLs. A later `renderChat` reuses them.
- **Saved data.** Conversations, files and settings stay in the browser's storage — that is what lets the next mount resume. `workspace.sessions.clear()` or `workspace.destroy()` remove them.

`onSession` is the place to attach your own listeners, since every new or resumed conversation has a new agent:

```js
renderChat(el, {
  provider,
  onSession: (agent) => {
    agent.on("tool_end", (e) => analytics.track("tool", { name: e.name, status: e.status }));
  },
});
```

## Your own pieces: header buttons, `composerTop`, toolbar buttons, the empty state

`headerActions` (buttons before the settings gear), `headerEnd` (buttons after it, at the far end — a close or collapse button), `composerTop` (a panel right above the composer — a plan to approve, a status line) and an element given as `emptyState` are yours: you fill and update them (a React portal works), and the chat's own button and input resets do not touch them (they get the class `ra-host`), so your styles apply as they are. Content a tool's `display.render` returns is treated the same way.

`composerActions` puts buttons of yours into the composer's toolbar, after the attach button. An element goes in as it is (and keeps your styles); a plain object is drawn like the chat's own toolbar buttons and is changed later by its `id`:

```js
const chat = renderChat(host, {
  // …
  composerActions: [
    { id: "analyze", label: "Analyse the backtest", icon: "<svg …>", hidden: true,
      onClick: () => chat.prompt("Analyse my latest backtest") },
  ],
});
// later, when there is something to analyse
chat.updateComposerAction("analyze", { hidden: false });
chat.updateComposerAction("analyze", { disabled: true, label: "Backtest running…" });
```

`iconOnly: true` draws only the icon, with the label as its tooltip.

`settingsTabs` adds tabs of yours to the gear's panel, after the chat's own "Model" tab, so a host needs no second settings button and the panel stays short. In a tab the chat draws a `toggle` or a `select`, reads it back when the user presses Apply (calling `onChange` only for a value that changed) and puts back `default` on Reset; you keep the value and act on it. An element goes in as it is. The panel reopens on the tab last shown.

```js
renderChat(host, {
  // …
  settingsTabs: [{
    label: "Editor",
    fields: [
      { id: "autoApply", type: "toggle", label: "Apply changes automatically", hint: "Off: ask before every change",
        default: true, value: () => prefs.autoApply, onChange: (v) => { prefs.autoApply = v; save(prefs); } },
      { id: "market", type: "select", label: "Market", options: [{ value: "spot", label: "Spot" }, { value: "swap", label: "Perpetual" }],
        value: () => prefs.market, onChange: (v) => { prefs.market = v; save(prefs); } },
    ],
  }],
});
```

## Context from your page: `addContext`

What the user picked or selected in your app — an element in a preview, a passage of a document, a row of a table — goes into the next message as a chip in the composer, beside the attached files:

```js
const remove = chat.addContext({
  id: "selection",                 // a later item with the same id replaces this one
  label: "button.primary",         // the chip, and the line that names it in the message
  title: "<button class=…>",       // the chip's tooltip (default: the label)
  icon: "<svg …>",                 // the chip's icon (default: a pointer)
  text: JSON.stringify(selection), // what the model reads
});
remove();                          // take it out again
```

The user can remove it with its ×; sending takes it, and a message may be only context. The model gets one text part per item after the typed words, `[context] <label>` on the first line and `text` below; the user's bubble shows the chip, not the text. Rewinding to the message puts the items back into the composer. Mark page content as untrusted in `text` yourself when it is.

## One conversation: `sessions: false`

An app with one conversation per document or project turns the list off:

```js
renderChat(el, { provider, workspace: projectWorkspace, sessions: false });
```

The header then has no *Chats* or *New chat*; a **Clear** button (after a confirmation) starts the conversation over — the messages, the queue and the usage go, the conversation keeps its id, the files stay. `/new` and `/clear` do the same, `/resume` is not offered, and `chat.clear()` does it from your code. A chat showing your own `agent` works the same way.

## Inside your app's layout

The chat fills the element you give it and can live in a side panel of your own page. Things to know when it does:

- **Moving it** — taking the element out of the page and putting it back (a framework re-render) resets its scroll position, as for any scrolled element. Keep the element where it is, or save `element.querySelector(".ra-log").scrollTop` before and set it after.
- **Your file view** — `files: false` hides the chat's Files panel; file paths in replies call `onOpenFile(path)`.
- **Your buttons** — `headerActions: [button]` puts them in the chat's header; give each an `aria-label` (in a narrow chat the labels fold to icons).
- **Your colours** — `palette: { light: {…}, dark: {…} }` with your page's tokens, and `vars: { font }`.
- **Your focus styles** — a generic rule of yours such as `textarea:focus-visible { outline: … }` does not reach the composer's text area: the rounded box shows focus.

## Using your own agent

```js
const agent = createAgent(provider, { tools, workspace, ui: myDialogs });
renderChat(el, { agent });
```

The chat shows that agent; it does not make new ones (no conversation list or *New chat*; *Clear* starts it over).

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
import { selectBox, enhanceSelect } from "@runappsai/agent/ui";

// Give an existing <select> the same look; its .value and change events keep working.
const lang = enhanceSelect(document.querySelector("#language"), document.querySelector("aside"));
lang.destroy();     // later: the plain <select> again

// Or build one.
const box = selectBox(document.querySelector("aside"), {
  options: [{ value: "en", label: "English" }, { value: "zh", label: "中文", note: "Chinese" }],
  value: "en",
});
box.el.addEventListener("change", () => console.log(box.value));
container.append(box.el);
box.close();        // close its list (it closes itself on a choice, Escape or a click outside)
```

The second argument is where the list opens: a positioned element (`position: relative`) with the class **`ra-ui`**, which gives it the chat's colours (dark follows the system unless `data-scheme="light"`; `data-palette` picks a palette).

## Debug

`debug: true` (or `chat.setDebug(true)`) adds a *Debug* button: the call chain run by run and turn by turn, every request sent to the model and what came back, the event log, the context (system prompt, messages, limits) and the tools declared to the model.

In debug mode the chat is framed with an orange dashed border, so you see which element of your page it is mounted in and how much of it it fills.
