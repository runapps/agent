// Shared types of the agent harness: tools, events, the UI and file
// interfaces an app implements, and the options of `Agent`.
//
// The harness runs the model ↔ tool loop (`agent.ts`) over the chat
// endpoint; everything an app owns — its dialogs, its document as
// files, its skills zip, its tools — comes in through these interfaces.

import type { ChatCompletionParams, ChatMessage, ContentPart } from "./llm.js";
import type { Usage } from "./llm.js";
import type { Agent } from "./agent.js";
import type { CompactionSettings, CutPlan } from "./compaction.js";
import type { Workspace } from "./workspace.js";
import type { TextEdit } from "./edit.js";

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
  /**
   * Say whether this call brought anything new, for the guard against
   * repeated calls (by default a result counts as new unless the run has
   * already had the same one). `read_file` says false for lines already read.
   */
  progress(made: boolean): void;
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
  confirm?: (args: A) => ToolConfirm | Promise<ToolConfirm>;
  /**
   * Checks a call before the user is asked or anything runs (after the
   * arguments matched the schema): return or throw the reason to refuse it,
   * which the model gets as the call's error. Use it for what the schema
   * cannot say (the text to replace is not there, the target changed), so
   * the user is never asked to approve a call that would fail.
   */
  validate?: (args: A) => string | void | Promise<string | void>;
  /** Changes or removes something the user may not want gone. */
  destructive?: boolean;
  /**
   * How the chat UI (`renderChat`) shows a call of this tool; the model
   * never sees it. Every function is the app's own: an exception in one
   * falls back to the default display.
   */
  display?: ToolDisplay<A>;
  /**
   * What the model is told when the run is stopped while this call runs
   * (default: that it was stopped). The call's own work may go on; this is
   * where a tool says how far it got, so a later turn does not redo it.
   */
  whenStopped?: (args: A) => ToolResultValue;
  /**
   * Only looks (reads, lists, searches): running it changes nothing. A
   * successful call of a tool that is not read-only counts as progress for
   * the guard against repeated calls; a read-only one only when its result is new.
   */
  readOnly?: boolean;
  /** Longest result sent to the model, in characters (default 32 000). */
  maxResultChars?: number;
  /**
   * Only useful to a model that sees pictures (a screenshot tool, say): it
   * is offered only while the model in use is known to take images
   * (`agent.accepts("image")`).
   */
  vision?: boolean;
  execute(args: A, ctx: ToolContext): Promise<ToolResultValue> | ToolResultValue;
}

/** A confirmation question: a title, or a title and a message (the details: arguments, what will happen); `false` runs without asking. */
/**
 * What `confirm` asks: the question, or `{ title, message }` with details
 * under it; `always` adds a third answer ("Always allow") that allows this
 * call and runs `onChoose` (where the tool stops asking, e.g. turns on its
 * app's auto-apply setting).
 */
export type ToolConfirm = string | false | { title: string; message?: string; always?: { label: string; onChoose: () => void } };

/** A tool as the agent holds it (`defineTool` normalises a definition). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<A = any> extends ToolDefinition<A> {
  parameters: JSONSchema;
}

export type ToolStatus = "ok" | "error" | "declined" | "blocked" | "skipped";

/** A tool's look in the chat UI (see `ToolDefinition.display`). */
export interface ToolDisplay<A = any> {
  /** The call in words, e.g. "Run 3 nodes": the card's title and the folded line of a reply's calls. Default: the tool's name and its arguments. */
  label?: (args: A) => string;
  /** The card's icon (SVG markup, about 14px). */
  icon?: string;
  /**
   * Content of the app's own on the card, under its title and visible while
   * it is folded (a card's arguments and raw result stay behind it): called
   * when the call starts (`status: "running"`) and again with its result.
   * `details` is what `execute` returned as details (live calls only).
   */
  render?: (call: { args: A; status: ToolStatus | "running"; result?: string; details?: unknown }) => HTMLElement | null | undefined;
  /** A short outcome beside the status mark when the call ends ("$0.12", "3 nodes"). */
  outcome?: (call: { args: A; status: ToolStatus; result: string; details?: unknown }) => string | undefined;
}

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
/** The agent's dialogs. A question given `signal` closes (as if dismissed) when the run is stopped. */
export interface AgentUI {
  /**
   * Yes/no question; resolves false when dismissed. With `always`, a UI may
   * offer a third answer under its label ("Always allow"): it calls
   * `onChoose` and resolves true. A UI that does not just answers yes or no.
   */
  confirm(
    title: string,
    message?: string,
    opts?: { ok?: string; cancel?: string; danger?: boolean; signal?: AbortSignal; always?: { label: string; onChoose: () => void } },
  ): Promise<boolean>;
  /**
   * Pick one (or several with `multi`) of `options`; `allowOther` adds a
   * free-text choice. Resolves the chosen values, or null when dismissed.
   */
  select(
    title: string,
    options: SelectOption[],
    opts?: { message?: string; multi?: boolean; allowOther?: boolean; signal?: AbortSignal },
  ): Promise<string[] | null>;
  /** Free text; null when dismissed. */
  input(
    title: string,
    opts?: { message?: string; placeholder?: string; multiline?: boolean; initial?: string; signal?: AbortSignal },
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
  /**
   * Applies the agent's `edit_file` replacements itself (optional): each
   * `oldText` is to be found once in the file and replaced by its `newText`
   * — all of them against the original, none overlapping. Implement it to
   * change your data in place (one node of a document, a range of a text
   * buffer) instead of receiving the whole file. Throw an Error with a
   * message for the model when an edit does not apply. Without it, the
   * workspace reads the file, applies the edits (`applyEdits`) and writes
   * the whole result back.
   */
  edit?(path: string, edits: TextEdit[]): Promise<void>;
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
  /** It comes with the app (the workspace's `skills` option): the user cannot remove it. */
  builtin?: boolean;
  /** Where the user's skill is kept: its zip (`/skills/pack.zip`) or folder (`/skills/name`) in `userSkillsDir`. */
  from?: string;
  /** Its zip is loaded the first time it is used (a LazySkill of the app's). */
  lazy?: boolean;
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
  /** `message` is null for `continue()`, which adds no user message. */
  run_start: { runId: string; message: ChatMessage | null };
  turn_start: { runId: string; turn: number };
  /** Streamed assistant text: the new piece and the text so far. */
  text_delta: { runId: string; delta: string; text: string };
  reasoning_delta: { runId: string; delta: string; text: string };
  /** A model call is retried after it had already streamed text: discard what was shown. */
  message_reset: { runId: string; reason: string };
  message_end: { runId: string; message: ChatMessage; truncated: boolean };
  /**
   * A tool call's arguments as they stream in, before the call is complete
   * (`arguments` is the raw JSON so far; it may stop anywhere). Nothing runs
   * until the reply has ended; after a `message_reset` the calls start over.
   */
  tool_call_delta: { runId: string; index: number; id: string; name: string; delta: string; arguments: string };
  tool_start: { runId: string; id: string; name: string; args: unknown };
  tool_update: { runId: string; id: string; name: string; content: string };
  tool_end: {
    runId: string;
    id: string;
    name: string;
    status: ToolStatus;
    /** What the model was told (as text: pictures are named). */
    result: string;
    /** The result as the model got it, pictures included (when it had any). */
    content?: string | ContentPart[];
    details?: unknown;
    durationMs: number;
  };
  turn_end: { runId: string; turn: number; usage?: Usage };
  /** The transcript was shortened: by a model-written summary (`summary: true`) or by eliding/dropping. */
  /** A summary of older turns is being written (by the loop, or `compact()`; no runId then). A `compaction` event follows when it replaced them. */
  compaction_start: { runId?: string };
  compaction: { runId?: string; summary: boolean; tokensBefore: number; tokensAfter: number; droppedTurns: number; elidedResults: number };
  /** The session was written to the workspace. */
  session_saved: { id: string };
  /**
   * A model call is about to be made: the request as sent (debugging views,
   * counting calls). `purpose: "compaction"` for a call that writes a
   * summary of older turns (a long history may take several).
   */
  request: { runId: string; turn: number; params: ChatCompletionParams; purpose?: "compaction" };
  /** A model call came back (or failed): timing, finish reason, usage, the assembled message. */
  response: { runId: string; turn: number; durationMs: number; finishReason?: string; usage?: Usage; message?: ChatMessage; error?: string; purpose?: "compaction" };
  /** Queued steering entered the history (at a turn, or before a new prompt): draw these messages now. */
  steered: { runId: string; messages: ChatMessage[] };
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
  /** How the last run ended when it did not finish (stopped, turn limit, error); gone once another run starts. */
  ended?: RunEnd;
}

/** A run that did not finish: why, and when. */
export interface RunEnd { reason: Exclude<RunEndReason, "done">; error?: string; at: number }

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
  /** Private prompt reference(s) (RunApps: `{id, vars}`), forwarded on every request. */
  prompt?: unknown;
  tools?: Tool[];
  /** Adds the file tools and the skills list; `client.workspace()` makes one. */
  workspace?: Workspace | null;
  /**
   * Which of the workspace's file tools to offer (default all:
   * list_files, read_file, write_file, edit_file, delete_file,
   * move_file, copy_file, search_files). `["read_file", "list_files"]`
   * gives a read-only agent.
   */
  fileTools?: boolean | string[];
  /**
   * The file tools refuse to overwrite or edit an existing file the model
   * has not read in this conversation, or that changed since it read it
   * (the user edited it meanwhile), and ask it to read the file again —
   * so nobody's changes are overwritten from a stale copy. Default true.
   */
  readBeforeWrite?: boolean;
  /** Dialogs; `domUI()` when omitted. */
  ui?: AgentUI;
  /**
   * `"ask"` (default): destructive tools and tools with `confirm` ask the
   * user first. `"auto"`: never ask. A function decides per call.
   */
  permissions?: Permissions;
  /** Model calls per run (default 100 — a safety net; pi, opencode and Claude Code have none, the loop guard and the user's stop button are the real limits). */
  maxTurns?: number;
  /** `max_tokens` of each model call; `"auto"` (default) uses the catalogue's maximum output for the model (8192 when unknown). */
  maxTokens?: number | "auto";
  /** Context budget in tokens; `"auto"` (default) reads the catalogue. */
  /** The context budget: `"auto"` is the model's window; a number caps it (never above the window the catalogue gives). */
  maxInputTokens?: number | "auto";
  /** Run a turn's tool calls at once instead of one after another. */
  parallelTools?: boolean;
  /** Keep this many recent turns intact when the context is trimmed (default 4). */
  keepTurns?: number;
  /**
   * Whether the model sees pictures, when you know better than the
   * catalogue (default: its `input_modalities`; unknown when it has none).
   * `true` offers `vision` tools and lets read_file show pictures; `false`
   * never sends a picture — attached or returned by a tool — to the model.
   */
  vision?: boolean;
  /**
   * The memory notes file in the workspace (default `/memory/notes.md`):
   * shown to the model at the start of every conversation, and it is told
   * to append to it. `false` for none — when the workspace is the user's own
   * project, say, and you keep memory elsewhere.
   */
  memoryFile?: string | false;
  /** The project instructions file added to the system prompt (default `/AGENTS.md`); `false` for none. */
  instructionsFile?: string | false;
  /**
   * The guard against tool calls that go nowhere: after `warn` rounds in a
   * row that brought nothing new (the same results, lines already read,
   * the same errors) the model is told to use what it has; after `stop` the
   * run ends with an error. A round in which a tool that changes things
   * succeeded is progress. Default `{ warn: 3, stop: 6 }`; `false` turns it off.
   */
  loopGuard?: false | { warn?: number; stop?: number };
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
  sandbox?: boolean | { timeoutMs?: number; network?: boolean; maxLogChars?: number };
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
