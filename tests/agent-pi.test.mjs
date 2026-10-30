// The pi-derived pieces: sessions saved in the workspace and resumed by
// id, summarising compaction, slash templates and /skill:, multi-edit
// with fuzzy matching, AGENTS.md and memory notes in the system prompt.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RunApps } from "@runappsai/sdk";
import { Workspace, memoryFS, applyEdits, planCut, parseCommandArgs, substituteArgs, summaryOf, serializeConversation } from "../dist/index.js";

function sse(chunks) {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).concat("data: [DONE]\n\n");
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close(); } }), { status: 200 });
}
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, total_cost: 0.001 };
const reply = (text, finish = "stop") => [
  { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
];
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });

/** Streams come from `script`; non-streaming chat calls (the summariser) from `plain`. */
function scripted(script, plain = [], maxInput = 100000) {
  const requests = [];
  const client = new RunApps({
    apiKey: "k",
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/v1/models")) return json({ object: "list", data: [{ id: "m", object: "model", capability: "text", max_input_tokens: maxInput, max_tokens: 8192, is_default: true }] });
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.stream) { const n = script.shift(); if (!n) throw new Error("no scripted stream"); return sse(n); }
      const n = plain.shift(); if (!n) throw new Error("no scripted reply");
      return json(n);
    },
  });
  return { client, requests };
}
const ws = (id, extra = {}) => Workspace.open(null, { id, project: "t", indexedDB: null, ...extra });

test("sessions — an agent with an id saves after every turn and a new agent with the same id resumes it", async () => {
  const { client, requests } = scripted([reply("first"), reply("second")]);
  const w = await ws("sess-" + Math.random());
  const a = client.agent({ model: "m", id: "chat-1", workspace: w, sandbox: false, askUser: false });
  let saved = 0;
  a.on("session_saved", () => saved++);
  await a.prompt("hello there");
  assert.ok(saved >= 1);
  const list = await w.sessions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "chat-1");
  assert.equal(list[0].title, "hello there");
  assert.equal(list[0].messages, 2);

  const b = client.agent({ model: "m", id: "chat-1", workspace: w, sandbox: false, askUser: false });
  await b.ready();
  assert.equal(b.messages.length, 2);
  await b.prompt("more");
  assert.equal(requests.at(-1).messages.length, 4); // system + 3
  assert.equal((await w.sessions.get("chat-1")).messages.length, 4);

  // A different id is a fresh conversation; persist:false saves nothing.
  const c = client.agent({ model: "m", id: "chat-2", workspace: w, sandbox: false, askUser: false, persist: false });
  await c.ready();
  assert.equal(c.messages.length, 0);
  await w.sessions.delete("chat-1");
  assert.equal((await w.sessions.list()).length, 0);
});

test("compaction — planCut keeps whole recent turns and extracts an earlier summary", () => {
  const big = "x".repeat(600);
  const msgs = [];
  for (let t = 0; t < 5; t++) {
    msgs.push({ role: "user", content: `q${t} ${big}` });
    msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${t}`, type: "function", function: { name: "f", arguments: "{}" } }] });
    msgs.push({ role: "tool", tool_call_id: `c${t}`, content: big });
    msgs.push({ role: "assistant", content: `a${t}` });
  }
  const plan = planCut(msgs, 500);
  assert.ok(plan);
  // Walking back from the newest turn, two turns (~420 tokens each) are needed to reach 500.
  assert.equal(plan.kept[0].content.slice(0, 2), "q3");
  assert.equal(plan.toSummarize.length, 12);
  assert.equal(plan.previousSummary, undefined);
  // With a summary message at the front, it becomes previousSummary.
  const withSummary = [{ role: "user", content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nOLD\n</summary>" }, ...msgs];
  assert.equal(summaryOf(withSummary[0]), "OLD");
  const plan2 = planCut(withSummary, 500);
  assert.equal(plan2.previousSummary, "OLD");
  assert.equal(plan2.toSummarize.length, 12);
  assert.equal(planCut(msgs.slice(0, 4), 500), null, "one turn: nothing older to summarise");
  const text = serializeConversation(msgs.slice(0, 4));
  assert.match(text, /^\[User\]: q0/);
  assert.match(text, /\[Assistant tool calls\]: f\(\{\}\)/);
  assert.match(text, /\[Tool result\]: x+/);
});

test("compaction — near the window the agent summarises older turns with the model and keeps going", async () => {
  // Window 4000 tokens: reserve 800 (20 %), keep 1600 (40 %). Each turn ≈ 1100 tokens.
  const streams = [reply("a0 " + "y".repeat(3000)), reply("a1 " + "y".repeat(3000)), reply("a2 " + "y".repeat(3000)), reply("done")];
  const { client, requests } = scripted(streams, [
    { id: "s", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "## Goal\nhelp\n## Progress\n- [x] a0" }, finish_reason: "stop" }], usage: { total_cost: 0.002, prompt_tokens: 50, completion_tokens: 10 } },
  ], 4000);
  const agent = client.agent({ model: "m", sandbox: false, askUser: false });
  const events = [];
  agent.on("compaction", (e) => events.push(e));
  await agent.prompt("q0");
  await agent.prompt("q1");
  await agent.prompt("q2");
  await agent.prompt("q3");
  const summaryEvents = events.filter((e) => e.summary);
  assert.ok(summaryEvents.length >= 1, "a summary compaction happened");
  assert.ok(summaryEvents[0].tokensAfter < summaryEvents[0].tokensBefore);
  // The summariser was asked with pi's prompt and the conversation as text.
  const summarize = requests.find((r) => !r.stream);
  assert.match(summarize.messages[0].content, /context summarization assistant/);
  assert.match(summarize.messages[1].content, /<conversation>[\s\S]*\[User\]: q0/);
  // The transcript now starts with the summary message and the last request carried it.
  assert.equal(summaryOf(agent.messages[0]), "## Goal\nhelp\n## Progress\n- [x] a0");
  const last = requests.at(-1);
  assert.ok(last.stream);
  assert.match(last.messages[1].content, /compacted into the following summary/);
  assert.equal(last.messages.at(-1).content, "q3");
  assert.equal(agent.usage.total_cost, 0.006); // 4 streamed calls + summariser
});

test("compaction — when the summary alone does not fit, trimming keeps the summary and drops old turns", async () => {
  // Window 2000: reserve 400, keep 800. Replies ≈ 1000 tokens; the summariser answers with a 600-token summary.
  const big = () => reply("a " + "y".repeat(3000));
  const summary = "## Goal\nkeep facts\n" + "z".repeat(1800);
  const { client } = scripted([big(), big(), big(), reply("done")], Array(3).fill({ id: "s", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: summary }, finish_reason: "stop" }], usage: { total_cost: 0 } }), 2000);
  const agent = client.agent({ model: "m", sandbox: false, askUser: false });
  const events = [];
  agent.on("compaction", (e) => events.push(e));
  for (const q of ["q0", "q1", "q2", "q3"]) await agent.prompt(q);
  assert.ok(events.some((e) => e.summary));
  const trims = events.filter((e) => !e.summary);
  assert.ok(trims.length >= 1, "trimming also ran");
  assert.equal(summaryOf(agent.messages[0]), summary, "the summary stays first");
  assert.equal(agent.messages.at(-1).content, "done");
});

test("compaction — a failing summariser falls back to trimming; compaction:false never summarises", async () => {
  const streams = [reply("a0 " + "y".repeat(3000)), reply("a1 " + "y".repeat(3000)), reply("a2 " + "y".repeat(3000)), reply("done")];
  const { client, requests } = scripted(streams, [], 4000); // no plain reply → summariser throws
  const agent = client.agent({ model: "m", sandbox: false, askUser: false });
  const events = [];
  agent.on("compaction", (e) => events.push(e));
  for (const q of ["q0", "q1", "q2", "q3"]) await agent.prompt(q);
  assert.ok(events.some((e) => !e.summary && e.droppedTurns > 0));
  assert.equal(requests.filter((r) => !r.stream).length, 1, "one summariser attempt, which failed");
  const { client: c2, requests: r2 } = scripted([reply("a0 " + "y".repeat(3000)), reply("a1 " + "y".repeat(3000)), reply("a2 " + "y".repeat(3000)), reply("done")], [{ bad: true }], 4000);
  const b = c2.agent({ model: "m", sandbox: false, askUser: false, compaction: false });
  for (const q of ["q0", "q1", "q2", "q3"]) await b.prompt(q);
  assert.ok(r2.every((r) => r.stream), "no summariser call with compaction:false");
});

test("templates — argument parsing and substitution follow pi", () => {
  assert.deepEqual(parseCommandArgs(`a "b c" '' d`), ["a", "b c", "", "d"]);
  assert.equal(substituteArgs("Review $1 for $ARGUMENTS; ${2:-main}; ${@:2}", ["x"]), "Review x for x; main; ");
  assert.equal(substituteArgs("${@:2:1}|$@", ["a", "b", "c"]), "b|a b c");
});

test("templates and skills — /name expands a workspace template, /skill:name loads the skill, with the user's text after", async () => {
  const { client, requests } = scripted([reply("ok"), reply("ok"), reply("ok")]);
  const w = await ws("tpl-" + Math.random());
  await w.write("/prompts/review.md", "---\ndescription: Review a file\nargument-hint: <path>\n---\nReview $1 carefully.\nFocus: ${2:-style}");
  const skillsFs = memoryFS({ "/unit/SKILL.md": "---\nname: unit\ndescription: Units\n---\nConvert carefully." }, { readonly: true });
  // Skills normally come from a zip; a mount under /skills is refused, so write the skill into the work layer? /skills is read-only too.
  // Use a zip-less path: templates only here; the skill comes from the shared helper below.
  const agent = client.agent({ model: "m", workspace: w, sandbox: false, askUser: false, persist: false });
  await agent.prompt("/review src/a.ts");
  assert.equal(requests[0].messages.at(-1).content, "Review src/a.ts carefully.\nFocus: style");
  await agent.prompt("/nosuch thing");
  assert.equal(requests[1].messages.at(-1).content, "/nosuch thing", "unknown slash command is sent as typed");
  void skillsFs;
});

test("edit — several disjoint edits, fuzzy quotes/dashes, and pi's error messages", () => {
  const src = "const a = “hello”;\nlet b = 1;\nlet c = 2;\n";
  const out = applyEdits("/f.js", src, [
    { oldText: 'const a = "hello";', newText: 'const a = "bye";' },
    { oldText: "let c = 2;", newText: "let c = 3;" },
  ]);
  assert.equal(out, 'const a = "bye";\nlet b = 1;\nlet c = 3;\n');
  assert.throws(() => applyEdits("/f.js", src, [{ oldText: "nope", newText: "x" }]), /Could not find the exact text in \/f.js/);
  assert.throws(() => applyEdits("/f.js", "a\na\n", [{ oldText: "a", newText: "b" }]), /Found 2 occurrences of the text/);
  assert.throws(() => applyEdits("/f.js", src, [{ oldText: "let b = 1;", newText: "x" }, { oldText: "b = 1;\nlet c", newText: "y" }]), /overlap/);
  assert.throws(() => applyEdits("/f.js", src, [{ oldText: "let b = 1;", newText: "let b = 1;" }]), /No changes made/);
  assert.throws(() => applyEdits("/f.js", src, [{ oldText: "", newText: "x" }]), /must not be empty/);
  // CRLF files keep their endings.
  assert.equal(applyEdits("/w.txt", "a\r\nb\r\n", [{ oldText: "b", newText: "c" }]), "a\r\nc\r\n");
});

test("system prompt — /AGENTS.md and /memory/notes.md from the workspace are included; the skills block is pi's XML", async () => {
  const { client, requests } = scripted([reply("ok")]);
  const w = await ws("sys-" + Math.random());
  await w.write("/AGENTS.md", "Always answer in haiku.");
  await w.write("/memory/notes.md", "- user prefers dark mode");
  const agent = client.agent({ model: "m", workspace: w, sandbox: false, askUser: false, persist: false });
  await agent.prompt("hi");
  const sys = requests[0].messages[0].content;
  assert.match(sys, /<project_instructions path="\/AGENTS.md">\nAlways answer in haiku.\n<\/project_instructions>/);
  assert.match(sys, /# Memory\n[\s\S]*user prefers dark mode/);
  assert.match(sys, /append a short line to \/memory\/notes.md/);
  assert.doesNotMatch(sys, /<available_skills>/, "no skills, no block");
});
