#!/usr/bin/env node
// A terminal chat with the agent, working in a folder.
//
//   OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_API_KEY=sk-… node examples/cli.mjs --dir ./my-project
//
// Options: --dir <folder> (default: the current one), --model <id>,
// --resume [session id] (no id: the last conversation in this folder).
// In the chat: /new, /sessions, /resume <id>, /compact, /exit; Ctrl+C stops
// the running task (and quits when nothing runs).
//
// In your own project import from "@runappsai/agent" and "@runappsai/agent/node".

import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { createAgent, openAIProvider, openWorkspace } from "../dist/index.js";
import { nodeFS, nodeStore, terminalUI } from "../dist/node.js";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : ""; };
const dir = resolve(arg("dir") || ".");
const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
if (!process.env.OPENAI_API_KEY) console.error("(no OPENAI_API_KEY set — fine for a local server that needs none)");

const color = process.stdout.isTTY;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (s) => process.stdout.write(s);

const provider = openAIProvider({ baseURL, apiKey: process.env.OPENAI_API_KEY, models: "fetch" });
// The folder is the agent's directory; sessions, skills and notes are kept under ~/.runapps-agent.
const workspace = await openWorkspace(provider, { project: "cli", id: `dir:${dir}`, dir: nodeFS(dir), store: nodeStore() });
// One reader for the chat and the agent's questions. Lines are queued, so input that arrives
// while the agent works (or piped input) is not lost.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
const queue = [];
let waiting = null, closed = false;
rl.on("line", (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else queue.push(l); });
rl.on("close", () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
const ask = (prompt, signal) => new Promise((done) => {
  out(prompt);
  if (queue.length) return done(queue.shift());
  if (closed) return done(null);
  waiting = done;
  signal?.addEventListener("abort", () => { if (waiting === done) { waiting = null; done(null); } }, { once: true });
});
const ui = terminalUI({ ask });

let agent;
const open = async (id) => {
  agent = createAgent(provider, {
    id,
    model: arg("model") || process.env.MODEL || undefined,
    workspace,
    ui,
    appName: "agent CLI",
    instructions: `You are a helpful assistant working in the folder ${dir}. Keep answers short; this is a terminal.`,
  });
  await agent.ready();
  let thinking = false;
  agent.on("reasoning_delta", ({ delta }) => { if (!thinking) { out(paint("2", "\n· thinking: ")); thinking = true; } out(paint("2", delta)); });
  agent.on("text_delta", ({ delta }) => { if (thinking) { out("\n"); thinking = false; } out(delta); });
  agent.on("tool_start", ({ name, args }) => {
    thinking = false;
    const what = args && typeof args === "object" ? (args.path ?? args.query ?? (typeof args.code === "string" ? args.code.split("\n")[0] : "")) : "";
    out(paint("36", `\n⚙ ${name}${what ? ` ${String(what).slice(0, 80)}` : ""}`));
  });
  agent.on("tool_end", ({ status }) => out(paint(status === "ok" ? "32" : "31", status === "ok" ? " ✓" : ` ${status}`)));
  agent.on("compaction", ({ summary }) => out(paint("2", `\n(context ${summary ? "summarised" : "trimmed"})`)));
  if (agent.messages.length) out(paint("2", `Resumed ${agent.id} (${agent.messages.length} messages).\n`));
};

const resumeArg = arg("resume");
const last = resumeArg === "" ? (await workspace.sessions.list())[0]?.id : undefined;
await open(resumeArg || last || undefined);

// Ctrl+C: stop the running task, or quit when idle.
rl.on("SIGINT", () => { if (agent.busy) { void agent.abort(); out(paint("33", "\n(stopped)\n")); } else { rl.close(); process.exit(0); } });

out(paint("2", `Working in ${dir} — /exit to quit.\n`));
for (;;) {
  const got = await ask(paint("1", "\n› "));
  if (got === null) break;   // input closed
  const line = got.trim();
  if (!line) continue;
  if (line === "/exit" || line === "/quit") break;
  if (line === "/new") { await open(); out(paint("2", `New conversation ${agent.id}.\n`)); continue; }
  if (line === "/sessions") {
    for (const s of await workspace.sessions.list()) out(`${s.id === agent.id ? "*" : " "} ${s.id}  ${paint("2", new Date(s.savedAt).toLocaleString())}  ${s.title}\n`);
    continue;
  }
  if (line.startsWith("/resume ")) { await open(line.slice(8).trim()); continue; }
  if (line === "/compact") { out((await agent.compact()) ? "compacted\n" : "nothing to compact\n"); continue; }
  const r = await agent.prompt(line);
  if (r.reason === "error") out(paint("31", `\n✗ ${r.error?.message}`));
  else if (r.reason === "max_turns") out(paint("33", "\n(turn limit reached — send /continue-style follow-up to go on)"));
  const u = agent.usage;
  out(paint("2", `\n[${u.calls} calls · ${u.prompt_tokens + u.completion_tokens} tokens${u.total_cost ? ` · $${u.total_cost.toFixed(4)}` : ""}]\n`));
}
rl.close();
process.exit(0);
