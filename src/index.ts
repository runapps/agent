// @runappsai/agent — the core: `Agent` (the loop), `Workspace` (files,
// skills, sessions), providers, tools. No DOM: it runs in browsers, Node,
// Deno and workers. The chat UI is `@runappsai/agent/ui`; Node helpers
// (a folder as the directory, storage on disk, terminal dialogs) are
// `@runappsai/agent/node`.

export { Agent, type PromptContent } from "./agent.js";
export { openAIProvider, runappsProvider, toProvider, ProviderError, sseData, type ModelProvider, type ModelInfo, type OpenAIProviderOptions, type RunAppsClientLike } from "./provider.js";
export type { ChatMessage, ContentPart, ChatTool, ChatToolCall, ChatCompletionParams, ChatCompletionChunk, ChatCompletion, Usage } from "./llm.js";

import { Agent } from "./agent.js";
import type { AgentOptions } from "./types.js";
import { Workspace, type WorkspaceOptions } from "./workspace.js";
import { toProvider, type ModelProvider, type RunAppsClientLike } from "./provider.js";

/**
 * An agent on a model provider: `createAgent(openAIProvider({ baseURL, apiKey }), { tools, workspace, … })`,
 * or on a RunApps SDK client directly (`createAgent(client, …)`).
 */
export function createAgent(provider: ModelProvider | RunAppsClientLike, opts: AgentOptions = {}): Agent {
  return new Agent(provider, opts);
}

/**
 * A workspace for agents, in the app's own IndexedDB database
 * (`opts.project`, else the provider's `name`, e.g. the RunApps client's
 * project); resolves once its skills are ready. The provider is only
 * needed for `files:` skills sources; `null` is fine.
 */
export function openWorkspace(provider: ModelProvider | RunAppsClientLike | null, opts: WorkspaceOptions = {}): Promise<Workspace> {
  const p = provider ? toProvider(provider) : null;
  return Workspace.open(p, { ...opts, project: opts.project ?? p?.name ?? undefined });
}
export { Workspace, memoryFS, normalizePath, guessType, decodeText, titleOf, UNTITLED, DEFAULT_SKILLS_DIR, DEFAULT_USER_SKILLS_DIR, type SkillSource, type LazySkill, type WorkspaceOptions, type WorkspaceRead, type WorkspaceChange, type SessionStore, type WorkspaceStore, type WorkspaceStoreFactory, type FileRecord } from "./workspace.js";
export { planCut, serializeConversation, summaryOf, type CompactionSettings, type CutPlan } from "./compaction.js";
export { parseCommandArgs, substituteArgs, listTemplates, expandSlash, type PromptTemplate } from "./templates.js";
export { applyEdits, normalizeForFuzzyMatch, type TextEdit } from "./edit.js";
export { defineTool, normalizeResult } from "./tool.js";
export { domUI, nullUI, askUserTool } from "./dialogs.js";
export { configurePdf, extractPdfText, formatPdfText, isPdf, type PdfLib } from "./pdf.js";
export { fileTools } from "./file-tools.js";
export { sandboxTool, runInSandbox, type SandboxOptions, type SandboxResult } from "./sandbox.js";
export { parseSkill, parseFrontmatter } from "./skills.js";
export { collectCompletion, type CollectedCompletion } from "./completion.js";
export { buildSystemPrompt, estimateTokens, fitBudget, groupTurns } from "./context.js";
export { validateSchema } from "./json-schema.js";
export { listZip, readZipEntry, buildZip, type ZipEntry, type Inflate } from "./zip.js";
export { skillZipFS, skillFoldersOf, subFS } from "./skill-zips.js";
export type {
  AgentEventMap,
  AgentEventName,
  AgentFS,
  AgentOptions,
  AgentUI,
  AgentUsage,
  FileStat,
  JSONSchema,
  Permissions,
  RunEnd,
  RunEndReason,
  RunResult,
  SelectOption,
  SessionData,
  SessionSummary,
  Skill,
  Tool,
  ToolCallHookEvent,
  ToolContext,
  ToolDefinition,
  ToolResultValue,
  ToolStatus,
} from "./types.js";
