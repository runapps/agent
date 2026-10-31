// collectCompletion: one streamed model call gathered into a whole
// assistant message. Text is handed out as it arrives; tool calls are
// re-assembled by `index` (OpenAI's fragment protocol) and only returned
// once the stream has ended with a `finish_reason`, so a cut stream can
// never run half a tool call.

import type { ChatCompletionParams, ChatCompletionChunk, ChatMessage, ChatToolCall } from "./llm.js";
import type { Usage } from "./llm.js";

export interface CollectedCompletion {
  message: ChatMessage & { role: "assistant"; tool_calls?: ChatToolCall[] };
  finishReason: string;
  usage?: Usage;
  reasoning: string;
}

export interface CollectOptions {
  signal?: AbortSignal;
  onText?: (delta: string, text: string) => void;
  onReasoning?: (delta: string, text: string) => void;
  /** Hard cap on streamed characters (default 800 000). */
  maxChars?: number;
}

export type StreamFn = (
  params: ChatCompletionParams,
  init?: { signal?: AbortSignal },
) => AsyncIterable<ChatCompletionChunk>;

export async function collectCompletion(
  stream: StreamFn,
  params: ChatCompletionParams,
  opts: CollectOptions = {},
): Promise<CollectedCompletion> {
  const maxChars = opts.maxChars ?? 800_000;
  let text = "";
  let reasoning = "";
  let size = 0;
  let finish: string | undefined;
  let usage: Usage | undefined;
  const calls = new Map<number, ChatToolCall>();

  for await (const chunk of stream(params, { signal: opts.signal })) {
    opts.signal?.throwIfAborted();
    if (chunk.usage) usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) continue;
    for (const choice of chunk.choices) {
      if ((choice.index ?? 0) !== 0) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta as (ChatCompletionChunk["choices"][number]["delta"] & Record<string, unknown>) | undefined;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        size += delta.content.length;
        opts.onText?.(delta.content, text);
      }
      const r = (delta.reasoning_content ?? delta.reasoning ?? delta.thinking) as unknown;
      if (typeof r === "string" && r) {
        reasoning += r;
        size += r.length;
        opts.onReasoning?.(r, reasoning);
      }
      if (delta.tool_calls) {
        if (!Array.isArray(delta.tool_calls)) throw new Error("runapps agent: malformed streamed tool_calls");
        for (const part of delta.tool_calls) {
          const index = typeof part.index === "number" ? part.index : calls.size;
          if (!Number.isInteger(index) || index < 0 || index >= 64) {
            throw new Error("runapps agent: malformed streamed tool call index");
          }
          let call = calls.get(index);
          if (!call) {
            call = { index, id: "", type: "function", function: { name: "", arguments: "" } };
            calls.set(index, call);
          }
          if (part.id) call.id = part.id;
          if (part.type) call.type = part.type;
          if (part.function) {
            if (part.function.name) call.function.name += part.function.name;
            if (part.function.arguments) {
              call.function.arguments += part.function.arguments;
              size += part.function.arguments.length;
            }
          }
        }
      }
      if (size > maxChars) throw new Error("runapps agent: the model's reply exceeded the size limit");
    }
  }
  opts.signal?.throwIfAborted();
  if (!finish) throw new Error("runapps agent: the stream ended before the reply was complete");

  const indices = [...calls.keys()].sort((a, b) => a - b);
  if (indices.some((v, i) => v !== i)) throw new Error("runapps agent: streamed tool calls arrived incomplete");
  const toolCalls = indices.map((i) => {
    const c = calls.get(i)!;
    const { index: _drop, ...rest } = c;
    if (!rest.id) rest.id = `call_${Math.random().toString(36).slice(2, 10)}`;
    return rest;
  });

  const message: CollectedCompletion["message"] = { role: "assistant", content: text.length ? text : null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, finishReason: finish, usage, reasoning };
}
