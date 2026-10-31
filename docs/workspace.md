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

**A real folder.** `dir` makes a folder the directory itself — any `AgentFS`. In a browser, a folder the user picks (Chromium's File System Access API) or the origin-private file system:

```js
import { directoryFS } from "@runappsai/agent/ui";

const handle = await showDirectoryPicker({ mode: "readwrite" });
const workspace = await openWorkspace(provider, { id: "project", dir: directoryFS(handle, { description: "the user's project folder" }) });
```

In Node, a folder on disk — and `store` keeps the rest (sessions, the user's skills) on disk too instead of in memory (see [Node and the command line](node.md)):

```js
import { nodeFS, nodeStore } from "@runappsai/agent/node";

const workspace = await openWorkspace(provider, { id: "project", dir: nodeFS(process.cwd()), store: nodeStore() });
```

Files then land in that folder; sessions and the user's skills stay in the workspace's store (IndexedDB in a browser).

**Where a workspace keeps things.** In a browser, IndexedDB. Where there is none (Node, Deno), memory — gone when the process ends — unless you give it a `store`: `nodeStore(folder)`, or your own `WorkspaceStoreFactory` (`open(dbName, space)` → a `WorkspaceStore`; see `nodeStore` in `src/node.ts` for a complete one).

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
const idOf = (path) => path.slice(1, -".xml".length);            // "/page-1.xml" → "page-1"
const fileOf = (page) => ({ path: `/${page.id}.xml`, size: page.xml.length, mtime: page.updatedAt });

const pagesFS = {
  description: "the diagram's pages, one XML file per page",

  // Required: every file under `prefix` ("/" for all), and a file's content.
  async list(prefix) {
    return diagram.pages.map(fileOf).filter((f) => prefix === "/" || f.path.startsWith(prefix));
  },
  async read(path) {
    const page = diagram.getPage(idOf(path));
    if (!page) throw new Error(`No such file: ${path}`);
    return page.xml;                                  // text as a string, anything else as a Uint8Array
  },

  // Optional: leave write and delete out for a read-only mount.
  async write(path, content) {                       // creates or replaces
    const xml = typeof content === "string" ? content : new TextDecoder().decode(content);
    if (diagram.getPage(idOf(path))) diagram.setPageXml(idOf(path), xml);
    else diagram.addPage(idOf(path), xml);
  },
  async delete(path) {
    if (!diagram.getPage(idOf(path))) throw new Error(`No such file: ${path}`);
    diagram.removePage(idOf(path));
  },

  // Optional: a quick look at one file (without it, the workspace finds the file in list()).
  async stat(path) {
    const page = diagram.getPage(idOf(path));
    return page ? fileOf(page) : null;
  },

  // Optional: apply edit_file's replacements yourself, in place.
  async edit(path, edits) {
    const page = diagram.getPage(idOf(path));
    if (!page) throw new Error(`No such file: ${path}`);
    diagram.transaction(() => {                       // one undo step, other users' changes kept
      for (const { oldText, newText } of edits) {
        const at = page.xml.indexOf(oldText);
        if (at < 0 || page.xml.indexOf(oldText, at + 1) >= 0) throw new Error(`"${oldText}" must appear exactly once in ${path}`);
        page.replaceRange(at, at + oldText.length, newText);
      }
    });
  },
};

workspace.mount("/diagram", pagesFS);
// The agent sees /diagram/page-1.xml, … and its description in the system prompt.
```

**Editing.** The agent's `edit_file` sends only the replacements — `{ oldText, newText }` pairs, each `oldText` found once in the original — never the whole file. What happens next is up to the mount:

- **With `edit(path, edits)`**, the mount gets those replacements as they are and changes its data in place: one node of a document, a range in an editor's buffer, a transaction that keeps other users' concurrent changes and makes one undo step. Throw an Error with a readable message when an edit does not apply; the model sees it and tries again. Use the exported `applyEdits(path, text, edits)` if you want the workspace's own matching (exact first, then tolerant of curly quotes, dashes and trailing spaces).
- **Without it**, the workspace reads the file, applies the replacements and writes the whole result back with `write` — fine for files; a mount whose `write` has to rebuild a large structure from the whole text should implement `edit`.

So a mount with `read` and `write` supports `read_file`, `write_file` and `edit_file`; `edit` makes edits precise; `delete` adds `delete_file` (and the files panel's delete). Without `write`, `edit` and `delete` the mount is read-only, and the files panel shows it with a lock. `workspace.edit(path, edits)` does the same from your code.

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
// In Node: nodePdf() from @runappsai/agent/node (with `npm i pdfjs-dist`).
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
