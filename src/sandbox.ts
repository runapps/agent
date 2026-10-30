// A JavaScript sandbox for the model: its code runs in a Worker (browser)
// or a worker thread (Node) with no DOM and, by default, no network, a
// captured console, and an `fs` bridged to the workspace. The `run_js`
// tool wraps it so the model can compute, transform data and run a
// skill's scripts instead of guessing.

import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";
import type { Workspace } from "./workspace.js";

export interface SandboxOptions {
  /** Kill the run after this long (default 10 s, max 60 s). */
  timeoutMs?: number;
  /** Leave fetch/WebSocket available inside the sandbox (default false). */
  network?: boolean;
  /** Longest console output kept (default 20 000 chars). */
  maxLogChars?: number;
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
function rpc(op, args) {
  return new Promise(function (resolve, reject) {
    var id = ++seq;
    pending.set(id, { resolve: resolve, reject: reject });
    send({ type: "fs", id: id, op: op, args: args });
  });
}
var fs = {
  read: function (p) { return rpc("read", [p]); },
  write: function (p, c) { return rpc("write", [p, c]); },
  list: function (p) { return rpc("list", [p || "/"]); },
  exists: function (p) { return rpc("exists", [p]); },
  remove: function (p) { return rpc("delete", [p]); },
};
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
  if (!msg.network) {
    var g = isNode ? globalThis : self;
    ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "navigator"].forEach(function (k) {
      try { Object.defineProperty(g, k, { value: undefined, configurable: true, writable: true }); } catch (e) {}
    });
    if (isNode) { try { globalThis.require = undefined; globalThis.process = undefined; } catch (e) {} }
  }
  var start = Date.now();
  try {
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    var fn = new AsyncFunction("fs", "input", "console", msg.code);
    var value = await fn(fs, msg.input, sandboxConsole);
    send({ type: "done", result: serialize(value), logs: logs.join("\\n"), durationMs: Date.now() - start });
  } catch (e) {
    send({ type: "error", error: (e && e.stack) || String(e), logs: logs.join("\\n"), durationMs: Date.now() - start });
  }
}
function onMessage(m) {
  if (m.type === "run") run(m);
  else if (m.type === "fsResult") {
    var p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
  }
}
if (isNode) port.on("message", onMessage); else self.onmessage = function (ev) { onMessage(ev.data); };
`;

interface WorkerLike {
  post(msg: unknown): void;
  onMessage(fn: (msg: Record<string, unknown>) => void): void;
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
    terminate: () => w.terminate(),
  };
}

/** Runs `code` once in a fresh sandbox bound to `ws` (null: no fs). */
export async function runInSandbox(
  ws: Workspace | null,
  code: string,
  input: unknown,
  opts: SandboxOptions & { signal?: AbortSignal } = {},
): Promise<SandboxResult> {
  const timeoutMs = Math.min(60_000, Math.max(100, opts.timeoutMs ?? 10_000));
  const worker = await spawn();
  const started = Date.now();
  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, logs: "", error: `Timed out after ${timeoutMs} ms`, durationMs: Date.now() - started }), timeoutMs);
    const onAbort = () => finish({ ok: false, logs: "", error: "Aborted", durationMs: Date.now() - started });
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    worker.onMessage(async (m) => {
      if (m.type === "done") {
        finish({ ok: true, result: m.result as string | undefined, logs: (m.logs as string) ?? "", durationMs: (m.durationMs as number) ?? Date.now() - started });
      } else if (m.type === "error") {
        finish({ ok: false, error: String(m.error), logs: (m.logs as string) ?? "", durationMs: (m.durationMs as number) ?? Date.now() - started });
      } else if (m.type === "fs") {
        const id = m.id;
        const args = (m.args as unknown[]) ?? [];
        try {
          if (!ws) throw new Error("no workspace");
          let value: unknown;
          switch (m.op) {
            case "read": value = await ws.readText(String(args[0])); break;
            case "write": await ws.write(String(args[0]), String(args[1] ?? "")); value = true; break;
            case "list": value = (await ws.list(String(args[0] ?? "/"))).map((f) => ({ path: f.path, size: f.size })); break;
            case "exists": value = await ws.exists(String(args[0])); break;
            case "delete": await ws.delete(String(args[0])); value = true; break;
            default: throw new Error(`unknown fs op ${String(m.op)}`);
          }
          worker.post({ type: "fsResult", id, ok: true, value });
        } catch (e) {
          worker.post({ type: "fsResult", id, ok: false, error: (e as Error).message });
        }
      }
    });
    worker.post({ type: "run", code, input, network: !!opts.network, maxLogChars: opts.maxLogChars });
  });
}

/** The `run_js` tool. */
export function sandboxTool(ws: Workspace | null, opts: SandboxOptions = {}): Tool {
  return defineTool<{ code: string; input?: unknown; timeout_ms?: number }>({
    name: "run_js",
    description:
      "Run JavaScript in a sandbox (no DOM, no network) and get back what it returns plus its console output. Use it for arithmetic, dates, parsing, data transformation, and to run a skill's scripts instead of working them out by hand. The code is the body of an async function: use `return` for the result (JSON), `console.log` for notes. Available: `input` (the input argument), and `fs` for the workspace — `await fs.read(path)` → text, `await fs.write(path, text)`, `await fs.list(folder)` → [{path, size}], `await fs.exists(path)`.",
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
      const r = await runInSandbox(ws, code, input, { ...opts, timeoutMs: timeout_ms ?? opts.timeoutMs, signal: ctx.signal });
      const parts: string[] = [];
      if (r.logs) parts.push(`console:\n${r.logs}`);
      if (r.ok) parts.push(r.result === undefined ? "Returned: undefined" : `Returned: ${r.result}`);
      else parts.push(`Error: ${r.error}`);
      parts.push(`(${r.durationMs} ms)`);
      return { content: parts.join("\n\n"), details: r };
    },
  });
}
