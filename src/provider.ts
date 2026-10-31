// Where the agent's model calls go: a ModelProvider. One method is
// required — a streamed Chat Completions call; the rest are optional. Two
// come with the package: runappsProvider (the RunApps SDK client) and
// openAIProvider (any OpenAI-compatible endpoint, plain fetch). A host can
// write its own: its server, another SDK, a local model.

import type { ChatCompletion, ChatCompletionChunk, ChatCompletionParams } from "./llm.js";

/** A model in the provider's catalogue (all but `id` optional). */
export interface ModelInfo {
  id: string;
  /** The provider's default (used when the agent names no model). */
  is_default?: boolean;
  /** "text" for chat models; others are left out of the model picker. */
  capability?: string;
  /** Context window in tokens. */
  max_input_tokens?: number;
  /** Most tokens one reply may have. */
  max_tokens?: number;
  /** Request options the model takes; `inputs.reasoning_effort.enum` lists its thinking levels. */
  options?: { inputs?: Record<string, { enum?: unknown[]; default?: unknown }> };
}

export interface ModelProvider {
  /**
   * One streamed chat completion: OpenAI's `chat.completion.chunk`s —
   * `delta.content`, `delta.reasoning_content` (or `reasoning`),
   * `delta.tool_calls` by `index`, `finish_reason`, `usage`. Stop when
   * `signal` aborts. Throw a `ProviderError` with the HTTP status for
   * failures, so 408/429/5xx are retried (and `retryAfter` honoured).
   */
  stream(params: ChatCompletionParams, init?: { signal?: AbortSignal }): AsyncIterable<ChatCompletionChunk>;
  /** One whole completion (compaction summaries). Without it, `stream` is collected. */
  complete?(params: ChatCompletionParams, init?: { signal?: AbortSignal }): Promise<ChatCompletion>;
  /** The catalogue: context windows, output limits, the default model, thinking levels. Without it, safe defaults. */
  models?(opts?: { capability?: string }): Promise<ModelInfo[]>;
  /**
   * A file from the provider's own storage, for `files:<path>` skills
   * sources; `etag` is the one read last time — answer null when unchanged.
   */
  readFile?(path: string, opts?: { etag?: string }): Promise<{ bytes: Uint8Array; etag?: string } | null>;
  /** Names the app's local storage (IndexedDB) when the host gives no `project`. */
  name?: string;
}

/** A failed model call. `status` is the HTTP status (0: no answer at all). */
export class ProviderError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Seconds to wait before trying again, when the server said. */
  readonly retryAfter?: number;
  constructor(status: number, message: string, opts: { code?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = opts.code;
    this.retryAfter = opts.retryAfter;
  }
  /** The RunApps SDK's name for `status`. */
  get statusCode(): number { return this.status; }
}

/** The status of any provider's error: ProviderError, the RunApps SDK's APIError, or anything with a `status`. */
export function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : undefined;
  return s;
}

/** The parts of the RunApps SDK client a provider needs. */
export interface RunAppsClientLike {
  chat: {
    stream(params: ChatCompletionParams, init?: { signal?: AbortSignal }): AsyncIterable<ChatCompletionChunk>;
    create(params: ChatCompletionParams, init?: { signal?: AbortSignal }): Promise<ChatCompletion>;
  };
  models?: { list(opts?: { capability?: string }): Promise<unknown[]> };
  files?: { stat(path: string): Promise<{ etag?: string }>; get(path: string): Promise<Blob> };
  projectName?: string;
}

/** The RunApps SDK client as a provider: the gateway's models and catalogue, the user's RunApps storage for `files:` skills. */
export function runappsProvider(client: RunAppsClientLike): ModelProvider {
  const files = client.files;
  return {
    name: client.projectName,
    stream: (p, init) => client.chat.stream(p, init),
    complete: (p, init) => client.chat.create(p, init),
    models: client.models ? async (o) => (await client.models!.list(o)) as ModelInfo[] : undefined,
    readFile: files
      ? async (path, o) => {
          const st = await files.stat(path);
          if (o?.etag && st.etag && o.etag === st.etag) return null;
          return { bytes: new Uint8Array(await (await files.get(path)).arrayBuffer()), etag: st.etag };
        }
      : undefined,
  };
}

/** A provider, or a RunApps SDK client made into one. */
export function toProvider(p: ModelProvider | RunAppsClientLike): ModelProvider {
  if (typeof (p as ModelProvider).stream === "function") return p as ModelProvider;
  if (typeof (p as RunAppsClientLike).chat?.stream === "function") return runappsProvider(p as RunAppsClientLike);
  throw new Error("runapps agent: pass a ModelProvider (with stream()) or a RunApps client");
}

export interface OpenAIProviderOptions {
  /** The API root, e.g. `https://api.openai.com/v1` or your own proxy (`/api/llm`). */
  baseURL: string;
  /** Sent as `Authorization: Bearer …` (leave it out when your proxy adds it). */
  apiKey?: string;
  /** More request headers (an `Authorization` here replaces the apiKey's). */
  headers?: Record<string, string>;
  /** The catalogue: a fixed list, `"fetch"` for `GET /models` (ids, and limits where the endpoint lists them), or nothing. */
  models?: ModelInfo[] | "fetch";
  /** Asks for `usage` in the last streamed chunk (`stream_options.include_usage`, default true). */
  streamUsage?: boolean;
  fetch?: typeof fetch;
  name?: string;
}

/** Any OpenAI-compatible Chat Completions endpoint, with plain fetch and SSE. */
export function openAIProvider(o: OpenAIProviderOptions): ModelProvider {
  const base = o.baseURL.replace(/\/+$/, "");
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
    ...(o.headers ?? {}),
  });
  const post = async (body: unknown, signal?: AbortSignal): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ProviderError(0, `network error: ${(err as Error).message}`);
    }
    if (!res.ok) throw await errorOf(res);
    return res;
  };
  return {
    name: o.name,
    async *stream(p, init) {
      const body = { ...p, stream: true, ...(o.streamUsage === false ? {} : { stream_options: { include_usage: true } }) };
      const res = await post(body, init?.signal);
      if (!res.body) throw new ProviderError(0, "the response has no body to stream");
      for await (const data of sseData(res.body, init?.signal)) {
        if (data === "[DONE]") return;
        let chunk: ChatCompletionChunk & { error?: { message?: string; code?: string } };
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) throw new ProviderError(500, chunk.error.message ?? "stream error", { code: chunk.error.code });
        yield chunk;
      }
    },
    async complete(p, init) {
      const res = await post({ ...p, stream: false }, init?.signal);
      return (await res.json()) as ChatCompletion;
    },
    models: o.models === undefined ? undefined : async () => {
      if (Array.isArray(o.models)) return o.models;
      const res = await doFetch(`${base}/models`, { headers: headers() });
      if (!res.ok) throw await errorOf(res);
      // OpenAI lists ids only; a gateway that says more (limits, capability, default) is taken at its word.
      const j = (await res.json()) as { data?: Array<ModelInfo & Record<string, unknown>> };
      return (j.data ?? []).map(({ id, is_default, capability, max_input_tokens, max_tokens, options }) => ({ id, is_default, capability: capability ?? "text", max_input_tokens, max_tokens, options }));
    },
  };
}

async function errorOf(res: Response): Promise<ProviderError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: { message?: string; code?: string; type?: string } | string; message?: string };
    if (typeof j.error === "string") message = j.error;
    else if (j.error?.message) { message = j.error.message; code = j.error.code ?? j.error.type; }
    else if (j.message) message = j.message;
  } catch { /* not JSON */ }
  const ra = Number(res.headers.get("Retry-After"));
  return new ProviderError(res.status, message, { code, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined });
}

/** The `data:` payloads of a server-sent event stream. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r?\n\r?\n/)) >= 0) {
        const event = buf.slice(0, nl);
        buf = buf.slice(nl).replace(/^\r?\n\r?\n/, "");
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (data) yield data;
      }
    }
    const rest = buf.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (rest) yield rest;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  signal?.throwIfAborted();
}
