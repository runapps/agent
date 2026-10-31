// Compaction: when the transcript nears the model's window, the older
// turns are summarised by the model into a structured checkpoint that
// replaces them, and the recent turns stay verbatim. Ported from pi
// (github.com/earendil-works/pi, MIT): the prompts, the serialisation
// of the conversation as text (so the model summarises instead of
// continuing it) and the cut-point rules are theirs.

import type { ChatMessage } from "./llm.js";
import { estimateTokens, groupTurns } from "./context.js";

export interface CompactionSettings {
  /** Compact when the context is within this many tokens of the window (default 16 384, at most 20 % of the window). */
  reserveTokens: number;
  /** Keep about this many tokens of recent turns verbatim (default 20 000, at most 40 % of the window). */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = { reserveTokens: 16_384, keepRecentTokens: 20_000 };

export const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TOOL_RESULT_MAX_CHARS = 2000;

/** The summary a compaction message carries, or null for any other message. */
export function summaryOf(m: ChatMessage): string | null {
  if (m.role !== "user" || typeof m.content !== "string") return null;
  if (!m.content.startsWith(COMPACTION_SUMMARY_PREFIX) || !m.content.endsWith(COMPACTION_SUMMARY_SUFFIX)) return null;
  return m.content.slice(COMPACTION_SUMMARY_PREFIX.length, m.content.length - COMPACTION_SUMMARY_SUFFIX.length);
}

export function summaryMessage(summary: string): ChatMessage {
  return { role: "user", content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX };
}

export function resolveSettings(window: number, s: Partial<CompactionSettings> = {}): CompactionSettings {
  return {
    reserveTokens: Math.min(s.reserveTokens ?? DEFAULT_COMPACTION.reserveTokens, Math.floor(window * 0.2)),
    keepRecentTokens: Math.min(s.keepRecentTokens ?? DEFAULT_COMPACTION.keepRecentTokens, Math.floor(window * 0.4)),
  };
}

export function shouldCompact(contextTokens: number, window: number, s: CompactionSettings): boolean {
  return contextTokens > window - s.reserveTokens;
}

export interface CutPlan {
  /** Turns to summarise (whole turns, oldest first), minus any earlier summary message. */
  toSummarize: ChatMessage[];
  /** The earlier summary, when the transcript already had one. */
  previousSummary?: string;
  /** Turns kept verbatim. */
  kept: ChatMessage[];
  /** What the user asked the summary to focus on (`compact(focus)`). */
  focus?: string;
}

/**
 * Splits the transcript so that about `keepRecentTokens` of the newest
 * messages stay verbatim. A cut falls before a user message or before an
 * assistant message — inside a long agentic turn too (pi's split turn),
 * so one prompt followed by many tool rounds can still be summarised —
 * and never between a tool call and its result. The newest message
 * always stays; null when there is nothing older to summarise.
 */
export function planCut(messages: ChatMessage[], keepRecentTokens: number): CutPlan | null {
  if (messages.length < 2) return null;
  let acc = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    acc += estimateTokens([messages[i]!]);
    const role = messages[i]!.role;
    if (role === "user" || role === "assistant") {
      cut = i;
      if (acc >= keepRecentTokens) break;
    }
  }
  if (cut <= 0) return null;
  let previousSummary: string | undefined;
  const toSummarize: ChatMessage[] = [];
  for (const m of messages.slice(0, cut)) {
    const s = summaryOf(m);
    if (s !== null && previousSummary === undefined) previousSummary = s;
    else toSummarize.push(m);
  }
  if (!toSummarize.length) return null;
  return { toSummarize, previousSummary, kept: messages.slice(cut) };
}

/** The conversation as text, so the summariser describes it instead of continuing it. */
export function serializeConversation(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
    if (m.role === "user") {
      if (text) parts.push(`[User]: ${text}`);
    } else if (m.role === "assistant") {
      if (text) parts.push(`[Assistant]: ${text}`);
      if (m.tool_calls?.length) {
        parts.push(`[Assistant tool calls]: ${m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join("; ")}`);
      }
    } else if (m.role === "tool") {
      if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

function truncateForSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters truncated]`;
}

/** The messages of a summarisation request. */
export function summarizationMessages(toSummarize: ChatMessage[], previousSummary?: string, focus?: string): ChatMessage[] {
  let prompt = `<conversation>\n${serializeConversation(toSummarize)}\n</conversation>\n\n`;
  if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  prompt += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  // pi's `/compact <instructions>`: what the user wants the summary to keep above all.
  if (focus?.trim()) prompt += `\n\nThe user asked this summary to focus on: ${focus.trim()}`;
  return [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
}
