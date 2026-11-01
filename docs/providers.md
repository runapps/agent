# Providers

The agent never talks to a model API directly. It calls a **`ModelProvider`**: an object with one required method that streams a Chat Completions call. Two providers come with the package, and you can write your own in a few lines.

```js
createAgent(provider, options)
renderChat(element, { provider, ... })
openWorkspace(provider, options)     // the provider is only needed for `files:` skill sources and the storage name
```

## `openAIProvider` — any OpenAI-compatible API

```js
import { openAIProvider } from "@runappsai/agent";

const provider = openAIProvider({
  baseURL: "https://api.openai.com/v1",   // the API root; /chat/completions is appended
  apiKey: "sk-…",                         // sent as Authorization: Bearer …
  models: "fetch",                        // optional: read GET /models for the model list
});
```

It uses plain `fetch` and parses the server-sent event stream itself, so it works in browsers, Node 18+, Deno and workers.

| Option | |
|---|---|
| `baseURL` | API root, e.g. `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (Ollama), or a path on your own server (`/api/llm`). |
| `apiKey` | Optional. Leave it out when your proxy adds the key. |
| `headers` | More request headers. An `Authorization` here replaces the one from `apiKey`. |
| `models` | The catalogue: an array of `ModelInfo`, `"fetch"` for `GET /models` (ids, plus limits and capability where the endpoint lists them), or nothing. |
| `streamUsage` | Ask for `usage` in the last chunk (`stream_options.include_usage`). Default `true`; set `false` for servers that reject the field. |
| `fetch` | A `fetch` of your own (tests, a proxy-aware one). |
| `name` | Names the app's IndexedDB storage when `openWorkspace` gets no `project`. |

### Don't put API keys in a page

Anyone can read a key shipped to the browser. Put the key on your server and let the page call a small proxy that forwards to the provider:

```js
// Browser
const provider = openAIProvider({ baseURL: "/api/llm", models: [
  { id: "gpt-4.1", is_default: true, max_input_tokens: 1_000_000, max_tokens: 32_768 },
  { id: "gpt-4.1-mini", max_input_tokens: 1_000_000, max_tokens: 32_768 },
] });
```

```js
// Server (Express): forward the request body and stream the answer back.
app.post("/api/llm/chat/completions", async (req, res) => {
  if (!req.user) return res.status(401).end();               // your own auth
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(req.body),
  });
  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("Content-Type") ?? "application/json");
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
});
```

### Telling the agent about models

With `models`, the agent knows each model's context window (`max_input_tokens`) and longest reply (`max_tokens`): it sizes replies to the model's maximum, compacts the conversation before the window is full, and the chat's settings menu offers the list. Without it, the agent assumes a 128 000-token window and 8 192-token replies.

A model may also carry its `price`: `{ input, output }` per million tokens, `per_call` for a fixed amount added to each call, and `currency` (an ISO code, default `"USD"`). The chat shows it in the settings and in `/context`, and shows spending in that currency — so a provider's `usage.total_cost` must be in it too.

```js
const models = [
  {
    id: "deepseek-reasoner",
    is_default: true,                    // used when the agent names no model
    capability: "text",                  // "text" and "vision" models are offered in the chat's picker
    max_input_tokens: 128_000,
    max_tokens: 64_000,
    input_modalities: ["text"],          // what it takes: add "image" (or "video", "audio") for a model that sees them
    options: { inputs: { reasoning_effort: { enum: ["low", "medium", "high"], default: "medium" } } },
  },
];
```

`options.inputs.reasoning_effort` lists the thinking levels a model takes; the chat's settings menu offers them and sends the choice as `reasoning_effort`.

`input_modalities` says what a model takes besides text (RunApps' `/v1/models` lists it for every model; a `vision` capability also counts as pictures). `modelAccepts(model, "image")` reads it: `true`, `false`, or `undefined` when the catalogue does not say. See [Pictures and models that see them](agent.md#pictures-and-models-that-see-them).

## `runappsProvider` — RunApps

With the [RunApps SDK](https://github.com/runapps/sdk-js), users sign in with RunApps and pay for their own usage; the model catalogue (with limits and thinking levels), cost per call and `files:` storage come from the platform.

```html
<script src="https://www.runapps.ai/sdk/latest.js"></script>
<script>
  const client = new RunApps({ project: "my-app" });       // your app's slug
  const provider = RunAppsAgent.runappsProvider(client);
</script>
```

Passing the client itself works everywhere a provider is expected — `createAgent(client)`, `renderChat(el, { client })`, `openWorkspace(client, …)` — it is wrapped for you. The client's project also names the app's IndexedDB storage.

## Writing your own

A provider is any object with a `stream` method. This one wraps a server endpoint that answers with OpenAI chunks, one JSON object per line:

```js
import { ProviderError } from "@runappsai/agent";

const provider = {
  name: "my-app",
  async *stream(params, { signal } = {}) {
    const res = await fetch("/api/chat", { method: "POST", body: JSON.stringify(params), signal });
    if (!res.ok) throw new ProviderError(res.status, await res.text(), { retryAfter: Number(res.headers.get("Retry-After")) || undefined });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
  },
  async models() {
    return [{ id: "my-model", is_default: true, max_input_tokens: 200_000, max_tokens: 16_000 }];
  },
};
```

If your endpoint speaks server-sent events, `sseData(response.body, signal)` (exported) yields each event's `data:` payload.

### The interface

```ts
interface ModelProvider {
  /** Required: one streamed chat completion. */
  stream(params: ChatCompletionParams, init?: { signal?: AbortSignal }): AsyncIterable<ChatCompletionChunk>;
  /** A whole completion (used to write compaction summaries). Without it, stream() is collected. */
  complete?(params: ChatCompletionParams, init?: { signal?: AbortSignal }): Promise<ChatCompletion>;
  /** The model catalogue. Without it: 128k window, 8k replies, no model list in the settings. */
  models?(opts?: { capability?: string }): Promise<ModelInfo[]>;
  /** A file from your storage, for `files:<path>` skill sources; answer null when `etag` still matches. */
  readFile?(path: string, opts?: { etag?: string }): Promise<{ bytes: Uint8Array; etag?: string } | null>;
  /** Names the app's IndexedDB storage when openWorkspace gets no `project`. */
  name?: string;
}
```

**What `stream` receives** — an OpenAI Chat Completions request:

- `model` — absent when the agent names no model (your provider picks its default).
- `messages` — `system`, `user` (text, or content parts with `image_url` pictures), `assistant` (with `tool_calls`, and `reasoning_content` for thinking models on tool-calling turns), `tool` (results).
- `tools` — function definitions with JSON Schema parameters.
- `max_tokens`, sometimes `reasoning_effort`, `temperature`, `top_p`, and whatever the app put in `extra`.

**What it yields** — OpenAI `chat.completion.chunk` objects:

- `choices[0].delta.content` — text.
- `choices[0].delta.reasoning_content` (or `reasoning`) — the model's thinking, shown folded.
- `choices[0].delta.tool_calls` — tool call fragments, joined by `index` (`id` and `function.name` in the first fragment, `function.arguments` spread over several).
- `choices[0].finish_reason` — `"stop"`, `"tool_calls"`, `"length"`. A stream that ends without one is treated as cut off, and its tool calls are not run.
- `usage` — `prompt_tokens`, `completion_tokens`, and `total_cost` in USD if you know it (`agent.usage` adds them up).

### Errors and retries

Throw a `ProviderError(status, message, { code, retryAfter })` — or any error with a numeric `status` or `statusCode` — when a call fails:

| Status | What the agent does |
|---|---|
| `408`, `429`, `5xx`, `0` (no answer, network) | Tries again with backoff — three attempts in all — waiting `retryAfter` seconds when given. Text already shown is discarded first (`message_reset` event). |
| anything else | Ends the run with `reason: "error"`; the chat shows the message with a Retry button. |

Errors without a status are retried only when they look like network failures.
