// The agent harness: `Agent` (the loop), `Workspace` (files + skills),
// `defineTool`, the default UI and the built-in tools.

export { Agent, type PromptContent } from "./agent.js";

import type { RunApps } from "@runappsai/sdk";
import { Agent } from "./agent.js";
import type { AgentOptions } from "./types.js";
import { Workspace, type WorkspaceOptions } from "./workspace.js";

/** An agent on a client: `createAgent(client, { tools, workspace, … })`. */
export function createAgent(client: RunApps, opts: AgentOptions = {}): Agent {
  return new Agent(client, opts);
}

/**
 * A workspace for agents, scoped to the client's app (`project` option
 * of the client, or `opts.project`); resolves once its skills are unpacked.
 */
export function openWorkspace(client: RunApps | null, opts: WorkspaceOptions = {}): Promise<Workspace> {
  const project = opts.project ?? (client as unknown as { projectName?: string } | null)?.projectName ?? undefined;
  return Workspace.open(client, { ...opts, project });
}
export { Workspace, memoryFS, normalizePath, DEFAULT_SKILLS_DIR, type WorkspaceOptions, type WorkspaceRead, type SessionStore } from "./workspace.js";
export { directoryFS } from "./directory-fs.js";
export { planCut, serializeConversation, summaryOf, type CompactionSettings, type CutPlan } from "./compaction.js";
export { parseCommandArgs, substituteArgs, listTemplates, expandSlash, type PromptTemplate } from "./templates.js";
export { applyEdits, normalizeForFuzzyMatch, type TextEdit } from "./edit.js";
export { defineTool, normalizeResult } from "./tool.js";
export { domUI, nullUI, askUserTool } from "./ui.js";
export { VirtualList, type VRow, type VListOptions } from "./vlist.js";
export { renderChat, type ChatOptions, type ChatHandle } from "./chat.js";
export { renderMarkdown, renderInline, escapeHTML } from "./markdown.js";
export { fileTools } from "./file-tools.js";
export { sandboxTool, runInSandbox, type SandboxOptions, type SandboxResult } from "./sandbox.js";
export { parseSkill, parseFrontmatter } from "./skills.js";
export { collectCompletion, type CollectedCompletion } from "./completion.js";
export { buildSystemPrompt, estimateTokens, fitBudget, groupTurns } from "./context.js";
export { validateSchema } from "./json-schema.js";
export { listZip, readZipEntry, type ZipEntry, type Inflate } from "./zip.js";
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
