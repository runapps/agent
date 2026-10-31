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

Under `permissions: "ask"` (the default) a tool with `destructive: true` or a `confirm` asks the user first. `confirm` may return `false` to run without asking this time (`({ id }) => isDraft(id) ? false : "Delete …?"`). A declined call returns `"declined"` to the model. See [Permissions and dialogs](agent.md#permissions-and-dialogs) for the other modes.

## Built-in tools

| Tool | | Option |
|---|---|---|
| `ask_user` | One to three questions to the user, with options or free text, when a request is unclear. | `askUser: false` removes it |
| `run_js` | JavaScript the model writes, run in a Worker: no DOM, no network, a captured console, and `fs` bound to the workspace. The model computes, parses and transforms data with it instead of guessing, and runs skills' scripts. | `sandbox: false`, or `{ timeoutMs, network }` |
| `list_files` | Files under a folder, with sizes. | with a workspace |
| `read_file` | A file, 2000 lines / 50 KB per call, `offset` and `limit` to continue; a PDF as text. | |
| `write_file` | Create or replace a file. | |
| `edit_file` | One or more exact replacements — the model sends only the changed pieces; tolerant of curly quotes, dashes and trailing spaces. A mount with its own `edit()` applies them itself ([Workspace](workspace.md#mounting-your-apps-data)). | |
| `delete_file` | Delete a file (asks). | |
| `search_files` | Search file contents. | |

### Read before write

The agent does not change a file from a stale or partial view of it — the user may be editing files while it works:

- **Overwrite** (`write_file`, `fs.write` in `run_js`) of an existing file needs the model to have read all of it in this conversation. After a partial read (`read_file` shows 2000 lines at a time), it is told to read the rest (`offset=…`) or use `edit_file`.
- **Edit** (`edit_file`) needs it to have read the file — part is enough, since an edit only replaces the text it quotes.
- **Delete** (`delete_file`, `fs.remove`) of a file it read is refused if the file changed since; a file it never read can be deleted.
- Any of them is refused when the file **changed since the model read it** — the user edited it in the files panel, your app changed a mounted document, another tab wrote it. The model is told why and reads the file again.

New files can always be written, and the model's own writes count as read. `fs.read` in `run_js` counts as reading. A file's version is its modified time, size and a fingerprint of its content (files over 4 MB: time and size), so even a same-size change in the same instant shows. What the model has read is forgotten when the conversation is compacted or rewound, since it no longer has those contents. Turn it all off with `readBeforeWrite: false`.

The file tools come with a workspace; `fileTools: ["read_file", "list_files", "search_files"]` gives a read-only agent, `fileTools: false` none.

`sandboxTool(workspace, options)` and `runInSandbox(workspace, code, input)` are exported if you want the sandbox on its own.
