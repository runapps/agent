// webTools: the platform's web_search / web_fetch offered as the agent's
// own tools, beside the app's, switched per turn, their cost counted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgent, defineTool, runappsProvider } from "../dist/index.js";

const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, total_cost: 0.001 };

/** A provider whose model answers from `script` (one completion's chunks per call) and whose platform has web tools. */
function provider(script, opts = {}) {
  const requests = [];
  const calls = [];
  let lists = 0;
  const chunk = (delta, finish) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage } : {}) });
  const p = {
    name: "test",
    async *stream(params) {
      requests.push(params);
      const next = script.shift();
      if (!next) throw new Error("test: no scripted reply left");
      if (next.text) yield chunk({ role: "assistant", content: next.text });
      for (const [i, c] of (next.calls ?? []).entries()) {
        yield chunk({ tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] });
      }
      yield chunk({}, next.calls?.length ? "tool_calls" : "stop");
    },
    async models() {
      return [{ id: "m", capability: "text", max_input_tokens: 100000, max_tokens: 8192, is_default: true }];
    },
    platformTools: opts.noPlatform ? undefined : {
      async list() {
        lists++;
        return [
          { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, price: 0.005 },
          { name: "web_fetch", description: "Read a page", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, price: 0.0005 },
          { name: "twitter_search", description: "X", parameters: { type: "object", properties: {} }, price: 0.003 },
        ];
      },
      async call(name, args) {
        calls.push({ name, args });
        if (opts.fail) throw new Error("fetching x: no such host");
        return { content: `${name}: results for ${JSON.stringify(args)}`, data: { results: [1, 2, 3] }, usage: { total_cost: 0.005 } };
      },
    },
  };
  return { p, requests, calls, lists: () => lists };
}

const toolNames = (req) => (req.tools ?? []).map((t) => t.function.name);

const note = defineTool({
  name: "save_note",
  description: "Save a note",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  execute: () => "saved",
});

test("webTools offers web_search and web_fetch beside the agent's own tools and runs them", async () => {
  const { p, requests, calls, lists } = provider([
    { calls: [{ name: "web_search", args: { query: "go release" } }] },
    { text: "Go 1.27." },
  ]);
  const agent = createAgent(p, { tools: [note], webTools: true, sandbox: false, askUser: false });
  assert.equal(agent.webToolsAvailable, true);
  assert.equal(agent.webTools, true);
  const r = await agent.prompt("latest go?");
  assert.equal(r.reason, "done");
  assert.deepEqual(toolNames(requests[0]), ["save_note", "web_search", "web_fetch"]);
  assert.deepEqual(calls, [{ name: "web_search", args: { query: "go release" } }]);
  const toolMsg = requests[1].messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg.content), /web_search: results for/);
  assert.match(requests[0].messages[0].content, /web_fetch reads one/, "the guidelines are in the system prompt");
  assert.equal(lists(), 1, "the list is asked once");
  // Two model calls at 0.001 plus the search at 0.005.
  assert.ok(Math.abs(agent.usage.total_cost - 0.007) < 1e-9, String(agent.usage.total_cost));
  assert.equal(agent.usage.calls, 2);
});

test("webTools off: not offered; configure turns them on for the next run", async () => {
  const { p, requests } = provider([{ text: "a" }, { text: "b" }]);
  const agent = createAgent(p, { tools: [note], sandbox: false, askUser: false });
  await agent.prompt("one");
  assert.deepEqual(toolNames(requests[0]), ["save_note"]);
  agent.configure({ webTools: true });
  await agent.prompt("two");
  assert.deepEqual(toolNames(requests[1]), ["save_note", "web_search", "web_fetch"]);
});

test("a function webTools is read every turn", async () => {
  let on = false;
  const { p, requests } = provider([{ text: "a" }, { text: "b" }]);
  const agent = createAgent(p, { webTools: () => on, sandbox: false, askUser: false });
  await agent.prompt("one");
  on = true;
  await agent.prompt("two");
  assert.deepEqual(toolNames(requests[0]), []);
  assert.deepEqual(toolNames(requests[1]), ["web_search", "web_fetch"]);
});

test("a failed web call is an error the model reads, and costs nothing", async () => {
  const { p, requests } = provider([
    { calls: [{ name: "web_fetch", args: { url: "https://x.example" } }] },
    { text: "Could not read it." },
  ], { fail: true });
  const agent = createAgent(p, { webTools: true, sandbox: false, askUser: false });
  await agent.prompt("read x");
  const toolMsg = requests[1].messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg.content), /no such host/);
  assert.ok(Math.abs(agent.usage.total_cost - 0.002) < 1e-9, String(agent.usage.total_cost));
});

test("without a platform the option does nothing", async () => {
  const { p, requests } = provider([{ text: "a" }], { noPlatform: true });
  const agent = createAgent(p, { webTools: true, sandbox: false, askUser: false });
  assert.equal(agent.webToolsAvailable, false);
  assert.equal(agent.webTools, false);
  await agent.prompt("one");
  assert.deepEqual(toolNames(requests[0]), []);
});

test("runappsProvider passes the client's tools on", () => {
  const tools = { list: async () => [], call: async () => ({ content: "" }) };
  const p = runappsProvider({ chat: { stream: async function* () {} }, tools });
  assert.equal(p.platformTools, tools);
});
