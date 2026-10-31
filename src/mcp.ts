// MCP tools: connect to a Model Context Protocol server over Streamable
// HTTP and hand its tools to an agent. Plain fetch, no SDK: initialize,
// tools/list (paginated), tools/call, the session id header, answers that
// come as JSON or as an event stream, progress notifications, cancellation
// on abort, and DELETE to end the session.

import type { ContentPart } from "./llm.js";
import { sseData } from "./provider.js";
import { defineTool } from "./tool.js";
import type { JSONSchema, Tool } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface MCPOptions {
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** More request headers. */
  headers?: Record<string, string>;
  /**
   * Prefix of the tool names the model sees (`<prefix>__<tool>`). Default:
   * the server's name. Names are cut to the 64 characters a tool name may have.
   */
  prefix?: string;
  /**
   * When the user is asked before a call (under permissions "ask"):
   * `"always"` (the default), `"unless-read-only"` (tools the server marks
   * `readOnlyHint` run without asking) or `"never"`.
   */
  confirm?: "always" | "unless-read-only" | "never";
  /** Pass pictures a tool returns on to the model (default false: they are named, not sent). */
  images?: boolean;
  /** Longest a request may take, in ms (default 60 000). */
  timeoutMs?: number;
  /** Most tools taken from the server (default 64). */
  maxTools?: number;
  /** Longest tool result sent to the model, in characters (default 32 000). */
  maxResultChars?: number;
  /** Your own fetch (a proxy, tests). */
  fetch?: typeof fetch;
  /** The client name the server is told (default "runapps-agent"). */
  clientName?: string;
  signal?: AbortSignal;
}

/** One tool as the server described it. */
export interface MCPToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JSONSchema;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface MCPConnection {
  /** The server's tools, ready for `createAgent({ tools })`. */
  readonly tools: Tool[];
  /** What the server said about each tool. */
  readonly serverTools: readonly MCPToolInfo[];
  /** The server's name and version, as it gave them. */
  readonly server: { name: string; version?: string; title?: string };
  /** Instructions the server gave for using it, if any (worth adding to the agent's instructions). */
  readonly instructions?: string;
  /** Read the tool list again (after the server says it changed). */
  refresh(signal?: AbortSignal): Promise<Tool[]>;
  /** Ends the session on the server; the tools stop working. */
  close(): Promise<void>;
}

interface RPCMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** An MCP server's error, or a failed request to it. Never carries the token or the response's headers. */
export class MCPError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number) {
    super(message);
    this.name = "MCPError";
  }
}

/**
 * Connects to an MCP server (Streamable HTTP) and returns its tools.
 *
 * ```js
 * const github = await connectMCP("https://mcp.example.com/mcp", { token });
 * const agent = createAgent(provider, { tools: github.tools });
 * // later
 * await github.close();
 * ```
 */
export async function connectMCP(url: string | URL, opts: MCPOptions = {}): Promise<MCPConnection> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new MCPError("An MCP endpoint is an http(s) URL.");
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let session: string | undefined;
  let protocol: string | undefined;
  let nextId = 1;
  let closed = false;

  const headers = (json: boolean): Record<string, string> => ({
    ...(opts.headers ?? {}),
    ...(json ? { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...(session ? { "Mcp-Session-Id": session } : {}),
    ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
  });

  const post = (body: RPCMessage, signal: AbortSignal) => doFetch(endpoint, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
    signal,
    redirect: "error",
    credentials: "omit",
  });

  /** Answers a request the server makes of us: ping, everything else "not supported". */
  const answerServer = (m: RPCMessage) => {
    const reply: RPCMessage = m.method === "ping"
      ? { jsonrpc: "2.0", id: m.id, result: {} }
      : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} is not supported by this client` } };
    void post(reply, AbortSignal.timeout(timeoutMs)).then((r) => r.body?.cancel()).catch(() => undefined);
  };

  /** One request: its result, reading through notifications (progress) and server requests on the way. */
  const request = async (method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal, onProgress?: (text: string) => void, retried = false): Promise<Record<string, unknown>> => {
    if (closed) throw new MCPError("The MCP connection is closed.");
    const id = nextId++;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = anySignal([timeout, ...(signal ? [signal] : []), ...(opts.signal ? [opts.signal] : [])]);
    const body: RPCMessage = { jsonrpc: "2.0", id, method, ...(params ? { params: onProgress ? { ...params, _meta: { progressToken: id } } : params } : {}) };
    const cancel = () => {
      // Tell the server to stop (a request already running may still have its effect).
      if (method !== "initialize") void post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The user stopped it." } }, AbortSignal.timeout(5000)).then((r) => r.body?.cancel()).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      let res: Response;
      try {
        res = await post(body, combined);
      } catch (err) {
        signal?.throwIfAborted();
        if (timeout.aborted) throw new MCPError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s.`);
        throw new MCPError(`Could not reach the MCP server (${(err as Error).message}). Check the address, its CORS settings and your network.`);
      }
      if (res.status === 404 && session && !retried && method !== "initialize") {
        // The server forgot the session: start a new one and ask again.
        await res.body?.cancel();
        session = undefined;
        await initialize(signal);
        return request(method, params, signal, onProgress, true);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new MCPError(`The MCP server answered ${method} with HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the token)" : ""}.`, res.status);
      }
      const sid = res.headers.get("mcp-session-id");
      if (sid) session = sid;
      const handle = (m: RPCMessage): Record<string, unknown> | undefined => {
        if (m.id === id && (m.result || m.error)) {
          if (m.error) throw new MCPError(`${method}: ${m.error.message}`, undefined, m.error.code);
          return m.result ?? {};
        }
        if (m.method && m.id !== undefined) answerServer(m);
        else if (m.method === "notifications/progress" && m.params?.progressToken === id && onProgress) {
          const p = m.params as { progress?: number; total?: number; message?: string };
          onProgress(p.message ?? (p.total ? `${p.progress ?? 0} / ${p.total}` : String(p.progress ?? "")));
        }
        return undefined;
      };
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && res.body) {
        for await (const data of sseData(res.body, combined)) {
          let m: RPCMessage | RPCMessage[];
          try { m = JSON.parse(data); } catch { continue; }
          for (const one of Array.isArray(m) ? m : [m]) {
            const result = handle(one);
            if (result) { void res.body.cancel().catch(() => undefined); return result; }
          }
        }
        signal?.throwIfAborted();
        if (timeout.aborted) throw new MCPError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s.`);
        throw new MCPError(`The MCP server ended the stream without answering ${method}.`);
      }
      let parsed: RPCMessage | RPCMessage[];
      try { parsed = await res.json(); } catch { throw new MCPError(`The MCP server's answer to ${method} is not JSON.`); }
      for (const one of Array.isArray(parsed) ? parsed : [parsed]) {
        const result = handle(one);
        if (result) return result;
      }
      throw new MCPError(`The MCP server did not answer ${method}.`);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };

  const notify = async (method: string) => {
    const res = await post({ jsonrpc: "2.0", method }, anySignal([AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])]));
    await res.body?.cancel();
  };

  let serverInfo: MCPConnection["server"] = { name: "mcp" };
  let instructions: string | undefined;
  const initialize = async (signal?: AbortSignal) => {
    protocol = undefined;
    const result = await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: opts.clientName ?? "runapps-agent", version: "1" },
    }, signal);
    protocol = typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
    const info = result.serverInfo as { name?: string; version?: string; title?: string } | undefined;
    if (info?.name) serverInfo = { name: info.name, version: info.version, title: info.title };
    if (typeof result.instructions === "string") instructions = result.instructions;
    await notify("notifications/initialized");
  };

  await initialize(opts.signal);

  let infos: MCPToolInfo[] = [];
  let tools: Tool[] = [];
  const prefix = clean(opts.prefix ?? serverInfo.name).slice(0, 24) || "mcp";
  const label = serverInfo.title || serverInfo.name;

  const load = async (signal?: AbortSignal): Promise<Tool[]> => {
    const all: MCPToolInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request("tools/list", cursor ? { cursor } : {}, signal);
      if (!Array.isArray(page.tools)) throw new MCPError("The MCP server's tool list is malformed.");
      for (const t of page.tools as MCPToolInfo[]) {
        if (!t || typeof t.name !== "string" || !t.name) throw new MCPError("The MCP server listed a tool without a name.");
        const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" };
        all.push({ ...t, inputSchema: { type: "object", properties: {}, ...schema } });
      }
      if (all.length > (opts.maxTools ?? 64)) throw new MCPError(`The MCP server has more than ${opts.maxTools ?? 64} tools (maxTools).`);
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new MCPError("The MCP server's tool list repeats a page.");
        cursors.add(cursor);
      }
    } while (cursor);
    infos = all;
    const used = new Set<string>();
    tools = all.map((info) => {
      let name = `${prefix}__${clean(info.name)}`.slice(0, 64);
      for (let n = 2; used.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
      used.add(name);
      const readOnly = info.annotations?.readOnlyHint === true;
      const ask = opts.confirm === "never" ? false : opts.confirm === "unless-read-only" ? !readOnly : true;
      const title = info.title ?? info.annotations?.title ?? info.name;
      return defineTool<Record<string, unknown>>({
        name,
        description: `[${label} — MCP server] ${title !== info.name ? `${title}. ` : ""}${info.description ?? ""}`.trim().slice(0, 4000),
        parameters: info.inputSchema,
        readOnly,
        destructive: info.annotations?.destructiveHint === true || (!readOnly && ask),
        maxResultChars: opts.maxResultChars,
        confirm: ask
          ? (args) => ({ title: `Run ${label} / ${info.name}?`, message: JSON.stringify(args, null, 2).slice(0, 4000) })
          : () => false,
        async execute(args, ctx) {
          let result: Record<string, unknown>;
          try {
            result = await request("tools/call", { name: info.name, arguments: args }, ctx.signal, (text) => text && ctx.update(text));
          } catch (err) {
            ctx.signal.throwIfAborted();
            if (err instanceof MCPError && err.code !== undefined) throw err;
            // The call may have reached the server: say so, so the model does not repeat a side effect blindly.
            throw new MCPError(`${(err as Error).message} Whether ${info.name} took effect on the server is unknown; do not repeat it without checking.`);
          }
          const parts = contentOf(result, opts.images === true);
          if (result.isError === true) throw new MCPError(parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim() || `${info.name} reported an error.`);
          return parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts;
        },
      });
    });
    return tools;
  };

  try {
    await load(opts.signal);
  } catch (err) {
    await end();
    throw err;
  }

  async function end(): Promise<void> {
    if (closed) return;
    closed = true;
    if (!session) return;
    try {
      const res = await doFetch(endpoint, { method: "DELETE", headers: headers(false), redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
    } catch { /* the server may not support it, or be gone */ }
  }

  return {
    get tools() { return tools; },
    get serverTools() { return infos; },
    server: serverInfo,
    instructions,
    refresh: load,
    close: end,
  };
}

/** What a tools/call result becomes for the model: text, pictures when allowed, everything else named. */
function contentOf(result: Record<string, unknown>, images: boolean): ContentPart[] {
  const blocks = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  const parts: ContentPart[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
    else if (b.type === "image" && typeof b.data === "string") {
      const mime = typeof b.mimeType === "string" ? b.mimeType : "image/png";
      if (images) parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b.data}` } });
      else parts.push({ type: "text", text: `[A picture (${mime}, ${Math.round((b.data.length * 3) / 4)} bytes) was returned; it is not shown here.]` });
    } else if (b.type === "audio") parts.push({ type: "text", text: `[Audio (${String(b.mimeType ?? "audio")}) was returned; it is not shown here.]` });
    else if (b.type === "resource" && b.resource && typeof b.resource === "object") {
      const r = b.resource as { uri?: string; text?: string; mimeType?: string };
      parts.push({ type: "text", text: typeof r.text === "string" ? `${r.uri ? `${r.uri}:\n` : ""}${r.text}` : `[Resource ${r.uri ?? ""} (${r.mimeType ?? "binary"}); its content is not shown here.]` });
    } else if (b.type === "resource_link") parts.push({ type: "text", text: `[Link: ${String(b.name ?? "")} ${String(b.uri ?? "")}]`.replace(/\s+\]/, "]") });
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  if (!parts.length) parts.push({ type: "text", text: "OK" });
  return parts;
}

function clean(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
