// Agent: the model ↔ tool loop. One `prompt()` is a run; a run is turns
// of one model call each followed by that call's tool batch, until the
// model answers without tools (or the run is stopped). Everything the
// app shows comes through `on()` events; what the app owns (dialogs,
// files, skills, tools) comes in through the options.

import type { RunApps } from "@runappsai/sdk";
import type { ChatCompletionParams, ChatMessage, ChatToolCall, ContentPart } from "@runappsai/sdk";
import { APIError } from "@runappsai/sdk";
import type { Usage } from "@runappsai/sdk";
import type { Unsubscribe } from "@runappsai/sdk";
import { planCut, resolveSettings, shouldCompact, summaryMessage, summaryOf, summarizationMessages, type CompactionSettings } from "./compaction.js";
import { collectCompletion } from "./completion.js";
import { buildSystemPrompt, estimateTokens, fitBudget } from "./context.js";
import { expandSlash } from "./templates.js";
import { fileTools } from "./file-tools.js";
import { validateSchema } from "./json-schema.js";
import { sandboxTool } from "./sandbox.js";
import { normalizeResult, textOf, toChatTool } from "./tool.js";
import type {
  AgentEventMap,
  AgentEventName,
  AgentOptions,
  AgentUI,
  AgentUsage,
  RunEndReason,
  RunResult,
  SessionData,
  Tool,
  ToolStatus,
} from "./types.js";
import { askUserTool, domUI } from "./ui.js";
import { titleOf, type Workspace } from "./workspace.js";

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_INPUT_TOKENS = 128_000;
const MEMORY_PATH = "/memory/notes.md";
const AGENTS_PATH = "/AGENTS.md";
const MAX_NOTES_CHARS = 6000;
const MAX_RETRIES = 3;
const LOOP_WARN = 3;
const LOOP_STOP = 6;

export type PromptContent = string | ContentPart[];

type Handler<K extends AgentEventName> = (event: AgentEventMap[K]) => void;
type AnyHandler = (name: AgentEventName, event: AgentEventMap[AgentEventName]) => void;

interface Queued {
  kind: "steer" | "followUp";
  message: ChatMessage;
  resolve?: (r: RunResult) => void;
}

/** The message as the model sees it: without the chat's own bookkeeping fields. */
function stripMeta(m: ChatMessage): ChatMessage {
  if (!("ts" in m)) return m;
  const { ts: _ts, ...rest } = m as ChatMessage & { ts?: number };
  return rest as ChatMessage;
}

export class Agent {
  readonly id: string;
  readonly client: RunApps;
  readonly ui: AgentUI;
  readonly workspace: Workspace | null;
  readonly tools: Tool[];
  private readonly opts: AgentOptions;
  private history: ChatMessage[] = [];
  private committed = 0;
  private droppedTurns = 0;
  private _usage: AgentUsage = { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  private readonly handlers = new Map<AgentEventName, Set<Handler<AgentEventName>>>();
  private readonly anyHandlers = new Set<AnyHandler>();
  private queue: Queued[] = [];
  private current: { controller: AbortController; promise: Promise<RunResult> } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingSkills: string[] = [];
  private inputTokens: Promise<{ input: number; output: number }> | null = null;
  private lastBatches: string[] = [];
  private loopWarned = false;
  private readonly loaded: Promise<void>;
  private createdAt = Date.now();
  private readonly persist: boolean;

  constructor(client: RunApps, opts: AgentOptions = {}) {
    this.client = client;
    this.opts = opts;
    this.id = opts.id || `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.ui = opts.ui ?? domUI();
    this.workspace = opts.workspace ?? null;
    const tools: Tool[] = [...(opts.tools ?? [])];
    if (this.workspace && opts.fileTools !== false) {
      const want = Array.isArray(opts.fileTools) ? new Set(opts.fileTools) : null;
      tools.push(...fileTools(this.workspace).filter((t) => !want || want.has(t.name)));
    }
    if (opts.askUser !== false) tools.push(askUserTool());
    if (opts.sandbox !== false) tools.push(sandboxTool(this.workspace, typeof opts.sandbox === "object" ? opts.sandbox : {}));
    const seen = new Set<string>();
    for (const t of tools) {
      if (seen.has(t.name)) throw new Error(`runapps agent: two tools are named "${t.name}"`);
      seen.add(t.name);
    }
    this.tools = tools;
    if (opts.serverTools?.length && (opts.tools?.length || this.workspace || opts.sandbox !== false || opts.askUser !== false)) {
      throw new Error("runapps agent: serverTools work only for an agent with no tools of its own (tools: [], workspace: null, sandbox: false, askUser: false) — the gateway runs that loop");
    }
    this.persist = !!this.workspace && opts.persist !== false;
    if (opts.restore) {
      this.applySession(opts.restore);
      this.loaded = Promise.resolve();
    } else if (this.persist && opts.id) {
      // An id names a session: continue it when the workspace has one.
      this.loaded = this.workspace!.sessions.get(opts.id).then((saved) => {
        if (saved) this.applySession(saved);
      }).catch(() => undefined);
    } else {
      this.loaded = Promise.resolve();
    }
  }

  private applySession(data: SessionData): void {
    if (data.v !== 1 && data.v !== 2) throw new Error("runapps agent: unknown session format");
    this.history = data.messages.slice();
    this.committed = this.history.length;
    this.droppedTurns = data.droppedTurns ?? 0;
    this._usage = { ...data.usage };
    this.createdAt = data.createdAt ?? data.savedAt ?? Date.now();
    if (data.model && !this.opts.model) this.opts.model = data.model;
  }

  /** Resolves once a saved session (if any) has been loaded. */
  ready(): Promise<void> {
    return this.loaded;
  }

  private async saveSession(): Promise<void> {
    if (!this.persist || !this.workspace) return;
    try {
      await this.workspace.sessions.save(this.export());
      this.emit("session_saved", { id: this.id });
    } catch (err) {
      console.warn("[runapps agent] could not save the session:", err);
    }
  }

  /* ---------------- events ---------------- */

  on<K extends AgentEventName>(name: K, handler: Handler<K>): Unsubscribe;
  on(name: "*", handler: AnyHandler): Unsubscribe;
  on(name: AgentEventName | "*", handler: Handler<AgentEventName> | AnyHandler): Unsubscribe {
    if (name === "*") {
      this.anyHandlers.add(handler as AnyHandler);
      return () => { this.anyHandlers.delete(handler as AnyHandler); };
    }
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as Handler<AgentEventName>);
    return () => { this.handlers.get(name)?.delete(handler as Handler<AgentEventName>); };
  }

  private emit<K extends AgentEventName>(name: K, event: AgentEventMap[K]): void {
    for (const h of this.handlers.get(name) ?? []) {
      try { (h as Handler<K>)(event); } catch (err) { console.error("[runapps agent] listener for", name, "threw:", err); }
    }
    for (const h of this.anyHandlers) {
      try { h(name, event); } catch (err) { console.error("[runapps agent] listener threw:", err); }
    }
  }

  /* ---------------- state ---------------- */

  /** The transcript (a copy), without the system prompt. */
  get messages(): ChatMessage[] {
    return this.history.slice();
  }

  get usage(): AgentUsage {
    return { ...this._usage };
  }

  get busy(): boolean {
    return this.current !== null;
  }

  get model(): string | undefined {
    return this.opts.model;
  }

  set model(name: string | undefined) {
    this.opts.model = name;
    this.inputTokens = null;
  }

  /** A snapshot to save (`restore` continues it). Taken at the last complete turn. */
  export(): SessionData {
    const messages = this.history.slice(0, this.committed);
    const data: SessionData = {
      v: 2,
      id: this.id,
      model: this.opts.model,
      messages,
      usage: { ...this._usage },
      droppedTurns: this.droppedTurns,
      createdAt: this.createdAt,
      savedAt: Date.now(),
    };
    data.title = titleOf(data);
    return data;
  }

  /** Forgets the conversation (the workspace stays). */
  reset(): void {
    if (this.current) throw new Error("runapps agent: cannot reset while a run is active; abort() first");
    this.history = [];
    this.committed = 0;
    this.droppedTurns = 0;
    this.lastBatches = [];
    this.loopWarned = false;
  }

  /**
   * Loads a skill for the next prompt: its instructions are placed before
   * the user's message, as if the user had asked for that skill.
   */
  useSkill(name: string): void {
    if (!this.workspace) throw new Error("runapps agent: useSkill needs a workspace");
    this.pendingSkills.push(name);
  }

  /* ---------------- input ---------------- */

  /**
   * Sends a user message and runs until the model answers. While a run is
   * active the message is queued as a follow-up (same as `followUp`).
   */
  prompt(content: PromptContent, init: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const message = this.userMessage(content);
    if (this.current) return this.enqueue("followUp", message);
    return this.start(message, init.signal);
  }

  /** Adds guidance that the model sees after the current tool batch; queued when idle like `prompt`. */
  steer(content: PromptContent): Promise<RunResult> | void {
    const message = this.userMessage(content);
    if (!this.current) return this.start(message);
    this.queue.push({ kind: "steer", message });
    this.emit("queued", { kind: "steer", message });
  }

  /** Runs after the current run has finished. */
  followUp(content: PromptContent): Promise<RunResult> {
    const message = this.userMessage(content);
    if (!this.current) return this.start(message);
    return this.enqueue("followUp", message);
  }

  /** What waits for the current run: steering (joins the next turn) and follow-ups (run after it). */
  get queued(): Array<{ kind: "steer" | "followUp"; message: ChatMessage }> {
    return this.queue.map((q) => ({ kind: q.kind, message: q.message }));
  }
  /** Drops one queued message (by the object `queued` lists); a waiting `followUp()` resolves as aborted. */
  dequeue(message: ChatMessage): boolean {
    const q = this.queue.find((q) => q.message === message);
    if (!q) return false;
    this.queue = this.queue.filter((x) => x !== q);
    q.resolve?.({ runId: "", reason: "aborted", text: "", usage: { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 } });
    return true;
  }
  /** Drops everything queued; a waiting `followUp()` resolves as aborted. */
  clearQueue(): void {
    const dropped = this.queue;
    this.queue = [];
    for (const q of dropped) q.resolve?.({ runId: "", reason: "aborted", text: "", usage: { total_cost: 0, prompt_tokens: 0, completion_tokens: 0, calls: 0 } });
  }
  /** Stops the current run (pending tool calls get a "skipped" result) and drops the queue. */
  async abort(): Promise<void> {
    this.clearQueue();
    const cur = this.current;
    if (!cur) return;
    cur.controller.abort();
    await cur.promise.catch(() => undefined);
  }

  private enqueue(kind: "followUp", message: ChatMessage): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      this.queue.push({ kind, message, resolve });
      this.emit("queued", { kind, message });
    });
  }

  private userMessage(content: PromptContent): ChatMessage {
    const parts: ContentPart[] = typeof content === "string" ? [{ type: "text", text: content }] : content.slice();
    // `ts` (when it was sent) rides along in the saved session and is stripped before the model sees it.
    return { role: "user", content: parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts, ts: Date.now() } as ChatMessage;
  }

  /**
   * Goes back to before message `index` (as in `messages`): later messages
   * are dropped and the session saved. The caller re-sends or edits the
   * message. Not while a run is active.
   */
  async rewind(index: number): Promise<void> {
    if (this.current) throw new Error("runapps agent: cannot rewind while a run is active; abort() first");
    if (!Number.isInteger(index) || index < 0 || index > this.history.length) throw new Error(`runapps agent: no message at ${index}`);
    this.clearQueue();
    this.history = this.history.slice(0, index);
    this.committed = this.history.length;
    this.lastBatches = [];
    this.loopWarned = false;
    await this.saveSession();
    this.emit("rewind", { index });
  }

  private start(message: ChatMessage, signal?: AbortSignal): Promise<RunResult> {
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const promise = this.chain.then(() => this.run(message, controller)).finally(() => {
      if (this.current?.controller === controller) this.current = null;
      this.drainFollowUps();
    });
    this.current = { controller, promise };
    this.chain = promise.catch(() => undefined);
    return promise;
  }

  private drainFollowUps(): void {
    const next = this.queue.find((q) => q.kind === "followUp");
    if (!next) return;
    this.queue = this.queue.filter((q) => q !== next);
    this.start(next.message).then((r) => next.resolve?.(r), () => undefined);
  }

  /* ---------------- the loop ---------------- */

  private async run(message: ChatMessage, controller: AbortController): Promise<RunResult> {
    await this.loaded;
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const signal = controller.signal;
    let reason: RunEndReason = "done";
    let error: Error | undefined;
    let lastText = "";
    let truncatedRounds = 0;

    const prefaced = await this.withSkillPrefaces(await this.expandSlashes(message));
    this.history.push(prefaced);
    this.emit("run_start", { runId, message: prefaced });

    const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const { output: maxTokens, input: window } = await this.limits();
    const compaction = resolveSettings(window, typeof this.opts.compaction === "object" ? this.opts.compaction : {});

    try {
      for (let turn = 1; ; turn++) {
        if (signal.aborted) { reason = "aborted"; break; }
        if (turn > maxTurns) { reason = "max_turns"; break; }
        this.emit("turn_start", { runId, turn });

        // Steering arrives between tool batches.
        for (const q of this.queue.filter((q) => q.kind === "steer")) this.history.push(q.message);
        this.queue = this.queue.filter((q) => q.kind !== "steer");

        const system = await this.systemPrompt();
        // Context management, pi-style: summarise older turns when the
        // window is nearly full; elide/drop as the fallback.
        const tokensBefore = estimateTokens(this.history, system);
        if (shouldCompact(tokensBefore, window, compaction)) {
          const summarized = this.opts.compaction === false ? false : await this.compactWith(compaction, runId, signal);
          const after = estimateTokens(this.history, system);
          if (!summarized || shouldCompact(after, window, compaction)) {
            // Trim, keeping a compaction summary at the front pinned: it
            // is the memory of everything already dropped.
            const pinned = this.history.length && summaryOf(this.history[0]!) !== null ? [this.history[0]!] : [];
            const rest = this.history.slice(pinned.length);
            const fit = fitBudget(rest, { budget: window - compaction.reserveTokens - estimateTokens(pinned), keepTurns: this.opts.keepTurns ?? 4, system });
            if (fit.droppedTurns || fit.elidedResults) {
              this.history = [...pinned, ...fit.messages];
              this.droppedTurns += fit.droppedTurns;
              this.committed = Math.min(this.committed, this.history.length);
              this.emit("compaction", { runId, summary: false, tokensBefore: after, tokensAfter: estimateTokens(this.history, system), droppedTurns: fit.droppedTurns, elidedResults: fit.elidedResults });
            }
          }
        }

        const params: ChatCompletionParams = {
          ...(this.opts.extra ?? {}),
          model: this.opts.model ?? "",
          messages: [{ role: "system", content: system }, ...this.history.map(stripMeta)],
          max_tokens: maxTokens,
        };
        if (!params.model) delete (params as Partial<ChatCompletionParams>).model;
        if (this.tools.length) params.tools = this.tools.map((t) => toChatTool(t as Tool<unknown>));
        if (this.opts.serverTools?.length) params.server_tools = this.opts.serverTools;
        if (this.opts.prompt) params.prompt = this.opts.prompt;
        if (this.opts.temperature !== undefined) params.temperature = this.opts.temperature;
        if (this.opts.top_p !== undefined) params.top_p = this.opts.top_p;

        const completion = await this.callModel(params, runId, signal);
        if (completion.usage) this.addUsage(completion.usage);
        const assistant: ChatMessage = { role: "assistant", content: completion.message.content };
        if (completion.message.tool_calls?.length) assistant.tool_calls = completion.message.tool_calls;
        this.history.push(assistant);
        if (typeof assistant.content === "string" && assistant.content) lastText = assistant.content;
        const truncated = completion.finishReason === "length";
        this.emit("message_end", { runId, message: assistant, truncated });
        this.emit("turn_end", { runId, turn, usage: completion.usage });

        const calls = assistant.tool_calls ?? [];
        if (!calls.length) {
          this.committed = this.history.length;
          await this.saveSession();
          if (truncated && this.balanceLimited(completion.usage, maxTokens)) {
            reason = "error";
            error = new APIError(402, "insufficient_balance", "runapps agent: the reply was cut short because the balance could not cover a full answer; top up to continue");
            break;
          }
          // pi: steering that arrived during the final reply still gets its turn.
          if (!signal.aborted && this.queue.some((q) => q.kind === "steer")) continue;
          break;
        }

        const results = await this.runBatch(calls, runId, signal, truncated);
        this.committed = this.history.length;
        await this.saveSession();
        if (signal.aborted) { reason = "aborted"; break; }
        if (truncated) {
          truncatedRounds++;
          if (this.balanceLimited(completion.usage, maxTokens)) {
            reason = "error";
            error = new APIError(402, "insufficient_balance", "runapps agent: the reply was cut short because the balance could not cover a full answer; top up to continue");
            break;
          }
          if (truncatedRounds >= 2) {
            reason = "error";
            error = new Error("runapps agent: the model's tool calls were cut off by the output limit twice in a row");
            break;
          }
        }
        const guard = this.checkLoop(results);
        if (guard === "stop") {
          reason = "error";
          error = new Error("runapps agent: stopped after repeating the same tool calls without progress");
          break;
        }
        if (guard === "warn") {
          this.history.push({
            role: "user",
            content: "[environment] The last rounds repeated the same tool calls with the same results. Do not repeat them; either take a different approach or explain the blocker and finish.",
          });
        }
      }
    } catch (err) {
      if (signal.aborted) reason = "aborted";
      else {
        reason = "error";
        error = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (reason === "aborted") this.closeOpenToolCalls();
    this.committed = this.history.length;
    this.lastBatches = [];
    this.loopWarned = false;
    await this.saveSession();
    const result: RunResult = {
      runId,
      reason,
      text: lastText,
      usage: this.usage,
      ...(error ? { error } : {}),
    };
    this.emit("run_end", result);
    return result;
  }

  /** The system prompt for the next request (what the model is told). */
  async systemPrompt(): Promise<string> {
    const ws = this.workspace;
    const readOpt = async (path: string, max: number) => {
      if (!ws) return undefined;
      try {
        const t = await ws.readText(path);
        return t.length > max ? t.slice(t.length - max) : t;
      } catch {
        return undefined;
      }
    };
    return buildSystemPrompt({
      appName: this.opts.appName,
      instructions: typeof this.opts.instructions === "function" ? this.opts.instructions() : this.opts.instructions,
      tools: this.tools,
      workspaceDescription: ws ? ws.describe() : undefined,
      skills: ws ? await ws.skills() : [],
      hasSandbox: this.tools.some((t) => t.name === "run_js"),
      hasAskUser: this.tools.some((t) => t.name === "ask_user"),
      canWrite: this.tools.some((t) => t.name === "write_file" || t.name === "edit_file"),
      agentsMd: await readOpt(AGENTS_PATH, 20_000),
      memory: await readOpt(MEMORY_PATH, MAX_NOTES_CHARS),
      droppedTurns: this.droppedTurns,
    });
  }

  /**
   * Summarises the older turns into a checkpoint now (the loop does this
   * by itself when the window is nearly full). Resolves true when a
   * summary replaced older turns.
   */
  async compact(): Promise<boolean> {
    if (this.current) throw new Error("runapps agent: cannot compact while a run is active");
    const window = await this.contextTokens();
    const settings = resolveSettings(window, typeof this.opts.compaction === "object" ? this.opts.compaction : {});
    const done = await this.compactWith(settings, undefined, new AbortController().signal);
    if (done) await this.saveSession();
    return done;
  }

  private async compactWith(settings: CompactionSettings, runId: string | undefined, signal: AbortSignal): Promise<boolean> {
    const plan = planCut(this.history, settings.keepRecentTokens);
    if (!plan) return false;
    const tokensBefore = estimateTokens(this.history);
    let summary: string;
    try {
      if (typeof this.opts.compaction === "function") {
        summary = await this.opts.compaction(plan, this);
      } else {
        const res = await this.client.chat.create(
          { model: this.opts.model ?? "", messages: summarizationMessages(plan.toSummarize, plan.previousSummary), max_tokens: (await this.limits()).output },
          { signal },
        );
        if (res.usage) this.addUsage(res.usage);
        const choice = res.choices[0];
        if (!choice || choice.finish_reason === "length") throw new Error("the summary is incomplete");
        if (choice.message.tool_calls?.length) throw new Error("the summariser attempted to call a tool");
        summary = (choice.message.content ?? "").trim();
        if (!summary) throw new Error("empty summary");
      }
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn("[runapps agent] compaction summary failed, falling back to trimming:", err);
      return false;
    }
    this.history = [summaryMessage(summary), ...plan.kept];
    this.committed = this.history.length;
    this.emit("compaction", { runId, summary: true, tokensBefore, tokensAfter: estimateTokens(this.history), droppedTurns: 0, elidedResults: 0 });
    return true;
  }

  /** `/skill:name args` and `/template args` in a user message. */
  private async expandSlashes(message: ChatMessage): Promise<ChatMessage> {
    if (!this.workspace || typeof message.content !== "string" || !message.content.startsWith("/")) return message;
    const expanded = await expandSlash(this.workspace, message.content);
    return expanded === message.content ? message : { role: "user", content: expanded };
  }

  /** One model call with retries for transient failures. */
  private async callModel(params: ChatCompletionParams, runId: string, signal: AbortSignal) {
    let text = "";
    let reasoning = "";
    let streamed = false;
    for (let attempt = 1; ; attempt++) {
      text = "";
      reasoning = "";
      try {
        return await collectCompletion(
          (p, init) => this.client.chat.stream(p, init),
          params,
          {
            signal,
            onText: (delta, all) => {
              streamed = true;
              text = all;
              this.emit("text_delta", { runId, delta, text: all });
            },
            onReasoning: (delta, all) => {
              streamed = true;
              reasoning = all;
              this.emit("reasoning_delta", { runId, delta, text: all });
            },
          },
        );
      } catch (err) {
        if (signal.aborted) throw err;
        if (attempt >= MAX_RETRIES || !isTransient(err)) throw err;
        const wait = retryDelay(err, attempt);
        if (streamed) this.emit("message_reset", { runId, reason: (err as Error).message });
        streamed = false;
        await sleep(wait, signal);
      }
    }
  }

  private async runBatch(calls: ChatToolCall[], runId: string, signal: AbortSignal, truncated: boolean): Promise<string[]> {
    const run = (call: ChatToolCall) => this.runTool(call, runId, signal, truncated);
    const outcomes = this.opts.parallelTools
      ? await Promise.all(calls.map((c) => run(c)))
      : await (async () => {
          const out: Array<{ message: ChatMessage; fingerprint: string }> = [];
          let interrupted = false;
          for (const c of calls) {
            if (interrupted) { out.push(this.skipTool(c, runId, "Skipped: the user sent a new instruction; the following tool calls were not run.")); continue; }
            out.push(await run(c));
            // pi: steering is checked after each tool; when some arrived, the rest of the batch is skipped so the model sees it at once.
            if (this.queue.some((q) => q.kind === "steer")) interrupted = true;
          }
          return out;
        })();
    for (const o of outcomes) this.history.push(o.message);
    return outcomes.map((o) => o.fingerprint);
  }

  private skipTool(call: ChatToolCall, runId: string, why: string): { message: ChatMessage; fingerprint: string } {
    const id = call.id ?? "", name = call.function.name;
    this.emit("tool_start", { runId, id, name, args: call.function.arguments });
    this.emit("tool_end", { runId, id, name, status: "skipped", result: why, durationMs: 0 });
    return { message: { role: "tool", tool_call_id: id, content: why }, fingerprint: `${name}|${call.function.arguments}|skipped|${why}` };
  }

  private async runTool(call: ChatToolCall, runId: string, signal: AbortSignal, truncated: boolean): Promise<{ message: ChatMessage; fingerprint: string }> {
    const id = call.id ?? "";
    const name = call.function.name;
    const started = Date.now();
    const finish = (status: ToolStatus, content: string | ContentPart[], details?: unknown): { message: ChatMessage; fingerprint: string } => {
      const result = textOf(content);
      this.emit("tool_end", { runId, id, name, status, result, details, durationMs: Date.now() - started });
      return { message: { role: "tool", tool_call_id: id, content }, fingerprint: `${name}|${call.function.arguments}|${status}|${result.slice(0, 2000)}` };
    };

    if (signal.aborted) return finish("skipped", "Skipped: the user stopped the run.");
    if (truncated) {
      // pi: nothing from a reply cut by the output limit runs.
      this.emit("tool_start", { runId, id, name, args: call.function.arguments });
      return finish("error", `Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`);
    }
    const tool = this.tools.find((t) => t.name === name);
    let args: unknown;
    try {
      args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      this.emit("tool_start", { runId, id, name, args: call.function.arguments });
      return finish("error", "Error: the arguments are not valid JSON.");
    }
    this.emit("tool_start", { runId, id, name, args });
    if (!tool) return finish("error", `Error: there is no tool named "${name}". Available tools: ${this.tools.map((t) => t.name).join(", ")}.`);
    if (args === null || typeof args !== "object" || Array.isArray(args)) return finish("error", "Error: the arguments must be a JSON object.");
    const problems = validateSchema(tool.parameters, args);
    if (problems.length) return finish("error", `Error: invalid arguments for ${name}:\n- ${problems.join("\n- ")}\nFix the call and try again.`);

    // Gate: hook, permissions, the tool's own confirm.
    try {
      const hook = await this.opts.onToolCall?.({ id, name, args, tool });
      if (hook && hook.block) return finish("blocked", `${hook.reason ?? "This action was not allowed."} Do not retry it another way; say what you would have done.`);
      const allowed = await this.permitted(tool, args);
      if (!allowed) return finish("declined", "The user declined this action. Do not retry it another way; say what you would have done.");
    } catch (err) {
      if (signal.aborted) return finish("skipped", "Skipped: the user stopped the run.");
      return finish("error", `Error: ${(err as Error).message}`);
    }

    if (signal.aborted) return finish("skipped", "Skipped: the user stopped the run.");
    try {
      const value = await tool.execute(args as Record<string, unknown>, {
        signal,
        ui: this.ui,
        workspace: this.workspace,
        agent: this,
        callId: id,
        update: (content) => this.emit("tool_update", { runId, id, name, content }),
      });
      if (signal.aborted) return finish("skipped", "Skipped: the user stopped the run.");
      const norm = normalizeResult(value, tool.maxResultChars);
      return finish("ok", norm.content, norm.details);
    } catch (err) {
      if (signal.aborted) return finish("skipped", "Skipped: the user stopped the run.");
      const msg = err instanceof Error ? err.message : String(err);
      return finish("error", msg.startsWith("Error:") ? msg : `Error: ${msg}`);
    }
  }

  private async permitted(tool: Tool, args: unknown): Promise<boolean> {
    const p = this.opts.permissions ?? "ask";
    if (typeof p === "function") return p({ name: tool.name, args, tool });
    if (p === "auto") return true;
    let question: string | false = false;
    if (tool.confirm) question = await tool.confirm(args as Record<string, unknown>);
    else if (tool.destructive) question = `Allow ${tool.name}?`;
    if (question === false) return true;
    return this.ui.confirm(question, undefined, { danger: !!tool.destructive });
  }

  /** After an abort, every open tool call gets a result so the transcript stays valid. */
  private closeOpenToolCalls(): void {
    const last = this.history[this.history.length - 1];
    if (!last) return;
    let i = this.history.length - 1;
    while (i >= 0 && this.history[i]!.role === "tool") i--;
    const assistant = this.history[i];
    if (!assistant || assistant.role !== "assistant" || !assistant.tool_calls?.length) return;
    const answered = new Set(this.history.slice(i + 1).map((m) => m.tool_call_id));
    for (const c of assistant.tool_calls) {
      if (c.id && !answered.has(c.id)) this.history.push({ role: "tool", tool_call_id: c.id, content: "Skipped: the user stopped the run." });
    }
  }

  private checkLoop(fingerprints: string[]): "ok" | "warn" | "stop" {
    const key = fingerprints.slice().sort().join("\n");
    this.lastBatches.push(key);
    if (this.lastBatches.length > LOOP_STOP) this.lastBatches.shift();
    const same = (n: number) => this.lastBatches.length >= n && this.lastBatches.slice(-n).every((k) => k === key);
    if (same(LOOP_STOP)) return "stop";
    if (same(LOOP_WARN) && !this.loopWarned) {
      this.loopWarned = true;
      return "warn";
    }
    return "ok";
  }

  private balanceLimited(usage: Usage | undefined, maxTokens: number): boolean {
    // The gateway lowers max_tokens to what the balance covers (never
    // below 1024); a reply cut well short of what we asked for says so.
    const out = usage?.completion_tokens;
    return typeof out === "number" && out > 0 && out < maxTokens * 0.9;
  }

  private addUsage(u: Usage): void {
    this._usage.total_cost = round(this._usage.total_cost + (u.total_cost ?? 0));
    this._usage.prompt_tokens += u.prompt_tokens ?? 0;
    this._usage.completion_tokens += u.completion_tokens ?? 0;
    this._usage.calls++;
  }

  /** How full the model's context is: tokens the next call would send (estimated) against the window. */
  async context(): Promise<{ used: number; window: number }> {
    const [window, system] = await Promise.all([this.contextTokens(), this.systemPrompt().catch(() => "")]);
    return { used: estimateTokens(this.history, system), window };
  }

  /**
   * The model's limits as the agent uses them: `input` is the context
   * window, `output` the `max_tokens` of each call — the catalogue's
   * figures for the model (its `max_input_tokens` / `max_tokens`), unless
   * `maxInputTokens` / `maxTokens` are given as numbers.
   */
  async limits(): Promise<{ input: number; output: number }> {
    const fromCatalogue = typeof this.opts.maxInputTokens !== "number" || typeof this.opts.maxTokens !== "number";
    const cat = fromCatalogue ? await this.catalogueLimits() : { input: DEFAULT_INPUT_TOKENS, output: DEFAULT_MAX_TOKENS };
    return {
      input: typeof this.opts.maxInputTokens === "number" ? this.opts.maxInputTokens : cat.input,
      output: typeof this.opts.maxTokens === "number" ? this.opts.maxTokens : cat.output,
    };
  }

  private contextTokens(): Promise<number> {
    return this.limits().then((l) => l.input);
  }

  private catalogueLimits(): Promise<{ input: number; output: number }> {
    if (!this.inputTokens) {
      this.inputTokens = (async () => {
        try {
          const models = await this.client.models.list();
          const want = this.opts.model?.toLowerCase();
          const m = (want ? models.find((x) => x.id.toLowerCase() === want) : models.find((x) => x.is_default && (x.capability === "text"))) as { max_input_tokens?: number; max_tokens?: number } | undefined;
          const input = typeof m?.max_input_tokens === "number" && m.max_input_tokens > 0 ? m.max_input_tokens : DEFAULT_INPUT_TOKENS;
          const output = typeof m?.max_tokens === "number" && m.max_tokens > 0 ? m.max_tokens : DEFAULT_MAX_TOKENS;
          return { input, output };
        } catch {
          return { input: DEFAULT_INPUT_TOKENS, output: DEFAULT_MAX_TOKENS };
        }
      })();
    }
    return this.inputTokens;
  }

  private async withSkillPrefaces(message: ChatMessage): Promise<ChatMessage> {
    if (!this.pendingSkills.length || !this.workspace) return message;
    const names = this.pendingSkills.splice(0);
    const parts: ContentPart[] = [];
    for (const name of names) {
      const { skill, body } = await this.workspace.skillBody(name);
      parts.push({ type: "text", text: `[The user invoked the skill "${skill.name}" (${skill.path}). Follow these instructions for the request below.]\n\n${body}` });
    }
    const own: ContentPart[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
    return { role: "user", content: [...parts, ...own] };
  }

  /** Tokens the next request would send (estimate), for status displays. */
  estimateContext(): number {
    return estimateTokens(this.history);
  }

  /** The model's context window in tokens (from the catalogue). */
  contextWindow(): Promise<number> {
    return this.contextTokens();
  }
}

/* ------------------------------------------------------------------ */

function isTransient(err: unknown): boolean {
  if (err instanceof APIError) return err.statusCode === 408 || err.statusCode === 429 || err.statusCode >= 500 || err.statusCode === 0;
  if (err instanceof Error) return /network|fetch failed|ECONNRESET|socket|stream ended before/i.test(err.message) || err.name === "TypeError";
  return false;
}

function retryDelay(err: unknown, attempt: number): number {
  const ra = err instanceof APIError ? err.retryAfter : undefined;
  if (typeof ra === "number" && ra > 0) return Math.min(30_000, ra * 1000);
  return Math.min(8000, 800 * 2 ** (attempt - 1)) + Math.random() * 300;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
