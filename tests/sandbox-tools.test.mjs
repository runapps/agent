// run_js's `tools`: the code calls the agent's tools through the model's gate;
// a stopped run ends its worker, stuck or not. Runs against the compiled dist/ build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgent, defineTool, runInSandbox, Workspace } from "../dist/index.js";

/** A provider that replies from a list: `{ code }` calls run_js, a string answers. */
function scripted(script) {
  const requests = [];
  return {
    requests,
    provider: {
      name: "scripted",
      async models() { return [{ id: "m", is_default: true, capability: "text", max_input_tokens: 128000, max_tokens: 8192 }]; },
      async *stream(p) {
        requests.push(p);
        const next = script.shift();
        if (next === undefined) throw new Error("test: no scripted reply left");
        if (typeof next === "string") yield { choices: [{ index: 0, delta: { content: next }, finish_reason: "stop" }] };
        else yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${script.length}`, type: "function", function: { name: "run_js", arguments: JSON.stringify(next) } }] }, finish_reason: "tool_calls" }] };
      },
    },
  };
}

const opts = (extra = {}) => ({ model: "m", askUser: false, ...extra });

const add = (calls = []) => defineTool({
  name: "add",
  description: "Adds",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
  readOnly: true,
  execute: ({ a, b }) => { calls.push([a, b]); return String(a + b); },
});

/** What run_js told the model in the last run. */
const told = (agent) => agent.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");

test("run_js tools — the code calls a tool and only what it returns reaches the model", async () => {
  const calls = [];
  const big = defineTool({ name: "big", description: "Long", readOnly: true, maxResultChars: 100, execute: () => "x".repeat(50_000) });
  const { provider, requests } = scripted([{ code: "const s = await tools.add({ a: 2, b: 3 }); const l = await tools.big(); return { s, length: l.length };" }, "done"]);
  const agent = createAgent(provider, opts({ tools: [add(calls), big] }));
  const events = [];
  agent.on("tool_start", (e) => events.push(["start", e.name, e.parentId]));
  agent.on("tool_end", (e) => events.push(["end", e.name, e.parentId, e.status]));
  await agent.prompt("x");
  assert.deepEqual(calls, [[2, 3]]);
  // The whole result reaches the code (past big's maxResultChars), and nothing of it the conversation.
  assert.match(told(agent), /"s":"5","length":50000/);
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes("xxxxxxxx"));
  const parent = agent.messages.find((m) => m.role === "tool").tool_call_id;
  assert.deepEqual(events, [
    ["start", "run_js", undefined],
    ["start", "add", parent],
    ["end", "add", parent, "ok"],
    ["start", "big", parent],
    ["end", "big", parent, "ok"],
    ["end", "run_js", undefined, "ok"],
  ]);
  assert.equal(agent.messages.filter((m) => m.role === "tool").length, 1, "a nested call is not in the conversation");
});

test("run_js tools — a nested call goes through schema, confirm and the hook", async () => {
  const asked = [];
  const wipe = defineTool({ name: "wipe", description: "Wipes", destructive: true, execute: () => "wiped" });
  const hooked = [];
  const { provider } = scripted([
    { code: "try { await tools.add({ a: 'no', b: 1 }); } catch (e) { console.log('bad:', e.message); } try { await tools.wipe(); } catch (e) { console.log('no:', e.message); } return await tools.wipe();" },
    "done",
  ]);
  let answer = false;
  const ui = { confirm: async (title) => { asked.push(title); const a = answer; answer = true; return a; }, notify() {} };
  const agent = createAgent(provider, opts({ tools: [add(), wipe], ui, onToolCall: ({ name }) => { hooked.push(name); } }));
  await agent.prompt("x");
  const out = told(agent);
  assert.match(out, /bad: invalid arguments for add/);
  assert.match(out, /no: The user declined this action/);
  assert.match(out, /Returned: "wiped"/);
  assert.deepEqual(asked, ["Allow wipe?", "Allow wipe?"]);
  assert.deepEqual(hooked, ["run_js", "wipe", "wipe"], "an invalid call is refused before the hook");
});

test("run_js tools — the code gets the other tools, not run_js, not run-ending tools, and there is no fs", async () => {
  const end = defineTool({ name: "suggest", description: "Ends", endsRun: true, execute: () => "x" });
  const { provider } = scripted([{ code: "return { names: Object.keys(tools), hasFs: typeof fs };" }, "done"]);
  const agent = createAgent(provider, opts({ tools: [add(), end] }));
  await agent.prompt("x");
  assert.match(told(agent), /"names":\["add"\],"hasFs":"undefined"/);
});

test("run_js tools — callableFromCode: false keeps a tool from the code, not from the model", async () => {
  let ran = 0;
  const paid = defineTool({ name: "paid", description: "Costs money", callableFromCode: false, readOnly: true, execute: () => { ran++; return "paid"; } });
  const script = [
    { code: "console.log(Object.keys(tools).join()); try { await tools.paid(); } catch (e) { console.log(e.message); } return 1;" },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "direct", type: "function", function: { name: "paid", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    "done",
  ];
  const requests = [];
  const provider = {
    name: "s",
    async models() { return [{ id: "m", is_default: true, capability: "text", max_input_tokens: 128000, max_tokens: 8192 }]; },
    async *stream(p) {
      requests.push(p);
      const next = script.shift();
      if (typeof next === "string") yield { choices: [{ index: 0, delta: { content: next }, finish_reason: "stop" }] };
      else if (next.choices) yield next;
      else yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "js", type: "function", function: { name: "run_js", arguments: JSON.stringify(next) } }] }, finish_reason: "tool_calls" }] };
    },
  };
  const agent = createAgent(provider, opts({ tools: [add(), paid] }));
  await agent.prompt("x");
  const out = told(agent);
  assert.match(out, /console:\nadd\n/, "not among the code's tools");
  assert.match(out, /tools\.paid cannot be called from run_js/);
  assert.equal(ran, 1, "the model's direct call ran, the code's did not");
  assert.ok(requests[0].tools.some((t) => t.function.name === "paid"), "the model is still offered it");
});

test("run_js tools — a tool's failure reads as one error, with no frames of the bridge in it", async () => {
  const bad = defineTool({ name: "bad", description: "Fails", readOnly: true, execute: () => { throw new Error("No exchange is set"); } });
  const { provider } = scripted([{ code: "await tools.bad();" }, { code: "throw new Error('mine');" }, "done"]);
  const agent = createAgent(provider, opts({ tools: [bad] }));
  await agent.prompt("x");
  const [first, second] = agent.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(first, /^Error: No exchange is set\n\n\(\d+ ms\)$/);
  assert.match(second, /mine\n\s+at /, "the code's own error keeps its stack");
});

test("run_js tools — the call limit and the code limit", async () => {
  const calls = [];
  const { provider } = scripted([
    { code: "for (let i = 0; i < 5; i++) await tools.add({ a: i, b: 0 }); return 'all';" },
    { code: "// " + "x".repeat(200) },
    "done",
  ]);
  const agent = createAgent(provider, opts({ tools: [add(calls)], sandbox: { maxToolCalls: 3, maxCodeChars: 100 } }));
  await agent.prompt("x");
  const out = told(agent);
  assert.equal(calls.length, 3);
  assert.match(out, /used its 3 tool calls/);
  assert.match(out, /the limit is 100/);
});

test("run_js tools — calls run one at a time, in order", async () => {
  const log = [];
  const slow = defineTool({ name: "slow", description: "Slow", parameters: { type: "object", properties: { n: { type: "number" } } }, readOnly: true, execute: async ({ n }) => { log.push(`start ${n}`); await new Promise((r) => setTimeout(r, 30)); log.push(`end ${n}`); return String(n); } });
  const { provider } = scripted([{ code: "return await Promise.all([tools.slow({ n: 1 }), tools.slow({ n: 2 })]);" }, "done"]);
  const agent = createAgent(provider, opts({ tools: [slow] }));
  await agent.prompt("x");
  assert.deepEqual(log, ["start 1", "end 1", "start 2", "end 2"]);
  assert.match(told(agent), /Returned: \["1","2"\]/);
});

test("run_js tools — waiting for a tool does not count against the time limit; the code's own time does", async () => {
  const slow = defineTool({ name: "slow", description: "Slow", readOnly: true, execute: async () => { await new Promise((r) => setTimeout(r, 500)); return "late"; } });
  const { provider } = scripted([
    { code: "return await tools.slow();", timeout_ms: 150 },
    { code: "await tools.slow(); while (true) {}", timeout_ms: 150 },
    "done",
  ]);
  const agent = createAgent(provider, opts({ tools: [slow] }));
  await agent.prompt("x");
  const [first, second] = agent.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(first, /Returned: "late"/);
  assert.match(second, /Timed out after 150 ms/);
});

test("run_js tools — a call the code did not wait for ends with the code", async () => {
  let stopped = false, ran = 0;
  const long = defineTool({ name: "long", description: "Long", readOnly: true, execute: (_, ctx) => { ran++; return new Promise((resolve) => { ctx.signal.addEventListener("abort", () => { stopped = true; resolve("stopped"); }, { once: true }); }); } });
  const { provider } = scripted([{ code: "tools.long(); tools.long(); await new Promise((r) => setTimeout(r, 30)); return 'gone';" }, "done"]);
  const agent = createAgent(provider, opts({ tools: [long] }));
  await agent.prompt("x");
  assert.match(told(agent), /Returned: "gone"/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stopped, true, "the one in progress is stopped");
  assert.equal(ran, 1, "the queued one never starts");
});

/** CPU this process burned over `ms`: a worker stuck in a loop shows up as about `ms`. */
async function cpuOver(ms) {
  const a = process.cpuUsage();
  await new Promise((r) => setTimeout(r, ms));
  const d = process.cpuUsage(a);
  return (d.user + d.system) / 1000;
}

test("stop — a run_js stuck in a loop ends at once and its worker is gone", async () => {
  const { provider } = scripted([{ code: "while (true) {}", timeout_ms: 60000 }, "after"]);
  const agent = createAgent(provider, opts());
  let started;
  const running = new Promise((r) => { started = r; });
  agent.on("tool_start", () => started());
  const run = agent.prompt("x");
  await running;
  // Let the worker start and spin.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(await cpuOver(200) > 100, "the loop is burning CPU");
  const t0 = Date.now();
  await agent.abort();
  const result = await run;
  assert.ok(Date.now() - t0 < 2000, "stopped at once, not at the 60 s limit");
  assert.equal(result.reason, "aborted");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(await cpuOver(300) < 100, "the worker no longer runs");
});

test("stop — a tool in progress inside run_js is stopped and the worker with it", async () => {
  let aborted = false, started;
  const running = new Promise((r) => { started = r; });
  const long = defineTool({ name: "long", description: "Long", execute: (_, ctx) => new Promise((resolve) => { started(); ctx.signal.addEventListener("abort", () => { aborted = true; resolve("x"); }, { once: true }); }) });
  const { provider } = scripted([{ code: "await tools.long(); return 'never';" }]);
  const agent = createAgent(provider, opts({ tools: [long] }));
  const ends = [];
  agent.on("tool_end", (e) => ends.push([e.name, e.status]));
  const run = agent.prompt("x");
  await running;
  await agent.abort();
  await run;
  assert.equal(aborted, true);
  assert.deepEqual(ends.sort(), [["long", "skipped"], ["run_js", "skipped"]]);
});

test("stop — a signal already aborted never leaves a worker running", async () => {
  const c = new AbortController();
  c.abort();
  const t0 = Date.now();
  const r = await runInSandbox("while (true) {}", undefined, { signal: c.signal, timeoutMs: 60000 });
  assert.equal(r.error, "Aborted");
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(await cpuOver(200) < 100);
});

const openWs = (id) => Workspace.open(null, { project: "t", id: `${id}-${Math.random()}`, indexedDB: null, userSkills: false });

test("run_js tools — from code read_file and list_files give everything; called directly they keep their limits", async () => {
  const workspace = await openWs("whole");
  await workspace.write("/big.txt", Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
  for (let i = 0; i < 510; i++) await workspace.write(`/many/${i}.txt`, "x");
  const { provider } = scripted([
    { code: `
      const all = await tools.read_file({ path: "/big.txt" });
      const part = await tools.read_file({ path: "/big.txt", offset: 4999 });
      const some = await tools.read_file({ path: "/big.txt", limit: 3 });
      const list = await tools.list_files({ path: "/many" });
      return { lines: all.split("\\n").length, last: all.trim().split("\\n").pop(), part: part.split("\\n").length, some: some.split("\\n")[0], capped: /entries limit/.test(list), listed: list.split("\\n").length };` },
    "done",
  ]);
  const agent = createAgent(provider, opts({ workspace, persist: false }));
  await agent.prompt("x");
  const out = told(agent);
  assert.match(out, /"lines":5000,"last":"line 5000","part":2/, out);
  assert.match(out, /"some":"line 1","capped":false,"listed":510/, out);
  const direct = await agent.tools.find((t) => t.name === "read_file").execute({ path: "/big.txt" }, { workspace, progress() {} });
  assert.match(direct, /Showing lines 1-2000 of 5000/);
});

test("run_js tools — files through tools keep read-before-write and asking before a delete", async () => {
  const workspace = await openWs("guard");
  await workspace.write("/data.csv", "a,b");
  await workspace.write("/gone.txt", "x");
  const { provider } = scripted([
    { code: `try { await tools.write_file({ path: "/data.csv", content: "x" }); } catch (e) { console.log("refused:", e.message); }
      await tools.read_file({ path: "/data.csv" });
      await tools.write_file({ path: "/data.csv", content: "c,d" });
      try { await tools.delete_file({ path: "/gone.txt" }); } catch (e) { console.log("no:", e.message); }
      return "ok";` },
    "done",
  ]);
  const asked = [];
  const agent = createAgent(provider, opts({ workspace, persist: false, ui: { confirm: async (t) => { asked.push(t); return false; }, notify() {} } }));
  await agent.prompt("x");
  const out = told(agent);
  assert.match(out, /refused: .*not overwritten|refused: .*not read it/s, out);
  assert.match(out, /no: The user declined/);
  assert.equal(await workspace.readText("/data.csv"), "c,d", "reading in the code counts as reading");
  assert.ok(await workspace.exists("/gone.txt"));
  assert.equal(asked.length, 1);
});

test("run_js — without file tools the code cannot reach the workspace and the prompt does not mention it", async () => {
  const workspace = await openWs("nofiles");
  await workspace.write("/secret.txt", "s");
  const { provider } = scripted([{ code: "return { keys: Object.keys(tools), fs: typeof fs };" }, "done"]);
  const agent = createAgent(provider, opts({ workspace, persist: false, fileTools: false }));
  await agent.prompt("x");
  assert.match(told(agent), /"keys":\[\],"fs":"undefined"/);
  const sys = await agent.systemPrompt();
  assert.doesNotMatch(sys, /# Workspace|tools\.read_file/);
});

test("run_js — the prompt says read_file is whole from code only when there is a read_file", async () => {
  const workspace = await openWs("hint");
  const agent = createAgent(scripted([]).provider, opts({ workspace, persist: false }));
  assert.match(await agent.systemPrompt(), /tools\.read_file\(\{ path \}\) returns the whole file/);
  assert.doesNotMatch(agent.tools.find((t) => t.name === "run_js").description, /\bfs\b/);
});

test("run_js tools — the model is told how to use them", async () => {
  const { provider } = scripted([]);
  const agent = createAgent(provider, opts({ tools: [add()] }));
  assert.match(agent.tools.find((t) => t.name === "run_js").description, /tools\.<name>\(args\)/);
  assert.match(await agent.systemPrompt(), /fetch it inside run_js with `tools`/);
});
