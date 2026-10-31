# Workspace and files

A workspace is the directory the agent works in. Give an agent one and it gets the file tools (`list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `search_files`), skills, saved sessions, memory notes and prompt templates.

```js
import { openWorkspace, createAgent } from "@runappsai/agent";

const workspace = await openWorkspace(provider, { id: "default" });
await workspace.write("/notes/todo.md", "- ship v2\n");

const agent = createAgent(provider, { workspace });
await agent.prompt("Add 'write the launch post' to /notes/todo.md");
console.log(await workspace.readText("/notes/todo.md"));
```

## Where the files live

By default a workspace is a virtual file tree in **IndexedDB**: one database per app, in which every `id` is a separate directory. The same id opens the same files again after a reload and in other tabs.

```js
openWorkspace(provider, {
  id: "default",          // which directory
  project: "my-app",      // which app's database (default: the provider's name)
});
```

**A directory per conversation.** The chat UI takes a function and opens a directory under each session's id, so every conversation has its own files; resuming a conversation reopens them:

```js
renderChat(el, { provider, workspace: (sessionId) => openWorkspace(provider, { id: sessionId }) });
```

Pass one workspace instead (`workspace: await openWorkspace(provider, { id: "shared" })`) and every conversation shares the same files.

**A real folder.** `dir` makes a folder the directory itself — a folder the user picks (Chromium's File System Access API), the origin-private file system, or any `AgentFS`:

```js
import { directoryFS } from "@runappsai/agent";

const handle = await showDirectoryPicker({ mode: "readwrite" });
const workspace = await openWorkspace(provider, { id: "project", dir: directoryFS(handle, { description: "the user's project folder" }) });
```

Files then land in that folder; sessions and the user's skills stay in IndexedDB.

## Reading and writing

```js
await workspace.write("/data/report.csv", csvText);                     // text
await workspace.write("/img/logo.png", bytes, "image/png");             // bytes, with a type
const { data, size, contentType } = await workspace.read("/img/logo.png");
const text = await workspace.readText("/data/report.csv");              // throws for binary files
const pdf = await workspace.readAsText("/docs/spec.pdf");               // { text, kind: "pdf" } — see PDFs
await workspace.delete("/data/old.csv");
const files = await workspace.list("/data");                             // [{ path, size, contentType, mtime }]
await workspace.exists("/data/report.csv");
await workspace.clearWork();                                             // empty the directory (skills stay)
await workspace.destroy();                                               // drop this directory and its sessions
```

Paths are absolute and POSIX-style (`/a/b.txt`); `..` is resolved. Text is stored as strings, everything else as bytes.

## Mounting your app's data

Mount an `AgentFS` at a path and the agent reads (and, if you allow it, edits) your app's own data as files: the document being edited, a project's pages, a cloud folder.

```js
const pagesFS = {
  description: "the diagram's pages, one XML file per page",
  async list(prefix) {
    return diagram.pages.map((p) => ({ path: `/${p.id}.xml`, size: p.xml.length }));
  },
  async read(path) {
    const page = diagram.pages.find((p) => `/${p.id}.xml` === path);
    if (!page) throw new Error(`No such file: ${path}`);
    return page.xml;
  },
  async write(path, content) {                    // leave write/delete out for a read-only mount
    diagram.setPageXml(path.slice(1, -4), String(content));
  },
};

workspace.mount("/diagram", pagesFS);
// The agent sees /diagram/page-1.xml, … and its description in the system prompt.
```

Paths given to the mount are relative to it (`/page-1.xml`). A mount is your live data, not storage: nothing of it is saved by the workspace. `memoryFS({ "/a.md": "…" }, { description, readonly })` is a ready-made in-memory one (its `files` map is the content). `workspace.unmount("/diagram")` removes it.

## Files with a meaning

| Path | |
|---|---|
| `/AGENTS.md` | Your instructions for this project; added to the system prompt. |
| `/memory/notes.md` | The agent's memory: it appends a line to remember something, and the notes are shown at the start of every conversation in this directory. |
| `/prompts/<name>.md` | Prompt templates, typed as `/name args`. |
| `/.agent/skills/` | The skills, generated and read-only (see [Skills](skills.md)). |
| `/skills/` | The user's skills, shared by every directory of the app. |
| `/uploads/` | Where the chat UI saves attached files (`uploadsDir`). |

### Prompt templates

A file `/prompts/standup.md`:

```markdown
---
description: Write my standup from the notes of a day
argument-hint: <date>
---
Read /notes/$1.md and write my standup: done, doing, blocked. Three bullets each at most.
```

Typing `/standup 2026-11-01` sends the expanded text. Arguments follow bash: `$1`, `$2`, `$@` (all), `${2:-default}`, `${@:2}` (from the second on); quotes group words. `listTemplates(workspace)` lists them (the chat shows them in its `/` menu).

## PDFs

`read_file` (and `fs.read` inside `run_js`) reads a PDF as the text of its pages, each under a `--- page N ---` line; a scanned PDF without a text layer says so. The text comes from Mozilla's pdf.js, loaded from jsDelivr the first time a PDF is read (about 500 KB gzipped; nothing is added to this package), and is cached with the directory until the file changes.

```js
import { configurePdf } from "@runappsai/agent";
configurePdf({ url: "/vendor/pdf.min.mjs", workerUrl: "/vendor/pdf.worker.min.mjs" });   // a copy you host
configurePdf({ load: () => import("pdfjs-dist") });                                       // a bundled one
```

## Change events

Every write and delete is reported, whoever made it — the agent, `run_js`, your code — and changes in other tabs of the app arrive too:

```js
const off = workspace.onChange(({ path, kind, remote }) => {
  // kind: "write" | "delete"; remote: true when another tab did it
  if (path.startsWith("/notes/")) refreshNotesList();
});
```

## Keeping your own data with a directory

`putData(key, value)`, `getData(key)` and `deleteData(key)` store any JSON-able value alongside the directory (the chat keeps its rewind snapshots there). They are dropped with the directory.

## Sessions

`workspace.sessions` lists and manages the conversations saved in the app's database — see [Sessions](agent.md#sessions).

```js
await workspace.sessions.list();     // every conversation of the app, newest first
await workspace.sessions.get(id);
await workspace.sessions.delete(id); // a conversation that had a directory of its own takes it along
await workspace.sessions.clear();    // all of them
```
