# Tools

A tool is a function the model may call. Describe it, declare its arguments as JSON Schema, and implement `execute`.

```js
import { defineTool } from "@runappsai/agent";

const getWeather = defineTool({
  name: "get_weather",
  description: "Current weather for a city. Use when the user asks about the weather or what to wear.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name, e.g. 'Lisbon'" },
      unit: { type: "string", enum: ["c", "f"], default: "c" },
    },
    required: ["city"],
    additionalProperties: false,
  },
  async execute({ city, unit = "c" }, { signal }) {
    const res = await fetch(`/api/weather?city=${encodeURIComponent(city)}&unit=${unit}`, { signal });
    return res.json();                     // any JSON value is sent to the model as JSON
  },
});

createAgent(provider, { tools: [getWeather] });
```

## Writing a good tool

- **`name`** — `^[A-Za-z0-9_-]{1,64}$`. Verbs in snake_case read best (`create_invoice`).
- **`description`** — what it does *and when to use it*. The model decides from this alone.
- **`parameters`** — close objects with `additionalProperties: false` and list `required`. Arguments are checked against the schema before `execute` runs; a mismatch goes back to the model as a readable error and the model corrects the call.
- **`guidelines`** — one or more sentences for the system prompt when a rule is too long for the description (`"Always call list_invoices before create_invoice to avoid duplicates."`).

## What `execute` gets

```js
execute(args, ctx)
```

| `ctx` | |
|---|---|
| `signal` | Aborted when the user stops the run. Pass it to `fetch` and long loops. |
| `update(text)` | Report progress; shown live by the chat UI (a `tool_update` event). |
| `ui` | The agent's dialogs (`confirm`, `select`, `input`, `notify`). |
| `workspace` | The agent's workspace, or null. |
| `agent` | The agent. |
| `callId` | The model's id for this call. |
| `progress(made)` | Say whether this call brought anything new (see [Calls that go nowhere](#calls-that-go-nowhere)). |

```js
const exportReport = defineTool({
  name: "export_report",
  description: "Export the report as a PDF into the workspace.",
  async execute(_args, { update, workspace, signal }) {
    update("Collecting data…");
    const data = await loadData({ signal });
    update(`Rendering ${data.pages} pages…`);
    const pdf = await renderPdf(data, { signal });
    await workspace.write("/exports/report.pdf", pdf, "application/pdf");
    return "Saved /exports/report.pdf";
  },
});
```

## What `execute` returns

| Return | The model gets |
|---|---|
| a string | the string |
| a number, boolean, object, array | JSON |
| content parts `[{ type: "text", … }, { type: "image_url", … }]` | text and pictures |
| `{ content, details }` | `content` only; `details` stays for your app (in the `tool_end` event) |
| `undefined`, `null`, `""` | `"OK"` |

Results longer than `maxResultChars` (default 32 000 characters) are cut, with a note saying so. A thrown error is sent to the model as an error result.

A tool message can only carry text in the OpenAI format, so pictures (and audio or video) a tool returns go to the model in a user message right after the batch's results, each labelled with the call it came from. Only the latest two batches' pictures are sent again on later turns — each costs thousands of tokens; older ones are replaced by a note telling the model to call the tool again for the current state.

```js
// A screenshot back to a vision model
execute: async () => [
  { type: "text", text: "The current canvas:" },
  { type: "image_url", image_url: { url: await canvas.toDataURL("image/png") } },
]
```

## Asking before acting

```js
const deleteProject = defineTool({
  name: "delete_project",
  description: "Delete a project and all its files.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  destructive: true,                                   // asks "Allow delete_project?" first
  confirm: ({ id }) => `Delete project ${id} and all its files?`,   // or your own question
  execute: ({ id }) => api.deleteProject(id),
});
```

Under `permissions: "ask"` (the default) a tool with `destructive: true` or a `confirm` asks the user first. `confirm` may return `false` to run without asking this time (`({ id }) => isDraft(id) ? false : "Delete …?"`), or `{ title, message }` to show the details under the question (`message` goes to `ui.confirm`'s second argument — the arguments, what will happen). A declined call returns `"declined"` to the model. `{ title, always: { label, onChoose } }` adds a third answer to the question ("Always allow"): the call runs and `onChoose()` is called — where you stop asking from then on (turn your app's auto-apply setting on). `ok` names the confirm button ("Apply"), and `body: () => element` puts content of your own in the question — a diff with a checkbox per change, say: the chat shows it under the message, the user sets what they like in it, and `execute` reads that from the element (keep a reference in the tool's closure); a terminal leaves it out. See [Permissions and dialogs](agent.md#permissions-and-dialogs) for the other modes.

### Refusing a call before it is asked: `validate`

The schema checks the shape of the arguments; `validate(args)` checks what the schema cannot — the text to replace is not in the document, the record changed since it was read. It runs after the schema check and before any question: return (or throw) the reason and the call ends there, the model gets the reason as its error, and the user is never asked to approve a call that would fail.

```js
defineTool({
  name: "edit_doc",
  // …
  validate: ({ oldText }) => (doc.includes(oldText) ? undefined : "oldText is not in the document; read it again"),
  confirm: () => "Apply this change?",
  execute: ({ oldText, newText }) => { /* … */ },
});
```

`execute` still has to check again when it can be called with something that changed in between (the user typed while the question waited).

## Stopped while running: `whenStopped`

When the user stops the run while a call is still running, the run ends at once; the call's own work may go on (a batch already started). By default the model is told the call was skipped. `whenStopped(args)` returns what it should be told instead — how far the call got — so a later turn does not redo it:

```js
defineTool({
  name: "run_batch",
  // …
  whenStopped: (args) => JSON.stringify({ ok: false, error: "stopped by the user", done: finishedOf(args.ids) }),
});
```

## How the chat shows a call: `display`

`renderChat` shows a call as a card: the tool's name, its arguments, its result. A tool for people who never see tool names says it in its own words (the model never sees any of this; an exception in one of these falls back to the default):

```js
defineTool({
  name: "add_node",
  // …
  display: {
    label: (args) => `Add a ${args.type} node`,           // the card's title and the folded line ("Add a Text node ×2")
    icon: "<svg …>",                                       // the card's icon
    render: ({ args, status, result, details }) => chipsFor(args, result), // your element under the title, visible while folded
    outcome: ({ result }) => summaryOf(result),             // beside the status mark ("Added", "$0.12")
  },
});
```

`render` runs when the call starts (`status: "running"`) and again with the result; `details` is what `execute` returned as details (live calls; a reopened conversation has only the result text). The arguments and the raw result stay in the card, behind its fold. `display: { hidden: true }` gives a tool no card at all (nor a line in the exported conversation): a call the user need not see.

## Tools that end the run

Normally every tool call is followed by another model call, so the model can use the result. A tool whose result the model does not need can say `endsRun: true`: when a reply has text and calls only such tools, the agent runs them and the run ends there — no further call, no tokens spent resending the conversation. Called alongside other tools, or in a reply with no text, the run goes on as usual. The chat's next-message suggestion (`nextPrompt`) is such a tool.

## Tools for models that see

`vision: true` offers a tool only while the model in use is known to see pictures — a screenshot tool, say, is useless to a text-only model, and offering it invites a call whose result it cannot read:

```js
const screenshot = defineTool({
  name: "capture_page",
  description: "A picture of the page as the user sees it now.",
  readOnly: true,
  vision: true,
  execute: async () => [{ type: "text", text: "The page:" }, { type: "image_url", image_url: { url: await snap() } }],
});
```

## Calls that go nowhere

Models sometimes circle: they read the same lines again with another limit, repeat a search, retry a call that fails the same way. The agent watches each round of tool calls for anything new:

- A tool that **changes things** succeeding with arguments it has not had before is progress.
- A **read-only** tool (`readOnly: true`) is progress only when its result is one the run has not had since the last change — reading another range of lines already read is not (`read_file` reports that itself).
- The same error again is not progress; a declined call or the user steering is.

After three rounds in a row without anything new the model is told to use what it has already read; after six the run ends with an error. Mark your look-only tools `readOnly: true`, and call `ctx.progress(false)` when a call returned nothing new in a way the result text does not show (a refreshed timestamp, say). `loopGuard: { warn, stop }` changes the counts; `loopGuard: false` turns it off.

```js
const listOrders = defineTool({
  name: "list_orders",
  description: "List the user's orders, newest first.",
  readOnly: true,
  execute: async (_args, ctx) => {
    const { orders, fetchedAt } = await api.orders();
    return { orders };            // fetchedAt left out: it would make every result look new
  },
});
```

## MCP servers

`connectMCP(url, options)` connects to a [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP and returns its tools, ready for an agent. No SDK: plain `fetch`, in browsers and Node.

```js
import { connectMCP, createAgent } from "@runappsai/agent";

const github = await connectMCP("https://mcp.example.com/mcp", { token: githubToken });
const agent = createAgent(provider, {
  tools: [...myTools, ...github.tools],
  instructions: [myInstructions, github.instructions].filter(Boolean).join("\n\n"),
});
// …
await github.close();          // ends the session on the server
```

| Option | Default | |
|---|---|---|
| `token` | | Sent as `Authorization: Bearer …`. |
| `headers` | | More request headers. |
| `name` | the server's own | What the server is called in tool descriptions and confirmations (the name the user gave it). |
| `prefix` | the server's name | Tool names are `<prefix>__<tool>` (64 characters at most), so two servers' tools never clash. |
| `confirm` | `"always"` | Ask before every call (`"ask"` permissions); `"unless-read-only"` lets tools the server marks `readOnlyHint` run without asking; `"never"`. The question names the server and the tool and shows the arguments. |
| `images` | `false` | Pass pictures a tool returns to the model; otherwise they are named, not sent. |
| `timeoutMs` | `60000` | Longest a request may take. |
| `maxTools`, `maxResultChars` | `64`, `32000` | Limits. |
| `fetch` | global | Your own fetch (a proxy, tests). |
| `signal` | | Cancels connecting. |

The connection has `tools`, `serverTools` (what the server said about each), `server` (`{ name, version, title }`), `instructions`, `refresh()` (read the list again) and `close()`.

What it handles: the session id the server gives, answers that come as JSON or as an event stream, progress notifications (shown as the call's `tool_update`), a session the server has forgotten (started again once), stopping a call (the server is sent a cancellation), and requests the server makes of the client (`ping` is answered; sampling and the like are declined). A tool's text, resources and links go to the model; `isError` results become errors. Errors never include the token or the server's response headers; a call that fails after it was sent says its effect on the server is unknown, so the model does not repeat a side effect blindly.

In a browser the server must allow your page's origin (CORS) and expose the `Mcp-Session-Id` header. OAuth sign-in and local (stdio) servers are not supported: get the token yourself and pass it.

## Built-in tools

| Tool | | Option |
|---|---|---|
| `ask_user` | One to three questions to the user, with options or free text, when a request is unclear. | `askUser: false` removes it |
| `run_js` | JavaScript the model writes, run in a Worker: no DOM, no network, a captured console, and `fs` bound to the workspace. The model computes, parses and transforms data with it instead of guessing, and runs skills' scripts. | `sandbox: false`, or `{ timeoutMs, network }` |
| `list_files` | Files under a folder, with sizes. | with a workspace |
| `read_file` | A file, 2000 lines / 50 KB per call, `offset` and `limit` to continue; a PDF as text; a picture shown to a model that sees pictures. | |
| `write_file` | Create or replace a file (`replace: true`: without reading it first, for a rewrite from scratch). | |
| `edit_file` | One or more exact replacements — the model sends only the changed pieces; tolerant of curly quotes, dashes and trailing spaces. A mount with its own `edit()` applies them itself ([Workspace](workspace.md#mounting-your-apps-data)). | |
| `delete_file` | Delete a file (asks). | |
| `move_file`, `copy_file` | Move/rename or copy a file; never over an existing one. What was read of the source counts as read of the copy. | |
| `search_files` | Search file contents. | |

### Read before write

The agent does not change a file from a stale or partial view of it — the user may be editing files while it works:

- **Overwrite** (`write_file`, `fs.write` in `run_js`) of an existing file needs the model to have read all of it in this conversation. After a partial read, `write_file` refuses once and puts the unread lines in its error (up to one read's worth: 2000 lines or 50 KB); they count as read, so the next `write_file` goes through, or the error says from which `offset` to read on. `fs.write` just says to read the rest.
- **`replace: true`** on `write_file` overwrites an existing file without reading it, for when the user asked for it to be rewritten from scratch. The result says what went unread (`Replaced /a.js (3 bytes). Its previous content (3 lines) was replaced without being read.`), so it shows in the tool card. The parameter exists only while the guard is on.
- **Edit** (`edit_file`) needs it to have read the file — part is enough, since an edit only replaces the text it quotes.
- **Delete** (`delete_file`, `fs.remove`) of a file it read is refused if the file changed since; a file it never read can be deleted.
- Any of them is refused when the file **changed since the model read it** — the user edited it in the files panel, your app changed a mounted document, another tab wrote it. The model is told why and reads the file again.

New files can always be written, and the model's own writes count as read. `fs.read` in `run_js` counts as reading. A file's version is its modified time, size and a fingerprint of its content (files over 4 MB: time and size), so even a same-size change in the same instant shows. What the model has read is forgotten when the conversation is compacted or rewound, since it no longer has those contents. Turn it all off with `readBeforeWrite: false`.

The file tools come with a workspace; `fileTools: ["read_file", "list_files", "search_files"]` gives a read-only agent, `fileTools: false` none.

`sandboxTool(workspace, options)` and `runInSandbox(workspace, code, input)` are exported if you want the sandbox on its own.
