// A JavaScript sandbox for the model: its code runs in a Worker (browser)
// or a worker thread (Node) with no DOM and, by default, no network, a
// captured console, and a `tools` object that calls the agent's own tools
// (the files too, through the file tools). The `run_js` tool wraps it so
// the model can compute, transform data and run a skill's scripts instead
// of guessing.

import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";

/**
 * Isolation is best effort: the code runs in a Worker of the page's origin with network and storage
 * globals removed. Code that can be trusted with nothing should run in a sandboxed iframe of its own.
 */
export interface SandboxOptions {
  /** Kill the run after this long (default 10 s, max 60 s). */
  timeoutMs?: number;
  /** Leave fetch/WebSocket available inside the sandbox (default false). */
  network?: boolean;
  /** Longest console output kept (default 20 000 chars). */
  maxLogChars?: number;
  /** Most tool calls one run may make (default 50). */
  maxToolCalls?: number;
  /** Longest code accepted (default 20 000 chars). */
  maxCodeChars?: number;
}

/** What `runInSandbox` needs to give the code its `tools`. */
export interface SandboxToolBridge {
  names: string[];
  /** Resolves with the tool's text; rejects with what the model would be told when it did not succeed. */
  call(name: string, args: unknown, signal: AbortSignal): Promise<string>;
  max?: number;
}

export interface SandboxResult {
  ok: boolean;
  /** The value the code returned, JSON-serialised. */
  result?: string;
  logs: string;
  error?: string;
  durationMs: number;
}

// The worker program. Plain JS, no imports, so it can run as a blob URL
// Worker and as a worker_threads eval script alike.
const WORKER_SOURCE = `
"use strict";
var isNode = typeof self === "undefined";
var port, send;
if (isNode) {
  port = require("node:worker_threads").parentPort;
  send = function (m) { port.postMessage(m); };
} else {
  port = self;
  send = function (m) { self.postMessage(m); };
}
var pending = new Map(), seq = 0;
function callTool(name, args) {
  return new Promise(function (resolve, reject) {
    var id = ++seq;
    pending.set(id, { resolve: resolve, reject: reject });
    send({ type: "tool", id: id, name: name, args: args });
  });
}
var tools = {};
var logs = [], logChars = 0, maxLog = 20000;
function fmt(a) {
  if (typeof a === "string") return a;
  try { return JSON.stringify(a, null, 0); } catch (e) { return String(a); }
}
function log() {
  var line = Array.prototype.map.call(arguments, fmt).join(" ");
  if (logChars < maxLog) { logs.push(line); logChars += line.length + 1; }
}
var sandboxConsole = { log: log, info: log, warn: log, error: log, debug: log, table: log, dir: log };
function serialize(v) {
  if (v === undefined) return undefined;
  try { return JSON.stringify(v); } catch (e) { return JSON.stringify(String(v)); }
}
async function run(msg) {
  maxLog = msg.maxLogChars || maxLog;
  var g = isNode ? globalThis : self;
  // Shadow a global on the object and on every prototype that defines it (so a getter cannot be fetched from the prototype).
  function hide(k) {
    for (var o = g; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, k)) { try { Object.defineProperty(o, k, { value: undefined, configurable: false, writable: false }); } catch (e) {} }
    }
    try { Object.defineProperty(g, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  // Always: no nested workers (they would get the network back), no direct access to the app's storage.
  ["Worker", "SharedWorker", "indexedDB", "caches", "BroadcastChannel"].forEach(hide);
  if (!msg.network) {
    ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts", "navigator"].forEach(hide);
    if (isNode) { try { globalThis.require = undefined; globalThis.process = undefined; } catch (e) {} }
  }
  var start = Date.now();
  try {
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    (msg.tools || []).forEach(function (name) {
      tools[name] = function (args) { return callTool(name, args === undefined ? {} : args); };
    });
    var fn = new AsyncFunction("input", "console", "tools", msg.code);
    // A tool the code may not call says so, rather than "tools.x is not a function".
    var offered = new Proxy(Object.freeze(tools), {
      get: function (t, k) {
        if (k in t || typeof k !== "string" || k === "then" || k === "toJSON") return t[k];
        return function () { return Promise.reject(new Error("tools." + k + " cannot be called from run_js; call it directly if you have it")); };
      },
    });
    var value = await fn(msg.input, sandboxConsole, offered);
    send({ type: "done", result: serialize(value), logs: logs.join("\\n"), durationMs: Date.now() - start });
  } catch (e) {
    send({ type: "error", error: (e && e.stack) || String(e), logs: logs.join("\\n"), durationMs: Date.now() - start });
  }
}
function onMessage(m) {
  if (m.type === "run") run(m);
  else if (m.type === "toolResult") {
    var p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) { p.resolve(m.value); return; }
    // The host's words, without this program's frames in them.
    var err = new Error(m.error);
    err.stack = m.error;
    p.reject(err);
  }
}
if (isNode) port.on("message", onMessage); else self.onmessage = function (ev) { onMessage(ev.data); };
`;

interface WorkerLike {
  post(msg: unknown): void;
  onMessage(fn: (msg: Record<string, unknown>) => void): void;
  /** The worker died or never started (a page's CSP, say). */
  onFail(fn: (why: string) => void): void;
  terminate(): void;
}

async function spawn(): Promise<WorkerLike> {
  if (typeof Worker === "function" && typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    return {
      post: (m) => w.postMessage(m),
      onMessage: (fn) => { w.onmessage = (ev) => fn(ev.data as Record<string, unknown>); },
      onFail: (fn) => { w.onerror = (ev) => { ev.preventDefault(); fn(ev.message || "The sandbox worker could not run; the page's Content-Security-Policy may block it."); }; },
      terminate: () => w.terminate(),
    };
  }
  // Node: worker_threads, imported in a way bundlers for the browser leave alone.
  const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<{ Worker: new (src: string, o: { eval: boolean }) => { postMessage(m: unknown): void; on(ev: string, fn: (m: unknown) => void): void; terminate(): void } }>;
  const { Worker: NodeWorker } = await dynamicImport("node:worker_threads");
  const w = new NodeWorker(WORKER_SOURCE, { eval: true });
  return {
    post: (m) => w.postMessage(m),
    onMessage: (fn) => w.on("message", (m) => fn(m as Record<string, unknown>)),
    onFail: (fn) => {
      w.on("error", (e) => fn(e instanceof Error ? e.message : String(e)));
      w.on("exit", () => fn("The sandbox worker exited before the code finished."));
    },
    terminate: () => w.terminate(),
  };
}

/** Runs `code` once in a fresh sandbox; `bridge` gives it its `tools`. */
export async function runInSandbox(
  code: string,
  input: unknown,
  opts: SandboxOptions & { signal?: AbortSignal; bridge?: SandboxToolBridge } = {},
): Promise<SandboxResult> {
  const timeoutMs = Math.min(60_000, Math.max(100, opts.timeoutMs ?? 10_000));
  const worker = await spawn();
  const started = Date.now();
  const bridge = opts.bridge;
  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    // Whatever the code left running ends with it: a call still queued never starts, one in progress is stopped.
    const running = new AbortController();
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      running.abort();
      resolve(r);
    };
    // The limit is on the code's own time: waiting for a tool (a backtest, the user's answer) does not count.
    let left = timeoutMs, resumed = 0, waiting = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startClock = () => {
      resumed = Date.now();
      timer = setTimeout(() => finish({ ok: false, logs: "", error: `Timed out after ${timeoutMs} ms`, durationMs: Date.now() - started }), Math.max(0, left));
    };
    const whileWaiting = async <T>(work: () => Promise<T>): Promise<T> => {
      if (waiting++ === 0) { clearTimeout(timer); left -= Date.now() - resumed; }
      try { return await work(); } finally { if (--waiting === 0 && !settled) startClock(); }
    };
    startClock();
    const onAbort = () => finish({ ok: false, logs: "", error: "Aborted", durationMs: Date.now() - started });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Stopped while the worker was starting: an abort event is not sent twice.
    if (opts.signal?.aborted) return onAbort();
    worker.onFail((why) => finish({ ok: false, logs: "", error: why, durationMs: Date.now() - started }));

    // One tool at a time, as the agent runs the model's calls (a page has one backtest, one question at a time).
    let toolCalls = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const callTool = (name: string, args: unknown): Promise<string> => {
      if (!bridge?.names.includes(name)) throw new Error(`there is no tool named "${name}"`);
      const max = bridge.max ?? 50;
      if (++toolCalls > max) throw new Error(`this run has used its ${max} tool calls; return what you have and continue in another run_js`);
      const turn = queue.then(() => {
        if (settled) throw new Error("the code has finished");
        return bridge.call(name, args, running.signal);
      });
      queue = turn.catch(() => {});
      return turn;
    };

    worker.onMessage(async (m) => {
      if (m.type === "done") {
        finish({ ok: true, result: m.result as string | undefined, logs: (m.logs as string) ?? "", durationMs: (m.durationMs as number) ?? Date.now() - started });
      } else if (m.type === "error") {
        finish({ ok: false, error: String(m.error), logs: (m.logs as string) ?? "", durationMs: (m.durationMs as number) ?? Date.now() - started });
      } else if (m.type === "tool") {
        void whileWaiting(async () => {
          try {
            worker.post({ type: "toolResult", id: m.id, ok: true, value: await callTool(String(m.name), m.args) });
          } catch (e) {
            worker.post({ type: "toolResult", id: m.id, ok: false, error: (e as Error).message });
          }
        });
      }
    });
    worker.post({ type: "run", code, input, network: !!opts.network, maxLogChars: opts.maxLogChars, tools: bridge?.names });
  });
}

/** The `run_js` tool. */
export function sandboxTool(opts: SandboxOptions = {}): Tool {
  const maxCode = opts.maxCodeChars ?? 20_000;
  return defineTool<{ code: string; input?: unknown; timeout_ms?: number }>({
    name: "run_js",
    description:
      `Run JavaScript in a sandbox (no DOM, no network) and get back what it returns plus its console output. Use it for arithmetic, dates, parsing, data transformation and to run a skill's scripts instead of working them out by hand. The code is the body of an async function: use \`return\` for the result (JSON), \`console.log\` for notes. Available: \`input\` (the input argument), and \`tools\` — \`await tools.<name>(args)\` calls any of your other tools with the same arguments and rules, one at a time, and resolves with its full text result (it throws when the call fails or the user declines; do not work around a decline). A tool that cannot be called from code says so when called. Up to ${opts.maxToolCalls ?? 50} calls per run and ${maxCode} characters of code; time spent waiting for a tool does not count against the time limit.`,
    guidelines: "A large result you only need to compute over (logs, orders, a long list): fetch it inside run_js with `tools` and return the numbers, so the data never passes through this conversation. Parse a tool's text there rather than assuming a shape: try one call and look at it first.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript, the body of an async function" },
        input: { description: "Any JSON value made available as `input`" },
        timeout_ms: { type: "integer", minimum: 100, maximum: 60000 },
      },
      required: ["code"],
      additionalProperties: false,
    },
    maxResultChars: 24_000,
    async execute({ code, input, timeout_ms }, ctx) {
      if (code.length > maxCode) throw new Error(`the code is ${code.length} characters; the limit is ${maxCode}. Do less in one run.`);
      const bridge: SandboxToolBridge = {
        names: ctx.agent.tools.filter((t) => t.name !== "run_js" && !t.endsRun && !t.display?.hidden && t.callableFromCode !== false).map((t) => t.name),
        max: opts.maxToolCalls,
        call: async (name, args, signal) => {
          const r = await ctx.callTool(name, args, { signal });
          if (r.status !== "ok") throw new Error(r.text.replace(/^Error:\s*/, ""));
          return r.text;
        },
      };
      const r = await runInSandbox(code, input, { ...opts, timeoutMs: timeout_ms ?? opts.timeoutMs, signal: ctx.signal, bridge });
      const parts: string[] = [];
      if (r.logs) parts.push(`console:\n${r.logs}`);
      if (r.ok) parts.push(r.result === undefined ? "Returned: undefined" : `Returned: ${r.result}`);
      else parts.push(/^\w*Error\b/.test(r.error ?? "") ? String(r.error) : `Error: ${r.error}`);
      parts.push(`(${r.durationMs} ms)`);
      return { content: parts.join("\n\n"), details: r };
    },
  });
}
