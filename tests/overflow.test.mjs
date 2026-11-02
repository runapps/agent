// A request larger than the model's context: recognised in each provider's wording, recovered from
// without the user when it can be, and otherwise reported with what takes up the room.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgent, defineTool, estimateTokens, isContextOverflow, ContextOverflowError, ProviderError, summaryOf } from "../dist/index.js";

const chunk = (delta, finish = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
const refusal = () => new ProviderError(400, "prompt is too long for m: the request is over its limit", { code: "context_length_exceeded" });

/** A provider that refuses while `refuse(params)` says so, and otherwise answers "ok". */
function provider({ refuse = () => null, window = 100_000 } = {}) {
  const calls = [];
  return {
    calls,
    summaries: 0,
    async models() { return window === null ? [] : [{ id: "m", capability: "text", is_default: true, max_input_tokens: window, max_tokens: 4096 }]; },
    async *stream(params) {
      calls.push(params);
      const err = refuse(params, calls.length);
      if (err) throw err;
      yield chunk({ content: "ok" });
      yield chunk({}, "stop");
    },
    async complete() {
      this.summaries++;
      return { id: "s", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "SUMMARY" }, finish_reason: "stop" }] };
    },
  };
}
const agentOn = (p, opts = {}) => createAgent(p, { model: "m", sandbox: false, askUser: false, ...opts });
const fill = (tokens) => "x".repeat(tokens * 3);

test("overflow — each provider's wording is recognised; limits on the reply and rate limits are not", () => {
  for (const message of [
    "prompt is too long for m: at least 5 tokens > its 3 max_input_tokens",
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "Your input exceeds the context window of this model",
    "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)",
    "Input is too long for requested model.",
    "Invalid request: Your request exceeded model token limit: 8192",
    "Range of input length should be [1, 30720]",
    "too many input tokens",
  ]) assert.ok(isContextOverflow(new Error(message)), message);
  assert.ok(isContextOverflow(new ProviderError(413, "Request Entity Too Large")));
  assert.ok(isContextOverflow(new ProviderError(400, "bad", { code: "context_length_exceeded" })));
  for (const err of [
    new Error("max_tokens is too large: 64000 > 8192"),
    new Error("余额不足"),
    new Error("the model does not exist"),
    new ProviderError(429, "Request too large for gpt on tokens per min (TPM): limit 30000, requested 90000"),
    new ProviderError(402, "prompt too long to hold for this balance"),
  ]) assert.ok(!isContextOverflow(err), err.message);
});

test("overflow — refused once: older turns are summarised and the same request goes out again, no error", async () => {
  const p = provider({ refuse: (_, n) => (n === 3 ? refusal() : null) });
  const agent = agentOn(p);
  await agent.prompt("first " + fill(2000));
  await agent.prompt("second " + fill(2000));
  const events = [];
  agent.on("compaction", (e) => events.push(e));
  const r = await agent.prompt("third");
  assert.equal(r.reason, "done");
  assert.equal(r.error, undefined);
  assert.equal(agent.lastEnd, null);
  assert.equal(p.summaries, 1);
  assert.ok(events.some((e) => e.summary));
  assert.equal(summaryOf(agent.messages[0]), "SUMMARY");
  assert.ok(agent.messages.some((m) => m.role === "user" && m.content === "third"), "the request itself stays");
  assert.equal(p.calls.at(-1).messages.at(-1).content, "third");
});

test("overflow — a refusal that states the real limit corrects the window for what is sent next", async () => {
  const limit = 2000;
  const p = provider({ refuse: (params, n) => (n > 2 && estimateTokens(params.messages) > limit ? new Error(`This model's maximum context length is ${limit} tokens.`) : null) });
  const big = defineTool({ name: "big", description: "lots", parameters: { type: "object", properties: {} }, execute: () => fill(600) });
  const agent = agentOn(p, { tools: [big], compaction: false });
  // The catalogue says 100,000, so nothing trims until the model refuses.
  await agent.prompt("old " + fill(1500));
  await agent.prompt("older " + fill(1500));
  const r = await agent.prompt("now");
  assert.equal(r.reason, "done");
  assert.ok(estimateTokens(p.calls.at(-1).messages) <= limit);
});

test("overflow — a message too large to shrink: told apart from attachments, with no needless calls", async () => {
  const p = provider({ refuse: () => refusal() });
  const agent = agentOn(p);
  const r = await agent.prompt("words " + fill(90_000));
  assert.equal(r.reason, "error");
  assert.ok(r.error instanceof ContextOverflowError);
  assert.equal(r.error.code, "context_overflow");
  assert.equal(r.error.overflow.cause, "message");
  assert.match(r.error.detail, /over its limit/);
  assert.equal(p.calls.length, 1, "nothing could be made smaller, so it is not sent again");
  assert.deepEqual(agent.lastEnd.overflow, r.error.overflow);
  assert.equal(agent.export().ended.overflow.cause, "message", "saved with the session, so the card comes back when it is reopened");

  const q = provider({ refuse: () => refusal() });
  const withFile = agentOn(q);
  const f = await withFile.prompt([{ type: "text", text: "see this" }, { type: "text", text: "[attachments]\n- big.txt" }, { type: "text", text: `<file name="big.txt">\n${fill(90_000)}\n</file>` }]);
  assert.equal(f.error.overflow.cause, "attachments");
});

test("overflow — far beyond a known window the request is not sent at all", async () => {
  const p = provider({ window: 1000 });
  const r = await agentOn(p).prompt(fill(5000));
  assert.equal(r.reason, "error");
  assert.equal(r.error.overflow.cause, "message");
  assert.equal(p.calls.length, 0);
  // Without a catalogue the window is a guess: the model decides.
  const open = provider({ window: null });
  assert.equal((await agentOn(open).prompt(fill(500_000))).reason, "done");
  assert.equal(open.calls.length, 1);
});

test("overflow — the tools themselves can be what takes up the room", async () => {
  const many = Array.from({ length: 40 }, (_, i) => defineTool({ name: `t${i}`, description: fill(100), parameters: { type: "object", properties: {} }, execute: () => "" }));
  const p = provider({ refuse: () => refusal(), window: 4000 });
  const r = await agentOn(p, { tools: many }).prompt("hi");
  assert.equal(r.error.overflow.cause, "tools");
});

test("overflow — big results of the latest turn go in the second round, calls and results stay paired", async () => {
  const big = defineTool({ name: "big", description: "lots", parameters: { type: "object", properties: {} }, execute: () => fill(4000) });
  let round = 0;
  const p = provider({ window: 20_000, refuse: (params) => (estimateTokens(params.messages) > 5000 ? refusal() : null) });
  const stream = p.stream;
  p.stream = async function* (params) {
    if (round++ === 0) { yield chunk({ tool_calls: [{ index: 0, id: "b1", type: "function", function: { name: "big", arguments: "{}" } }, { index: 1, id: "b2", type: "function", function: { name: "big", arguments: "{}" } }] }); yield chunk({}, "tool_calls"); return; }
    yield* stream.call(p, params);
  };
  const r = await agentOn(p, { tools: [big], compaction: false }).prompt("go");
  assert.equal(r.reason, "done");
  const sent = p.calls.at(-1).messages;
  assert.ok(estimateTokens(sent) <= 5000);
  assert.ok(sent.filter((m) => m.role === "tool").every((m) => sent.some((a) => a.tool_calls?.some((c) => c.id === m.tool_call_id))));
  assert.ok(sent.some((m) => m.role === "tool" && String(m.content).startsWith("[result elided")));
});

test("overflow — other failures are left alone", async () => {
  const p = provider({ refuse: () => new Error("the model does not exist") });
  const agent = agentOn(p);
  const r = await agent.prompt("hi");
  assert.equal(r.reason, "error");
  assert.ok(!(r.error instanceof ContextOverflowError));
  assert.equal(agent.lastEnd.overflow, undefined);
  assert.equal(p.calls.length, 1);
  assert.equal(p.summaries, 0);
});

test("summarize / seed — a summary that stays out of the conversation starts a new one", async () => {
  const p = provider();
  const a = agentOn(p);
  await a.prompt("first");
  await a.prompt("second");
  const before = [...a.messages];
  const asked = before[2];
  assert.equal(await a.summarize(asked), "SUMMARY");
  assert.deepEqual(a.messages, before, "the conversation is untouched");
  // The message left out is really left out of what the summariser sees.
  let seen = "";
  const q = provider();
  q.complete = async (params) => { seen = JSON.stringify(params.messages); return { id: "s", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "S2" }, finish_reason: "stop" }] }; };
  const b = agentOn(q);
  await b.prompt("keep me");
  await b.prompt("leave me out");
  await b.summarize(b.messages[2]);
  assert.match(seen, /keep me/);
  assert.doesNotMatch(seen, /leave me out/);

  const c = agentOn(provider());
  await c.seed("SUMMARY");
  assert.equal(summaryOf(c.messages[0]), "SUMMARY");
  assert.equal((await c.prompt("go on")).reason, "done");
  await assert.rejects(() => c.seed("again"), /empty conversation/);
  assert.equal(await agentOn(provider()).summarize(), null, "nothing to summarise");
});
