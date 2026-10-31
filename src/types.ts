// Shared types of the agent harness: tools, events, the UI and file
// interfaces an app implements, and the options of `Agent`.
//
// The harness runs the model ↔ tool loop (`agent.ts`) over the chat
// endpoint; everything an app owns — its dialogs, its document as
// files, its skills zip, its tools — comes in through these interfaces.

import type { ChatMessage, ContentPart, PromptInput } from "@runappsai/sdk";
import type { Usage } from "@runappsai/sdk";
import type { Agent } from "./agent.js";
import type { CompactionSettings, CutPlan } from "./compaction.js";
import type { Workspace } from "./workspace.js";

/** A JSON Schema object (draft 7 / 2020-12 subset — see json-schema.ts). */
export type JSONSchema = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/** What a tool's `execute` receives besides its arguments. */
export interface ToolContext {
  /** Aborted when the user stops the run; long tools should honour it. */
  signal: AbortSignal;
  /** The agent's dialogs (confirm / select / input / notify). */
  ui: AgentUI;
  /** The agent's workspace, when it has one. */
  workspace: Workspace | null;
  agent: Agent;
  /** The model's id for this call (`tool_call_id`). */
  callId: string;
  /** Report progress; the app sees it as a `tool_update` event. */
  update(content: string): void;
}

/**
 * What `execute` may return. A string goes to the model as is; content
 * parts let a tool answer with an image; any other value is serialised as
 * JSON. `{ content, details }` keeps `details` for the app (events) and
 * sends only `content` to the model.
 */
export type ToolResultValue =
  | string
  | ContentPart[]
  | { content: string | ContentPart[]; details?: unknown }
  | number
  | boolean
  | object
  | null
  | undefined
  | void;

export interface ToolDefinition<A = Record<string, unknown>> {
  /** `^[A-Za-z0-9_-]{1,64}$`, what the model calls. */
  name: string;
  /** What it does and when to use it — the model reads this. */
  description: string;
  /** JSON Schema of the arguments object. Default: no arguments. */
  parameters?: JSONSchema;
  /**
   * Extra guidance placed in the system prompt (one or more sentences
   * that name the tool), for rules too long for `description`.
   */
  guidelines?: string | string[];
  /**
   * Asked before running under permissions `"ask"`: return the question
   * to put to the user (a short sentence naming what will happen), or
   * `false` to run without asking this time. Without `confirm`, a tool
   * asks when it is `destructive`.
   */
  confirm?: (args: A) => string | false | Promise<string | false>;
  /** Changes or removes something the user may not want gone. */
  destructive?: boolean;
  /** Longest result sent to the model, in characters (default 32 000). */
  maxResultChars?: number;
  execute(args: A, ctx: ToolContext): Promise<ToolResultValue> | ToolResultValue;
}

/** A tool as the agent holds it (`defineTool` normalises a definition). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<A = any> extends ToolDefinition<A> {
  parameters: JSONSchema;
}

export type ToolStatus = "ok" | "error" | "declined" | "blocked" | "skipped";

/* ------------------------------------------------------------------ */
/* UI an app provides                                                  */
/* ------------------------------------------------------------------ */

export interface SelectOption {
  value: string;
  label?: string;
  description?: string;
}

/**
 * The dialogs the harness and its built-in tools use. `domUI()` is the
 * default (plain `<dialog>`s); an app with its own design passes an
 * object implementing this interface.
 */
export interface AgentUI {
  /** Yes/no question; resolves false when dismissed. */
  confirm(
    title: string,
    message?: string,
    opts?: { ok?: string; cancel?: string; danger?: boolean },
  ): Promise<boolean>;
  /**
   * Pick one (or several with `multi`) of `options`; `allowOther` adds a
   * free-text choice. Resolves the chosen values, or null when dismissed.
   */
  select(
    title: string,
    options: SelectOption[],
    opts?: { message?: string; multi?: boolean; allowOther?: boolean },
  ): Promise<string[] | null>;
  /** Free text; null when dismissed. */
  input(
    title: string,
    opts?: { message?: string; placeholder?: string; multiline?: boolean; initial?: string },
  ): Promise<string | null>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/* ------------------------------------------------------------------ */
/* Files an app exposes                                                */
/* ------------------------------------------------------------------ */

export interface FileStat {
  /** Absolute POSIX path inside the workspace. */
  path: string;
  size: number;
  contentType?: string;
  /** Milliseconds since the epoch, when known. */
  mtime?: number;
}

/**
 * A file tree an app mounts into the agent's workspace (its document as
 * files, a cloud folder, …). Paths given to it are relative to the mount
 * point, absolute POSIX style (`/notes/today.md`). Read-only mounts leave
 * `write`/`delete` out.
 */
export interface AgentFS {
  /** Every file under `prefix` (recursive). */
  list(prefix: string): Promise<FileStat[]>;
  /** Text as a string, anything else as bytes; throws when missing. */
  read(path: string): Promise<string | Uint8Array>;
  write?(path: string, content: string | Uint8Array, contentType?: string): Promise<void>;
  delete?(path: string): Promise<void>;
  stat?(path: string): Promise<FileStat | null>;
  /** Shown to the model in the workspace description. */
  description?: string;
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

/** A skill folder found in the workspace (`<skillsDir>/<name>/SKILL.md`, default `/.agent/skills`). */
export interface Skill {
  name: string;
  description: string;
  /** Path of SKILL.md in the workspace. */
  path: string;
  /** The skill's folder. */
  dir: string;
  /** Only loaded when the app or user asks for it, never picked by the model. */
  disableModelInvocation?: boolean;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type RunEndReason = "done" | "aborted" | "max_turns" | "error";

export interface AgentUsage {
  /** Sum of every model call's `total_cost` (the gateway's figure, before platform markup and creator fee). */
  total_cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Model calls made (turns), including retries that returned usage. */
  calls: number;
}

export interface RunResult {
  runId: string;
  reason: RunEndReason;
  error?: Error;
  /** The last assistant text of the run. */
  text: string;
  usage: AgentUsage;
}

export interface AgentEventMap {
  run_start: { runId: string; message: ChatMessage };
  turn_start: { runId: string; turn: number };
  /** Streamed assistant text: the new piece and the text so far. */
  text_delta: { runId: string; delta: string; text: string };
  reasoning_delta: { runId: string; delta: string; text: string };
  /** A model call is retried after it had already streamed text: discard what was shown. */
  message_reset: { runId: string; reason: string };
  message_end: { runId: string; message: ChatMessage; truncated: boolean };
  tool_start: { runId: string; id: string; name: string; args: unknown };
  tool_update: { runId: string; id: string; name: string; content: string };
  tool_end: {
    runId: string;
    id: string;
    name: string;
    status: ToolStatus;
    /** What the model was told. */
    result: string;
    details?: unknown;
    durationMs: number;
  };
  turn_end: { runId: string; turn: number; usage?: Usage };
  /** The transcript was shortened: by a model-written summary (`summary: true`) or by eliding/dropping. */
  compaction: { runId?: string; summary: boolean; tokensBefore: number; tokensAfter: number; droppedTurns: number; elidedResults: number };
  /** The session was written to the workspace. */
  session_saved: { id: string };
  /** `rewind(index)` dropped the messages from `index` on. */
  rewind: { index: number };
  queued: { kind: "steer" | "followUp"; message: ChatMessage };
  run_end: RunResult;
}

export type AgentEventName = keyof AgentEventMap;

/* ------------------------------------------------------------------ */
/* Options and session                                                 */
/* ------------------------------------------------------------------ */

export type Permissions =
  | "ask"
  | "auto"
  | ((call: { name: string; args: unknown; tool: Tool }) => boolean | Promise<boolean>);

export interface ToolCallHookEvent {
  id: string;
  name: string;
  args: unknown;
  tool: Tool;
}

export interface SessionData {
  v: 1 | 2;
  /** The agent's id (v2). */
  id?: string;
  /** The workspace (directory) id it was saved from; set by the store. */
  space?: string;
  /** The first user message, shortened (v2). */
  title?: string;
  model?: string;
  messages: ChatMessage[];
  usage: AgentUsage;
  droppedTurns: number;
  createdAt?: number;
  savedAt: number;
}

/** What a workspace lists for each saved session. */
export interface SessionSummary {
  id: string;
  /** The workspace (directory) id the session was saved from. */
  workspace?: string;
  title: string;
  model?: string;
  messages: number;
  createdAt: number;
  savedAt: number;
}

export interface AgentOptions {
  /** Model name from the catalogue; the platform default when omitted. */
  model?: string;
  /** The app's own system instructions (a function is re-read every turn). */
  instructions?: string | (() => string);
  /** A short name for the app, used in the system prompt. */
  appName?: string;
  /** Private prompt reference(s), forwarded on every request. */
  prompt?: PromptInput;
  tools?: Tool[];
  /** Adds the file tools and the skills list; `client.workspace()` makes one. */
  workspace?: Workspace | null;
  /**
   * Which of the workspace's file tools to offer (default all:
   * list_files, read_file, write_file, edit_file, delete_file,
   * search_files). `["read_file", "list_files"]` gives a read-only agent.
   */
  fileTools?: boolean | string[];
  /** Dialogs; `domUI()` when omitted. */
  ui?: AgentUI;
  /**
   * `"ask"` (default): destructive tools and tools with `confirm` ask the
   * user first. `"auto"`: never ask. A function decides per call.
   */
  permissions?: Permissions;
  /** Model calls per run (default 20). */
  maxTurns?: number;
  /** `max_tokens` of each model call (default 8192). */
  maxTokens?: number;
  /** Context budget in tokens; `"auto"` (default) reads the catalogue. */
  maxInputTokens?: number | "auto";
  /** Run a turn's tool calls at once instead of one after another. */
  parallelTools?: boolean;
  /** Keep this many recent turns intact when the context is trimmed (default 4). */
  keepTurns?: number;
  temperature?: number;
  top_p?: number;
  /** Any other chat parameter, sent as is (`reasoning_effort`, …). */
  extra?: Record<string, unknown>;
  /** Continue a saved session. */
  restore?: SessionData;
  /** Runs before every tool call; return `{ block: true }` to refuse it. */
  onToolCall?: (
    ev: ToolCallHookEvent,
  ) => void | { block: boolean; reason?: string } | Promise<void | { block: boolean; reason?: string }>;
  /** Offer the gateway's server tools when the agent has no tools of its own. */
  serverTools?: Array<"web_search" | "web_fetch" | "twitter_search">;
  /**
   * The `run_js` sandbox tool (default on): the model computes and runs
   * scripts in a Worker with no DOM and no network. `false` removes it;
   * an object configures it (timeout, network).
   */
  sandbox?: boolean | { timeoutMs?: number; network?: boolean };
  /** The `ask_user` tool (default on). */
  askUser?: boolean;
  /**
   * Session id (default: a random id). With a workspace, an agent whose
   * id has a saved session continues it, and every turn is saved under
   * it (`persist: false` turns that off).
   */
  id?: string;
  /** Save the session in the workspace after every turn (default true when there is a workspace). */
  persist?: boolean;
  /**
   * When the transcript nears the model's window, older turns are
   * summarised by the model (pi-style checkpoint) and replaced by the
   * summary; the newest turns stay verbatim. `false` falls back to
   * eliding old tool results and dropping old turns; an object tunes
   * the thresholds; a function writes the summary itself.
   */
  compaction?: false | Partial<CompactionSettings> | ((plan: CutPlan, agent: Agent) => Promise<string>);
}
