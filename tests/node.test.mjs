// @runappsai/agent/node: a folder as the directory, the workspace's storage
// on disk (sessions, the user's skills, files), and terminal dialogs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Workspace, buildZip } from "../dist/index.js";
import { nodeFS, nodeStore, terminalUI } from "../dist/node.js";

const tmp = () => mkdtemp(join(tmpdir(), "ra-agent-"));

test("nodeFS — a folder as the directory: list (ignoring .git / node_modules), read text and bytes, write into new folders, delete; paths cannot leave it", async () => {
  const dir = await tmp();
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules/x"), { recursive: true });
  await writeFile(join(dir, "src/a.ts"), "let a = 1;");
  await writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  await writeFile(join(dir, "node_modules/x/i.js"), "ignored");
  const fs = nodeFS(dir);
  const ws = await Workspace.open(null, { id: "proj", project: "nodefs", dir: fs, indexedDB: null, userSkills: false });
  assert.deepEqual((await ws.list("/")).map((f) => f.path).sort(), ["/logo.png", "/src/a.ts"]);
  assert.equal(await ws.readText("/src/a.ts"), "let a = 1;");
  assert.ok((await ws.read("/logo.png")).data instanceof Uint8Array);
  await ws.write("/docs/new/readme.md", "# hi");
  assert.equal(await readFile(join(dir, "docs/new/readme.md"), "utf8"), "# hi");
  await ws.delete("/src/a.ts");
  assert.equal(await ws.exists("/src/a.ts"), false);
  await assert.rejects(fs.read("/../outside.txt"), /outside the folder|No such file/);
  assert.match(ws.describe(), new RegExp(`the folder ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const ro = nodeFS(dir, { readonly: true });
  assert.equal(ro.write, undefined);
});

test("nodeStore — sessions, the user's skills and the directory's files survive a new process (a new Workspace on the same folder)", async () => {
  const root = await tmp();
  const store = nodeStore(root);
  const a = await Workspace.open(null, { id: "s1", project: "cli", store });
  await a.write("/notes.md", "kept");
  await a.write("/bin/data.bin", new Uint8Array([1, 2, 3]));
  await a.putData("ckpt", { at: 1, files: [{ path: "/x", data: new Uint8Array([9]) }] });
  await a.installSkill(await buildZip([{ path: "SKILL.md", data: "---\ndescription: Packed skill\n---\nbody" }]), { name: "packed" });
  const usage = { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  await a.sessions.save({ v: 2, id: "s1", messages: [{ role: "user", content: "hello" }], usage, droppedTurns: 0, savedAt: 1 });

  // A new process: everything is read back from disk.
  const b = await Workspace.open(null, { id: "s1", project: "cli", store: nodeStore(root) });
  assert.equal(await b.readText("/notes.md"), "kept");
  assert.deepEqual([...(await b.read("/bin/data.bin")).data], [1, 2, 3]);
  assert.deepEqual([...(await b.getData("ckpt")).files[0].data], [9]);
  assert.deepEqual((await b.skills()).map((s) => [s.name, s.from]), [["packed", "/skills/packed.zip"]]);
  assert.equal((await b.sessions.get("s1")).messages[0].content, "hello");
  assert.deepEqual((await b.sessions.list()).map((s) => [s.id, s.workspace, s.title]), [["s1", "s1", "hello"]]);
  // Another directory of the app is its own tree but shares the user's skills and the session list.
  const c = await Workspace.open(null, { id: "s2", project: "cli", store: nodeStore(root) });
  assert.equal(await c.exists("/notes.md"), false);
  assert.deepEqual((await c.skills()).map((s) => s.name), ["packed"]);
  assert.equal((await c.sessions.list()).length, 1);
  // destroy() drops one directory and its sessions.
  await b.destroy();
  const d = await Workspace.open(null, { id: "s1", project: "cli", store: nodeStore(root) });
  assert.equal(await d.exists("/notes.md"), false);
  assert.equal((await d.sessions.list()).length, 0);
  // (reopening writes the directory's bookkeeping again, but none of its files)
  assert.deepEqual(await readdir(join(root, encodeURIComponent("__runapps_agent_ws:cli"), "spaces", "s1", "files")).catch(() => []), []);
});

test("terminalUI — y/N, numbered choices (with retries and free text), single and multi-line input, notify; a stopped run dismisses the question", async () => {
  const run = async (answers, fn) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (b) => { printed += b; });
    const ui = terminalUI({ input, output });
    const p = fn(ui);
    for (const a of answers) { await new Promise((r) => setTimeout(r, 15)); input.write(a + "\n"); }
    const v = await p;
    return { v, printed };
  };
  assert.equal((await run(["y"], (ui) => ui.confirm("Delete?", "3 files"))).v, true);
  assert.equal((await run([""], (ui) => ui.confirm("Delete?"))).v, false);
  const sel = await run(["9", "2"], (ui) => ui.select("Colour", [{ value: "warm", label: "Warm" }, { value: "cool", label: "Cool", description: "blues" }]));
  assert.deepEqual(sel.v, ["cool"]);
  assert.match(sel.printed, /2\) Cool — blues/);
  assert.match(sel.printed, /Pick a number from 1 to 2/);
  assert.deepEqual((await run(["1, 2"], (ui) => ui.select("Both", [{ value: "a" }, { value: "b" }], { multi: true }))).v, ["a", "b"]);
  assert.deepEqual((await run(["teal"], (ui) => ui.select("Colour", [{ value: "warm" }], { allowOther: true }))).v, ["teal"]);
  assert.equal((await run(["Ada"], (ui) => ui.input("Name"))).v, "Ada");
  assert.equal((await run(["line 1", "line 2", ""], (ui) => ui.input("Notes", { multiline: true }))).v, "line 1\nline 2");
  const n = await run([], async (ui) => ui.notify("saved", "warning"));
  assert.match(n.printed, /! saved/);
  const ctl = new AbortController();
  const stopped = run([], (ui) => { setTimeout(() => ctl.abort(), 20); return ui.confirm("Wait?", "", { signal: ctl.signal }); });
  assert.equal((await stopped).v, false);
});
