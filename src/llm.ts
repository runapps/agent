// The model API the agent speaks: OpenAI's Chat Completions, as types of
// its own, so the package depends on no SDK. The RunApps SDK's types are
// the same shape (its client works as a provider unchanged), and so are
// those of any OpenAI-compatible endpoint.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  /** A thinking model's reasoning (DeepSeek's field; sent back on tool-calling turns). */
  reasoning_content?: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } };

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export interface ChatToolCall {
  index?: number;
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** One request. Fields a provider does not know it may drop. */
export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_tokens?: number;
  stream?: boolean;
  reasoning_effort?: string;
  [extra: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** What the call cost in USD, when the provider says (RunApps does). */
  total_cost?: number;
}

/** A streamed piece of a reply (`chat.completion.chunk`). */
export interface ChatCompletionChunk {
  choices: Array<{
    index?: number;
    delta?: { role?: string; content?: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string; reasoning?: string };
    finish_reason?: string | null;
  }>;
  usage?: Usage | null;
}

/** A whole reply (`chat.completion`). */
export interface ChatCompletion {
  choices: Array<{
    index?: number;
    message: { role: string; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string; reasoning?: string };
    finish_reason: string;
  }>;
  usage?: Usage | null;
}

export type Unsubscribe = () => void;
