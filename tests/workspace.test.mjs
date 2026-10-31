// Workspace: zip unpacking into IndexedDB, skills in /.agent/skills
// layer, mounts, path safety, ETag refresh, and the run_js sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { SyncEngine, SDKEvents } from "@runappsai/sdk";
import { Workspace, memoryFS, parseSkill, listZip, readZipEntry, fileTools, runInSandbox, sandboxTool, nullUI } from "../dist/index.js";

const inflate = (b) => new Uint8Array(zlib.inflateRawSync(b));

/** A minimal zip writer (deflate, UTF-8 names, optional data descriptor). */
function makeZip(files, { descriptor = false, stored = false } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const comp = stored ? data : new Uint8Array(zlib.deflateRawSync(data));
    const nameB = enc.encode(name);
    const flags = 0x800 | (descriptor ? 8 : 0);
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0),
      ...u32(descriptor ? 0 : crc), ...u32(descriptor ? 0 : comp.length), ...u32(descriptor ? 0 : data.length), ...u16(nameB.length), ...u16(0), ...nameB]);
    central.push({ nameB, flags, method, crc, comp: comp.length, size: data.length, offset });
    parts.push(local, comp);
    offset += local.length + comp.length;
    if (descriptor) { const d = new Uint8Array([...u32(0x08074b50), ...u32(crc), ...u32(comp.length), ...u32(data.length)]); parts.push(d); offset += d.length; }
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(c.flags), ...u16(c.method), ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.comp), ...u32(c.size),
      ...u16(c.nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset), ...c.nameB]);
    parts.push(h); offset += h.length;
  }
  parts.push(new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(offset - cdStart), ...u32(cdStart), ...u16(0)]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

const SKILLS = {
  "pdf-tools/SKILL.md": "---\nname: pdf-tools\ndescription: Extract text and tables from PDF files. Use when reading PDFs.\n---\n\n# PDF tools\n\nRead `references/formats.md` first.\n",
  "pdf-tools/references/formats.md": "PDF 1.7 …",
  "pdf-tools/scripts/count.js": "return input.length;",
  "secret/SKILL.md": "---\nname: secret\ndescription: Hidden one\ndisable-model-invocation: true\n---\nbody",
  "broken/SKILL.md": "---\nname: broken\n---\nno description",
  "chart/SKILL.md": "﻿---\r\nname: Chart Maker\r\ndescription: >\r\n  Draw charts\r\n  from CSV.\r\nmetadata:\r\n  author: zero\r\n---\r\n\r\nUse run_js.\r\n",
  "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
};

/** fetch that serves `zip` at any URL, with an ETag and 304 support, counting hits. */
function zipFetch(zip, etag = '"v1"') {
  const hits = { get: 0, notModified: 0 };
  return {
    hits,
    fetch: async (_url, init) => {
      if (init?.headers?.["If-None-Match"] === etag) { hits.notModified++; return new Response(null, { status: 304 }); }
      hits.get++;
      return new Response(zip, { status: 200, headers: { ETag: etag } });
    },
  };
}

test("zip — lists and inflates deflate, stored and data-descriptor entries; refuses zip64", async () => {
  for (const opts of [{}, { stored: true }, { descriptor: true }]) {
    const zip = makeZip({ "a/b.txt": "hello", "é.txt": "ü" }, opts);
    const entries = listZip(zip);
    assert.deepEqual(entries.map((e) => e.name), ["a/b.txt", "é.txt"]);
    assert.equal(new TextDecoder().decode(await readZipEntry(zip, entries[0], inflate)), "hello");
    assert.equal(new TextDecoder().decode(await readZipEntry(zip, entries[1], inflate)), "ü");
  }
  const z64 = makeZip({ "a.txt": "x" });
  // Forge a zip64 marker: count 0xffff in the EOCD.
  z64[z64.length - 12] = 0xff; z64[z64.length - 11] = 0xff;
  assert.throws(() => listZip(z64), /zip64/);
  assert.throws(() => listZip(new Uint8Array([1, 2, 3])), /not a zip/);
});

test("parseSkill — frontmatter, folder fallback, folded description, BOM/CRLF, invalid ones", () => {
  const ok = parseSkill(SKILLS["pdf-tools/SKILL.md"], "/skills/pdf-tools/SKILL.md");
  assert.equal(ok.skill.name, "pdf-tools");
  assert.equal(ok.skill.dir, "/skills/pdf-tools");
  assert.match(ok.body, /^# PDF tools/);
  const chart = parseSkill(SKILLS["chart/SKILL.md"], "/skills/chart/SKILL.md");
  assert.equal(chart.skill.name, "chart"); // "Chart Maker" is not a valid name → folder
  assert.equal(chart.skill.description, "Draw charts from CSV.");
  assert.deepEqual(chart.skill.metadata, { author: "zero" });
  assert.equal(chart.body, "Use run_js.");
  assert.equal(parseSkill(SKILLS["broken/SKILL.md"], "/skills/broken/SKILL.md"), null);
  assert.equal(parseSkill(SKILLS["secret/SKILL.md"], "/skills/secret/SKILL.md").skill.disableModelInvocation, true);
});

test("workspace — the app's skills zip is read in place under /.agent/skills: found, read-only, not stored; work files persist", async () => {
  const idb = new IDBFactory();
  const zip = makeZip(SKILLS);
  const { fetch, hits } = zipFetch(zip);
  const ws = await Workspace.open(null, { id: "s1", project: "demo", skills: "/skills.zip", fetch, inflate, indexedDB: idb });
  assert.equal(ws.dbName, "__runapps_agent_ws:demo");
  assert.equal(ws.id, "s1");
  const skills = await ws.skills();
  assert.deepEqual(skills.map((s) => s.name), ["chart", "pdf-tools", "secret"]);
  assert.equal(skills[0].builtin, true);
  assert.equal((await ws.readText("/.agent/skills/pdf-tools/references/formats.md")), "PDF 1.7 …");
  // Files outside the skill folders are not exposed; the generated folder is read-only.
  assert.equal(await ws.exists("/.agent/skills/logo.png"), false);
  await assert.rejects(ws.write("/.agent/skills/pdf-tools/x.md", "x"), /read-only/);
  await assert.rejects(ws.write("/.agent/skills/new/SKILL.md", "x"), /read-only/);
  assert.equal(ws.isReadOnly("/.agent/skills/pdf-tools/SKILL.md"), true);
  await assert.rejects(ws.removeSkill("pdf-tools"), /comes with the app/);
  assert.equal(ws.skillsDir, "/.agent/skills");
  assert.equal(ws.userSkillsDir, "/skills");
  assert.match(ws.describe(), /\/\.agent\/skills\/ — skills/);
  assert.match(ws.describe(), /\/skills\/ — the user's skills/);
  await ws.write("/notes/../notes/today.md", "hi");
  assert.equal(await ws.readText("/notes/today.md"), "hi");
  assert.equal((await ws.list("/notes")).length, 1);
  const body = await ws.skillBody("pdf-tools");
  assert.match(body.body, /references\/formats.md/);

  // Another directory of the page sees the work file only in its own id; the zip is fetched once per page.
  const ws2 = await Workspace.open(null, { id: "s1", project: "demo", skills: "/skills.zip", fetch, inflate, indexedDB: idb });
  assert.equal(await ws2.readText("/notes/today.md"), "hi");
  assert.equal(hits.get, 1);
  await ws2.refreshSkills();
  assert.equal(hits.get, 2, "an explicit refresh fetches again");
  const ws3 = await Workspace.open(null, { id: "s2", project: "demo", skills: "/skills.zip", fetch, inflate, indexedDB: idb });
  assert.equal(await ws3.exists("/notes/today.md"), false);
  assert.deepEqual((await ws3.skills()).map((s) => s.name), ["chart", "pdf-tools", "secret"]);
  // Nothing of the zip was stored: a workspace without the option has no skills.
  const bare = await Workspace.open(null, { id: "s1", project: "demo", indexedDB: idb });
  assert.deepEqual(await bare.skills(), []);
});

test("workspace — a new zip version replaces the old files, removing what is gone", async () => {
  const idb = new IDBFactory();
  let zip = makeZip({ "one/SKILL.md": "---\ndescription: One\n---\n1", "one/extra.md": "x" });
  let etag = '"a"';
  const fetch = async (_u, init) => init?.headers?.["If-None-Match"] === etag ? new Response(null, { status: 304 }) : new Response(zip, { status: 200, headers: { ETag: etag } });
  const ws = await Workspace.open(null, { id: "v", skills: "/s.zip", fetch, inflate, indexedDB: idb });
  assert.equal(await ws.exists("/.agent/skills/one/extra.md"), true);
  zip = makeZip({ "one/SKILL.md": "---\ndescription: One v2\n---\n2" });
  etag = '"b"';
  await ws.refreshSkills();
  assert.equal(await ws.exists("/.agent/skills/one/extra.md"), false);
  assert.equal((await ws.skills())[0].description, "One v2");
});

test("workspace — a zip with SKILL.md at its root becomes one skill named after the zip", async () => {
  const zip = makeZip({ "SKILL.md": "---\ndescription: Root skill\n---\nhi", "scripts/x.js": "1" });
  const ws = await Workspace.open(null, { id: "r", skills: "/My Pack.zip", fetch: zipFetch(zip).fetch, inflate, indexedDB: new IDBFactory() });
  const skills = await ws.skills();
  assert.equal(skills[0].name, "my-pack");
  assert.equal(await ws.exists("/.agent/skills/my-pack/scripts/x.js"), true);
});

test("workspace — mounts take precedence, read-only mounts refuse writes, listing merges", async () => {
  const ws = await Workspace.open(null, { id: "m", indexedDB: null });
  await ws.write("/work/a.txt", "work");
  const doc = memoryFS({ "/page1.xml": "<x/>" }, { description: "the diagram" });
  ws.mount("/doc", doc);
  ws.mount("/ro", memoryFS({ "/r.txt": "r" }, { readonly: true }));
  assert.equal(await ws.readText("/doc/page1.xml"), "<x/>");
  await ws.write("/doc/page2.xml", "<y/>");
  assert.equal(doc.files.get("/page2.xml"), "<y/>");
  await assert.rejects(ws.write("/ro/r.txt", "z"), /read-only/);
  const all = (await ws.list("/")).map((f) => f.path);
  assert.deepEqual(all, ["/doc/page1.xml", "/doc/page2.xml", "/ro/r.txt", "/work/a.txt"]);
  assert.match(ws.describe(), /\/doc\/ — the diagram/);
  assert.throws(() => ws.mount("/", doc), /cannot mount/);
});

test("workspace — the database is invisible to Sync", async () => {
  const idb = new IDBFactory();
  const calls = [];
  const remote = {
    async list() { calls.push("list"); return []; },
    async get() { calls.push("get"); return null; },
    async put(...a) { calls.push("put"); return { etag: "e" }; },
    async pull() { calls.push("pull"); return { ops: [], cursor: "0" }; },
    async push(ops) { calls.push("push"); return { cursor: "1" }; },
  };
  const events = new SDKEvents();
  const engine = new SyncEngine(
    { remote, events, userId: () => "u1", onAuthChange: () => () => {}, factory: idb },
    { pushDelayMs: 10, pullIntervalMs: 0, openTimeoutMs: 500 },
  );
  const ws = await Workspace.open(null, { id: "sync", skills: "/s.zip", fetch: zipFetch(makeZip({ "a/SKILL.md": "---\ndescription: A\n---\n" })).fetch, inflate, indexedDB: idb });
  await ws.write("/w.txt", "x");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!calls.includes("put") && !calls.includes("push"), JSON.stringify(calls));
  engine.dispose();
});

test("file tools — list, read with ranges, write, edit exactly once, search, delete asks", async () => {
  const ws = await Workspace.open(null, { id: "ft", indexedDB: null });
  const tools = Object.fromEntries(fileTools(ws).map((t) => [t.name, t]));
  const ctx = { signal: new AbortController().signal, ui: nullUI(), workspace: ws, update() {} };
  await tools.write_file.execute({ path: "/a.md", content: "line1\nline2\nline3" }, ctx);
  assert.match(await tools.list_files.execute({}, ctx), /\/a.md  \(17 B\)/);
  assert.equal(await tools.read_file.execute({ path: "/a.md" }, ctx), "line1\nline2\nline3");
  assert.equal(await tools.read_file.execute({ path: "/a.md", offset: 2, limit: 1 }, ctx), "line2\n\n[1 more lines in file. Use offset=3 to continue.]");
  assert.match(await tools.read_file.execute({ path: "/a.md", offset: 9 }, ctx), /beyond end of file \(3 lines total\)/);
  await assert.rejects(tools.edit_file.execute({ path: "/a.md", oldText: "line", newText: "L" }, ctx), /Found 3 occurrences/);
  await tools.edit_file.execute({ path: "/a.md", edits: [{ oldText: "line2", newText: "LINE2" }] }, ctx);
  assert.match(await tools.search_files.execute({ query: "LINE" }, ctx), /^\/a.md:2: LINE2$/m);
  assert.equal(tools.delete_file.destructive, true);
  assert.equal(tools.delete_file.confirm({ path: "a.md" }), "Delete /a.md?");
  await tools.delete_file.execute({ path: "/a.md" }, ctx);
  assert.equal(await ws.exists("/a.md"), false);
});

test("sandbox — computes, logs, reaches the workspace, has no network, times out", async () => {
  const ws = await Workspace.open(null, { id: "sb", indexedDB: null });
  await ws.write("/data.csv", "1,2\n3,4");
  const r = await runInSandbox(ws, `
    console.log("start");
    const rows = (await fs.read("/data.csv")).split("\\n").map(l => l.split(",").map(Number));
    await fs.write("/sum.txt", String(rows.flat().reduce((a,b)=>a+b,0)));
    return { sum: rows.flat().reduce((a,b)=>a+b,0), hasFetch: typeof fetch, input };
  `, { k: 1 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(r.result), { sum: 10, hasFetch: "undefined", input: { k: 1 } });
  assert.equal(r.logs, "start");
  assert.equal(await ws.readText("/sum.txt"), "10");
  const t = await runInSandbox(null, "while(true){}", undefined, { timeoutMs: 300 });
  assert.equal(t.ok, false);
  assert.match(t.error, /Timed out/);
  const e = await runInSandbox(null, "throw new Error('nope')");
  assert.match(e.error, /nope/);
  const tool = sandboxTool(ws);
  const out = await tool.execute({ code: "return 1+1" }, { signal: new AbortController().signal });
  assert.match(out.content, /Returned: 2/);
});

test("workspace — edit_file hands a mount with edit() the replacements as they are; without it the file is read, edited and written back whole", async () => {
  const doc = { "/page.xml": "<p>hello</p><p>world</p>" };
  const calls = [];
  const ws = await Workspace.open(null, { id: "edits", project: "edits-test", indexedDB: null, userSkills: false });
  ws.mount("/doc", {
    list: async () => Object.keys(doc).map((path) => ({ path, size: doc[path].length })),
    read: async (path) => { if (!(path in doc)) throw new Error(`No such file: ${path}`); return doc[path]; },
    write: async (path, content) => { calls.push(["write", path]); doc[path] = String(content); },
    edit: async (path, edits) => {
      calls.push(["edit", path, edits.length]);
      for (const { oldText, newText } of edits) {
        if (doc[path].split(oldText).length !== 2) throw new Error(`"${oldText}" is not in ${path} exactly once`);
        doc[path] = doc[path].replace(oldText, newText);
      }
    },
  });
  const seen = [];
  ws.onChange((c) => seen.push(c.path));
  const tools = Object.fromEntries(fileTools(ws).map((t) => [t.name, t]));
  const ctx = { signal: new AbortController().signal, ui: nullUI(), workspace: ws, update() {} };
  await tools.read_file.execute({ path: "/doc/page.xml" }, ctx);
  await tools.edit_file.execute({ path: "/doc/page.xml", edits: [{ oldText: "hello", newText: "hi" }, { oldText: "world", newText: "there" }] }, ctx);
  assert.equal(doc["/page.xml"], "<p>hi</p><p>there</p>");
  assert.deepEqual(calls, [["edit", "/page.xml", 2]], "edit() only — no whole-file write");
  assert.ok(seen.includes("/doc/page.xml"), "the change is reported");
  // The mount's own error goes back to the model.
  await assert.rejects(tools.edit_file.execute({ path: "/doc/page.xml", oldText: "nope", newText: "x" }, ctx), /not in \/page.xml exactly once/);

  // No edit(): read, applyEdits, write back.
  ws.mount("/plain", memoryFS({ "/a.md": "one\ntwo\n" }));
  await tools.read_file.execute({ path: "/plain/a.md" }, ctx);
  await tools.edit_file.execute({ path: "/plain/a.md", oldText: "two", newText: "2" }, ctx);
  assert.equal(await ws.readText("/plain/a.md"), "one\n2\n");
  // The directory itself, and read-only places.
  await ws.write("/notes.md", "draft");
  await ws.edit("/notes.md", [{ oldText: "draft", newText: "final" }]);
  assert.equal(await ws.readText("/notes.md"), "final");
  ws.mount("/ro", memoryFS({ "/r.md": "x" }, { readonly: true }));
  await assert.rejects(ws.edit("/ro/r.md", [{ oldText: "x", newText: "y" }]), /read-only/);
});

test("file tools — read before write: an unread or since-changed file is not overwritten or edited; the model's own writes keep counting as read; mounts without a time compare content", async () => {
  const ws = await Workspace.open(null, { id: "stale", project: "stale-test", indexedDB: null, userSkills: false });
  const tools = Object.fromEntries(fileTools(ws).map((t) => [t.name, t]));
  const ctx = { signal: new AbortController().signal, ui: nullUI(), workspace: ws, update() {} };
  await ws.write("/plan.md", "- hire\n- ship v2\n- launch post\n");
  // Never read: overwriting or editing it is refused; a new file is fine.
  await assert.rejects(tools.write_file.execute({ path: "/plan.md", content: "x" }, ctx), /not read it in this conversation/);
  await assert.rejects(tools.edit_file.execute({ path: "/plan.md", oldText: "hire", newText: "hire 2" }, ctx), /not read it/);
  await tools.write_file.execute({ path: "/new.md", content: "fresh" }, ctx);
  // Read, then edit; the agent's own edit counts as seen, so a second edit needs no re-read.
  await tools.read_file.execute({ path: "/plan.md" }, ctx);
  await tools.edit_file.execute({ path: "/plan.md", oldText: "hire", newText: "hire 2" }, ctx);
  await tools.edit_file.execute({ path: "/plan.md", oldText: "launch post", newText: "launch post (draft)" }, ctx);
  await tools.edit_file.execute({ path: "/new.md", oldText: "fresh", newText: "fresher" }, ctx);
  // The user changes it meanwhile: refused until read again — even an edit whose oldText still matches.
  await new Promise((r) => setTimeout(r, 2));
  await ws.write("/plan.md", (await ws.readText("/plan.md")).replace("ship v2", "ship v3"));
  await assert.rejects(tools.edit_file.execute({ path: "/plan.md", oldText: "hire 2", newText: "hire 3" }, ctx), /changed since you last read it/);
  await assert.rejects(tools.write_file.execute({ path: "/plan.md", content: "- hire\n- ship v2\n" }, ctx), /changed since you last read it/);
  assert.match(await ws.readText("/plan.md"), /ship v3/, "the user's change is still there");
  await tools.read_file.execute({ path: "/plan.md" }, ctx);
  await tools.edit_file.execute({ path: "/plan.md", oldText: "hire 2", newText: "hire 3" }, ctx);
  assert.equal(await ws.readText("/plan.md"), "- hire 3\n- ship v3\n- launch post (draft)\n");
  // A mount with no modified time: the content decides.
  const doc = memoryFS({ "/d.md": "alpha" });
  ws.mount("/doc", doc);
  await tools.read_file.execute({ path: "/doc/d.md" }, ctx);
  doc.files.set("/d.md", "alpha beta");
  await assert.rejects(tools.edit_file.execute({ path: "/doc/d.md", oldText: "alpha", newText: "a" }, ctx), /changed since/);
  // Off: no checks.
  const loose = Object.fromEntries(fileTools(ws, { readBeforeWrite: false }).map((t) => [t.name, t]));
  await loose.write_file.execute({ path: "/plan.md", content: "overwritten" }, ctx);
  assert.equal(await ws.readText("/plan.md"), "overwritten");
});

test("workspace — reading a folder says so and read_file lists it", async () => {
  const ws = await Workspace.open(null, { id: "folder", indexedDB: null });
  await ws.write("/docs/a.md", "a");
  ws.mount("/doc", memoryFS({ "/p.txt": "p" }));
  await assert.rejects(ws.read("/docs"), /is a folder/);
  await assert.rejects(ws.read("/doc"), /is a folder/);
  await assert.rejects(ws.read("/doc/nope.txt"), /No such file: \/doc\/nope.txt/);
  const tools = Object.fromEntries(fileTools(ws).map((t) => [t.name, t]));
  const ctx = { signal: new AbortController().signal, ui: nullUI(), workspace: ws, update() {} };
  assert.match(await tools.read_file.execute({ path: "/doc/" }, ctx), /is a folder with 1 file:\n\/doc\/p.txt/);
});

test("workspace — the user's skills in /skills: folders and zips show up in the generated folder; install, unpack, replace, remove; skillsDir is configurable", async () => {
  const ws = await Workspace.open(null, { id: "dirskills", project: "userskills", indexedDB: null, inflate });
  await ws.write("/skills/hand/SKILL.md", "---\ndescription: Hand-written\n---\nDo it by hand.");
  const [hand] = await ws.skills();
  assert.deepEqual([hand.name, hand.path, hand.from, hand.builtin], ["hand", "/.agent/skills/hand/SKILL.md", "/skills/hand", undefined]);
  assert.equal((await ws.skillBody("hand")).body, "Do it by hand.");
  assert.equal(await ws.readText("/.agent/skills/hand/SKILL.md"), "---\ndescription: Hand-written\n---\nDo it by hand.");

  const pack = makeZip({ "SKILL.md": "---\ndescription: From a file input\n---\nzip body", "scripts/a.js": "1" });
  const installed = await ws.installSkill(pack, { name: "uploaded" });
  assert.deepEqual(installed.map((s) => [s.name, s.from]), [["uploaded", "/skills/uploaded.zip"]]);
  assert.equal(await ws.exists("/skills/uploaded.zip"), true);
  assert.equal(await ws.readText("/.agent/skills/uploaded/scripts/a.js"), "1");
  assert.deepEqual((await ws.skills()).map((s) => s.name), ["hand", "uploaded"]);

  // Installing the same name again replaces it (a file gone from the zip goes away).
  await ws.installSkill(makeZip({ "SKILL.md": "---\ndescription: v2\n---\n" }), { name: "uploaded" });
  assert.equal(await ws.exists("/.agent/skills/uploaded/scripts/a.js"), false);
  assert.equal((await ws.skills()).find((s) => s.name === "uploaded").description, "v2");

  // Editing a SKILL.md is visible at once; an invalid one (no description) drops out.
  await ws.write("/skills/hand/SKILL.md", "no frontmatter");
  assert.deepEqual((await ws.skills()).map((s) => s.name), ["uploaded"]);

  assert.equal(await ws.removeSkill("uploaded"), true);
  assert.equal(await ws.removeSkill("uploaded"), false);
  assert.equal(await ws.exists("/skills/uploaded.zip"), false);
  await assert.rejects(ws.installSkill(makeZip({ "readme.md": "no skill" }), { name: "bad" }), /no SKILL.md/);

  // unpack: the zip's skill becomes an editable folder.
  await ws.installSkill(makeZip({ "SKILL.md": "---\ndescription: Editable\n---\nv1" }), { name: "edit-me", unpack: true });
  assert.equal(await ws.exists("/skills/edit-me/SKILL.md"), true);
  await ws.write("/skills/edit-me/SKILL.md", "---\ndescription: Edited\n---\nv2");
  assert.equal((await ws.skills()).find((s) => s.name === "edit-me").description, "Edited");
  assert.equal(await ws.removeSkill("edit-me"), true);
  assert.equal(await ws.exists("/skills/edit-me/SKILL.md"), false);

  // clearWork keeps the user's skills.
  await ws.write("/skills/keep/SKILL.md", "---\ndescription: Keep\n---\n");
  await ws.write("/notes.md", "x");
  await ws.clearWork();
  assert.equal(await ws.exists("/notes.md"), false);
  assert.equal(await ws.exists("/skills/keep/SKILL.md"), true);

  const custom = await Workspace.open(null, { id: "custom", project: "userskills2", indexedDB: null, skillsDir: "/.claude/skills", skills: "/s.zip", fetch: zipFetch(makeZip({ "z/SKILL.md": "---\ndescription: Z\n---\n" })).fetch, inflate });
  assert.equal(await custom.exists("/.claude/skills/z/SKILL.md"), true);
  assert.deepEqual((await custom.skills()).map((s) => s.name), ["z"]);
  assert.match(fileTools(custom)[0].description, /\/\.claude\/skills holds the skills/);
  assert.throws(() => new Workspace(null, { userSkillsDir: "/.claude/skills/mine", skillsDir: "/.claude/skills" }), /apart from skillsDir/);
  const none = await Workspace.open(null, { id: "none", project: "userskills3", indexedDB: null, userSkillsDir: false });
  await assert.rejects(none.installSkill(pack), /no userSkillsDir/);
});

test("workspace — `dir` makes an AgentFS the directory itself: files, skills zips and mounts all land there", async () => {
  const idb = new IDBFactory();
  const folder = memoryFS({ "/README.md": "# proj", "/.agent/skills/local/SKILL.md": "---\ndescription: Local skill\n---\nlocal" }, { description: "the project folder" });
  const zip = makeZip({ "packed/SKILL.md": "---\ndescription: Packed\n---\n" });
  const ws = await Workspace.open(null, { id: "proj", dir: folder, skills: "/s.zip", fetch: zipFetch(zip).fetch, inflate, indexedDB: idb });
  assert.deepEqual((await ws.skills()).map((s) => s.name), ["local", "packed"]);
  assert.ok(!folder.files.has("/.agent/skills/packed/SKILL.md"), "the zip is read in place, not unpacked into the folder");
  await ws.write("/src/a.ts", "let a = 1");
  assert.equal(folder.files.get("/src/a.ts"), "let a = 1");
  assert.equal(await ws.readText("/README.md"), "# proj");
  ws.mount("/doc", memoryFS({ "/d.txt": "d" }));
  assert.deepEqual((await ws.list("/")).map((f) => f.path), ["/.agent/skills/local/SKILL.md", "/.agent/skills/packed/SKILL.md", "/doc/d.txt", "/README.md", "/src/a.ts"]);
  assert.match(ws.describe(), /^\/ — the project folder/);
  await ws.delete("/src/a.ts");
  assert.equal(folder.files.has("/src/a.ts"), false);
  await assert.rejects(ws.readText("/src/a.ts"), /No such file/);
  // Sessions still live in IndexedDB under the id.
  await ws.sessions.save({ v: 2, id: "s", messages: [], usage: { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 }, droppedTurns: 0, savedAt: 1 });
  assert.equal((await ws.sessions.list()).length, 1);
  const ro = await Workspace.open(null, { id: "ro", dir: memoryFS({ "/x.md": "x" }, { readonly: true }), indexedDB: null });
  await assert.rejects(ro.write("/y.md", "y"), /read-only/);
});

test("workspace — skills from before the generated folder move: a directory's own skill files go to /skills, copies of the app's zip are dropped, old library uploads become /skills zips", async () => {
  const idb = new IDBFactory();
  const zip = makeZip({ "one/SKILL.md": "---\ndescription: One\n---\n" });
  const seed = await Workspace.open(null, { id: "seed", project: "mig", indexedDB: idb, inflate });
  seed.close();
  await new Promise((r) => setTimeout(r, 10));
  // The old layout, written straight into the database.
  await new Promise((resolve, reject) => {
    const req = idb.open("__runapps_agent_ws:mig");
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["files", "meta"], "readwrite");
      const files = tx.objectStore("files"), meta = tx.objectStore("meta");
      files.put({ space: "old", path: "/.agent/skills/hand/SKILL.md", data: "---\ndescription: Hand\n---\n", mtime: 1, layer: "work" });
      files.put({ space: "old", path: "/.agent/skills/one/SKILL.md", data: "---\ndescription: One (old copy)\n---\n", mtime: 1, layer: "skills", source: "skills:/s.zip" });
      meta.put({ space: "old", key: "skills:/s.zip", value: { files: ["/.agent/skills/one/SKILL.md"] } });
      meta.delete(["\u0000skills", "migrated:2"]);
      meta.put({ space: "\u0000skills", key: "zip:up-pack", value: { name: "up-pack", bytes: makeZip({ "SKILL.md": "---\ndescription: Uploaded\n---\n" }), source: "upload", at: 1 } });
      meta.put({ space: "\u0000skills", key: "zip:s", value: { name: "s", bytes: zip, source: "/s.zip", at: 1 } });
      meta.put({ space: "\u0000skills", key: "removed:/x.zip", value: { at: 1 } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  const ws = await Workspace.open(null, { id: "old", project: "mig", skills: "/s.zip", fetch: zipFetch(zip).fetch, inflate, indexedDB: idb });
  assert.deepEqual((await ws.skills()).map((s) => [s.name, s.description, !!s.builtin]), [["hand", "Hand", false], ["one", "One", true], ["up-pack", "Uploaded", false]]);
  assert.equal(await ws.exists("/skills/hand/SKILL.md"), true);
  assert.equal(await ws.exists("/skills/up-pack.zip"), true);
  assert.equal(await ws.exists("/skills/one/SKILL.md"), false, "the app's copy is not kept");
});

test("workspace — lazy skills: listed from name and description, the zip loaded on first use (once per page), from a callback; a failed load is reported and tried again", async () => {
  let loads = 0, fail = true;
  const pdf = { name: "pdf-tools", description: "Read PDFs. Use when a PDF is attached.", load: async () => { loads++; return new Blob([makeZip(SKILLS)]); } };
  const flaky = { name: "flaky", description: "Sometimes offline", load: async () => { if (fail) throw new Error("offline"); return makeZip({ "SKILL.md": "---\ndescription: back\n---\nok" }); } };
  let calls = 0;
  const list = async () => { calls++; return [pdf, flaky]; };
  const ws = await Workspace.open(null, { id: "lazy", project: "lazy-test", indexedDB: null, inflate, skills: list });
  const skills = await ws.skills();
  assert.deepEqual(skills.map((x) => [x.name, x.description, x.lazy, x.builtin]), [["flaky", "Sometimes offline", true, true], ["pdf-tools", "Read PDFs. Use when a PDF is attached.", true, true]]);
  assert.equal(loads, 0, "listing loads nothing");
  assert.equal(calls, 1);
  // Before loading, SKILL.md is listed as a placeholder; reading it loads the zip.
  assert.deepEqual((await ws.list("/.agent/skills/pdf-tools")).map((f) => f.path), ["/.agent/skills/pdf-tools/SKILL.md"]);
  assert.equal(loads, 0);
  const seen = [];
  ws.onChange((c) => seen.push(c.path));
  assert.match(await ws.readText("/.agent/skills/pdf-tools/SKILL.md"), /name: pdf-tools/);
  assert.equal(loads, 1);
  assert.equal(await ws.readText("/.agent/skills/pdf-tools/references/formats.md"), "PDF 1.7 …");
  assert.ok((await ws.list("/.agent/skills/pdf-tools")).length > 1, "the real tree once loaded");
  assert.ok(seen.includes("/.agent/skills/pdf-tools"), "listeners hear it loaded");
  // Another directory of the page reuses the loaded zip.
  const other = await Workspace.open(null, { id: "lazy-2", project: "lazy-test", indexedDB: null, inflate, skills: list });
  assert.match((await other.skillBody("pdf-tools")).body, /formats\.md/);
  assert.equal(loads, 1, "loaded once per page");
  // A load that fails says so, and is tried again next time.
  await assert.rejects(ws.readText("/.agent/skills/flaky/SKILL.md"), /the skill "flaky" could not be loaded: offline/);
  fail = false;
  assert.match(await ws.readText("/.agent/skills/flaky/SKILL.md"), /ok/);
  await assert.rejects(ws.write("/.agent/skills/pdf-tools/x.md", "x"), /read-only/);
});

test("workspace — the user's skills are shared by every directory of the app; a change in one shows in the others", async () => {
  const idb = new IDBFactory();
  const a = await Workspace.open(null, { id: "lib-a", project: "lib", indexedDB: idb, inflate });
  const b = await Workspace.open(null, { id: "lib-b", project: "lib", indexedDB: idb, inflate });
  const seen = [];
  b.onChange((c) => seen.push(c.path));
  const got = await a.installSkill(makeZip({ "SKILL.md": "---\ndescription: Packed\n---\nbody", "ref/x.md": "X" }), { name: "My Tool" });
  assert.deepEqual(got.map((s) => [s.name, s.from]), [["my-tool", "/skills/my-tool.zip"]]);
  assert.deepEqual(await a.list("/.agent/skills/my-tool").then((l) => l.map((f) => f.path)), ["/.agent/skills/my-tool/ref/x.md", "/.agent/skills/my-tool/SKILL.md"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await b.exists("/.agent/skills/my-tool/SKILL.md"), true, "the other directory has it");
  assert.ok(seen.includes("/skills/my-tool.zip") && seen.includes("/.agent/skills"), "and told its listeners");
  // A skill written in b (as the agent would) shows in a.
  await b.write("/skills/notes/SKILL.md", "---\ndescription: Notes\n---\n");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await a.skills()).map((s) => s.name), ["my-tool", "notes"]);
  assert.equal(await a.removeSkill("my-tool"), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await b.skills()).map((s) => s.name), ["notes"]);
});

test("workspace — the app's skills from Blobs and bytes; a user's skill of the same name takes its place", async () => {
  const blob = new Blob([makeZip({ "SKILL.md": "---\ndescription: From a blob\n---\n" })]);
  const bytes = makeZip({ "x/SKILL.md": "---\ndescription: From bytes\n---\n" });
  const ws = await Workspace.open(null, { id: "blob", project: "blobs", indexedDB: null, inflate, skills: [{ name: "Blob Skill", data: blob }, bytes] });
  assert.deepEqual((await ws.skills()).map((s) => [s.name, s.description, s.builtin]), [["blob-skill", "From a blob", true], ["x", "From bytes", true]]);
  await ws.write("/skills/x/SKILL.md", "---\ndescription: Mine\n---\n");
  const x = (await ws.skills()).find((s) => s.name === "x");
  assert.deepEqual([x.description, x.builtin, x.from], ["Mine", undefined, "/skills/x"]);
});

test("workspace — ids are separate directories in one app database; sessions list across them; destroy drops one directory", async () => {
  const idb = new IDBFactory();
  const zip = makeZip({ "k/SKILL.md": "---\ndescription: K\n---\n" });
  const a = await Workspace.open(null, { id: "sess-a", project: "app", skills: "/s.zip", fetch: zipFetch(zip).fetch, inflate, indexedDB: idb });
  const b = await Workspace.open(null, { id: "sess-b", project: "app", skills: "/s.zip", fetch: zipFetch(zip).fetch, inflate, indexedDB: idb });
  assert.equal(a.dbName, b.dbName);
  await a.write("/notes.md", "A's notes");
  await b.write("/notes.md", "B's notes");
  await a.write("/skills/mine/SKILL.md", "---\ndescription: written in a\n---\n");
  await new Promise((r) => setTimeout(r, 50));  // b hears of it over the app's channel
  assert.equal(await a.readText("/notes.md"), "A's notes");
  assert.equal(await b.readText("/notes.md"), "B's notes");
  assert.deepEqual((await b.skills()).map((s) => s.name), ["k", "mine"], "every directory has the app's zip and the user's skills");
  const usage = { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  await a.sessions.save({ v: 2, id: "sess-a", messages: [{ role: "user", content: "hi from a" }], usage, droppedTurns: 0, savedAt: 2 });
  await b.sessions.save({ v: 2, id: "sess-b", messages: [{ role: "user", content: "hi from b" }], usage, droppedTurns: 0, savedAt: 3 });
  const listed = await a.sessions.list();
  assert.deepEqual(listed.map((s) => [s.id, s.workspace]), [["sess-b", "sess-b"], ["sess-a", "sess-a"]], "any directory lists every session with its workspace");
  await a.destroy();
  const a2 = await Workspace.open(null, { id: "sess-a", project: "app", indexedDB: idb });
  assert.equal(await a2.exists("/notes.md"), false);
  assert.equal(await b.readText("/notes.md"), "B's notes");
  assert.deepEqual((await b.sessions.list()).map((s) => s.id), ["sess-b"]);
});

test("workspace — deleting a session from another directory drops the directory made for it; a shared directory's sessions leave its files alone; clear() empties the app", async () => {
  const idb = new IDBFactory();
  const usage = { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  // The chat's model: a directory per session, named after it.
  const a = await Workspace.open(null, { id: "sess-a", project: "app", indexedDB: idb });
  const b = await Workspace.open(null, { id: "sess-b", project: "app", indexedDB: idb });
  await a.write("/notes.md", "A");
  await b.write("/notes.md", "B");
  await a.sessions.save({ v: 2, id: "sess-a", messages: [{ role: "user", content: "a" }], usage, droppedTurns: 0, savedAt: 1 });
  await b.sessions.save({ v: 2, id: "sess-b", messages: [{ role: "user", content: "b" }], usage, droppedTurns: 0, savedAt: 2 });
  // One shared directory saving several sessions.
  const shared = await Workspace.open(null, { id: "default", project: "app", indexedDB: idb });
  await shared.write("/shared.md", "keep me");
  await shared.sessions.save({ v: 2, id: "x1", messages: [], usage, droppedTurns: 0, savedAt: 3 });
  await shared.sessions.save({ v: 2, id: "x2", messages: [], usage, droppedTurns: 0, savedAt: 4 });

  await b.sessions.delete("sess-a");
  assert.deepEqual((await b.sessions.list()).map((s) => s.id), ["x2", "x1", "sess-b"]);
  const a2 = await Workspace.open(null, { id: "sess-a", project: "app", indexedDB: idb });
  assert.equal(await a2.exists("/notes.md"), false, "the session's own directory went with it");
  assert.equal(await b.readText("/notes.md"), "B");

  await b.sessions.delete("x1");
  assert.equal(await shared.readText("/shared.md"), "keep me", "a session of a shared directory leaves the files");
  assert.deepEqual((await shared.sessions.list()).map((s) => s.id), ["x2", "sess-b"]);

  await shared.sessions.clear();
  assert.deepEqual(await shared.sessions.list(), []);
  const b2 = await Workspace.open(null, { id: "sess-b", project: "app", indexedDB: idb });
  assert.equal(await b2.exists("/notes.md"), false);
  assert.equal(await shared.readText("/shared.md"), "keep me");
});

test("workspace — nested folders persist in the IndexedDB directory across reopen; a memoryFS mount starts over (it is the host's live data, not storage)", async () => {
  const idb = new IDBFactory();
  const a = await Workspace.open(null, { id: "s1", project: "app", indexedDB: idb });
  a.mount("/doc", memoryFS({ "/plan.md": "plan" }));
  for (let i = 1; i <= 12; i++) { await a.write(`/book/rewrite/ch${i}.md`, `chapter ${i}`); await a.write(`/doc/rewrite/ch${i}.md`, `doc chapter ${i}`); }
  await a.write("/top.md", "top");
  assert.equal((await a.list("/book/rewrite")).length, 12);
  assert.equal((await a.list("/doc/rewrite")).length, 12);
  const b = await Workspace.open(null, { id: "s1", project: "app", indexedDB: idb });
  b.mount("/doc", memoryFS({ "/plan.md": "plan" }));
  assert.equal((await b.list("/book/rewrite")).length, 12, "IndexedDB keeps nested folders");
  assert.equal(await b.readText("/book/rewrite/ch7.md"), "chapter 7");
  assert.equal(await b.readText("/top.md"), "top");
  assert.deepEqual((await b.list("/doc")).map((f) => f.path), ["/doc/plan.md"], "the memory mount starts over");
});

test("zip — buildZip writes an archive listZip/readZipEntry read back (deflated or stored), with nested paths", async () => {
  const { buildZip } = await import("../dist/index.js");
  const big = "lorem ipsum ".repeat(500);
  const zip = await buildZip([{ path: "a/b/c.txt", data: big }, { path: "x.bin", data: new Uint8Array([1, 2, 3]) }, { path: "/leading/slash.md", data: "# hi" }]);
  const entries = listZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["a/b/c.txt", "x.bin", "leading/slash.md"]);
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, entries[0], inflate)), big);
  assert.deepEqual([...await readZipEntry(zip, entries[1], inflate)], [1, 2, 3]);
  assert.equal(new TextDecoder().decode(await readZipEntry(zip, entries[2], inflate)), "# hi");
});

test("workspace — onChange reports writes and deletes (own, bulk, mounted) and relays another instance's changes as remote", async () => {
  const idb = new IDBFactory();
  const a = await Workspace.open(null, { id: "s1", project: "evt", indexedDB: idb });
  const b = await Workspace.open(null, { id: "s1", project: "evt", indexedDB: idb });
  const other = await Workspace.open(null, { id: "s2", project: "evt", indexedDB: idb });
  const got = [], gotB = [], gotOther = [];
  const off = a.onChange((c) => got.push(c));
  b.onChange((c) => gotB.push(c));
  other.onChange((c) => gotOther.push(c));
  a.mount("/doc", memoryFS({}));
  await a.write("/x.md", "1");
  await a.write("/doc/d.md", "2");
  await a.delete("/x.md");
  await a.write("/k/one.md", "a"); await a.write("/k/two.md", "b");
  await a.clearWork();
  assert.deepEqual(got.map((c) => `${c.kind} ${c.path}${c.remote ? " (remote)" : ""}`), ["write /x.md", "write /doc/d.md", "delete /x.md", "write /k/one.md", "write /k/two.md", "delete /k/one.md", "delete /k/two.md"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(gotB.length >= 1 && gotB.every((c) => c.remote === true), "the other instance of the same directory hears it as remote");
  assert.equal(gotOther.length, 0, "another directory of the app hears nothing");
  off();
  await a.write("/y.md", "3");
  assert.equal(got.length, 7, "unsubscribed");
});

test("workspace — the same session id in two directories stays two sessions", async () => {
  const idb = new IDBFactory();
  const usage = { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  const a = await Workspace.open(null, { id: "docA", project: "same-id", indexedDB: idb });
  const b = await Workspace.open(null, { id: "docB", project: "same-id", indexedDB: idb });
  await a.sessions.save({ v: 2, id: "assistant", messages: [{ role: "user", content: "about doc A" }], usage, droppedTurns: 0, savedAt: 1 });
  assert.equal(await b.sessions.get("assistant"), null, "docB does not resume docA's conversation");
  await b.sessions.save({ v: 2, id: "assistant", messages: [{ role: "user", content: "about doc B" }], usage, droppedTurns: 0, savedAt: 2 });
  assert.equal((await a.sessions.get("assistant")).messages[0].content, "about doc A", "docB's save did not overwrite docA's");
  assert.equal((await b.sessions.get("assistant")).messages[0].content, "about doc B");
  assert.equal((await a.sessions.list()).length, 2);
});

test("workspace — opening a version-3 database moves its sessions under [space, id] and keeps the files", async () => {
  const idb = new IDBFactory();
  const name = "__runapps_agent_ws:migrate";
  await new Promise((resolve, reject) => {
    const req = idb.open(name, 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("files", { keyPath: ["space", "path"] });
      db.createObjectStore("meta", { keyPath: ["space", "key"] });
      db.createObjectStore("sessions", { keyPath: "id" }).createIndex("space", "space");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["files", "sessions"], "readwrite");
      tx.objectStore("files").put({ space: "s1", path: "/notes.md", data: "kept", contentType: "text/markdown", mtime: 1 });
      tx.objectStore("sessions").put({ v: 2, id: "s1", space: "s1", messages: [{ role: "user", content: "old chat" }], usage: { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 }, droppedTurns: 0, savedAt: 1 });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  const ws = await Workspace.open(null, { id: "s1", project: "migrate", indexedDB: idb });
  assert.equal(await ws.readText("/notes.md"), "kept");
  assert.equal((await ws.sessions.get("s1")).messages[0].content, "old chat");
});

test("workspace — skills zip entries are normalised and stay under skillsDir", async () => {
  const idb = new IDBFactory();
  const zip = makeZip({ "e/SKILL.md": "---\ndescription: E\n---\n", "e/a//b.md": "B" });
  const ws = await Workspace.open(null, { id: "z", project: "zipnorm", skills: "/s.zip", fetch: zipFetch(zip).fetch, inflate, indexedDB: idb });
  assert.equal(await ws.exists("/.agent/skills/e/a/b.md"), true);
  assert.equal((await ws.list("/")).some((f) => f.path.includes("//")), false);
});

test("zip — buildZip refuses more entries than a plain zip can count; a stored entry with a wrong size is refused", async () => {
  const { buildZip } = await import("../dist/index.js");
  await assert.rejects(buildZip(Array.from({ length: 0xffff }, (_, i) => ({ path: `f${i}`, data: "" }))), /too many files/);
  const zip = makeZip({ "a.txt": "hello" }, { stored: true });
  const [e] = listZip(zip);
  await assert.rejects(readZipEntry(zip, { ...e, compressedSize: e.compressedSize + 40, size: e.size + 40 }, inflate), /damaged/);
  await assert.rejects(readZipEntry(zip, { ...e, size: e.size + 1 }, inflate), /damaged/);
});

test("pdf — read_file and run_js read a PDF's text page by page through a (stubbed) pdf.js; the text is cached until the file changes; scanned PDFs say so", async () => {
  const { configurePdf } = await import("../dist/index.js");
  let loads = 0, parses = 0;
  const pagesOf = (bytes) => new TextDecoder().decode(bytes).includes("SCAN") ? ["", ""] : ["第一页 正文", "Second page text"];
  configurePdf({ load: async () => { loads++; return { GlobalWorkerOptions: {}, getDocument: ({ data }) => ({ promise: (async () => { parses++; const pages = pagesOf(data); return { numPages: pages.length, getPage: async (n) => ({ getTextContent: async () => ({ items: [{ str: pages[n - 1], hasEOL: false }] }) }), destroy: () => {} }; })() }) }; } });
  const idb = new IDBFactory();
  const ws = await Workspace.open(null, { id: "pdf", project: "pdf-test", indexedDB: idb });
  const pdf = new TextEncoder().encode("%PDF-1.4 fake body");
  await ws.write("/docs/a.pdf", pdf, "application/pdf");
  const read = fileTools(ws).find((t) => t.name === "read_file");
  const out = await read.execute({ path: "/docs/a.pdf" }, { signal: new AbortController().signal });
  const text = typeof out === "string" ? out : out.content;
  assert.match(text, /\[PDF \/docs\/a\.pdf: 2 pages\]/);
  assert.match(text, /--- page 1 ---\n第一页 正文/);
  assert.match(text, /--- page 2 ---\nSecond page text/);
  await read.execute({ path: "/docs/a.pdf" }, { signal: new AbortController().signal });
  assert.equal(parses, 1, "the second read came from the cache");
  await ws.write("/docs/a.pdf", new TextEncoder().encode("%PDF-1.4 changed"), "application/pdf");
  await ws.readAsText("/docs/a.pdf");
  assert.equal(parses, 2, "a changed file is parsed again");
  await ws.write("/docs/scan.pdf", new TextEncoder().encode("%PDF-1.4 SCAN"), "application/pdf");
  assert.match((await ws.readAsText("/docs/scan.pdf")).text, /no text layer/);
  const r = await runInSandbox(ws, "return (await fs.read('/docs/a.pdf')).includes('Second page text')", null, {});
  assert.equal(r.result, "true");
  assert.equal(loads, 1, "pdf.js is loaded once");
  configurePdf({ load: undefined });
});
