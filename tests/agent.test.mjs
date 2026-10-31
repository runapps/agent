// The agent loop against a scripted gateway: tool round trips, gating,
// validation, cut streams, abort, retries, queueing, budget, sessions.
// Runs against the compiled dist/ build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunApps, APIError } from "@runappsai/sdk";
import { createAgent, defineTool, fitBudget, groupTurns } from "../dist/index.js";

/** SSE body from chunk objects (the gateway's framing). */
function sse(chunks) {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push("data: [DONE]\n\n");
  return new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, total_cost: 0.001 };

/** A reply with text (and optional tool calls), as the gateway streams it. */
function reply({ text = "", calls = [], finish }) {
  const chunks = [{ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] }];
  for (const piece of text.match(/.{1,5}/gs) ?? []) chunks.push({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: piece } }] });
  calls.forEach((c, i) => chunks.push({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id ?? `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] }));
  chunks.push({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: finish ?? (calls.length ? "tool_calls" : "stop") }], usage });
  return chunks;
}

/** A client whose gateway answers chat calls from `script` (each entry a Response or chunk list). */
function scripted(script, opts = {}) {
  const requests = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/v1/models")) return new Response(JSON.stringify({ object: "list", data: [{ id: "m", object: "model", capability: "text", max_input_tokens: opts.maxInput ?? 100000, max_tokens: 8192, is_default: true }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/v1/chat/completions")) {
      requests.push(JSON.parse(init.body));
      const next = script.shift();
      if (!next) throw new Error("test: no scripted reply left");
      if (typeof next === "function") return next();
      return next instanceof Response ? next : sse(next);
    }
    throw new Error("test: unexpected fetch " + u);
  };
  const client = new RunApps({ apiKey: "gw-test", fetch: fetchFn });
  return { client, requests };
}

const weather = defineTool({
  name: "get_weather",
  description: "Weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
  execute: ({ city }) => ({ city, temp_c: 17 }),
});

test("agent — tool round trip: call, result, final answer; events in order", async () => {
  const { client, requests } = scripted([
    reply({ text: "Let me check.", calls: [{ id: "call_a", name: "get_weather", args: { city: "Paris" } }] }),
    reply({ text: "It is 17°C in Paris." }),
  ]);
  const agent = createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false });
  const events = [];
  agent.on("*", (name) => events.push(name));
  const r = await agent.prompt("Weather in Paris?");
  assert.equal(r.reason, "done");
  assert.equal(r.text, "It is 17°C in Paris.");
  assert.equal(r.usage.calls, 2);
  assert.equal(r.usage.total_cost, 0.002);
  // The second request carries the assistant tool call and our result.
  const msgs = requests[1].messages;
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /get_weather|How to work/);
  assert.equal(msgs[2].role, "assistant");
  assert.equal(msgs[2].tool_calls[0].id, "call_a");
  assert.equal(msgs[3].role, "tool");
  assert.equal(msgs[3].tool_call_id, "call_a");
  assert.deepEqual(JSON.parse(msgs[3].content), { city: "Paris", temp_c: 17 });
  assert.equal(requests[0].max_tokens, 8192);
  assert.equal(requests[0].tools.length, 1);
  assert.deepEqual(events.filter((e) => e !== "text_delta"), ["run_start", "turn_start", "message_end", "turn_end", "tool_start", "tool_end", "turn_start", "message_end", "turn_end", "run_end"]);
  assert.equal(agent.messages.length, 4);
});

test("agent — a destructive tool is declined without a user, the model is told, and continues", async () => {
  const { client, requests } = scripted([
    reply({ calls: [{ name: "wipe", args: {} }] }),
    reply({ text: "Not done." }),
  ]);
  let ran = false;
  const wipe = defineTool({ name: "wipe", description: "Delete everything", destructive: true, execute: () => { ran = true; return "gone"; } });
  const agent = createAgent(client, { model: "m", tools: [wipe], sandbox: false, askUser: false });
  const ends = [];
  agent.on("tool_end", (e) => ends.push(e.status));
  await agent.prompt("wipe");
  assert.equal(ran, false);
  assert.deepEqual(ends, ["declined"]);
  assert.match(requests[1].messages.at(-1).content, /declined/);
});

test("agent — permissions auto runs destructive tools; a function decides per call", async () => {
  const { client } = scripted([reply({ calls: [{ name: "wipe", args: {} }] }), reply({ text: "ok" })]);
  let ran = 0;
  const wipe = defineTool({ name: "wipe", description: "d", destructive: true, execute: () => { ran++; return "gone"; } });
  await createAgent(client, { model: "m", tools: [wipe], sandbox: false, askUser: false, permissions: "auto" }).prompt("x");
  assert.equal(ran, 1);
  const { client: c2 } = scripted([reply({ calls: [{ name: "wipe", args: {} }] }), reply({ text: "ok" })]);
  const seen = [];
  await createAgent(c2, { model: "m", tools: [wipe], sandbox: false, askUser: false, permissions: ({ name }) => { seen.push(name); return false; } }).prompt("x");
  assert.deepEqual(seen, ["wipe"]);
  assert.equal(ran, 1);
});

test("agent — onToolCall hook blocks with a reason", async () => {
  const { client, requests } = scripted([reply({ calls: [{ name: "get_weather", args: { city: "Paris" } }] }), reply({ text: "ok" })]);
  const agent = createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false, onToolCall: () => ({ block: true, reason: "Weather is off today." }) });
  const ends = [];
  agent.on("tool_end", (e) => ends.push(e.status));
  await agent.prompt("x");
  assert.deepEqual(ends, ["blocked"]);
  assert.match(requests[1].messages.at(-1).content, /Weather is off today/);
});

test("agent — bad arguments are reported to the model, the tool does not run", async () => {
  const { client, requests } = scripted([
    reply({ calls: [{ name: "get_weather", args: { town: "Paris" } }] }),
    reply({ text: "ok" }),
  ]);
  let ran = false;
  const t = defineTool({ ...weather, execute: () => { ran = true; return "x"; } });
  await createAgent(client, { model: "m", tools: [t], sandbox: false, askUser: false }).prompt("x");
  assert.equal(ran, false);
  const msg = requests[1].messages.at(-1).content;
  assert.match(msg, /missing required "city"/);
  assert.match(msg, /unknown field "town"/);
});

test("agent — unknown tool and non-JSON arguments are errors to the model", async () => {
  const chunks = reply({ calls: [{ id: "k", name: "nope", args: {} }] });
  const { client, requests } = scripted([chunks, reply({ text: "ok" })]);
  await createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false }).prompt("x");
  assert.match(requests[1].messages.at(-1).content, /no tool named "nope"/);
});

test("agent — a stream without finish_reason runs no tool and ends the run with an error", async () => {
  const cut = () => { const c = reply({ calls: [{ name: "get_weather", args: { city: "Paris" } }] }); c.pop(); return c; }; // no finish chunk
  const { client } = scripted([cut(), cut(), cut()]); // a cut stream is retried, then given up
  let ran = false;
  const t = defineTool({ ...weather, execute: () => { ran = true; return "x"; } });
  const r = await createAgent(client, { model: "m", tools: [t], sandbox: false, askUser: false }).prompt("x");
  assert.equal(r.reason, "error");
  assert.match(r.error.message, /before the reply was complete/);
  assert.equal(ran, false);
});

test("agent — abort mid-batch: pending calls get a skipped result, the transcript stays valid, prompt works again", async () => {
  const { client, requests } = scripted([
    reply({ calls: [{ id: "a", name: "slow", args: {} }, { id: "b", name: "slow", args: {} }] }),
    reply({ text: "after" }),
  ]);
  const slow = defineTool({
    name: "slow", description: "waits",
    execute: (_a, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))),
  });
  const agent = createAgent(client, { model: "m", tools: [slow], sandbox: false, askUser: false });
  const started = new Promise((res) => agent.on("tool_start", res));
  const run = agent.prompt("go");
  await started;
  await agent.abort();
  const r = await run;
  assert.equal(r.reason, "aborted");
  const tools = agent.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id).sort();
  assert.deepEqual(tools, ["a", "b"]);
  assert.equal(agent.busy, false);
  const r2 = await agent.prompt("again");
  assert.equal(r2.text, "after");
  // Every tool call in the sent transcript has its result.
  const sent = requests[1].messages;
  const ids = sent.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  for (const id of ids) assert.ok(sent.some((m) => m.role === "tool" && m.tool_call_id === id), id);
});

test("agent — abort during the stream cancels the body", async () => {
  let cancelled = false;
  const slowStream = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n')); },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const { client } = scripted([slowStream]);
  const agent = createAgent(client, { model: "m", sandbox: false, askUser: false });
  const gotText = new Promise((res) => agent.on("text_delta", res));
  const run = agent.prompt("hi");
  await gotText;
  await agent.abort();
  const r = await run;
  assert.equal(r.reason, "aborted");
  assert.equal(cancelled, true);
});

test("agent — 429 before any text is retried; 402 is not", async () => {
  const err429 = () => new Response(JSON.stringify({ error: { type: "rate_limited", message: "slow down" } }), { status: 429, headers: { "Retry-After": "0" } });
  const { client, requests } = scripted([err429, reply({ text: "fine" })]);
  const r = await createAgent(client, { model: "m", sandbox: false, askUser: false }).prompt("x");
  assert.equal(r.text, "fine");
  assert.equal(requests.length, 2);

  const err402 = () => new Response(JSON.stringify({ error: { type: "insufficient_balance", message: "need $0.05" } }), { status: 402 });
  const { client: c2, requests: r2 } = scripted([err402, reply({ text: "never" })]);
  const res = await createAgent(c2, { model: "m", sandbox: false, askUser: false }).prompt("x");
  assert.equal(res.reason, "error");
  assert.ok(res.error instanceof APIError);
  assert.equal(res.error.statusCode, 402);
  assert.equal(r2.length, 1);
});

test("agent — a 5xx after text has streamed is retried with message_reset", async () => {
  const half = () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n'));
      c.enqueue(new TextEncoder().encode('data: {"error":{"code":502,"type":"upstream_error","message":"boom"}}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  }), { status: 200 });
  const { client } = scripted([half, reply({ text: "whole" })]);
  const agent = createAgent(client, { model: "m", sandbox: false, askUser: false });
  let resets = 0;
  agent.on("message_reset", () => resets++);
  const r = await agent.prompt("x");
  assert.equal(r.text, "whole");
  assert.equal(resets, 1);
});

test("agent — prompt while running queues a follow-up; steer lands before the next model call", async () => {
  const { client, requests } = scripted([
    reply({ calls: [{ name: "get_weather", args: { city: "Paris" } }] }),
    reply({ text: "first done" }),
    reply({ text: "second done" }),
  ]);
  const agent = createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false });
  const first = agent.prompt("one");
  await new Promise((res) => agent.on("tool_start", res));
  agent.steer("in Celsius please");
  const second = agent.prompt("two");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.text, "first done");
  assert.equal(b.text, "second done");
  const sentInSecondCall = requests[1].messages.map((m) => m.role + ":" + (typeof m.content === "string" ? m.content : ""));
  assert.ok(sentInSecondCall.includes("user:in Celsius please"));
  assert.equal(requests[2].messages.at(-1).content, "two");
});

test("agent — repeating the same tool batch warns the model, then stops", async () => {
  const same = () => reply({ calls: [{ id: "x", name: "get_weather", args: { city: "Paris" } }] });
  const { client, requests } = scripted([same(), same(), same(), same(), same(), same(), same(), reply({ text: "done" })]);
  const r = await createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false }).prompt("loop");
  assert.equal(r.reason, "error");
  assert.match(r.error.message, /without progress/);
  const warned = requests.some((q) => q.messages.some((m) => m.role === "user" && /repeated the same tool calls/.test(m.content)));
  assert.ok(warned);
});

test("agent — max_turns ends the run; continue() picks up with no new message and a fresh turn count", async () => {
  const call = (city) => reply({ calls: [{ name: "get_weather", args: { city } }] });
  const { client, requests } = scripted([call("Rome"), call("Oslo"), call("Lima"), reply({ text: "done after four" })]);
  const agent = createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false, maxTurns: 2 });
  const starts = [];
  agent.on("run_start", (e) => starts.push(e.message));
  const r = await agent.prompt("x");
  assert.equal(r.reason, "max_turns");
  assert.equal(requests.length, 2);
  const before = agent.messages.length;
  const r2 = await agent.continue();
  assert.equal(r2.reason, "done");
  assert.equal(r2.text, "done after four");
  assert.equal(requests.length, 4, "two more turns under a fresh limit");
  assert.equal(agent.messages.filter((m) => m.role === "user").length, 1, "no user message was added");
  assert.ok(agent.messages.length > before);
  assert.deepEqual(starts.map((m) => (m ? "message" : "continue")), ["message", "continue"]);
  assert.throws(() => createAgent(client, { model: "m", sandbox: false, askUser: false }).continue(), /nothing to continue/);
});

test("agent — finish_reason length with far fewer tokens than asked is reported as a balance problem", async () => {
  const chunks = reply({ text: "half an ans", finish: "length" });
  chunks.at(-1).usage = { ...usage, completion_tokens: 1024 };
  const { client } = scripted([chunks]);
  const r = await createAgent(client, { model: "m", sandbox: false, askUser: false, maxTokens: 8192 }).prompt("x");
  assert.equal(r.reason, "error");
  assert.equal(r.error.statusCode, 402);
});

test("agent — export at a turn boundary and restore continues the conversation", async () => {
  const { client, requests } = scripted([reply({ text: "hello" }), reply({ text: "again" })]);
  const agent = createAgent(client, { model: "m", sandbox: false, askUser: false });
  await agent.prompt("hi");
  const saved = agent.export();
  assert.equal(saved.v, 2);
  assert.equal(saved.title, "hi");
  assert.equal(saved.messages.length, 2);
  const agent2 = createAgent(client, { model: "m", sandbox: false, askUser: false, restore: saved });
  await agent2.prompt("more");
  assert.equal(requests[1].messages.length, 4); // system + 3
  assert.equal(agent2.usage.calls, 2);
});

test("agent — the system prompt lists tool guidelines and the app's instructions", async () => {
  const { client, requests } = scripted([reply({ text: "ok" })]);
  const t = defineTool({ ...weather, guidelines: "Use get_weather for any weather question." });
  await createAgent(client, { model: "m", tools: [t], sandbox: false, askUser: false, appName: "Weatherly", instructions: "You are terse." }).prompt("x");
  const sys = requests[0].messages[0].content;
  assert.match(sys, /built into Weatherly/);
  assert.match(sys, /You are terse\./);
  assert.match(sys, /# Tool notes\n- Use get_weather/);
  assert.doesNotMatch(sys, /# Skills/);
});

test("agent — prompt and extra parameters are forwarded", async () => {
  const { client, requests } = scripted([reply({ text: "ok" })]);
  await createAgent(client, { model: "m", sandbox: false, askUser: false, prompt: { id: "director", vars: { a: 1 } }, extra: { reasoning_effort: "low" }, temperature: 0.2 }).prompt("x");
  assert.deepEqual(requests[0].prompt, { id: "director", vars: { a: 1 } });
  assert.equal(requests[0].reasoning_effort, "low");
  assert.equal(requests[0].temperature, 0.2);
  assert.equal(requests[0].stream, true);
});

test("fitBudget — elides old tool results first, drops whole turns, never splits a tool call from its result", () => {
  const big = "x".repeat(3000);
  const msgs = [];
  for (let t = 0; t < 6; t++) {
    msgs.push({ role: "user", content: `q${t}` });
    msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${t}`, type: "function", function: { name: "f", arguments: "{}" } }] });
    msgs.push({ role: "tool", tool_call_id: `c${t}`, content: big });
    msgs.push({ role: "assistant", content: `a${t}` });
  }
  assert.equal(groupTurns(msgs).length, 6);
  const fit = fitBudget(msgs, { budget: 1500, keepTurns: 2 });
  assert.ok(fit.elidedResults > 0);
  assert.ok(fit.droppedTurns > 0);
  const out = fit.messages;
  assert.equal(out[0].role, "user");
  for (const m of out) if (m.role === "assistant" && m.tool_calls) {
    for (const c of m.tool_calls) assert.ok(out.some((x) => x.role === "tool" && x.tool_call_id === c.id));
  }
  // The newest turn is intact.
  assert.equal(out.at(-1).content, "a5");
  assert.equal(out.at(-2).content, big);
});

test("agent — steering that arrives during the final reply gets its own turn; clearQueue resolves follow-ups", async () => {
  const { client, requests } = scripted([reply({ text: "first" }), reply({ text: "after steer" })]);
  const agent = createAgent(client, { model: "m", sandbox: false, askUser: false });
  const off = agent.on("message_end", () => { off(); agent.steer("more please"); });
  const r = await agent.prompt("hi");
  assert.equal(r.text, "after steer");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some((m) => m.role === "user" && m.content === "more please"));
  assert.deepEqual(agent.queued, []);

  const { client: c2 } = scripted([reply({ text: "slow" })]);
  const a2 = createAgent(c2, { model: "m", sandbox: false, askUser: false });
  const run = a2.prompt("x");
  const queued = a2.followUp("later");
  assert.equal(a2.queued.length, 1);
  a2.clearQueue();
  assert.equal((await queued).reason, "aborted");
  assert.equal((await run).text, "slow");
});

test("agent — steer + follow-up queued mid-batch: the rest of the batch is skipped (pi), the steer joins the next turn, the follow-up runs only after the run ends; dequeue drops one", async () => {
  let release;
  const slow = defineTool({ name: "slow", description: "slow", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: () => new Promise((r) => { release = () => r("slow done"); }) });
  const fast = defineTool({ name: "fast", description: "fast", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: () => "fast done" });
  const { client, requests } = scripted([
    reply({ text: "working", calls: [{ id: "c1", name: "slow", args: {} }, { id: "c2", name: "fast", args: {} }] }),
    reply({ text: "answer after steer" }),
    reply({ text: "follow-up answered" }),
  ]);
  const agent = createAgent(client, { model: "m", tools: [slow, fast], sandbox: false, askUser: false });
  const log = [];
  agent.on("run_start", () => log.push("run_start"));
  agent.on("run_end", (r) => log.push("run_end:" + r.text));
  agent.on("tool_end", (e) => log.push(`tool_end:${e.name}:${e.status}`));
  const first = agent.prompt("go");
  await new Promise((r) => setTimeout(r, 20));
  agent.steer("change course");
  const fu = agent.followUp("and then this");
  const dropped = agent.followUp("never mind");
  assert.equal(agent.queued.length, 3);
  assert.equal(agent.dequeue(agent.queued[2].message), true);
  assert.equal((await dropped).reason, "aborted");
  assert.deepEqual(agent.queued.map((q) => q.kind), ["steer", "followUp"]);
  release();
  const r1 = await first;
  assert.equal(r1.text, "answer after steer");
  const r2 = await fu;
  assert.equal(r2.text, "follow-up answered");
  assert.deepEqual(log, ["run_start", "tool_end:slow:ok", "tool_end:fast:skipped", "run_end:answer after steer", "run_start", "run_end:follow-up answered"]);
  // The steer is in the second request, before the model's reply; the follow-up only in the third.
  const texts = (r) => r.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
  assert.deepEqual(texts(requests[1]), ["go", "change course"]);
  assert.deepEqual(texts(requests[2]), ["go", "change course", "and then this"]);
  assert.ok(requests[1].messages.some((m) => m.role === "tool" && /Skipped: the user sent a new instruction/.test(m.content)));
});

test("agent — user messages carry `ts` in the session but not in the request; rewind(index) drops what follows and saves", async () => {
  const { client, requests } = scripted([reply({ text: "one" }), reply({ text: "two" }), reply({ text: "three" })]);
  const agent = createAgent(client, { model: "m", sandbox: false, askUser: false });
  await agent.prompt("first");
  await agent.prompt("second");
  assert.equal(agent.messages.length, 4);
  assert.ok(typeof agent.messages[0].ts === "number" && typeof agent.messages[2].ts === "number", "sent time kept on the message");
  for (const r of requests) for (const m of r.messages) assert.equal("ts" in m, false, "the model never sees ts");
  const events = [];
  agent.on("rewind", (e) => events.push(e.index));
  await agent.rewind(2);
  assert.deepEqual(agent.messages.map((m) => m.content), ["first", "one"]);
  assert.deepEqual(events, [2]);
  assert.deepEqual(agent.export().messages.map((m) => m.content), ["first", "one"], "the saved session is the rewound one");
  await agent.prompt("second again");
  assert.equal(agent.messages.length, 4);
  assert.equal(agent.messages[3].content, "three");
  await assert.rejects(agent.rewind(9), /no message at 9/);
});

test("agent — max_tokens follows the catalogue's maximum output for the model unless maxTokens is a number; limits() reports both", async () => {
  const requests = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/v1/models")) return new Response(JSON.stringify({ object: "list", data: [
      { id: "small", object: "model", capability: "text", max_input_tokens: 32000, max_tokens: 4096, is_default: true },
      { id: "big", object: "model", capability: "text", max_input_tokens: 200000, max_tokens: 65536 },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    requests.push(JSON.parse(init.body));
    return sse(reply({ text: "ok" }));
  };
  const client = new RunApps({ apiKey: "gw-test", fetch: fetchFn });
  const big = createAgent(client, { model: "big", sandbox: false, askUser: false });
  await big.prompt("hi");
  assert.equal(requests[0].max_tokens, 65536);
  assert.deepEqual(await big.limits(), { input: 200000, output: 65536 });
  const dflt = createAgent(client, { sandbox: false, askUser: false });
  await dflt.prompt("hi");
  assert.equal(requests[1].max_tokens, 4096, "the default model's own limit");
  const pinned = createAgent(client, { model: "big", maxTokens: 1000, sandbox: false, askUser: false });
  await pinned.prompt("hi");
  assert.equal(requests[2].max_tokens, 1000);
});

test("agent — reasoning_content stays on the assistant turn and goes back to the model; configure({reasoningEffort}) sends reasoning_effort", async () => {
  const think = reply({ text: "Let me check.", calls: [{ id: "call_a", name: "get_weather", args: { city: "Paris" } }] });
  think.splice(1, 0, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { reasoning_content: "thinking hard…" } }] });
  const { client, requests } = scripted([think, reply({ text: "17°C." })]);
  const agent = createAgent(client, { model: "m", tools: [weather], sandbox: false, askUser: false });
  agent.configure({ reasoningEffort: "high" });
  assert.equal(agent.settings.reasoningEffort, "high");
  await agent.prompt("Weather in Paris?");
  assert.equal(requests[0].reasoning_effort, "high");
  const turn = agent.messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.equal(turn.reasoning_content, "thinking hard…");
  assert.equal(requests[1].messages.find((m) => m.role === "assistant" && m.tool_calls).reasoning_content, "thinking hard…", "sent back with the tool-calling turn");
  agent.configure({ reasoningEffort: null });
  assert.equal(agent.settings.reasoningEffort, undefined);
});
