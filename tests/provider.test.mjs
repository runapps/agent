// Providers: an OpenAI-compatible endpoint through plain fetch, a provider
// written by hand, and errors that are retried — no RunApps SDK involved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgent, defineTool, openAIProvider, ProviderError, sseData, Workspace } from "../dist/index.js";

const enc = new TextEncoder();
/** An SSE response split at awkward places (mid-line, CRLF framing), as proxies do. */
function sse(chunks, { crlf = false } = {}) {
  const nl = crlf ? "\r\n" : "\n";
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}${nl}${nl}`).join("") + `data: [DONE]${nl}${nl}`;
  const parts = text.match(/.{1,37}/gs);
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] });
const weather = defineTool({
  name: "get_weather",
  description: "Weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
  execute: ({ city }) => ({ city, temp_c: 17 }),
});

test("openAIProvider — streams a tool round trip from an OpenAI-compatible endpoint with plain fetch", async () => {
  const requests = [];
  const script = [
    () => sse([chunk({ role: "assistant", reasoning_content: "need weather" }), chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"ci" } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: "ty\":\"Rome\"}" } }] }), chunk({}, "tool_calls")], { crlf: true }),
    () => sse([chunk({ content: "Rome is " }), chunk({ content: "17°C." }), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 6 } }]),
  ];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return script.shift()();
  };
  const provider = openAIProvider({ baseURL: "https://llm.example.com/v1/", apiKey: "sk-test", fetch, models: [{ id: "my-model", is_default: true, max_input_tokens: 32000, max_tokens: 4096 }] });
  const agent = createAgent(provider, { model: "my-model", tools: [weather], sandbox: false, askUser: false });
  const r = await agent.prompt("Weather in Rome?");
  assert.equal(r.reason, "done");
  assert.equal(r.text, "Rome is 17°C.");
  assert.equal(requests[0].url, "https://llm.example.com/v1/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer sk-test");
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(requests[0].body.max_tokens, 4096, "the catalogue's output limit");
  assert.equal(requests[0].body.tools[0].function.name, "get_weather");
  const tool = requests[1].body.messages.find((m) => m.role === "tool");
  assert.deepEqual(JSON.parse(tool.content), { city: "Rome", temp_c: 17 });
  assert.equal(agent.usage.prompt_tokens, 50);
  assert.equal(agent.usage.total_cost, 0, "no cost from a provider that does not say");
  assert.deepEqual(await agent.limits(), { input: 32000, output: 4096 });
});

test("openAIProvider — a 429 with Retry-After is retried; a 400 is not, and says why", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit" } }), { status: 429, headers: { "Retry-After": "0.01" } });
    if (calls === 2) return sse([chunk({ content: "ok" }), chunk({}, "stop")]);
    return new Response(JSON.stringify({ error: { message: "model not found", code: "model_not_found" } }), { status: 400 });
  };
  const agent = createAgent(openAIProvider({ baseURL: "https://x/v1", fetch }), { model: "m", sandbox: false, askUser: false });
  assert.equal((await agent.prompt("hi")).text, "ok");
  assert.equal(calls, 2);
  const r = await agent.prompt("again");
  assert.equal(r.reason, "error");
  assert.ok(r.error instanceof ProviderError);
  assert.equal(r.error.status, 400);
  assert.equal(r.error.code, "model_not_found");
  assert.match(r.error.message, /model not found/);
  assert.equal(calls, 3, "not retried");
});

test("a provider written by hand: stream only — compaction collects the stream; no catalogue means defaults; no model is sent when none is set", async () => {
  const seen = [];
  const provider = {
    name: "my-app",
    async *stream(params) {
      seen.push(params);
      const last = params.messages.at(-1);
      const text = typeof last.content === "string" && last.content.includes("<conversation>") ? "SUMMARY" : `echo ${seen.length}`;
      yield chunk({ content: text });
      yield { ...chunk({}, "stop"), usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
  const ws = await Workspace.open(provider, { id: "hand", indexedDB: null });
  assert.equal(ws.dbName, "__runapps_agent_ws:my-app", "the provider's name scopes the storage");
  const agent = createAgent(provider, { workspace: ws, sandbox: false, askUser: false });
  await agent.prompt("one " + "x".repeat(2000));
  await agent.prompt("two " + "x".repeat(2000));
  assert.equal("model" in seen[0], false);
  assert.deepEqual(await agent.limits(), { input: 128000, output: 8192 });
  assert.equal(await agent.compact(), true);
  assert.match(agent.messages[0].content, /SUMMARY/);
});

test("sseData — events split across reads, CRLF framing, comments and multi-line data", async () => {
  const text = ": keep-alive\r\n\r\ndata: {\"a\":1}\r\n\r\ndata: line1\ndata: line2\n\ndata: [DONE]\n\n";
  const body = new ReadableStream({ start(c) { for (const p of text.match(/.{1,5}/gs)) c.enqueue(enc.encode(p)); c.close(); } });
  const out = [];
  for await (const d of sseData(body)) out.push(d);
  assert.deepEqual(out, ["{\"a\":1}", "line1\nline2", "[DONE]"]);
});
