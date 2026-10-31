// connectMCP against a fake Streamable HTTP server (a fetch function):
// initialize, sessions, pagination, JSON and event-stream answers,
// progress, server requests, errors, a forgotten session, cancel, close.
// Runs against the compiled dist/ build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { connectMCP, createAgent, MCPError } from "../dist/index.js";

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
const sse = (messages) => new Response(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** A fake MCP server. `tools` pages, `call(name, args, msg)` answers tools/call (a Response, or a result object). */
function server({ tools = [[{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }]], call, stream = false } = {}) {
  const log = [];
  let sessions = 0;
  let live = new Set();
  const fetch = async (url, init) => {
    const headers = init.headers ?? {};
    const entry = { method: init.method, session: headers["Mcp-Session-Id"], auth: headers.Authorization, version: headers["MCP-Protocol-Version"] };
    if (init.method === "DELETE") { log.push({ ...entry, rpc: "DELETE" }); live.delete(entry.session); return new Response(null, { status: 200 }); }
    const msg = JSON.parse(init.body);
    log.push({ ...entry, rpc: msg.method ?? (msg.error ? "error-reply" : "reply"), msg });
    if (msg.method === "initialize") {
      const id = `s${++sessions}`;
      live.add(id);
      return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Fake Server", version: "1.0" }, instructions: "Use echo to echo." } }, { headers: { "Mcp-Session-Id": id } });
    }
    if (entry.session && !live.has(entry.session)) return new Response("gone", { status: 404 });
    if (!msg.id) return new Response(null, { status: 202 });   // notifications, replies
    if (msg.method === "tools/list") {
      const page = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const result = { tools: tools[page], ...(page + 1 < tools.length ? { nextCursor: String(page + 1) } : {}) };
      return stream ? sse([{ jsonrpc: "2.0", id: msg.id, result }]) : json({ jsonrpc: "2.0", id: msg.id, result });
    }
    if (msg.method === "tools/call") {
      const out = call ? await call(msg.params.name, msg.params.arguments, msg, init) : { content: [{ type: "text", text: msg.params.arguments.text }] };
      return out instanceof Response ? out : json({ jsonrpc: "2.0", id: msg.id, result: out });
    }
    return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
  };
  return { fetch, log, forget: () => { live = new Set(); } };
}

test("mcp — connects, lists tools across pages, calls one, closes the session", async () => {
  const s = server({ tools: [[{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }], [{ name: "list.items", title: "List items", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]] });
  const mcp = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch, token: "tok" });
  assert.deepEqual(mcp.server, { name: "Fake Server", version: "1.0", title: undefined });
  assert.equal(mcp.instructions, "Use echo to echo.");
  assert.deepEqual(mcp.tools.map((t) => t.name), ["Fake_Server__echo", "Fake_Server__list_items"]);
  assert.equal(mcp.tools[1].readOnly, true);
  assert.match(mcp.tools[1].description, /^\[Fake Server — MCP server\] List items\./);
  // Every request after initialize carries the session, the version and the token.
  const after = s.log.filter((e) => e.rpc !== "initialize");
  assert.ok(after.every((e) => e.session === "s1" && e.auth === "Bearer tok"));
  assert.ok(s.log.filter((e) => e.rpc === "tools/list").every((e) => e.version === "2025-06-18"));
  assert.ok(s.log.some((e) => e.rpc === "notifications/initialized"));

  const out = await mcp.tools[0].execute({ text: "hi" }, { signal: new AbortController().signal, update() {} });
  assert.equal(out, "hi");
  await mcp.close();
  assert.equal(s.log.at(-1).rpc, "DELETE");
  await assert.rejects(mcp.tools[0].execute({ text: "x" }, { signal: new AbortController().signal, update() {} }), /closed/);
});

test("mcp — event-stream answers, progress, a server request answered, pictures named or passed on", async () => {
  const s = server({
    stream: true,
    call: (name, args, msg) => sse([
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: msg.params._meta.progressToken, progress: 1, total: 2, message: "half way" } },
      { jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} },
      { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "done" }, { type: "image", data: "AAAA", mimeType: "image/png" }] } },
    ]),
  });
  const updates = [];
  const named = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch });
  const parts = await named.tools[0].execute({ text: "x" }, { signal: new AbortController().signal, update: (t) => updates.push(t) });
  assert.deepEqual(updates, ["half way"]);
  assert.equal(parts[0].text, "done");
  assert.match(parts[1].text, /A picture \(image\/png, 3 bytes\)/);
  // The server's own request got a "not supported" answer.
  await new Promise((r) => setTimeout(r, 10));
  const reply = s.log.find((e) => e.rpc === "error-reply");
  assert.equal(reply.msg.id, 99);
  assert.equal(reply.msg.error.code, -32601);

  const withImages = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch, images: true });
  const parts2 = await withImages.tools[0].execute({ text: "x" }, { signal: new AbortController().signal, update() {} });
  assert.deepEqual(parts2[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
});

test("mcp — isError and HTTP errors become errors that never echo the token", async () => {
  const s = server({ call: (name, args) => args.text === "http" ? new Response("secret body tok", { status: 500 }) : { isError: true, content: [{ type: "text", text: "no such repo" }] } });
  const mcp = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch, token: "tok" });
  const ctx = { signal: new AbortController().signal, update() {} };
  await assert.rejects(mcp.tools[0].execute({ text: "x" }, ctx), (e) => e instanceof MCPError && e.message === "no such repo");
  await assert.rejects(mcp.tools[0].execute({ text: "http" }, ctx), (e) => /HTTP 500/.test(e.message) && /unknown; do not repeat/.test(e.message) && !e.message.includes("tok"));
  await assert.rejects(connectMCP("https://mcp.test/mcp", { fetch: async () => new Response("", { status: 401 }) }), /HTTP 401 \(check the token\)/);
});

test("mcp — a forgotten session is started again once; aborting tells the server", async () => {
  let hold;
  const s = server({ call: (name, args, msg, init) => args.text === "slow" ? new Promise((_, reject) => { hold = msg.id; init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); }) : { content: [{ type: "text", text: "ok" }] } });
  const mcp = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch });
  s.forget();
  const ctx = { signal: new AbortController().signal, update() {} };
  assert.equal(await mcp.tools[0].execute({ text: "again" }, ctx), "ok");
  assert.equal(s.log.filter((e) => e.rpc === "initialize").length, 2);
  assert.equal(s.log.at(-1).session, "s2");

  const ac = new AbortController();
  const p = mcp.tools[0].execute({ text: "slow" }, { signal: ac.signal, update() {} });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p);
  await new Promise((r) => setTimeout(r, 10));
  const cancelled = s.log.find((e) => e.rpc === "notifications/cancelled");
  assert.equal(cancelled.msg.params.requestId, hold);
});

test("mcp — the agent asks before a call, with the arguments; read-only tools can skip asking", async () => {
  const s = server({ tools: [[{ name: "write", inputSchema: { type: "object", properties: { text: { type: "string" } } } }, { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]] });
  const strict = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch, prefix: "gh" });
  assert.deepEqual(await strict.tools[0].confirm({ text: "a" }), { title: "Run Fake Server / write?", message: '{\n  "text": "a"\n}' });
  assert.equal(strict.tools[0].destructive, true);
  assert.ok(await strict.tools[1].confirm({}));
  const relaxed = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch, confirm: "unless-read-only" });
  assert.equal(await relaxed.tools[1].confirm({}), false);
  assert.ok(await relaxed.tools[0].confirm({}));

  // Through the agent: the dialog gets the title and the arguments.
  const asked = [];
  const ui = { confirm: async (title, message) => { asked.push([title, message]); return false; }, select: async () => null, input: async () => null, notify() {} };
  const provider = (() => {
    let n = 0;
    return {
      name: "t",
      async *stream() {
        if (n++ === 0) yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "gh__write", arguments: '{"text":"a"}' } }] }, finish_reason: "tool_calls" }] };
        else yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
      },
    };
  })();
  const agent = createAgent(provider, { tools: strict.tools, ui, sandbox: false, askUser: false });
  const statuses = [];
  agent.on("tool_end", (e) => statuses.push(e.status));
  await agent.prompt("go");
  assert.deepEqual(asked, [["Run Fake Server / write?", '{\n  "text": "a"\n}']]);
  assert.deepEqual(statuses, ["declined"]);
});

test("mcp — the signal cancels connecting only: aborting it later leaves the connection working", async () => {
  const s = server();
  const ac = new AbortController();
  const mcp = await connectMCP("https://mcp.test/mcp", { fetch: s.fetch, signal: ac.signal });
  ac.abort();
  assert.equal(await mcp.tools[0].execute({ text: "still here" }, { signal: new AbortController().signal, update() {} }), "still here");
  const early = new AbortController();
  early.abort();
  await assert.rejects(connectMCP("https://mcp.test/mcp", { fetch: s.fetch, signal: early.signal }));
});
