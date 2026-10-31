// `renderChat(target, opts)`: the element becomes a chat with an agent —
// transcript (Markdown replies, thinking, tool cards, compaction notes),
// composer (Enter sends, steer / follow-up while running, slash
// commands for skills and templates), questions the agent asks rendered
// inline, a session menu when there is a workspace. Plain DOM, no
// framework, styles injected once; the host gives the element a height.
//
// Look and behaviour follow the harness app's chat (React/Chakra, purple
// palette): a right-aligned user bubble, replies full width with their work folded,
// collapsible tool cards with an icon, duration and status, a fixed-
// height composer that never resizes while typing, and a virtual
// transcript (`VirtualList`) that keeps only the rows near the viewport
// in the DOM, so a long history costs nothing to open.

import type { RunApps } from "@runappsai/sdk";
import type { ChatMessage, ContentPart } from "@runappsai/sdk";
import { Agent } from "./agent.js";
import type { Workspace } from "./workspace.js";
import { summaryOf } from "./compaction.js";
import { escapeHTML } from "./markdown.js";
import { listTemplates } from "./templates.js";
import { VirtualList, type VRow } from "./vlist.js";
import { downloadBlob, h, I, modal, modalConfirm, renderMD } from "./dom.js";
import { filesPanel, freePath } from "./files-panel.js";
import { debugPanel } from "./debug-panel.js";
import { extractPdfText, formatPdfText, isPdf } from "./pdf.js";
import { CHAT_PALETTES, tokenCSS, tokenProp, type ChatPalette, type ChatVars } from "./chat-theme.js";
import type { AgentOptions, AgentUI, RunResult, SelectOption, SessionSummary, ToolStatus } from "./types.js";

export interface ChatOptions extends Omit<AgentOptions, "workspace"> {
  /** The client the agent calls the gateway with (required unless `agent` is given). */
  client?: RunApps;
  /**
   * One workspace shared by every session, or a function making one per
   * session from the session's id — `(id) => openWorkspace(client, { id, skills })`
   * gives each conversation its own directory (files, skills, memory).
   */
  workspace?: Workspace | null | ((sessionId: string) => Workspace | Promise<Workspace>);
  /** An agent the host made itself; its own `ui` answers questions, and the session menu is off. */
  agent?: Agent;
  /**
   * Which session to open: `true` (default) continues the one this app
   * last had open in this browser (a new chat when there is none), a
   * string names one, `false` always starts a new one. An `id` in the
   * agent options wins over all of these.
   */
  resume?: boolean | string;
  /** Header title (default `appName`, else "Assistant"); `false` hides the header. */
  title?: string | false;
  placeholder?: string;
  /** Shown while the transcript is empty: text, HTML element, or nothing. */
  emptyState?: string | HTMLElement | null;
  /** Starter prompts offered in the empty state; a click puts one in the composer. */
  suggestions?: string[];
  /** The history / new-chat menu (default: on when the agent has a workspace). */
  sessions?: boolean;
  /**
   * The settings gear in the header (default: on when the chat owns its
   * agent): model, max turns, max output, tool permissions. What the user
   * picks is kept per app in localStorage and applied to every session
   * over the host's options.
   */
  settings?: boolean;
  /** Dialog language (default: the document's). */
  locale?: "zh" | "en";
  /** `"auto"` (default) follows the system; `"light"` / `"dark"` force one. */
  theme?: "auto" | "light" | "dark";
  /**
   * Colours: a built-in palette by name — `"claude"` (default: ivory and
   * warm charcoal, coral accent), `"violet"`, `"slate"` (neutral, blue
   * accent), `"forest"` — or a palette of your own (`{ light, dark }`
   * token values; tokens left out keep the default's).
   */
  palette?: keyof typeof CHAT_PALETTES | ChatPalette;
  /**
   * Token overrides on top of the palette, by name (`accent`, `font`) or
   * property (`--ra-accent`); `{ light, dark }` sets them per scheme.
   * A host stylesheet can do the same: `.ra-chat { --ra-accent: … }`.
   */
  vars?: ChatVars | { light?: ChatVars; dark?: ChatVars };
  /** Extra class names on the chat's root, for host CSS. */
  className?: string;
  /**
   * Debug mode: a Debug button in the header opens what the agent did —
   * the call chain (runs, turns, tool calls with arguments and results),
   * the requests sent to the model with their responses, the event log,
   * the context (system prompt, messages, limits) and the tools. Off by
   * default; `setDebug()` switches it while mounted.
   */
  debug?: boolean;
  /** Show the run's cost and tokens under the composer (default on). */
  showUsage?: boolean;
  /**
   * Files attached to a message (paperclip, drag and drop, paste; default
   * on): each is saved in the session's directory under `uploadsDir` and
   * named in the message, so the agent reads it with `read_file`; an
   * image is also sent to the model as a picture. Without a workspace,
   * text files go inline. `false` turns the feature off.
   */
  attachments?: boolean;
  /** Where attached files are saved in the directory (default `/uploads`). */
  uploadsDir?: string;
  /** A tool card's file path becomes a link that calls this. */
  onOpenFile?: (path: string) => void;
  /** Called with each session's agent as the chat opens it (the first one, a new chat, a resumed one). */
  onSession?: (agent: Agent) => void;
}

export interface ChatHandle {
  /** The current session's agent (set once `ready` resolves when the workspace is made per session). */
  readonly agent: Agent;
  /** Resolves once the first session is open and drawn. */
  readonly ready: Promise<void>;
  readonly element: HTMLElement;
  /** The inline dialogs; a host tool may use them too. */
  readonly ui: AgentUI;
  /** Sends a message as if typed (queued when the agent is busy). */
  prompt(text: string): Promise<RunResult>;
  setInput(text: string): void;
  /** Starts a fresh conversation (a new agent with the same options). */
  newSession(): Promise<Agent>;
  /** Continues a saved session of the workspace. */
  resume(id: string): Promise<Agent>;
  /** Deletes a saved session (and the directory made for it); the current one is replaced by a new chat. */
  deleteSession(id: string): Promise<void>;
  /** Re-reads the workspace's skills and templates for `/` completion (after installing a skill). */
  refresh(): Promise<void>;
  /** Shows or hides the Debug button and panel. */
  setDebug(on: boolean): void;
  /** Changes the look while mounted: light/dark, palette, token overrides (each left out stays). */
  setAppearance(opts: { theme?: "auto" | "light" | "dark"; palette?: keyof typeof CHAT_PALETTES | ChatPalette; vars?: ChatVars | { light?: ChatVars; dark?: ChatVars } }): void;
  /** Removes the chat; an agent the chat made is stopped (a host's `agent` is left running). */
  unmount(): void;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const STRINGS = {
  en: {
    assistant: "Assistant", placeholder: "Ask the agent to do something…  type / for commands", placeholderBusy: "↵ to steer the current task, {mod}↵ to queue for later",
    send: "Send", stop: "Stop", steer: "Steer", followUp: "Follow-up", steerTip: "Insert into the current task", followUpTip: "Queue after the current task",
    usageLine: "{cost} · {tokens} tokens · {calls} calls", emptyResult: "(empty)",
    queued: "Queued messages", clear: "Clear queue", thinking: "Thinking…", thought: "Thought process",
    enter: "to send", newline: "new line", hintIdle: "↵ {enter} · ⇧↵ {newline}", hintBusy: "↵ steer · {mod}↵ follow-up · ⇧↵ {newline}", empty: "Start a conversation", history: "History", newChat: "New chat", noSessions: "No saved conversations",
    compacted: "Context compacted", trimmed: "Earlier conversation trimmed to fit the context", allow: "Allow", decline: "Decline", cancel: "Cancel", submit: "Submit", ok: "OK",
    other: "Other…", typeAnswer: "Type your answer", args: "Arguments", result: "Result", error: "Error", declined: "declined", blocked: "blocked", skipped: "skipped",
    open: "Open in editor", stopped: "Stopped.", maxTurns: "Paused at the turn limit ({n})", retry: "Retry", messages: "messages", skill: "Skill", template: "Template",
    delete: "Delete", deleteAll: "Delete all", confirmDelete: "Delete this conversation and its files?", confirmDeleteAll: "Delete every saved conversation and their files?", untitled: "New conversation",
    attach: "Attach files", drop: "Drop files to attach", tooLarge: "is too large (max 20 MB)", remove: "Remove",
    toolsRunning: "Running", toolsDone: "Ran {n} tool calls", toolsDone1: "Ran 1 tool call", toolsFailed: "{n} failed",
    actRead: "read {n} file(s)", actList: "listed {n} folder(s)", actSearch: "searched {n} time(s)", actWrite: "wrote {n} file(s)", actEdit: "edited {n} file(s)", actDelete: "deleted {n} file(s)", actRun: "ran {n} snippet(s)", actAsk: "asked you {n} time(s)", actOther: "used {name}",
    ingRead: "Reading", ingList: "Listing", ingSearch: "Searching", ingWrite: "Writing", ingEdit: "Editing", ingDelete: "Deleting", ingRun: "Running code", ingAsk: "Asking you", ingOther: "Running", current: "Current", jumpEnd: "Jump to the latest",
    debug: "Debug", dCalls: "Calls", dRequests: "Requests", dEvents: "Events", dContext: "Context", dTools: "Tools", dClear: "Clear the record", dFilter: "Filter by type",
    dNoCalls: "No tool calls yet.", dNoRequests: "No model requests yet. Each call to the model is listed here with what was sent and what came back.", dNoEvents: "No events yet.",
    dSystem: "System prompt", dMessages: "Messages sent to the model", dPayload: "Request", dResponse: "Response", dRun: "Run", dTurn: "Turn {n}", sent: "sent", justNow: "Just now", minutesAgo: "{n} min ago", hoursAgo: "{n} h ago", context: "context", copy: "Copy", copied: "Copied", rewind: "Rewind to here", rewindTitle: "Rewind to this message",
    rewindMsg: "The conversation after it is dropped and the message goes back into the composer.", rewindFiles: "Also restore the directory's files to that moment", rewindGone: "This message is no longer in the conversation.", rewindSnapshot: "{n} files ({size}) as they were at {time}", rewindPartial: "Files over 2 MB were not in the snapshot and stay as they are.", rewindGoneFile: "{path} is no longer in the directory.",
    running: "running", waitingAnswer: "waiting for your answer", finished: "finished", bgLimit: "{n} conversations are already running in the background; stop one before switching away from this one.",
    settings: "Settings", sEffort: "Thinking", sEffortDefault: "Model default", sEffortNone: "this model does not expose a thinking level", sModel: "Model", sDefault: "Platform default", sMaxTurns: "Max turns per run", sMaxTokens: "Max output per reply", sAuto: "Model's maximum", sPerms: "Tool permissions", sAsk: "Ask before destructive tools", sAutoPerm: "Allow everything", sCustom: "Decided by the app",
    apply: "Apply", reset: "Reset to the app's defaults", applied: "Settings applied", continueRun: "Continue", maxTurnsHint: "Raise the limit in Settings, or continue from here.",
    files: "Files", downloadZip: "Download as zip", zipping: "Zipping", wrap: "Word wrap", preview: "Preview Markdown", edit: "Edit", tooBig: "Too large to edit here; download it.", conflict: "The file changed since you opened it. Overwrite it?", readOnly: "Read-only", autoSaved: "Unsaved edits saved", upload: "Upload", newFile: "New file", refresh: "Refresh", close: "Close", save: "Save", download: "Download", confirmDeleteFile: "Delete {path}?", newFilePath: "Path of the new file",
    noPreview: "No preview for this file; download it.", changedByAgent: "changed by the agent", noFiles: "The directory is empty.", discard: "Discard unsaved changes?", saved: "Saved",
    worked: "Worked for {t}", workedNoTime: "Work", sec: "{s}s", minSec: "{m}m {s}s", hourMin: "{h}h {m}m",
    command: "Command", user: "User", compacting: "Compacting the context…", nothingToCompact: "Nothing to compact yet", busyCmd: "Wait for the current task to finish, or stop it, first", copiedReply: "Copied the last reply", nothingToCopy: "No reply to copy yet", nothingToContinue: "Nothing to continue",
    unknownModel: "No model named \"{name}\"", modelSet: "Model: {name}", effortSet: "Thinking: {name}", effortLevels: "Thinking levels of {model}: {levels}", unknownEffort: "\"{name}\" is not a thinking level of {model} ({levels})", debugOff: "Debug mode is off",
    cmdsTitle: "Commands", cmdsMore: "Templates (/name) and skills (/skill:name) are listed as you type.", autoCompact: "Auto-compaction", autoCompactAt: "when less than {n} tokens are left", directory: "Directory", messagesLabel: "Messages",
    cmdArgs: { compact: "[focus]", model: "[name]", effort: "[level]" },
    cmd: { help: "Show these commands", new: "Start a new conversation", resume: "Open a saved conversation", compact: "Summarise older turns now; add what the summary must keep", continue: "Continue the last run", model: "Switch model; no name opens the settings", effort: "Set the thinking level", context: "Context use, model and spending", copy: "Copy the last reply", export: "Download the conversation as Markdown", files: "Open the file manager", settings: "Open the settings", debug: "Show or hide the debug panel" },
  },
  zh: {
    assistant: "助手", placeholder: "让 agent 做点什么…  输入 / 查看命令", placeholderBusy: "↵ 插入当前任务，{mod}↵ 排队到之后",
    send: "发送", stop: "停止", steer: "插入", followUp: "排队", steerTip: "插入到当前任务，下一步就会看到", followUpTip: "排到当前任务结束之后",
    usageLine: "{cost} · {tokens} tokens · {calls} 次调用", emptyResult: "（空）",
    queued: "排队中的消息", clear: "清空队列", thinking: "思考中…", thought: "思考过程",
    enter: "发送", newline: "换行", hintIdle: "↵ {enter} · ⇧↵ {newline}", hintBusy: "↵ 插入 · {mod}↵ 排队 · ⇧↵ {newline}", empty: "开始对话", history: "历史", newChat: "新对话", noSessions: "还没有保存的对话",
    compacted: "上下文已压缩", trimmed: "较早的对话已裁剪以适应上下文", allow: "允许", decline: "拒绝", cancel: "取消", submit: "提交", ok: "确定",
    other: "其他…", typeAnswer: "请输入", args: "参数", result: "结果", error: "错误", declined: "已拒绝", blocked: "已拦截", skipped: "已跳过",
    open: "在编辑器中打开", stopped: "已停止。", maxTurns: "已达最大轮数 {n}，暂停", retry: "重试", messages: "条消息", skill: "Skill", template: "模板",
    delete: "删除", deleteAll: "全部删除", confirmDelete: "删除这个对话和它的文件？", confirmDeleteAll: "删除所有已保存的对话和它们的文件？", untitled: "新对话",
    attach: "添加附件", drop: "松开即可添加附件", tooLarge: "太大了（最大 20 MB）", remove: "移除",
    toolsRunning: "正在执行", toolsDone: "执行了 {n} 个工具调用", toolsDone1: "执行了 1 个工具调用", toolsFailed: "{n} 个失败",
    actRead: "读取了 {n} 个文件", actList: "查看了 {n} 个目录", actSearch: "搜索了 {n} 次", actWrite: "写入了 {n} 个文件", actEdit: "修改了 {n} 个文件", actDelete: "删除了 {n} 个文件", actRun: "运行了 {n} 段代码", actAsk: "询问了你 {n} 次", actOther: "调用了 {name}",
    ingRead: "正在读取", ingList: "正在查看", ingSearch: "正在搜索", ingWrite: "正在写入", ingEdit: "正在修改", ingDelete: "正在删除", ingRun: "正在运行代码", ingAsk: "正在询问你", ingOther: "正在执行", current: "当前", jumpEnd: "回到最新",
    debug: "调试", dCalls: "调用", dRequests: "请求", dEvents: "事件", dContext: "上下文", dTools: "工具", dClear: "清空记录", dFilter: "按类型过滤",
    dNoCalls: "还没有工具调用。", dNoRequests: "还没有模型请求。每次调用模型都会记在这里，包括发了什么、收到什么。", dNoEvents: "还没有事件。",
    dSystem: "系统提示词", dMessages: "发给模型的消息", dPayload: "请求内容", dResponse: "响应", dRun: "运行", dTurn: "第 {n} 轮", sent: "已发送", justNow: "刚刚", minutesAgo: "{n} 分钟前", hoursAgo: "{n} 小时前", context: "上下文", copy: "复制", copied: "已复制", rewind: "回退到这里", rewindTitle: "回退到这条消息",
    rewindMsg: "它之后的对话会被删除，消息内容放回输入框。", rewindFiles: "同时把目录里的文件恢复到那一刻", rewindGone: "这条消息已不在对话里（可能已被压缩）。", rewindSnapshot: "{time} 时的 {n} 个文件（{size}）", rewindPartial: "超过 2 MB 的文件没进快照，会保持原样。", rewindGoneFile: "{path} 已不在目录里。",
    running: "运行中", waitingAnswer: "等待你回答", finished: "已完成", bgLimit: "后台已有 {n} 个会话在运行，先停掉一个再切换。",
    settings: "设置", sEffort: "思考强度", sEffortDefault: "模型默认", sEffortNone: "这个模型没有思考强度可调", sModel: "模型", sDefault: "平台默认", sMaxTurns: "每次运行最大轮数", sMaxTokens: "单次回复最大输出", sAuto: "模型上限", sPerms: "工具权限", sAsk: "破坏性操作先询问", sAutoPerm: "全部自动允许", sCustom: "由应用决定",
    apply: "应用", reset: "恢复应用默认", applied: "设置已应用", continueRun: "继续", maxTurnsHint: "可在设置里调高上限，或点继续从这里接着跑",
    files: "文件", downloadZip: "打包下载 (zip)", zipping: "正在打包", wrap: "自动换行", preview: "预览 Markdown", edit: "编辑", tooBig: "文件太大，无法在这里编辑，可以下载。", conflict: "文件在你打开后被改过，要覆盖吗？", readOnly: "只读", autoSaved: "未保存的修改已自动保存", upload: "上传", newFile: "新建文件", refresh: "刷新", close: "关闭", save: "保存", download: "下载", confirmDeleteFile: "删除 {path}？", newFilePath: "新文件的路径",
    noPreview: "这个文件无法预览，可以下载。", changedByAgent: "agent 改过", noFiles: "目录是空的。", discard: "放弃未保存的修改？", saved: "已保存",
    worked: "已工作 {t}", workedNoTime: "工作过程", sec: "{s}秒", minSec: "{m}分{s}秒", hourMin: "{h}小时{m}分",
    command: "命令", user: "用户", compacting: "正在压缩上下文…", nothingToCompact: "暂时没有可压缩的内容", busyCmd: "请等当前任务结束（或先停止）", copiedReply: "已复制最后一条回复", nothingToCopy: "还没有可复制的回复", nothingToContinue: "没有可继续的内容",
    unknownModel: "没有名为“{name}”的模型", modelSet: "模型：{name}", effortSet: "思考强度：{name}", effortLevels: "{model} 的思考强度：{levels}", unknownEffort: "“{name}”不是 {model} 的思考强度（{levels}）", debugOff: "调试模式未开启",
    cmdsTitle: "命令", cmdsMore: "模板（/名称）和 Skill（/skill:名称）在输入时列出。", autoCompact: "自动压缩", autoCompactAt: "剩余不足 {n} tokens 时", directory: "目录", messagesLabel: "消息",
    cmdArgs: { compact: "[重点]", model: "[名称]", effort: "[档位]" },
    cmd: { help: "显示这些命令", new: "开始新对话", resume: "打开保存的对话", compact: "立即压缩较早的对话，可附上要保留的重点", continue: "继续上一次运行", model: "切换模型，不带名称则打开设置", effort: "设置思考强度", context: "上下文占用、模型和花费", copy: "复制最后一条回复", export: "把对话下载为 Markdown", files: "打开文件管理", settings: "打开设置", debug: "显示或隐藏调试面板" },
  },
};
type Strings = typeof STRINGS.en;

function pickLocale(opt?: "zh" | "en"): "zh" | "en" {
  if (opt) return opt;
  const lang = (typeof document !== "undefined" && document.documentElement.lang) || (typeof navigator !== "undefined" ? navigator.language : "") || "";
  return /^zh/i.test(lang) ? "zh" : "en";
}

/* ------------------------------------------------------------------ */
/* Styles — every colour and font is a --ra-* variable (chat-theme.ts)  */
/* ------------------------------------------------------------------ */

const STYLE_ID = "runapps-agent-chat-style";
const CSS = tokenCSS() + `
.ra-chat{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--ra-bg);color:var(--ra-fg);font:14px/1.5 var(--ra-font);position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.ra-chat *,.ra-chat *::before,.ra-chat *::after{box-sizing:border-box}
.ra-chat button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0;margin:0;line-height:inherit}
.ra-chat button:disabled{opacity:.5;cursor:default}
.ra-chat textarea,.ra-chat input[type=text]{font:inherit;color:inherit;background:transparent;border:0;outline:0;width:100%;margin:0}
.ra-chat svg{flex-shrink:0}
.ra-col{max-width:820px;margin:0 auto;padding:0 20px;width:100%}
.ra-chat .ra-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:500;border:1px solid var(--ra-border);background:var(--ra-bg);white-space:nowrap}
.ra-chat .ra-btn:hover{background:var(--ra-muted)}
.ra-chat .ra-btn.xs{height:24px;padding:0 8px;font-size:12px}
.ra-chat .ra-btn.ghost{border-color:transparent;background:transparent}
.ra-chat .ra-btn.ghost:hover{background:var(--ra-muted)}
.ra-chat .ra-btn.subtle{border-color:transparent;background:var(--ra-accent-subtle);color:var(--ra-accent-fg)}
.ra-chat .ra-btn.subtle:hover{background:var(--ra-accent-muted)}
.ra-chat .ra-btn.solid{border-color:var(--ra-accent);background:var(--ra-accent);color:#fff}
.ra-chat .ra-btn.solid:hover{filter:brightness(1.08)}
.ra-chat .ra-btn.red{border-color:#dc2626;background:#dc2626;color:#fff}
.ra-chat .ra-btn.red:hover{filter:brightness(1.08)}
.ra-chat .ra-btn.red-subtle{border-color:transparent;background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-head{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--ra-border);flex-shrink:0;min-height:44px}
.ra-head .ra-title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-badge{display:inline-flex;align-items:center;font-size:11px;font-weight:500;color:var(--ra-fg-muted);border:1px solid var(--ra-border);border-radius:4px;padding:0 6px;line-height:18px;white-space:nowrap}
.ra-badge.p{background:var(--ra-accent-subtle);color:var(--ra-accent-fg);border-color:transparent}
.ra-head .ra-sp{flex:1}
.ra-menu{position:absolute;right:12px;top:42px;z-index:6;width:min(360px,calc(100% - 24px));max-height:60%;overflow:auto;background:var(--ra-panel);border:1px solid var(--ra-border);border-radius:8px;box-shadow:var(--ra-shadow-md);padding:4px}
.ra-menu .ra-mi{display:flex;align-items:center;gap:6px;border-radius:6px}
.ra-menu .ra-mi:hover{background:var(--ra-muted)}
.ra-menu .ra-mi.ra-cur{background:var(--ra-muted);box-shadow:inset 3px 0 0 var(--ra-accent)}
.ra-menu .ra-mi>button:first-child>span.ra-mt{display:flex;align-items:center;gap:6px;min-width:0;overflow:visible}
.ra-menu .ra-mi .ra-mtt{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ra-menu .ra-mi .ra-mt .ra-spin{flex:none}
.ra-menu .ra-mi .ra-now{flex:none;display:inline-block;font-size:10.5px;font-weight:600;line-height:16px;padding:0 6px;border-radius:999px;background:var(--ra-accent-subtle);color:var(--ra-accent-fg);vertical-align:1px}
.ra-menu .ra-mi>button:first-child{flex:1;min-width:0;text-align:left;padding:6px 8px;font-size:13px}
.ra-menu .ra-mi>button:first-child>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-menu .ra-mi small{display:block;color:var(--ra-fg-muted);font-size:11px}
.ra-menu .ra-mi .ra-x{width:24px;height:24px;margin-right:4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted);opacity:0}
.ra-menu .ra-mi:hover .ra-x{opacity:1}
.ra-menu .ra-x:hover{background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-menu .ra-none{padding:8px 10px;color:var(--ra-fg-muted);font-size:13px}
.ra-set{padding:10px 12px;display:flex;flex-direction:column;gap:10px;width:min(360px,calc(100% - 24px))}
.ra-set label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--ra-fg-muted)}
.ra-set select,.ra-set input[type=number]{font:inherit;font-size:13px;color:var(--ra-fg);background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:6px;padding:5px 8px;outline:0;width:100%;margin:0}
.ra-set select:focus,.ra-set input:focus{border-color:var(--ra-accent)}
.ra-set .ra-row{display:flex;gap:8px;align-items:center}
.ra-set .ra-row>*{flex:1;min-width:0}
.ra-set .ra-lim{font-size:11px;color:var(--ra-fg-muted);margin-top:-4px}
.ra-set .ra-btns{justify-content:space-between}
.ra-card .ra-btn{margin-top:8px}
.ra-menu .ra-mi .ra-spin{margin-right:6px}
.ra-chat .ra-btn.ra-bg{position:relative}
.ra-chat .ra-btn.ra-bg::after{content:"";position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;background:var(--ra-accent)}
.ra-menu .ra-mf{border-top:1px solid var(--ra-border);margin-top:4px;padding-top:4px;display:flex;justify-content:flex-end}
.ra-main{flex:1;min-height:0;display:flex;position:relative;overflow:hidden}
.ra-chat{container-type:inline-size}
.ra-chatcol{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}
.ra-fp{position:absolute;top:0;right:0;bottom:0;width:380px;max-width:100%;z-index:4;border-left:1px solid var(--ra-border);background:var(--ra-subtle);display:flex;flex-direction:column;box-shadow:-8px 0 24px rgba(0,0,0,.08)}
.ra-chat.ra-files-open .ra-ed{right:380px}
@container (max-width:760px){.ra-fp{left:0;width:auto;border-left:0;box-shadow:none}.ra-chat.ra-files-open .ra-ed{right:0}.ra-chat.ra-editing .ra-fp{display:none}}
@container (max-width:560px){.ra-head .ra-btn span{display:none}.ra-head .ra-btn{padding:0 7px}.ra-head{padding:8px 10px}.ra-badge{display:none}.ra-col{padding:0 12px}}
@container (min-width:761px){.ra-dp{width:460px}}
/* Selected (its panel is open) reads differently from hover, so a button just clicked shut does not look still on. */
.ra-chat .ra-btn.on,.ra-chat .ra-btn.on:hover{background:var(--ra-accent-subtle);color:var(--ra-accent-fg)}
.ra-chat button:focus{outline:none}
.ra-chat button:focus-visible{outline:2px solid var(--ra-accent-muted);outline-offset:1px}
.ra-dtabs{display:flex;gap:2px;min-width:0;overflow-x:auto}
.ra-chat .ra-dtab{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:6px;font-size:12.5px;color:var(--ra-fg-muted);white-space:nowrap}
.ra-chat .ra-dtab:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-chat .ra-dtab.on{background:var(--ra-muted);color:var(--ra-fg);font-weight:600}
.ra-dcount{font-size:10.5px;font-weight:600;line-height:15px;padding:0 5px;border-radius:999px;background:var(--ra-accent-subtle);color:var(--ra-accent-fg)}
.ra-dbody{flex:1;min-height:0;overflow:auto;padding:8px 10px 14px;display:flex;flex-direction:column;gap:4px;font-size:13px}
.ra-dfold{border:1px solid var(--ra-border);border-radius:6px;background:var(--ra-bg)}
.ra-dfold>summary{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;list-style:none;min-width:0}
.ra-dfold>summary::-webkit-details-marker{display:none}
.ra-dfold>summary:hover{background:var(--ra-muted)}
.ra-dfold>summary .ra-chev{display:inline-flex;color:var(--ra-fg-muted);transition:transform .15s;flex:none}
.ra-dfold[open]>summary .ra-chev{transform:rotate(90deg)}
.ra-dfold>summary>.ra-dmuted:last-child{margin-left:auto;flex:none}
.ra-dfb{border-top:1px solid var(--ra-border);padding:6px 8px 8px;display:flex;flex-direction:column;gap:4px}
.ra-dpre{margin:0;max-height:220px;overflow:auto;background:var(--ra-muted);border-radius:4px;padding:6px 8px;font:11.5px/1.5 var(--ra-mono);white-space:pre-wrap;word-break:break-word}
.ra-dpre.tall{max-height:380px}
.ra-dlabel{font-size:11.5px;color:var(--ra-fg-muted);margin-top:4px}
.ra-dmuted{color:var(--ra-fg-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ra-dmono{font:600 12.5px var(--ra-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ra-dst{display:inline-flex;flex:none;font-size:12px}
.ra-dst.ok{color:var(--ra-ok)}.ra-dst.fail{color:var(--ra-red)}
.ra-drun{display:flex;flex-direction:column;gap:4px;padding:6px 0 10px;border-bottom:1px dashed var(--ra-border)}
.ra-drh{font-size:11.5px;font-weight:600;color:var(--ra-fg-muted);text-transform:uppercase;letter-spacing:.04em}
.ra-dturn{display:flex;align-items:center;gap:2px;min-width:0;padding:2px 0 0 2px}
.ra-dbadge{flex:none;font-size:10.5px;font-weight:600;line-height:16px;padding:0 6px;border-radius:4px;background:var(--ra-muted);color:var(--ra-fg-muted)}
.ra-dbadge.ok{background:color-mix(in srgb,var(--ra-ok) 15%,transparent);color:var(--ra-ok)}
.ra-dbadge.fail{background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-dbar{display:flex;gap:6px;align-items:center;margin-bottom:4px}
.ra-dbar .ra-field{flex:1;border:1px solid var(--ra-border);border-radius:6px;padding:4px 8px;background:var(--ra-bg);font-size:12.5px}
.ra-dkv{display:grid;grid-template-columns:76px 1fr;gap:3px 8px;align-items:baseline}
.ra-dkv .ra-dmono{font-weight:500;white-space:normal;word-break:break-all}
.ra-ddesc{font-size:12.5px;color:var(--ra-fg);white-space:pre-wrap}
.ra-fph{display:flex;align-items:center;gap:2px;height:40px;padding:0 8px 0 12px;border-bottom:1px solid var(--ra-border);flex-shrink:0}
.ra-fph .ra-fpt{font-size:12px;font-weight:600;color:var(--ra-fg-muted);text-transform:uppercase;letter-spacing:.04em}
.ra-fph .ra-sp{flex:1}
.ra-chat .ra-ib{width:26px;height:26px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted)}
.ra-chat .ra-ib:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-tree{flex:1;min-height:0;overflow:auto;padding:4px}
.ra-fr{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;cursor:pointer;font-size:13px;min-height:26px}
.ra-fr:hover{background:var(--ra-panel)}
.ra-fr.ra-cur{background:var(--ra-accent-subtle)}
.ra-fr .ra-frc{width:12px;display:inline-flex;color:var(--ra-fg-muted);flex-shrink:0}
.ra-fr .ra-fri{display:inline-flex;color:var(--ra-fg-muted);flex-shrink:0}
.ra-fr .ra-frn{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-dot{width:6px;height:6px;border-radius:50%;background:#f97316;flex-shrink:0}
.ra-fr .ra-fra{display:none;gap:0;flex-shrink:0}
.ra-fr:hover .ra-fra{display:inline-flex}
.ra-fr .ra-fra .ra-ib{width:22px;height:22px}
.ra-fpe{padding:8px 10px;font-size:12px;color:var(--ra-fg-muted)}
.ra-ed{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;background:var(--ra-bg)}
.ra-edh{display:flex;align-items:center;gap:6px;height:40px;padding:0 8px 0 16px;border-bottom:1px solid var(--ra-border);flex-shrink:0;background:var(--ra-subtle)}
.ra-edh .ra-edp{flex:1;min-width:0;font:12px var(--ra-mono);color:var(--ra-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-edh .ra-eda{display:inline-flex;align-items:center;gap:2px}
.ra-edb{flex:1;min-height:0;display:flex;flex-direction:column}
.ra-edta{flex:1;min-height:0;resize:none;padding:14px 20px;font:13.5px/1.6 var(--ra-mono);tab-size:2;white-space:pre;overflow:auto}
.ra-edta.ra-wrap{white-space:pre-wrap;word-break:break-word}
.ra-edmd{flex:1;min-height:0;overflow:auto;padding:16px 24px;max-width:860px}
.ra-chat .ra-ib.on{background:var(--ra-accent-subtle);color:var(--ra-accent-fg)}
.ra-edpv{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px}
.ra-edpv img{max-width:100%;max-height:100%;border-radius:4px}
.ra-edpv:has(.ra-edpdf){padding:0}
.ra-edpdf{width:100%;height:100%;border:0;background:var(--ra-bg)}
.ra-fpdrop{position:absolute;inset:0;z-index:5;display:none;align-items:center;justify-content:center;background:color-mix(in srgb,var(--ra-accent) 8%,transparent);border:2px dashed var(--ra-accent);color:var(--ra-accent-fg);font-weight:600;pointer-events:none}
.ra-fp[data-drop="1"] .ra-fpdrop{display:flex}
.ra-md .ra-path{display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:var(--ra-link);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--ra-link) 45%,transparent);text-underline-offset:3px}
.ra-md .ra-path:hover{text-decoration-color:var(--ra-link)}
.ra-md .ra-path:hover{background:var(--ra-accent-muted)}
.ra-tool .ra-tacts{display:flex;gap:10px}
.ra-log{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.ra-jumpwrap{position:relative;height:0;flex-shrink:0;z-index:2}
.ra-chat .ra-jump{position:absolute;left:50%;bottom:10px;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,var(--ra-panel) 82%,transparent);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid var(--ra-border);color:var(--ra-fg-muted);box-shadow:var(--ra-shadow);
  opacity:0;transform:translate(-50%,6px);pointer-events:none;transition:opacity .18s,transform .18s,color .15s,border-color .15s}
.ra-chat .ra-jump.show{opacity:.7;transform:translate(-50%,0);pointer-events:auto}
.ra-chat .ra-jump:hover,.ra-chat .ra-jump:focus-visible{opacity:1;color:var(--ra-fg);border-color:var(--ra-accent-muted)}
.ra-log .ra-col{padding-top:6px;padding-bottom:6px}
.ra-row{padding:10px 0}
.ra-empty{padding:48px 0 24px;text-align:center;color:var(--ra-fg-muted)}
.ra-sugs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:16px}
.ra-sugs button{border:1px solid var(--ra-border);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--ra-fg)}
.ra-sugs button:hover{background:var(--ra-muted)}
.ra-user{display:flex;justify-content:flex-end}
.ra-user .ra-bubble{max-width:85%;background:var(--ra-user-bg);border-radius:16px;padding:8px 14px;white-space:pre-wrap;word-break:break-word;font-size:14px}
.ra-user img{display:block;max-width:240px;border-radius:4px;margin-top:6px}
.ra-user{flex-direction:column;align-items:flex-end}
.ra-uf{display:flex;align-items:center;gap:2px;font-size:12px;color:var(--ra-fg-muted);margin-top:4px;height:22px;padding-right:2px;opacity:0;transition:opacity .15s}
.ra-user:hover .ra-uf,.ra-uf:focus-within{opacity:1}
.ra-uf .ra-ut{display:inline-flex;align-items:center;gap:5px;margin-right:4px}
.ra-uf .ra-ut::after{content:"·";margin-left:4px}
.ra-uf .ra-ib{width:22px;height:22px}
.ra-modal label.ra-ck{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}
.ra-modal label.ra-ck input{width:auto;accent-color:var(--ra-accent)}
.ra-modal .ra-dn{font-size:12px;color:var(--ra-fg-muted);margin:-4px 0 0 24px}
.ra-asst{min-width:0}
.ra-body{min-width:0;display:flex;flex-direction:column;gap:8px}
.ra-work{border-bottom:1px solid var(--ra-border);padding-bottom:6px;margin-bottom:4px}
.ra-work>summary{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--ra-fg-muted);cursor:pointer;list-style:none;user-select:none;padding:2px 0}
.ra-work>summary::-webkit-details-marker{display:none}
.ra-work>summary:hover{color:var(--ra-fg)}
.ra-work>summary .ra-chev{display:inline-flex;transition:transform .15s}
.ra-work[open]>summary .ra-chev{transform:rotate(90deg)}
.ra-work .ra-wb{display:flex;flex-direction:column;gap:8px;margin:8px 0 4px}
.ra-md{font-size:14px;line-height:1.65;word-break:break-word;overflow-wrap:anywhere}
.ra-md>:first-child{margin-top:0}.ra-md>:last-child{margin-bottom:0}
.ra-md p{margin:.5em 0}.ra-md h1,.ra-md h2,.ra-md h3,.ra-md h4{margin:1em 0 .4em;line-height:1.3;font-weight:650}.ra-md h1{font-size:1.35em}.ra-md h2{font-size:1.2em}.ra-md h3{font-size:1.05em}
.ra-md strong{font-weight:650}
.ra-md ul,.ra-md ol{margin:.4em 0;padding-left:1.4em}.ra-md li{margin:.15em 0}
.ra-md code{font:.88em/1.5 var(--ra-mono);background:var(--ra-muted);padding:.1em .35em;border-radius:4px}
.ra-md .ra-cb{margin:.7em 0;border:1px solid var(--ra-border);border-radius:6px;overflow:hidden}
.ra-md .ra-cbh{display:flex;align-items:center;justify-content:space-between;padding:4px 10px;border-bottom:1px solid var(--ra-border);background:var(--ra-muted);color:var(--ra-fg-muted);font:12px var(--ra-mono)}
.ra-md .ra-cbh button{display:inline-flex;padding:3px;border-radius:4px;color:inherit}
.ra-md .ra-cbh button:hover{background:var(--ra-panel)}
.ra-md pre{margin:0;padding:10px 12px;overflow:auto;font:12.5px/1.55 var(--ra-mono)}
.ra-md pre code{background:none;padding:0;font:inherit}
.ra-md blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid var(--ra-accent);color:var(--ra-fg-muted)}
.ra-md .ra-tw{margin:.7em 0;overflow:auto;border:1px solid var(--ra-border);border-radius:6px}
.ra-md table{border-collapse:collapse;width:100%;font-size:.95em}
.ra-md th,.ra-md td{padding:6px 10px;border-bottom:1px solid var(--ra-border);text-align:left}.ra-md thead{background:var(--ra-muted)}.ra-md th{font-weight:600}.ra-md tr:last-child td{border-bottom:0}
.ra-md hr{border:0;border-top:1px solid var(--ra-border);margin:1em 0}
.ra-md a{color:var(--ra-link);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--ra-link) 45%,transparent);text-underline-offset:3px}
.ra-md a:hover{text-decoration-color:var(--ra-link)}
.ra-md img{max-width:100%;border-radius:4px}
.ra-cursor>:last-child::after{content:"";display:inline-block;width:7px;height:14px;background:var(--ra-fg-muted);margin-left:2px;vertical-align:-2px;animation:ra-blink 1s steps(2) infinite;border-radius:1px}
@keyframes ra-blink{50%{opacity:0}}
.ra-think summary{cursor:pointer;color:var(--ra-fg-muted);font-size:12px;list-style:none;display:inline-flex;align-items:center;gap:6px;user-select:none;padding:2px 0}
.ra-think summary::-webkit-details-marker{display:none}
.ra-think summary .ra-chev{transition:transform .15s}
.ra-think[open] summary .ra-chev{transform:rotate(90deg)}
.ra-think .ra-think-body{font-size:12px;color:var(--ra-fg-muted);white-space:pre-wrap;border-left:2px solid var(--ra-border);padding-left:12px;margin:4px 0 0 4px;max-height:280px;overflow:auto}
.ra-tg>summary{display:inline-flex;align-items:center;gap:6px;max-width:100%;font-size:13px;color:var(--ra-fg-muted);cursor:pointer;list-style:none;user-select:none;padding:2px 0}
.ra-tg>summary::-webkit-details-marker{display:none}
.ra-tg>summary:hover{color:var(--ra-fg)}
.ra-tg>summary .ra-tgt{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-tg>summary .ra-tgt code{font:12px var(--ra-mono);background:none;padding:0;color:inherit}
.ra-tg>summary .ra-tgf{color:var(--ra-red);flex-shrink:0}
.ra-tg>summary .ra-chev{display:inline-flex;transition:transform .15s;flex-shrink:0}
.ra-tg[open]>summary .ra-chev{transform:rotate(90deg)}
.ra-tg .ra-tgb{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.ra-tool{border:1px solid var(--ra-border);border-radius:6px;overflow:hidden;font-size:14px}
.ra-tool.fail{border-color:var(--ra-red)}
.ra-tool>summary{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none;user-select:none}
.ra-tool>summary::-webkit-details-marker{display:none}
.ra-tool>summary:hover{background:var(--ra-muted)}
.ra-tool>summary .ra-chev{color:var(--ra-fg-muted);transition:transform .15s}
.ra-tool[open]>summary .ra-chev{transform:rotate(90deg)}
.ra-tool .ra-ticon{width:20px;height:20px;border-radius:4px;background:var(--ra-accent-subtle);color:var(--ra-accent-fg);display:inline-flex;align-items:center;justify-content:center}
.ra-tool.fail .ra-ticon{background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-tool .ra-tname{font-weight:600;white-space:nowrap}
.ra-tool .ra-tsum{flex:1;min-width:0;color:var(--ra-fg-muted);font:13px var(--ra-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-tool .ra-tend{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:var(--ra-fg-muted);white-space:nowrap}
.ra-tool .ra-tend .ok{color:var(--ra-ok);display:inline-flex}.ra-tool .ra-tend .fail{color:var(--ra-red);display:inline-flex}
.ra-spin{width:12px;height:12px;border:2px solid var(--ra-border);border-top-color:var(--ra-accent);border-radius:50%;animation:ra-spin .8s linear infinite;flex-shrink:0}
@keyframes ra-spin{to{transform:rotate(360deg)}}
.ra-tool .ra-tbody{border-top:1px solid var(--ra-border);padding:4px 10px 10px;display:flex;flex-direction:column;gap:8px}
.ra-tool .ra-tlabel{font-size:12px;color:var(--ra-fg-muted);margin:4px 0}
.ra-tool pre{margin:0;background:var(--ra-muted);border-radius:4px;padding:8px;max-height:280px;overflow:auto;font:12px/1.5 var(--ra-mono);white-space:pre-wrap;word-break:break-word}
.ra-tool .ra-tupd{font-size:12px;color:var(--ra-fg-muted);padding:0 10px 8px;white-space:pre-wrap}
.ra-tool .ra-open{font-size:12px;color:var(--ra-accent-fg);align-self:flex-start;text-decoration:underline;text-underline-offset:2px}
.ra-card{border:1px solid var(--ra-border);background:var(--ra-muted);border-radius:6px;padding:12px}
.ra-card .ra-ct{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;margin-bottom:6px}
.ra-card .ra-ct.only{margin-bottom:0;font-weight:500;color:var(--ra-fg-muted)}
.ra-card .ra-md{font-size:13px}
.ra-err{border:1px solid var(--ra-red);background:var(--ra-red-subtle);border-radius:6px;padding:8px;font-size:14px;color:var(--ra-red);white-space:pre-wrap;word-break:break-word}
.ra-err .ra-btn{margin-top:6px}
.ra-ask{flex-shrink:0;max-height:45%;overflow-y:auto}
.ra-ask .ra-col{display:flex;flex-direction:column;gap:8px;padding-top:8px;padding-bottom:8px}
.ra-q{border:1px solid var(--ra-accent-muted);border-radius:8px;padding:12px;background:var(--ra-subtle);display:flex;flex-direction:column;gap:10px}
.ra-q .ra-qt{font-weight:600;font-size:14px}
.ra-q .ra-qm{font-size:14px;white-space:pre-wrap}
.ra-q .ra-opts{display:flex;flex-direction:column;gap:4px}
.ra-q .ra-opt{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--ra-border);border-radius:6px;padding:6px 12px;text-align:left;width:100%;background:var(--ra-bg);font-size:14px;min-height:32px}
.ra-q .ra-opt:hover{background:var(--ra-muted)}
.ra-q .ra-opt input[type=radio],.ra-q .ra-opt input[type=checkbox]{width:auto;flex:none;margin:4px 0 0;accent-color:var(--ra-accent)}
.ra-q .ra-opt>div,.ra-q .ra-opt>span{flex:1;min-width:0}
.ra-q .ra-opt small{display:block;color:var(--ra-fg-muted);font-size:12px}
.ra-q .ra-field{border:1px solid var(--ra-border);border-radius:6px;padding:6px 10px;background:var(--ra-bg);width:100%;font-size:14px}
.ra-q .ra-field:focus{border-color:var(--ra-accent)}
.ra-q textarea.ra-field{min-height:96px;max-height:200px;resize:vertical}
.ra-btns{display:flex;justify-content:flex-end;gap:8px}
.ra-status{font-size:14px;color:var(--ra-fg-muted);padding:4px 0}
.ra-comp{flex-shrink:0;border-top:1px solid var(--ra-border);padding:8px 0 14px}
.ra-alert{font-size:14px;color:var(--ra-red);margin-bottom:8px;white-space:pre-wrap}
.ra-queue{border:1px solid var(--ra-border);border-radius:6px;padding:8px;margin-bottom:8px;font-size:12px}
.ra-queue .ra-qh{display:flex;justify-content:space-between;align-items:center;color:var(--ra-fg-muted);margin-bottom:4px}
.ra-queue .ra-qh button{width:20px;height:20px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center}
.ra-queue .ra-qh button:hover{background:var(--ra-muted)}
.ra-queue .ra-qi{display:flex;gap:6px;align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0}
.ra-queue .ra-qi span{overflow:hidden;text-overflow:ellipsis}
.ra-queue .ra-qi>span:nth-child(2){flex:1;min-width:0}
.ra-queue .ra-qi button{width:18px;height:18px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted);flex-shrink:0}
.ra-queue .ra-qi button:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-box{position:relative;border:1px solid var(--ra-border);border-radius:12px;padding:8px 10px 6px;background:var(--ra-panel);box-shadow:var(--ra-shadow)}
.ra-box:focus-within{border-color:color-mix(in srgb,var(--ra-fg) 28%,transparent)}
.ra-box textarea{resize:none;height:64px;overflow-y:auto;padding:2px 4px;line-height:1.5;display:block}
.ra-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;min-height:32px}
.ra-bar .ra-hint{font-size:12px;color:var(--ra-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.01em}
.ra-kbd{display:inline-block;font:11px/1.4 var(--ra-mono);border:1px solid var(--ra-border);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--ra-muted);color:var(--ra-fg)}
.ra-bar .ra-acts{display:flex;gap:6px;align-items:center}
.ra-chat .ra-send{width:32px;height:32px;border-radius:50%;background:var(--ra-accent);color:#fff;display:inline-flex;align-items:center;justify-content:center}
.ra-chat .ra-send:hover{filter:brightness(1.08)}
.ra-cmds{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:5;background:var(--ra-panel);border:1px solid var(--ra-border);border-radius:6px;box-shadow:var(--ra-shadow-md);padding:4px;max-height:260px;overflow:auto}
.ra-cmds button{display:flex;gap:8px;align-items:center;width:100%;text-align:left;padding:6px 8px;border-radius:4px;font-size:13px}
.ra-cmds button:hover,.ra-cmds button.ra-cur{background:var(--ra-muted)}
.ra-cmds .ra-cn{font:600 14px var(--ra-mono)}
.ra-cmds .ra-ca{font:12px var(--ra-mono);color:var(--ra-fg-muted);margin-left:-4px}
.ra-cmds .ra-cd{font-size:12px;color:var(--ra-fg-muted);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-chat .ra-attach{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted);margin-right:4px}
.ra-chat .ra-attach:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-bar .ra-left{display:flex;align-items:center;min-width:0}
.ra-files{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 6px}
.ra-chip{display:inline-flex;align-items:center;gap:10px;max-width:min(100%,340px);height:44px;border:1px solid var(--ra-border);border-radius:12px;padding:0 12px 0 10px;font-size:14px;background:var(--ra-panel);white-space:nowrap}
.ra-chip img{width:30px;height:30px;object-fit:cover;border-radius:6px;flex:none}
.ra-chip .ra-ext{flex:none;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em;color:var(--ra-fg-muted);border:1px solid var(--ra-border);border-radius:7px;padding:5px 6px;text-transform:uppercase;min-width:34px;text-align:center}
.ra-chip .ra-cn{display:inline-flex;min-width:0;flex:0 1 auto;color:var(--ra-fg)}
.ra-chip .ra-cn .st{min-width:0;overflow:hidden;text-overflow:ellipsis}
.ra-chip .ra-cn .ex{flex:none}
.ra-chip small{flex:none;color:var(--ra-fg-muted);font-size:13px}
.ra-chip button{flex:none;width:20px;height:20px;border-radius:6px;color:var(--ra-fg-muted);display:inline-flex;align-items:center;justify-content:center}
.ra-chip button:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-user .ra-files{justify-content:flex-end;padding:0;margin-top:8px}
.ra-chip-link{cursor:pointer}
.ra-chip-link:hover{border-color:color-mix(in srgb,var(--ra-fg) 25%,transparent);background:var(--ra-subtle)}
.ra-drop{position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;background:color-mix(in srgb,var(--ra-accent) 8%,transparent);border:2px dashed var(--ra-accent);border-radius:8px;color:var(--ra-accent-fg);font-weight:600;pointer-events:none}
.ra-chat[data-drop="1"] .ra-drop{display:flex}
.ra-usage{display:flex;align-items:center;justify-content:flex-end;gap:8px;font-size:11px;color:var(--ra-fg-muted);margin-top:6px;min-height:16px}
.ra-ring{display:inline-flex;cursor:default}
.ra-ring circle{fill:none;stroke-width:2.5}
.ra-ring .tr{stroke:var(--ra-border)}
.ra-ring .pr{stroke:var(--ra-accent);stroke-linecap:round;transition:stroke-dashoffset .3s}
.ra-ring.mid .pr{stroke:var(--ra-warn-fg)}
.ra-ring.hi .pr{stroke:var(--ra-red)}
.ra-warn{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:5px 6px 5px 10px;border:1px solid var(--ra-warn-border);background:var(--ra-warn-bg);color:var(--ra-warn-fg);border-radius:8px;font-size:12.5px;font-weight:500;line-height:1.4}
.ra-warn>span{min-width:0}
.ra-chat .ra-warn .ra-btn{height:22px;padding:0 8px;font-size:12px;border-color:var(--ra-warn-border);background:transparent;color:inherit}
.ra-chat .ra-warn .ra-btn:hover{background:var(--ra-warn-border)}
.ra-modal{position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);padding:16px}
.ra-modal .ra-dlg{width:min(420px,100%);background:var(--ra-panel);border:1px solid var(--ra-border);border-radius:10px;box-shadow:var(--ra-shadow-md);padding:16px;display:flex;flex-direction:column;gap:10px}
.ra-modal .ra-dt{font-size:15px;font-weight:600}
.ra-modal .ra-dm{font-size:14px;color:var(--ra-fg-muted);white-space:pre-wrap}
.ra-modal .ra-btns{margin-top:4px}
.ra-toasts{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:7;display:flex;flex-direction:column;gap:6px;pointer-events:none;max-width:calc(100% - 32px)}
.ra-toast{background:#18181b;color:#fff;font-size:13px;padding:8px 14px;border-radius:8px;box-shadow:var(--ra-shadow-md);white-space:pre-wrap;word-break:break-word}
.ra-toast.warning{background:#d97706}.ra-toast.error{background:#dc2626}
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  // First in <head>, so a host stylesheet's rules of equal weight come later and win.
  document.head.prepend(s);
}

/* ------------------------------------------------------------------ */
/* DOM helpers and icons (lucide outlines, inline)                     */
/* ------------------------------------------------------------------ */

const TOOL_ICON: Record<string, () => string> = {
  read_file: I.fileText, write_file: I.filePlus, edit_file: I.filePen, delete_file: I.fileX, list_files: I.folderOpen,
  search_files: I.search, run_js: I.braces, ask_user: I.message,
};

/** Text of a message's content; images are listed as `<img>` elements by the caller. */
function textOfContent(content: string | ContentPart[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n");
}

function imagesOf(content: string | ContentPart[] | null | undefined): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : []));
}

/** One-line summary of a call's arguments: the path, the pattern, the question, else the first value. */
function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return typeof args === "string" ? args.slice(0, 80) : "";
  const a = args as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : undefined;
  if (name === "search_files") return `${String(a.pattern ?? "")}${path ? ` in ${path}` : ""}`;
  if (name === "run_js") return String(a.code ?? "").split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim().slice(0, 80) ?? "";
  if (name === "ask_user") { const q = a.questions; return Array.isArray(q) && q[0] && typeof q[0] === "object" ? String((q[0] as { question?: string }).question ?? "") : ""; }
  if (path) return path;
  const first = Object.values(a)[0];
  return first === undefined ? "" : (typeof first === "string" ? first : JSON.stringify(first)).slice(0, 80);
}

type ToolKind = "Read" | "List" | "Search" | "Write" | "Edit" | "Delete" | "Run" | "Ask" | "Other";
const TOOL_KIND: Record<string, ToolKind> = {
  read_file: "Read", list_files: "List", search_files: "Search", write_file: "Write", edit_file: "Edit", delete_file: "Delete", run_js: "Run", ask_user: "Ask",
};
const pathArg = (args: unknown): string | undefined => (args && typeof args === "object" && typeof (args as { path?: unknown }).path === "string" ? (args as { path: string }).path : undefined);

/** The status a saved tool result stands for, as the live card showed it. */
function statusOfResult(text: string): ToolStatus {
  if (text.startsWith("Skipped")) return "skipped";
  if (text.startsWith("The user declined")) return "declined";
  if (text.includes("Do not retry it another way")) return "blocked";
  if (/^Error|^Tool call "[^"]*" was not executed/.test(text)) return "error";
  return "ok";
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function relTime(ts: number, t: Strings): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t.justNow;
  if (s < 3600) return t.minutesAgo.replace("{n}", String(Math.floor(s / 60)));
  if (s < 86400) return t.hoursAgo.replace("{n}", String(Math.floor(s / 3600)));
  return clockTime(ts);
}
/** "18:00" today, "10/31 18:00" earlier this year, else with the year. */
function clockTime(ts: number): string {
  const d = new Date(ts), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}
const tsOf = (m: ChatMessage | undefined): number | undefined => (m as (ChatMessage & { ts?: number }) | undefined)?.ts;

/** The directory's work files at one moment (what rewinding restores): skills and mounts are left out, big files too. */
interface Checkpoint {
  at: number;
  files: Array<{ path: string; contentType?: string; data: string | Uint8Array }>;
  partial: boolean;
  /** Files that existed but were too big for the snapshot: a restore leaves them alone. */
  skipped?: string[];
}
const CKPT_FILE_MAX = 2 * 1024 * 1024;
const CKPT_TOTAL_MAX = 32 * 1024 * 1024;
/** Snapshots kept per directory (the newest user messages); older ones are deleted. */
const CKPT_KEEP = 30;
const ckptKey = (ts: number) => `ckpt:${ts}`;
const CKPT_INDEX = "ckpt:index";
async function takeCheckpoint(ws: Workspace, ts: number): Promise<void> {
  const files: Checkpoint["files"] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of await ws.list("/")) {
    if (ws.isSkillPath(f.path) || ws.mountOf(f.path)) continue;
    if (f.size > CKPT_FILE_MAX || total + f.size > CKPT_TOTAL_MAX) { skipped.push(f.path); continue; }
    const r = await ws.read(f.path);
    files.push({ path: f.path, contentType: r.contentType, data: r.data });
    total += f.size;
  }
  await ws.putData(ckptKey(ts), { at: ts, files, partial: skipped.length > 0, skipped } satisfies Checkpoint);
  const index = [...((await ws.getData<number[]>(CKPT_INDEX)) ?? []).filter((t) => t !== ts), ts].sort((a, b) => a - b);
  for (const old of index.splice(0, Math.max(0, index.length - CKPT_KEEP))) await ws.deleteData(ckptKey(old));
  await ws.putData(CKPT_INDEX, index);
}
/** Drops the snapshots of messages sent after `ts` (they were rewound away). */
async function dropCheckpointsAfter(ws: Workspace, ts: number): Promise<void> {
  const index = (await ws.getData<number[]>(CKPT_INDEX)) ?? [];
  for (const t of index.filter((t) => t > ts)) await ws.deleteData(ckptKey(t));
  await ws.putData(CKPT_INDEX, index.filter((t) => t <= ts));
}
async function restoreCheckpoint(ws: Workspace, c: Checkpoint): Promise<void> {
  const keep = new Set([...c.files.map((f) => f.path), ...(c.skipped ?? [])]);
  for (const f of await ws.list("/")) {
    if (ws.isSkillPath(f.path) || ws.mountOf(f.path) || keep.has(f.path)) continue;
    // Snapshots from before `skipped` was recorded: a big file may not have been in it; leave it.
    if (!c.skipped && c.partial && f.size > CKPT_FILE_MAX) continue;
    await ws.delete(f.path);
  }
  for (const f of c.files) await ws.write(f.path, f.data, f.contentType);
}

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_IMAGE_PART = 8 * 1024 * 1024;
const MAX_INLINE_TEXT = 64 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|ini|cfg|conf|log|env|svg|tex|rst)$/i;
const ATTACH_MARK = "[attachments]";
/** One line of the attachment list: `- <path or name> (<type>, <size>)[ — note]`; the name may hold parentheses. */
function parseAttachLine(line: string): { ref: string; type: string; size: string } | null {
  const m = /^- (.+) \(([^()]*)\)(?: — .*)?$/.exec(line);
  if (!m) return null;
  const [type = "", size = ""] = m[2]!.split(/,\s*/);
  return { ref: m[1]!, type, size };
}
/** What the user typed for a message: the slash command as written, not its expansion. */
const typedOf = (m: ChatMessage | undefined): string | undefined => (m as { typed?: string } | undefined)?.typed;
/** Added to the agent's instructions when it has a directory: how to hand a file to the user. */
const filesHint = (uploads: string) => `The user can browse, edit and download every file of the directory from the chat's Files panel. When you create or change a file for the user, name its absolute path in backticks (for example \`${uploads}/report.csv\`); in the chat that path becomes a link that opens the file, with a download button. Files the user attaches arrive under ${uploads}.`;

/** A file the user attached: read once, saved to the directory (or inlined) when the message is sent. */
interface Attachment { file: File; name: string; bytes: Uint8Array; text: string | null; image: boolean; preview: string | null; chip: HTMLElement; /** Already in the directory at this path (re-attached by a rewind): reused, not copied. */ path?: string }

/** Text when the type or extension says so, or when the first 8 KB hold no NUL byte and decode as UTF-8. */
function decodeText(file: File, bytes: Uint8Array): string | null {
  const typed = /^text\//.test(file.type) || /json|xml|javascript|yaml|csv|svg/.test(file.type) || TEXT_EXT.test(file.name);
  if (!typed) { const head = bytes.subarray(0, 8192); for (const b of head) if (b === 0) return null; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

function safeName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f]/g, "").trim() || "file";
  return base.length > 120 ? base.slice(-120) : base;
}

/* ------------------------------------------------------------------ */
/* Inline dialogs                                                      */
/* ------------------------------------------------------------------ */

interface Pending { card: HTMLElement; cancel: () => void }

/** `AgentUI` whose questions are cards above the composer and whose notices are toasts in the chat. */
function inlineUI(askArea: HTMLElement, toasts: HTMLElement, t: Strings, onChange: () => void): AgentUI & { cancelAll(all?: boolean): void; park(): HTMLElement[]; restore(cards: HTMLElement[]): void } {
  const pending = new Set<Pending>();
  const open = <T,>(build: (card: HTMLElement, done: (v: T) => void) => void, cancelValue: T, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve) => {
      if (signal?.aborted) { resolve(cancelValue); return; }
      const card = h("section", "ra-q");
      let entry: Pending;
      // A stopped run takes its question away as if dismissed.
      const onAbort = () => entry.cancel();
      const done = (v: T) => { signal?.removeEventListener("abort", onAbort); pending.delete(entry); card.remove(); onChange(); resolve(v); };
      entry = { card, cancel: () => done(cancelValue) };
      signal?.addEventListener("abort", onAbort, { once: true });
      card.addEventListener("keydown", (e) => { if (e.key === "Escape" && !(e as KeyboardEvent).isComposing) { e.preventDefault(); e.stopPropagation(); entry.cancel(); } });
      build(card, done);
      pending.add(entry);
      askArea.append(card);
      onChange();
      const focus = card.querySelector<HTMLElement>("input,textarea,button.solid,button");
      queueMicrotask(() => focus?.focus());
    });
  const head = (card: HTMLElement, title: string, message?: string) => {
    card.append(h("div", "ra-qt", title));
    if (message) card.append(h("div", "ra-qm", message));
  };
  const btn = (label: string, cls: string, onClick: () => void) => { const b = h("button", "ra-btn xs " + cls, label); b.type = "button"; b.addEventListener("click", onClick); return b; };

  return {
    confirm: (title, message, opts = {}) => open<boolean>((card, done) => {
      head(card, title, message);
      const row = h("div", "ra-btns");
      row.append(btn(opts.cancel ?? t.decline, "ghost", () => done(false)), btn(opts.ok ?? t.allow, opts.danger ? "red" : "solid", () => done(true)));
      card.append(row);
    }, false, opts.signal),

    select: (title, options: SelectOption[], opts = {}) => open<string[] | null>((card, done) => {
      head(card, title, opts.message);
      const list = h("div", "ra-opts");
      if (!opts.multi && !opts.allowOther) {
        // Single choice: a click answers.
        for (const o of options) {
          const b = h("button", "ra-opt"); b.type = "button";
          const text = h("div"); text.append(h("span", "", o.label ?? o.value));
          if (o.description) text.append(h("small", "", o.description));
          b.append(text);
          b.addEventListener("click", () => done([o.value]));
          list.append(b);
        }
        card.append(list, (() => { const r = h("div", "ra-btns"); r.append(btn(t.cancel, "ghost", () => done(null))); return r; })());
        return;
      }
      const name = "ra_" + Math.random().toString(36).slice(2, 8);
      const inputs: HTMLInputElement[] = [];
      const add = (o: SelectOption) => {
        const label = h("label", "ra-opt");
        const input = h("input"); input.type = opts.multi ? "checkbox" : "radio"; input.name = name; input.value = o.value;
        inputs.push(input);
        const text = h("div"); text.append(h("span", "", o.label ?? o.value));
        if (o.description) text.append(h("small", "", o.description));
        label.append(input, text);
        list.append(label);
      };
      options.forEach(add);
      let other: HTMLInputElement | null = null;
      if (opts.allowOther) {
        add({ value: "__other__", label: t.other });
        other = h("input", "ra-field"); other.type = "text"; other.placeholder = t.typeAnswer;
        other.addEventListener("focus", () => { const o = inputs.find((i) => i.value === "__other__"); if (o) o.checked = true; });
        list.append(other);
      }
      card.append(list);
      const row = h("div", "ra-btns");
      row.append(btn(t.cancel, "ghost", () => done(null)), btn(t.ok, "solid", () => {
        const picked = inputs.filter((i) => i.checked).map((i) => (i.value === "__other__" ? (other?.value.trim() ?? "") : i.value)).filter(Boolean);
        if (picked.length) done(picked);
      }));
      card.append(row);
    }, null, opts.signal),

    input: (title, opts = {}) => open<string | null>((card, done) => {
      head(card, title, opts.message);
      const field = opts.multiline ? h("textarea", "ra-field") : h("input", "ra-field");
      if (!opts.multiline) (field as HTMLInputElement).type = "text";
      if (opts.placeholder) field.placeholder = opts.placeholder;
      if (opts.initial) field.value = opts.initial;
      field.addEventListener("keydown", (ev) => {
        const e = ev as KeyboardEvent;
        if (e.key === "Enter" && !e.isComposing && (!opts.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); done(field.value); }
      });
      card.append(field);
      const row = h("div", "ra-btns");
      row.append(btn(t.cancel, "ghost", () => done(null)), btn(t.submit, "solid", () => done(field.value)));
      card.append(row);
    }, null, opts.signal),

    notify(message, level = "info") {
      const el = h("div", "ra-toast " + level, message);
      toasts.append(el);
      setTimeout(() => el.remove(), level === "error" ? 8000 : 4000);
    },

    /** Declines the questions on screen (`all`: the parked ones of other sessions too). */
    cancelAll(all = false) {
      for (const p of [...pending]) if (all || p.card.isConnected) p.cancel();
    },
    /** Takes the cards on screen out of the DOM, still pending, for the session being left. */
    park() {
      const out: HTMLElement[] = [];
      for (const p of pending) if (p.card.isConnected) { p.card.remove(); out.push(p.card); }
      onChange();
      return out;
    },
    restore(cards) {
      for (const c of cards) askArea.append(c);
      if (cards.length) onChange();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Transcript rows                                                     */
/* ------------------------------------------------------------------ */

type Command = { name: string; description: string; kind: string; /** Built-in: runs on Enter when it takes no argument. */ args?: string; builtin?: boolean };

interface ToolCard { el: HTMLDetailsElement; name: string; args: unknown; end: HTMLElement; body: HTMLElement; update: HTMLElement | null; result: HTMLElement | null }

/** A reply: its body holds thinking, text and tool cards, filled live or from saved messages; once done, all but the answer folds into "Worked for …". */
interface AsstRow extends VRow {
  body: HTMLElement;
  text: HTMLElement | null;
  think: HTMLDetailsElement | null;
  thinkBody: HTMLElement | null;
  md: string;
  reasoning: string;
  /** The Markdown last drawn and whether it was drawn final, so repeated flushes do no work. */
  drawn?: string;
  drawnFinal?: boolean;
}

const LAST_KEY = (project: string) => `__runapps_agent_chat:${project}:last`;
function readLast(project: string): string | null {
  try { return localStorage.getItem(LAST_KEY(project)); } catch { return null; }
}
function writeLast(project: string, id: string | null): void {
  try { if (id) localStorage.setItem(LAST_KEY(project), id); else localStorage.removeItem(LAST_KEY(project)); } catch { /* private mode */ }
}

export function renderChat(target: HTMLElement, opts: ChatOptions): ChatHandle {
  if (typeof document === "undefined") throw new Error("runapps agent: renderChat needs a document");
  if (!opts.agent && !opts.client) throw new Error("runapps agent: renderChat needs a client (or an agent)");
  injectStyles();
  const lang = pickLocale(opts.locale);
  const t = STRINGS[lang];
  const { client, agent: givenAgent, workspace: wsOpt, resume: resumeOpt, palette: paletteOpt, vars: varsOpt, className, debug: debugOpt, settings: _settingsOpt, title, placeholder, emptyState, suggestions, sessions, locale: _l, theme, showUsage, attachments: attachOpt, uploadsDir: uploadsOpt, onOpenFile, onSession, ...agentOpts } = opts;
  const uploadsDir = "/" + (uploadsOpt ?? "/uploads").replace(/^\/+|\/+$/g, "");
  const project = (client as unknown as { projectName?: string } | undefined)?.projectName ?? agentOpts.appName ?? "app";

  // Shell.
  const root = h("div", "ra-chat");
  if (className) root.classList.add(...className.split(/\s+/).filter(Boolean));
  // Appearance: data-theme is what was asked (auto/light/dark), data-scheme what applies; the palette and
  // overrides are applied for the scheme in effect (a custom palette inline, since it has no CSS of its own).
  let themeNow = theme ?? "auto";
  let paletteNow: keyof typeof CHAT_PALETTES | ChatPalette = paletteOpt ?? "claude";
  let varsNow = varsOpt;
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  let inlineProps: string[] = [];
  const applyAppearance = () => {
    const scheme = themeNow === "auto" ? (media?.matches ? "dark" : "light") : themeNow;
    root.dataset.theme = themeNow;
    root.dataset.scheme = scheme;
    if (typeof paletteNow === "string") root.dataset.palette = paletteNow; else delete root.dataset.palette;
    for (const prop of inlineProps) root.style.removeProperty(prop);
    inlineProps = [];
    const set = (vals: Record<string, string | undefined> | undefined) => {
      for (const [k, v] of Object.entries(vals ?? {})) if (v !== undefined) { const prop = tokenProp(k); root.style.setProperty(prop, v); inlineProps.push(prop); }
    };
    if (typeof paletteNow !== "string") set(paletteNow[scheme]);
    const v = varsNow as { light?: ChatVars; dark?: ChatVars } | ChatVars | undefined;
    if (v && ("light" in v || "dark" in v)) set((v as { light?: ChatVars; dark?: ChatVars })[scheme] as Record<string, string | undefined>);
    else set(v as Record<string, string | undefined>);
  };
  applyAppearance();
  const onScheme = () => { if (themeNow === "auto") applyAppearance(); };
  media?.addEventListener?.("change", onScheme);
  const head = h("div", "ra-head");
  const titleEl = h("div", "ra-title", title === false ? "" : title || agentOpts.appName || t.assistant);
  const modelEl = h("span", "ra-badge");
  const debugBtn = h("button", "ra-btn ghost"); debugBtn.type = "button"; debugBtn.innerHTML = I.bug() + `<span>${escapeHTML(t.debug)}</span>`;
  const filesBtn = h("button", "ra-btn ghost"); filesBtn.type = "button"; filesBtn.innerHTML = I.folder() + `<span>${escapeHTML(t.files)}</span>`;
  const histBtn = h("button", "ra-btn ghost"); histBtn.type = "button"; histBtn.innerHTML = I.hist() + `<span>${escapeHTML(t.history)}</span>`;
  const newBtn = h("button", "ra-btn ghost"); newBtn.type = "button"; newBtn.innerHTML = I.plus() + `<span>${escapeHTML(t.newChat)}</span>`;
  const setBtn = h("button", "ra-btn ghost"); setBtn.type = "button"; setBtn.innerHTML = I.gear(); setBtn.title = t.settings; setBtn.setAttribute("aria-label", t.settings);
  head.append(titleEl, modelEl, h("span", "ra-sp"), debugBtn, filesBtn, histBtn, newBtn, setBtn);
  if (title === false) head.style.display = "none";
  const log = h("div", "ra-log");
  const inner = h("div", "ra-col");
  log.append(inner);
  const askArea = h("div", "ra-ask");
  const askCol = h("div", "ra-col");
  askArea.append(askCol);
  const statusEl = h("div", "ra-status"); statusEl.style.display = "none";
  const comp = h("div", "ra-comp");
  const compCol = h("div", "ra-col");
  const alertEl = h("div", "ra-alert"); alertEl.style.display = "none"; alertEl.setAttribute("role", "alert");
  const queueEl = h("div", "ra-queue"); queueEl.style.display = "none";
  const box = h("div", "ra-box");
  const cmds = h("div", "ra-cmds"); cmds.style.display = "none";
  const ta = h("textarea"); ta.rows = 2; ta.setAttribute("aria-label", "Message");
  const files = h("div", "ra-files"); files.style.display = "none";
  const bar = h("div", "ra-bar");
  const left = h("div", "ra-left");
  const attachBtn = h("button", "ra-attach"); attachBtn.type = "button"; attachBtn.innerHTML = I.clip(); attachBtn.title = t.attach; attachBtn.setAttribute("aria-label", t.attach);
  const fileInput = h("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.style.display = "none";
  if (attachOpt === false) attachBtn.style.display = "none";
  const hint = h("span", "ra-hint");
  // ⌘ on a Mac, Ctrl elsewhere (the symbols read like the app's own placeholder: "↵ to send, ⌘↵ to queue").
  // Chrome's userAgentData says "macOS", navigator.platform says "MacIntel": match either, any case.
  const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(`${(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ""} ${navigator.platform ?? ""}`);
  const MOD = isMac ? "⌘" : "Ctrl+";
  const fill = (x: string) => x.replace("{mod}", MOD).replace("{enter}", t.enter).replace("{newline}", t.newline);
  hint.textContent = fill(t.hintIdle);
  const acts = h("div", "ra-acts");
  const sendBtn = h("button", "ra-send"); sendBtn.type = "button"; sendBtn.innerHTML = I.send(); sendBtn.setAttribute("aria-label", t.send);
  const steerBtn = h("button", "ra-btn xs subtle"); steerBtn.type = "button"; steerBtn.innerHTML = I.corner() + escapeHTML(t.steer); steerBtn.title = t.steerTip;
  const fuBtn = h("button", "ra-btn xs subtle", t.followUp); fuBtn.type = "button"; fuBtn.title = t.followUpTip;
  const stopBtn = h("button", "ra-btn xs red"); stopBtn.type = "button"; stopBtn.innerHTML = I.square() + escapeHTML(t.stop);
  acts.append(steerBtn, fuBtn, stopBtn, sendBtn);
  left.append(attachBtn, hint);
  bar.append(left, acts);
  box.append(cmds, files, ta, bar, fileInput);
  const drop = h("div", "ra-drop", t.drop);
  const usageEl = h("div", "ra-usage");
  const usageText = h("span");
  const ring = h("span", "ra-ring"); ring.style.display = "none";
  usageEl.append(usageText, ring);
  if (showUsage === false) usageEl.style.display = "none";
  compCol.append(alertEl, queueEl, box, usageEl);
  comp.append(compCol);
  const toasts = h("div", "ra-toasts");
  const statusCol = h("div", "ra-col"); statusCol.append(statusEl);
  const main = h("div", "ra-main");
  const chatCol = h("div", "ra-chatcol");
  // Back to the end: shown while the transcript is scrolled away from it.
  const jumpWrap = h("div", "ra-jumpwrap");
  const jumpBtn = h("button", "ra-jump"); jumpBtn.type = "button"; jumpBtn.innerHTML = I.arrowDown(); jumpBtn.title = t.jumpEnd; jumpBtn.setAttribute("aria-label", t.jumpEnd); jumpBtn.tabIndex = -1;
  jumpWrap.append(jumpBtn);
  chatCol.append(log, jumpWrap, askArea, statusCol, comp);
  main.append(chatCol);
  root.append(head, main, toasts, drop);
  target.replaceChildren(root);

  // State.
  let agent: Agent;
  const list = new VirtualList(log, inner, {
    estimate: 96, overscan: 400, rowClass: "ra-row",
    onFollow: (following) => {
      const show = !following && log.scrollHeight - log.clientHeight > 40;
      jumpBtn.classList.toggle("show", show);
      jumpBtn.tabIndex = show ? 0 : -1;
    },
  });
  jumpBtn.addEventListener("click", () => list.scrollToBottom());
  // Opening or closing something in the transcript (tool calls, a card, the thinking) keeps the clicked line where it is.
  log.addEventListener("click", (e) => {
    const sum = (e.target as HTMLElement).closest("summary");
    if (sum && log.contains(sum)) list.pin(sum);
  }, true);
  let active: AsstRow | null = null;
  let renderTimer: number | null = null;
  const cards = new Map<string, ToolCard>();
  /** The call behind each tool card element, for the group line that sums them up. */
  const cardCall = new WeakMap<Element, { name: string; args: unknown }>();
  /** Calls of the drawn history still waiting for a result (a resumed run): tool_end fills them in before their row is built. */
  const histCalls = new Map<string, { result?: string; status?: ToolStatus }>();
  let commands: Command[] = [];
  let cmdIndex = 0;
  let cmdFrame: number | null = null;
  let unsub: Array<() => void> = [];
  let menu: HTMLElement | null = null;
  let mounted = true;

  const ui = inlineUI(askCol, toasts, t, () => list.schedule());
  const MAX_BACKGROUND = 3;
  /** Sessions the chat made that are still running after the user switched away (and the current one). */
  const live = new Map<string, Agent>();
  const bgSubs = new Map<string, Array<() => void>>();
  const parked = new Map<string, HTMLElement[]>();
  /** Background sessions whose question waits for the user to come back. */
  const waiting = new Set<string>();
  const waiters = new Map<string, Array<(shown: boolean) => void>>();
  /** Resolves true once session `id` is on screen; false when its run stops (or the session goes away) first. */
  const whenCurrent = (id: string, signal?: AbortSignal) => new Promise<boolean>((res) => {
    if (agent?.id === id) { res(true); return; }
    if (signal?.aborted) { res(false); return; }
    waiting.add(id);
    const w = waiters.get(id) ?? [];
    const settle = (shown: boolean) => { signal?.removeEventListener("abort", onAbort); res(shown); };
    const onAbort = () => { const list = waiters.get(id); if (list) { const k = list.indexOf(settle); if (k >= 0) list.splice(k, 1); if (!list.length) { waiters.delete(id); waiting.delete(id); } } settle(false); markBackground(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    w.push(settle);
    waiters.set(id, w);
    markBackground();
  });
  const wake = (id: string, shown = true) => { const w = waiters.get(id); waiters.delete(id); waiting.delete(id); w?.forEach((f) => f(shown)); };
  /** The chat's dialogs for one session: a question from a session that is not on screen waits until it is (or its run stops). */
  const uiFor = (id: string): AgentUI => ({
    confirm: async (title, message, o) => ((await whenCurrent(id, o?.signal)) ? ui.confirm(title, message, o) : false),
    select: async (title, options, o) => ((await whenCurrent(id, o?.signal)) ? ui.select(title, options, o) : null),
    input: async (title, o) => ((await whenCurrent(id, o?.signal)) ? ui.input(title, o) : null),
    notify: (m, l) => ui.notify(m, l),
  });
  /** Whether rewinding may restore files: only a directory of the session's own, kept in IndexedDB (not a folder on disk, not shared). */
  const restorable = (a: Agent) => !!a.workspace && typeof wsOpt === "function" && !a.workspace.root;
  const background = () => [...live.values()].filter((a) => a !== agent && (a.busy || a.queued.length > 0 || waiting.has(a.id)));
  const titleOfAgent = (a: Agent) => { const m = a.messages.find((x) => x.role === "user"); const text = m ? textOfContent(m.content as string | ContentPart[]).replace(/\s+/g, " ").trim() : ""; return text.length > 40 ? text.slice(0, 37) + "…" : text || t.untitled; };
  const markBackground = () => histBtn.classList.toggle("ra-bg", background().length > 0);
  /** The work files as they are when a message is sent, so a rewind to it can put them back. */
  const checkpoint = async (a: Agent, msg: ChatMessage) => {
    const ts = tsOf(msg);
    if (!a.workspace || !ts || !restorable(a)) return;
    try { await takeCheckpoint(a.workspace, ts); } catch (err) { console.warn("runapps agent: checkpoint failed", err); }
  };
  /** Keeps an eye on a session running in the background: a notice when it ends, dropped once idle. */
  const watchBackground = (a: Agent) => {
    if (bgSubs.has(a.id)) return;
    const subs: Array<() => void> = [];
    subs.push(a.on("run_end", () => {
      if (agent === a) return;
      ui.notify(`${titleOfAgent(a)} · ${t.finished}`);
      // `busy` flips after the run's promise settles, a tick after this event.
      setTimeout(() => { if (agent !== a && !a.busy && !a.queued.length && !waiting.has(a.id)) { live.delete(a.id); unwatchBackground(a); } markBackground(); }, 50);
    }));
    subs.push(a.on("run_start", (ev: { message: ChatMessage | null }) => { markBackground(); if (ev.message) void checkpoint(a, ev.message); }));
    bgSubs.set(a.id, subs);
    markBackground();
  };
  const unwatchBackground = (a: Agent) => { bgSubs.get(a.id)?.forEach((u) => u()); bgSubs.delete(a.id); };
  // The header buttons of the two side panels show which one is open, however it was opened or closed.
  const panel = filesPanel({ t, root, editorHost: chatCol, notify: (m, l) => ui.notify(m, l), onChange: () => void refreshCommands(), onShow: (v) => filesBtn.classList.toggle("on", v) });
  main.append(panel.el);
  const dpanel = debugPanel({ t, root, onShow: (v) => debugBtn.classList.toggle("on", v) });
  main.append(dpanel.el);
  let debugOn = !!debugOpt;
  const applyDebug = () => {
    debugBtn.style.display = debugOn ? "" : "none";
    root.dataset.debug = debugOn ? "1" : "";
    if (!debugOn) dpanel.close();
  };
  applyDebug();
  filesBtn.addEventListener("click", () => { if (dpanel.visible) { dpanel.close(); applyDebug(); } void panel.toggle(); });
  debugBtn.addEventListener("click", async () => {
    if (panel.visible) await panel.close();
    if (panel.visible) return;  // closing was declined (unsaved edits)
    dpanel.toggle();
    applyDebug();
  });
  /** Opens a path: the host's editor when it has one, else the files panel. */
  const openPath = (path: string) => { if (onOpenFile) onOpenFile(path); else void panel.open(path); };
  const openIfExists = async (path: string) => {
    const ws = agent?.workspace;
    if (ws && !(await ws.exists(path))) { ui.notify(`${t.rewindGoneFile.replace("{path}", path)}`, "warning"); return; }
    openPath(path);
  };
  const emptyEl = h("div", "ra-empty");
  const emptyRow: VRow = { render: () => emptyEl };

  const showEmpty = () => {
    if (emptyState === null) return;
    emptyEl.replaceChildren();
    if (emptyState instanceof HTMLElement) emptyEl.append(emptyState);
    else emptyEl.append(h("div", "", typeof emptyState === "string" ? emptyState : t.empty));
    if (suggestions?.length) {
      const row = h("div", "ra-sugs");
      for (const s of suggestions) { const b = h("button", "", s); b.type = "button"; b.addEventListener("click", () => { ta.value = s; ta.focus(); renderCmds(); }); row.append(b); }
      emptyEl.append(row);
    }
    if (!list.rows.includes(emptyRow)) list.push(emptyRow);
  };
  const hideEmpty = () => list.remove(emptyRow);

  /* --- rows --- */
  const addRow = (row: VRow) => { hideEmpty(); list.push(row); };

  /** An attachment card: the file type as a small badge (or the picture), the name ellipsised in the middle so the extension stays, the size. */
  const chipEl = (name: string, size: string, preview: string | null): HTMLElement => {
    const chip = h("span", "ra-chip");
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
    if (preview) { const img = h("img"); img.src = preview; img.alt = ""; chip.append(img); }
    else chip.append(h("span", "ra-ext", (ext.slice(1) || "file").slice(0, 4)));
    const n = h("span", "ra-cn"); n.title = name;
    n.append(h("span", "st", ext ? name.slice(0, dot) : name));
    if (ext) n.append(h("span", "ex", ext));
    chip.append(n);
    if (size) chip.append(h("small", "", size.replace(/\s+(?=[KMG]?B$)/, "")));
    return chip;
  };
  interface UserRow extends VRow { msg?: ChatMessage; text: string; update(): void }
  const userEl = (content: string | ContentPart[], row: UserRow): HTMLElement => {
    const el = h("div", "ra-user");
    const b = h("div", "ra-bubble");
    // The attachment list (a text part of its own) is shown as chips, not as text.
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text) : [];
    const text = row.text;
    b.textContent = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
    const attached = parts.find((p) => p.startsWith(ATTACH_MARK));
    if (attached) {
      const chips = h("div", "ra-files");
      for (const line of attached.split("\n").slice(1)) {
        const a = parseAttachLine(line);
        if (!a) continue;
        const chip = chipEl(a.ref.replace(/^.*\//, ""), a.size, null);
        // A file saved in the directory: click to find it in the files panel.
        if (a.ref.startsWith("/")) { const path = a.ref; chip.classList.add("ra-chip-link"); chip.title = `${t.open} ${path}`; chip.setAttribute("role", "button"); chip.tabIndex = 0; chip.addEventListener("click", () => void openIfExists(path)); chip.addEventListener("keydown", (e) => { if (e.key === "Enter") void openIfExists(path); }); }
        chips.append(chip);
      }
      if (chips.childElementCount) b.append(chips);
    }
    for (const url of imagesOf(content)) { const img = h("img"); img.src = url; img.alt = ""; b.append(img); }
    // Footer, shown on hover: sent + when, copy, rewind.
    const foot = h("div", "ra-uf");
    const time = h("span", "ra-ut");
    const copy = h("button", "ra-ib"); copy.type = "button"; copy.innerHTML = I.copy(13); copy.title = t.copy; copy.setAttribute("aria-label", t.copy);
    copy.addEventListener("click", () => { void navigator.clipboard?.writeText(row.text).then(() => ui.notify(t.copied)); });
    const back = h("button", "ra-ib"); back.type = "button"; back.innerHTML = I.undo(); back.title = t.rewind; back.setAttribute("aria-label", t.rewind);
    back.addEventListener("click", () => void rewindTo(row));
    foot.append(time, copy, back);
    el.addEventListener("mouseenter", () => row.update());
    row.update = () => {
      const ts = tsOf(row.msg);
      time.innerHTML = I.checks() + `<span>${escapeHTML(ts ? relTime(ts, t) : t.sent)}</span>`;
      back.disabled = !row.msg;
    };
    row.update();
    el.append(b, foot);
    return el;
  };
  const userRow = (content: string | ContentPart[], msg?: ChatMessage): UserRow => {
    const parts = typeof content === "string" ? [content] : content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text);
    // Expanded slash commands show what was typed; the expansion is for the model.
    const own = parts.filter((p) => !p.startsWith(ATTACH_MARK) && !p.startsWith("<file name="));
    const typed = typedOf(msg);
    const row: UserRow = { msg, text: typed ?? own.join("\n"), update: () => undefined, render: () => userEl(content, row) };
    return row;
  };
  /** The row drawn for a message this chat sent, until the agent's run_start hands over the message object. */
  let awaitingRow: UserRow | null = null;
  const addUser = (content: string | ContentPart[], msg?: ChatMessage) => { const row = userRow(content, msg); addRow(row); list.scrollToBottom(); return row; };

  /** A dialog for rewinding: drop what follows the message, optionally put the files back as they were. */
  /** Asks before rewinding; the file option shows only when there is a snapshot to restore (and says what it holds). */
  const rewindDialog = async (ckpt: Checkpoint | undefined): Promise<{ files: boolean } | null> => {
    const ck = h("input"); ck.type = "checkbox"; ck.checked = !!ckpt;
    const body: HTMLElement[] = [];
    if (ckpt) {
      const lab = h("label", "ra-ck"); lab.append(ck, h("span", "", t.rewindFiles));
      const size = ckpt.files.reduce((n, f) => n + (typeof f.data === "string" ? new TextEncoder().encode(f.data).length : f.data.byteLength), 0);
      body.push(lab, h("div", "ra-dn", t.rewindSnapshot.replace("{n}", String(ckpt.files.length)).replace("{size}", fmtSize(size)).replace("{time}", clockTime(ckpt.at)) + (ckpt.partial ? ` ${t.rewindPartial}` : "")));
    }
    const ok = await modal(root, { title: t.rewindTitle, message: t.rewindMsg, body, ok: t.rewind, cancel: t.cancel, focus: "ok" });
    return ok ? { files: !!ckpt && ck.checked } : null;
  };
  const rewindTo = async (row: UserRow) => {
    if (!row.msg || !agent) return;
    const a = agent;
    const index = a.messages.indexOf(row.msg);
    if (index < 0) { ui.notify(t.rewindGone, "warning"); return; }
    const ws = a.workspace;
    const ts = tsOf(row.msg);
    const ckpt = ws && ts && restorable(a) ? await ws.getData<Checkpoint>(ckptKey(ts)) : undefined;
    const choice = await rewindDialog(ckpt);
    if (!choice || agent !== a) return;
    let rewound = false;
    try {
      if (a.busy) { ui.cancelAll(); await a.abort(); }
      await a.rewind(index);
      rewound = true;
      if (choice.files && ws && ckpt) {
        try { await restoreCheckpoint(ws, ckpt); } catch (err) { ui.notify((err as Error).message, "error"); }
      }
      if (ws && ts) void dropCheckpointsAfter(ws, ts).catch(() => undefined);
    } catch (err) {
      ui.notify((err as Error).message, "error");
    } finally {
      // Whatever happened, the transcript shows what the agent has.
      if (agent === a) { renderHistory(a.messages); showUsage_(a); void panel.refresh(); void refreshCommands(); }
    }
    if (!rewound || agent !== a) return;
    ta.value = row.text; ta.focus(); renderCmds();
    await reattach(row.msg);
  };
  /** Puts a rewound message's attachments back into the composer: from the directory, or from what the message carried inline. */
  const reattach = async (msg: ChatMessage) => {
    if (!Array.isArray(msg.content)) return;
    const parts = msg.content;
    const block = parts.find((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text" && p.text.startsWith(ATTACH_MARK));
    if (!block) return;
    const ws = agent?.workspace;
    const inline = new Map<string, string>();
    for (const p of parts) if (p.type === "text") { const m = /^<file name="([^"]*)">\n([\s\S]*)\n<\/file>$/.exec(p.text); if (m) inline.set(m[1]!, m[2]!); }
    const images = parts.flatMap((p) => (p.type === "image_url" && p.image_url.url.startsWith("data:") ? [p.image_url.url] : []));
    const files: File[] = [], paths: Array<string | undefined> = [], missing: string[] = [];
    for (const line of block.text.split("\n").slice(1)) {
      const a = parseAttachLine(line);
      if (!a) continue;
      const { ref, type } = a;
      const name = ref.replace(/^.*\//, "");
      if (ref.startsWith("/") && ws) {
        try { const r = await ws.read(ref); files.push(new File([r.data as BlobPart], name, { type: r.contentType || type })); paths.push(ref); } catch { missing.push(ref); }
      } else if (inline.has(name)) { files.push(new File([inline.get(name)!], name, { type })); paths.push(undefined); }
      else if (/^image\//.test(type) && images.length) { const blob = await (await fetch(images.shift()!)).blob(); files.push(new File([blob], name, { type })); paths.push(undefined); }
      else missing.push(name);
    }
    if (files.length) await addFiles(files, paths);
    if (missing.length) ui.notify(t.rewindGoneFile.replace("{path}", missing.join(", ")), "warning");
  };

  const asstRow = (): AsstRow => {
    const el = h("div", "ra-asst");
    const body = h("div", "ra-body");
    el.append(body);
    return { render: () => el, el, body, text: null, think: null, thinkBody: null, md: "", reasoning: "" };
  };

  const fmtDuration = (ms: number): string => {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return t.sec.replace("{s}", String(s));
    if (s < 3600) return t.minSec.replace("{m}", String(Math.floor(s / 60))).replace("{s}", String(s % 60));
    return t.hourMin.replace("{h}", String(Math.floor(s / 3600))).replace("{m}", String(Math.floor((s % 3600) / 60)));
  };
  /**
   * A finished reply: everything before its answer (thinking, tool calls, text written along the way)
   * folds into one "Worked for 6m 38s" line, the answer stays below it. A reply that is only an answer
   * has nothing to fold; one that ended without an answer (stopped, turn limit) folds whole.
   */
  const foldReply = (body: HTMLElement, ms?: number) => {
    if (body.querySelector(":scope>.ra-work")) return;
    const kids = Array.from(body.children);
    const last = kids.at(-1);
    const process = last?.classList.contains("ra-md") ? kids.slice(0, -1) : kids;
    if (!process.length) return;
    const d = h("details", "ra-work") as HTMLDetailsElement;
    const sum = h("summary");
    sum.append(h("span", "", ms !== undefined && ms > 0 ? t.worked.replace("{t}", fmtDuration(ms)) : t.workedNoTime));
    const chev = h("span", "ra-chev"); chev.innerHTML = I.chev(13); sum.append(chev);
    // Opening it keeps the line where it is; the steps open below.
    sum.addEventListener("click", () => list.pin(sum));
    const inner = h("div", "ra-wb");
    inner.append(...process);
    d.append(sum, inner);
    body.prepend(d);
  };
  /** When the reply being drawn began (the run, or the steer it follows): its "worked for" time counts from here. */
  let replyStart = 0;
  const closeActive = () => {
    if (!active) return;
    flushActive(true);
    foldReply(active.body, replyStart ? Date.now() - replyStart : undefined);
    active = null;
    list.schedule();
  };

  const ensureActive = (): AsstRow => {
    if (!active) { active = asstRow(); addRow(active); }
    return active;
  };

  const thinkEl = (reasoning: string, done: boolean): [HTMLDetailsElement, HTMLElement] => {
    const d = h("details", "ra-think") as HTMLDetailsElement;
    const s = h("summary");
    s.innerHTML = `<span class="ra-chev">${I.chev(13)}</span>${I.brain()}<span>${escapeHTML(done ? t.thought : t.thinking)}</span>`;
    const body = h("div", "ra-think-body", reasoning);
    d.append(s, body);
    return [d, body];
  };

  /** `code` spans naming a file of the directory become links that open it (checked against the directory, so prose paths stay plain). */
  const linkPaths = (el: HTMLElement) => {
    const ws = agent?.workspace;
    if (!ws) return;
    for (const code of Array.from(el.querySelectorAll("code"))) {
      if (code.closest("pre") || code.classList.contains("ra-path")) continue;
      const text = code.textContent?.trim() ?? "";
      if (!/^\/[^\s`'"<>]+$/.test(text) || text.length > 200) continue;
      void ws.exists(text).then((ok) => { if (ok && !code.classList.contains("ra-path")) { code.classList.add("ra-path"); code.dataset.path = text; code.title = t.open; code.insertAdjacentHTML("beforeend", I.download(11)); } });
    }
  };
  const renderFinal = (el: HTMLElement, md: string) => { renderMD(el, md, false); linkPaths(el); };

  const flushActive = (final: boolean) => {
    if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
    if (!active) return;
    if (active.text && (active.drawn !== active.md || active.drawnFinal !== final)) {
      renderMD(active.text, active.md, !final);
      active.drawn = active.md; active.drawnFinal = final;
      if (final) linkPaths(active.text);
    }
    if (active.thinkBody) active.thinkBody.textContent = active.reasoning;
    if (active.think && final) (active.think.querySelector("summary span:last-child") as HTMLElement).textContent = t.thought;
    list.schedule();
  };
  const scheduleRender = () => { if (renderTimer === null) renderTimer = window.setTimeout(() => { renderTimer = null; flushActive(false); }, 100); };

  const makeCard = (name: string, args: unknown): ToolCard => {
    const el = h("details", "ra-tool") as HTMLDetailsElement;
    cardCall.set(el, { name, args });
    const sum = h("summary");
    const icon = h("span", "ra-ticon"); icon.innerHTML = (TOOL_ICON[name] ?? I.wrench)();
    const end = h("span", "ra-tend");
    end.innerHTML = '<span class="ra-spin"></span>';
    sum.innerHTML = `<span class="ra-chev">${I.chev()}</span>`;
    sum.append(icon, h("span", "ra-tname", name), h("span", "ra-tsum", summarizeArgs(name, args)), end);
    const tb = h("div", "ra-tbody");
    const argsPre = h("pre", "", name === "run_js" && args && typeof args === "object" && typeof (args as { code?: unknown }).code === "string" ? (args as { code: string }).code : typeof args === "string" ? args : JSON.stringify(args, null, 2));
    tb.append(h("div", "ra-tlabel", t.args), argsPre);
    const path = args && typeof args === "object" && typeof (args as { path?: unknown }).path === "string" ? (args as { path: string }).path : null;
    if (path && name !== "delete_file" && name !== "list_files" && name !== "search_files") {
      const acts = h("div", "ra-tacts");
      const o = h("button", "ra-open", `${t.open} ${path}`); o.type = "button"; o.addEventListener("click", () => openPath(path));
      const d = h("button", "ra-open", t.download); d.type = "button"; d.addEventListener("click", () => void panel.download(path));
      acts.append(o, d);
      tb.append(acts);
    }
    el.append(sum, tb);
    return { el, name, args, end, body: tb, update: null, result: null };
  };

  /**
   * Consecutive tool calls of a reply share one collapsed line — "Running read_file /x" while one runs,
   * "Ran 3 tool calls" when done, failures counted — and their cards only show when it is opened.
   */
  const groupIn = (body: HTMLElement): HTMLElement => {
    const last = body.lastElementChild;
    if (last instanceof HTMLDetailsElement && last.classList.contains("ra-tg")) return last.querySelector<HTMLElement>(".ra-tgb")!;
    const g = h("details", "ra-tg") as HTMLDetailsElement;
    const sum = h("summary");
    const inner = h("div", "ra-tgb");
    g.append(sum, inner);
    body.append(g);
    return inner;
  };
  /** "读取了 3 个文件，修改了 1 个文件" — counted by kind, distinct paths for file tools, in the order they first ran. */
  const describeCalls = (calls: Array<{ name: string; args: unknown }>): string => {
    const order: string[] = [];
    const seen = new Map<string, Set<string> | number>();
    for (const c of calls) {
      const kind = TOOL_KIND[c.name] ?? "Other";
      const key = kind === "Other" ? `Other:${c.name}` : kind;
      if (!seen.has(key)) { order.push(key); seen.set(key, kind === "Read" || kind === "Write" || kind === "Edit" || kind === "Delete" ? new Set<string>() : 0); }
      const v = seen.get(key)!;
      if (v instanceof Set) v.add(pathArg(c.args) ?? String(v.size)); else seen.set(key, v + 1);
    }
    return order.map((key) => {
      const v = seen.get(key)!;
      const n = String(v instanceof Set ? v.size : v);
      if (key.startsWith("Other:")) return t.actOther.replace("{name}", key.slice(6));
      return (t[`act${key}` as keyof Strings] as string).replace("{n}", n);
    }).join(lang === "zh" ? "，" : ", ");
  };
  /** "正在修改 第一章.md" — the call in progress, by kind, with its file name or argument summary. */
  const describeRunning = (c: { name: string; args: unknown }, el: HTMLElement): { verb: string; what: string; title?: string } => {
    const kind = TOOL_KIND[c.name] ?? "Other";
    const path = pathArg(c.args);
    const verb = t[`ing${kind}` as keyof Strings] as string;
    if (kind === "Other") return { verb: `${verb} ${c.name}`, what: el.querySelector(".ra-tsum")?.textContent ?? "" };
    if (kind === "Ask") return { verb, what: "" };
    if (path && kind !== "Search") return { verb, what: path.slice(path.lastIndexOf("/") + 1) || path, title: path };
    return { verb, what: el.querySelector(".ra-tsum")?.textContent ?? "" };
  };
  const refreshGroup = (cardEl: HTMLElement) => {
    const g = cardEl.closest<HTMLDetailsElement>(".ra-tg");
    if (!g) return;
    const all = Array.from(g.querySelectorAll<HTMLElement>(".ra-tgb > .ra-tool"));
    const running = all.filter((c) => c.querySelector(".ra-tend .ra-spin"));
    const failed = all.filter((c) => c.classList.contains("fail")).length;
    const sum = g.querySelector("summary")!;
    sum.replaceChildren();
    if (running.length) {
      const el = running[running.length - 1]!;
      const r = describeRunning(cardCall.get(el) ?? { name: el.querySelector(".ra-tname")?.textContent ?? "", args: undefined }, el);
      sum.append(h("span", "ra-spin"));
      const txt = h("span", "ra-tgt"); txt.append(`${r.verb} `); if (r.what) txt.append(h("code", "", r.what));
      if (r.title) txt.title = r.title;
      sum.append(txt);
    } else {
      const calls = all.map((el) => cardCall.get(el)).filter((c): c is { name: string; args: unknown } => !!c);
      const label = calls.length ? describeCalls(calls) : (all.length === 1 ? t.toolsDone1 : t.toolsDone.replace("{n}", String(all.length)));
      const txt = h("span", "ra-tgt", label); txt.title = all.length === 1 ? t.toolsDone1 : t.toolsDone.replace("{n}", String(all.length));
      sum.append(txt);
    }
    if (failed) sum.append(h("span", "ra-tgf", t.toolsFailed.replace("{n}", String(failed))));
    const chev = h("span", "ra-chev"); chev.innerHTML = I.chev(12);
    sum.append(chev);
  };

  const addCard = (id: string, name: string, args: unknown, body: HTMLElement): ToolCard => {
    const card = makeCard(name, args);
    groupIn(body).append(card.el);
    cards.set(id, card);
    refreshGroup(card.el);
    list.schedule();
    return card;
  };

  const finishCard = (card: ToolCard, status: ToolStatus, result: string, durationMs?: number) => {
    const ok = status === "ok";
    const fail = status === "error" || status === "blocked";
    card.end.replaceChildren();
    if (durationMs !== undefined) card.end.append(h("span", "", `${Math.round(durationMs)}ms`));
    const mark = h("span", ok ? "ok" : fail ? "fail" : "");
    if (ok) mark.innerHTML = I.check();
    else if (status === "error") mark.innerHTML = I.xcircle();
    else if (status === "blocked") { mark.innerHTML = I.ban(); mark.title = t.blocked; }
    else mark.textContent = t[status as "declined" | "skipped"] ?? status;
    card.end.append(mark);
    card.el.classList.toggle("fail", fail);
    card.update?.remove();
    if (!card.result) {
      card.result = h("pre", "");
      card.body.append(h("div", "ra-tlabel", status === "error" ? t.error : t.result), card.result);
    }
    card.result.textContent = result.length > 20_000 ? result.slice(0, 20_000) + "…" : result || t.emptyResult;
    refreshGroup(card.el);
    list.schedule();
  };

  const noteEl = (text: string, summary?: string, action?: { label: string; onClick: () => void }): HTMLElement => {
    const card = h("div", "ra-card");
    const head = h("div", "ra-ct" + (summary ? "" : " only"));
    head.innerHTML = I.layers() + `<span>${escapeHTML(text)}</span>`;
    card.append(head);
    if (summary) { const md = h("div", "ra-md"); renderMD(md, summary, false); card.append(md); }
    if (action) { const b = h("button", "ra-btn xs subtle", action.label); b.type = "button"; b.addEventListener("click", () => { b.disabled = true; action.onClick(); }); card.append(b); }
    return card;
  };
  const addNote = (text: string, summary?: string, action?: { label: string; onClick: () => void }) => { addRow({ render: () => noteEl(text, summary, action) }); list.schedule(); };
  /** A short notice sized to its text (a run that stopped at the turn limit); its button runs the action and removes the notice. */
  const addWarn = (text: string, action?: { label: string; onClick: () => void }, hint?: string) => {
    const row: VRow = {
      render: () => {
        const el = h("div", "ra-warn"); el.setAttribute("role", "status"); if (hint) el.title = hint;
        el.innerHTML = I.alert(14);
        el.append(h("span", "", text));
        if (action) { const b = h("button", "ra-btn xs", action.label); b.type = "button"; b.addEventListener("click", () => { list.remove(row); action.onClick(); }); el.append(b); }
        return el;
      },
    };
    addRow(row);
    list.schedule();
  };

  const addError = (message: string, retry?: () => void) => {
    const row: VRow = {
      render: () => {
        const card = h("div", "ra-err", message);
        if (retry) { const b = h("button", "ra-btn xs red-subtle", t.retry); b.type = "button"; b.addEventListener("click", () => { list.remove(row); retry(); }); card.append(b); }
        return card;
      },
    };
    addRow(row);
    list.schedule();
  };

  /** Rows for a saved transcript; each reply is built only when scrolled into view. */
  const renderHistory = (messages: ChatMessage[]) => {
    list.clear();
    cards.clear();
    histCalls.clear();
    active = null;
    type HistCall = { id: string; name: string; args: unknown; result?: string; status?: ToolStatus };
    type Item = { kind: "think"; text: string } | { kind: "text"; text: string } | { kind: "call"; call: HistCall };
    // One row per reply, as live: every turn between two user messages; text-less turns (thinking + tool calls) share a group.
    let last: { items: Item[]; calls: HistCall[]; start?: number; end?: number } | null = null;
    let lastUserTs: number | undefined;
    const flush = (atEnd = false) => {
      if (!last) return;
      const m = last; last = null;
      // A reply still being written (the session is running) is not folded yet.
      const fold = !(atEnd && agent?.busy);
      addRow({
        render: () => {
          const r = asstRow();
          for (const it of m.items) {
            if (it.kind === "think") {
              // Thinking during a chain of calls sits in the group, before the calls it led to.
              const [d] = thinkEl(it.text, true);
              const lastEl = r.body.lastElementChild;
              if (lastEl instanceof HTMLDetailsElement && lastEl.classList.contains("ra-tg")) lastEl.querySelector(".ra-tgb")!.append(d);
              else r.body.append(d);
            } else if (it.kind === "text") {
              const el = h("div", "ra-md"); renderFinal(el, it.text); r.body.append(el);
            } else {
              const c = it.call;
              const card = makeCard(c.name, c.args);
              groupIn(r.body).append(card.el);
              // A call still running (the session is mid-run) gets its card registered, so its tool_end lands.
              if (c.status) finishCard(card, c.status, c.result ?? "");
              else { if (c.id) cards.set(c.id, card); refreshGroup(card.el); }
            }
          }
          if (fold) foldReply(r.body, m.start !== undefined && m.end !== undefined ? m.end - m.start : undefined);
          return r.el!;
        },
      });
    };
    for (const m of messages) {
      if (m.role === "user") {
        flush();
        const s = typeof m.content === "string" ? summaryOf(m) : null;
        if (s !== null) { addNote(t.compacted, s); continue; }
        // The agent's own notes to the model (a loop warning) are not the user's messages.
        if (typeof m.content === "string" && m.content.startsWith("[environment]")) continue;
        lastUserTs = tsOf(m);
        addRow(userRow(m.content as string | ContentPart[], m));
      } else if (m.role === "assistant") {
        const text = textOfContent(m.content);
        const rs = (m as { reasoning_content?: unknown }).reasoning_content; const reasoning = typeof rs === "string" ? rs : "";
        if (!last) last = { items: [], calls: [], start: lastUserTs };
        last.end = tsOf(m) ?? last.end;
        if (reasoning) last.items.push({ kind: "think", text: reasoning });
        if (text) last.items.push({ kind: "text", text });
        for (const c of m.tool_calls ?? []) {
          let args: unknown = c.function.arguments;
          try { args = JSON.parse(c.function.arguments); } catch { /* keep the string */ }
          const call: HistCall = { id: c.id ?? "", name: c.function.name, args };
          last.items.push({ kind: "call", call });
          last.calls.push(call);
          if (call.id) histCalls.set(call.id, call);
        }
      } else if (m.role === "tool") {
        const text = textOfContent(m.content);
        const call = last?.calls.find((c) => c.id === (m.tool_call_id ?? ""));
        if (call) { call.result = text; call.status = statusOfResult(text); histCalls.delete(call.id); }
      }
    }
    flush(true);
    if (!messages.length) showEmpty();
    list.scrollToBottom();
  };

  /* --- composer --- */
  const setBusy = (busy: boolean) => {
    root.dataset.busy = busy ? "1" : "";
    ta.placeholder = busy ? fill(t.placeholderBusy) : (placeholder ?? t.placeholder);
    hint.textContent = fill(busy ? t.hintBusy : t.hintIdle);
    sendBtn.style.display = busy ? "none" : "";
    steerBtn.style.display = fuBtn.style.display = stopBtn.style.display = busy ? "" : "none";
    renderQueue();
  };
  const renderQueue = () => {
    const q = agent?.queued ?? [];
    queueEl.style.display = q.length ? "" : "none";
    queueEl.replaceChildren();
    if (!q.length) return;
    const hd = h("div", "ra-qh");
    hd.append(h("span", "", t.queued));
    const clear = h("button"); clear.type = "button"; clear.innerHTML = I.x(); clear.title = t.clear; clear.setAttribute("aria-label", t.clear);
    clear.addEventListener("click", () => { agent.clearQueue(); renderQueue(); });
    hd.append(clear);
    queueEl.append(hd);
    for (const item of q) {
      const l = h("div", "ra-qi");
      const x = h("button"); x.type = "button"; x.innerHTML = I.x(11); x.title = t.remove; x.setAttribute("aria-label", t.remove);
      x.addEventListener("click", () => { agent.dequeue(item.message); renderQueue(); });
      l.append(h("span", "ra-badge", item.kind === "steer" ? t.steer : t.followUp), h("span", "", textOfContent(item.message.content)), x);
      queueEl.append(l);
    }
  };
  const setAlert = (message?: string) => { alertEl.style.display = message ? "" : "none"; alertEl.textContent = message ?? ""; };

  const refreshCommands = async () => {
    const ws = agent?.workspace;
    if (!ws) { commands = []; return; }
    try {
      const [skills, templates] = await Promise.all([ws.skills(), listTemplates(ws)]);
      commands = [
        ...templates.map((p) => ({ name: p.name, description: p.description, kind: t.template })),
        ...skills.map((s) => ({ name: `skill:${s.name}`, description: s.description, kind: t.skill })),
      ];
    } catch { commands = []; }
  };
  let cmdsDismissed = false;
  const currentSuggestions = (): Command[] => {
    const v = ta.value;
    if (cmdsDismissed || !v.startsWith("/") || /\s/.test(v)) return [];
    return [...builtinCommands(), ...commands].filter((c) => `/${c.name}`.startsWith(v)).slice(0, 40);
  };
  const renderCmds = () => {
    const found = currentSuggestions();
    cmds.style.display = found.length ? "" : "none";
    cmds.replaceChildren();
    if (cmdIndex >= found.length) cmdIndex = 0;
    found.forEach((c, i) => {
      const b = h("button", i === cmdIndex ? "ra-cur" : ""); b.type = "button";
      b.append(h("span", "ra-cn", `/${c.name}`));
      if (c.args) b.append(h("span", "ra-ca", c.args));
      b.append(h("span", "ra-badge", c.kind), h("span", "ra-cd", c.description));
      b.addEventListener("mousedown", (e) => { e.preventDefault(); pickCommand(c); ta.focus(); });
      cmds.append(b);
      if (i === cmdIndex) b.scrollIntoView?.({ block: "nearest" });
    });
  };
  // Typing only touches the popover, once per frame; the transcript and the box never change size.
  const scheduleCmds = () => { if (cmdFrame === null) cmdFrame = requestAnimationFrame(() => { cmdFrame = null; renderCmds(); }); };

  /* --- attachments --- */
  const pendingFiles: Attachment[] = [];
  const renderFiles = () => { files.style.display = pendingFiles.length ? "" : "none"; };
  const removeFile = (a: Attachment) => { const i = pendingFiles.indexOf(a); if (i >= 0) pendingFiles.splice(i, 1); if (a.preview) URL.revokeObjectURL(a.preview); a.chip.remove(); renderFiles(); };
  const addFiles = async (list: ArrayLike<File> | null | undefined, paths: Array<string | undefined> = []) => {
    if (attachOpt === false || !list?.length) return;
    for (const [i, file] of Array.from(list).entries()) {
      if (file.size > MAX_ATTACHMENT) { ui.notify(`${file.name} ${t.tooLarge}`, "warning"); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
      const text = image ? null : decodeText(file, bytes);
      const preview = image ? URL.createObjectURL(file) : null;
      const chip = chipEl(safeName(file.name), fmtSize(file.size), preview);
      const x = h("button"); x.type = "button"; x.innerHTML = I.x(); x.title = t.remove; x.setAttribute("aria-label", t.remove);
      chip.append(x);
      const a: Attachment = { file, name: safeName(file.name), bytes, text, image, preview, chip, path: paths[i] };
      x.addEventListener("click", () => removeFile(a));
      pendingFiles.push(a);
      files.append(chip);
    }
    renderFiles();
    ta.focus();
  };
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { void addFiles(fileInput.files); fileInput.value = ""; });
  ta.addEventListener("paste", (e) => {
    const items = Array.from(e.clipboardData?.files ?? []);
    // Office apps put a picture of the selection next to its text: the text is what was meant.
    if (!items.length || e.clipboardData?.getData("text/plain")) return;
    e.preventDefault();
    void addFiles(items);
  });
  let dragDepth = 0;
  root.addEventListener("dragenter", (e) => { if (attachOpt === false || !e.dataTransfer?.types.includes("Files")) return; e.preventDefault(); dragDepth++; root.dataset.drop = "1"; });
  root.addEventListener("dragover", (e) => { if (root.dataset.drop) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; } });
  root.addEventListener("dragleave", () => { if (root.dataset.drop && --dragDepth <= 0) { dragDepth = 0; delete root.dataset.drop; } });
  root.addEventListener("drop", (e) => { if (!root.dataset.drop) return; e.preventDefault(); dragDepth = 0; delete root.dataset.drop; void addFiles(e.dataTransfer?.files); });

  /** The message to send: the text, the attachment list (saved to the directory, or inlined), and pictures for the model. */
  const buildContent = async (text: string, taken: Attachment[], target: Agent): Promise<string | ContentPart[]> => {
    if (!taken.length) return text;
    const ws = target.workspace;
    const lines: string[] = [];
    const parts: ContentPart[] = [];
    for (const a of taken) {
      const type = a.file.type || (a.text !== null ? "text/plain" : "application/octet-stream");
      if (ws) {
        const path = a.path && (await ws.exists(a.path)) ? a.path : await freePath(ws, uploadsDir, a.name);
        if (path !== a.path) await ws.write(path, a.text ?? a.bytes, type);
        lines.push(`- ${path} (${type}, ${fmtSize(a.file.size)})`);
        void panel.refresh();
      } else if (isPdf(a.name, a.file.type, a.bytes)) {
        // No directory to save it in: its text goes in the message (pdf.js, loaded now).
        let text = "";
        try { text = formatPdfText(a.name, await extractPdfText(a.bytes)); } catch (err) { text = `Could not read the PDF: ${(err as Error).message}`; }
        if (text.length > MAX_INLINE_TEXT) text = text.slice(0, MAX_INLINE_TEXT) + "\n[… truncated]";
        lines.push(`- ${a.name} (${type}, ${fmtSize(a.file.size)}) — its text below`);
        parts.push({ type: "text", text: `<file name="${a.name}">\n${text}\n</file>` });
      } else if (a.text !== null && a.text.length <= MAX_INLINE_TEXT) {
        lines.push(`- ${a.name} (${type}, ${fmtSize(a.file.size)}) — contents below`);
        parts.push({ type: "text", text: `<file name="${a.name}">\n${a.text}\n</file>` });
      } else lines.push(`- ${a.name} (${type}, ${fmtSize(a.file.size)}) — ${a.image ? "the picture below" : "not readable here"}`);
      if (a.image && a.file.size <= MAX_IMAGE_PART) {
        const b64 = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(a.file); });
        parts.push({ type: "image_url", image_url: { url: b64 } });
      }
    }
    const note = ws ? `${ATTACH_MARK} files the user attached, saved in the directory (read them with read_file):` : `${ATTACH_MARK} files the user attached:`;
    const content: ContentPart[] = [];
    if (text) content.push({ type: "text", text });
    content.push({ type: "text", text: `${note}\n${lines.join("\n")}` });
    content.push(...parts);
    return content;
  };

  let sending = false;
  const send = async (mode: "prompt" | "steer" | "followUp") => {
    const text = ta.value.trim();
    if ((!text && !pendingFiles.length) || !agent || sending) return;
    if (runBuiltin(text)) return;
    if (compacting) { ui.notify(t.compacting); return; }
    const a = agent;
    // The files are taken now, so a second Enter while they are being written cannot send them again.
    const taken = pendingFiles.splice(0);
    for (const f of taken) f.chip.remove();
    renderFiles();
    ta.value = ""; renderCmds(); setAlert();
    sending = true;
    let content: string | ContentPart[];
    try {
      content = await buildContent(text, taken, a);
    } catch (err) {
      // Nothing was sent: the text and the files go back where they were.
      ta.value = text;
      pendingFiles.unshift(...taken);
      for (const f of taken.slice().reverse()) files.prepend(f.chip);
      renderFiles();
      setAlert((err as Error).message);
      return;
    } finally {
      sending = false;
    }
    for (const f of taken) if (f.preview) URL.revokeObjectURL(f.preview);
    if (!a.busy) mode = "prompt";
    try {
      if (mode === "prompt") {
        // Drawn now; the agent's run_start hands this row its message.
        if (agent === a && !a.busy) awaitingRow = addUser(content);
        await a.prompt(content);
        return;
      }
      if (mode === "steer") a.steer(content);
      else void a.followUp(content).catch(() => undefined);
      renderQueue();
    } catch (err) { awaitingRow = null; setAlert((err as Error).message); }
  };

  ta.addEventListener("input", () => { cmdsDismissed = false; scheduleCmds(); });
  ta.addEventListener("keydown", (e) => {
    // Confirming a word in an input method is not sending (Safari reports it with keyCode 229).
    if (e.isComposing || e.keyCode === 229) return;
    const found = currentSuggestions();
    if (found.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = (cmdIndex + 1) % found.length; renderCmds(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = (cmdIndex - 1 + found.length) % found.length; renderCmds(); return; }
      if (e.key === "Tab") { e.preventDefault(); ta.value = `/${found[cmdIndex]!.name} `; renderCmds(); return; }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); pickCommand(found[cmdIndex]!); return; }
      if (e.key === "Escape") { cmdsDismissed = true; cmds.style.display = "none"; return; }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    // ⌘↵ on a Mac, Ctrl+↵ elsewhere queues a follow-up while the agent runs. Both modifiers are accepted
    // everywhere (⊞↵ too, when Windows lets the browser see it — the OS binds Win+Enter to Narrator); Alt+↵ still works.
    const queueKey = e.metaKey || e.ctrlKey || e.altKey;
    void send(agent?.busy ? (queueKey ? "followUp" : "steer") : "prompt");
  });
  ta.addEventListener("blur", () => { cmds.style.display = "none"; });
  ta.addEventListener("focus", () => renderCmds());
  sendBtn.addEventListener("click", () => void send("prompt"));
  steerBtn.addEventListener("click", () => void send("steer"));
  fuBtn.addEventListener("click", () => void send("followUp"));
  stopBtn.addEventListener("click", () => { ui.cancelAll(); void agent?.abort(); });
  log.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const pathEl = target.closest<HTMLElement>(".ra-path");
    if (pathEl?.dataset.path) { e.preventDefault(); openPath(pathEl.dataset.path); return; }
    const a = target.closest<HTMLAnchorElement>(".ra-md a[href]");
    if (a && agent?.workspace) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("/") && !href.startsWith("//")) { e.preventDefault(); const ws = agent.workspace; void ws.exists(href).then((ok) => { if (ok) openPath(href); else window.open(a.href, "_blank", "noopener"); }); return; }
    }
  });

  /* --- settings --- */
  type UserSettings = { model?: string; maxTurns?: number; maxTokens?: number; reasoningEffort?: string };
  const SET_KEY = `__runapps_agent_chat:${project}:settings`;
  const readSettings = (): UserSettings => { try { return JSON.parse(localStorage.getItem(SET_KEY) || "{}") as UserSettings; } catch { return {}; } };
  const writeSettings = (v: UserSettings) => { try { if (Object.keys(v).length) localStorage.setItem(SET_KEY, JSON.stringify(v)); else localStorage.removeItem(SET_KEY); } catch { /* private mode */ } };
  let userSettings: UserSettings = givenAgent ? {} : readSettings();
  let permChoice: "ask" | "auto" | null = null;  // not persisted: allowing everything is a per-page decision
  const hasSettings = opts.settings ?? !givenAgent;
  if (!hasSettings) setBtn.style.display = "none";
  type CatModel = { id: string; is_default?: boolean; max_input_tokens?: number; max_tokens?: number; options?: { inputs?: Record<string, { enum?: unknown[]; default?: unknown }> } };
  let modelsCache: CatModel[] | null = null;
  /** The thinking levels a model offers (`options.inputs.reasoning_effort`), or null when it has none. */
  const effortOf = (m: CatModel | undefined): { levels: string[]; def?: string } | null => {
    const f = m?.options?.inputs?.reasoning_effort;
    if (!f) return null;
    const levels = (f.enum ?? []).filter((v): v is string => typeof v === "string");
    return levels.length ? { levels, def: typeof f.default === "string" ? f.default : undefined } : null;
  };
  /** Puts the user's settings on an agent (every open session gets the same ones). */
  const applyTo = (ag: Agent, s: UserSettings, p: "ask" | "auto" | null) => {
    const hostEffort = (agentOpts.extra as { reasoning_effort?: unknown } | undefined)?.reasoning_effort;
    ag.configure({ model: s.model ?? agentOpts.model, maxTurns: s.maxTurns ?? agentOpts.maxTurns ?? 100, maxTokens: s.maxTokens ?? (typeof agentOpts.maxTokens === "number" ? agentOpts.maxTokens : "auto"), permissions: p ?? agentOpts.permissions ?? "ask", reasoningEffort: s.reasoningEffort ?? (typeof hostEffort === "string" ? hostEffort : null) });
    modelEl.textContent = ag.model ?? ""; modelEl.style.display = ag.model ? "" : "none";
  };
  const saveSettings = (next: UserSettings) => { userSettings = next; writeSettings(next); for (const ag of live.values()) applyTo(ag, next, permChoice); showUsage_(agent); };
  const loadModels = async (): Promise<CatModel[]> => {
    if (client) { try { modelsCache ??= (await client.models.list({ capability: "text" })) as unknown as CatModel[]; } catch { /* no catalogue */ } }
    return modelsCache ?? [];
  };
  const kTok = (n?: number) => (typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : "?");
  const openSettings = async () => {
    if (menu) { closeMenu(); return; }
    if (!agent) return;
    const a = agent;
    // This menu's own reference: another menu opened while the catalogue loads replaces it.
    const mine = h("div", "ra-menu ra-set");
    menu = mine;
    root.append(mine);
    const cur = a.settings;
    const modelSel = h("select");
    modelSel.append(new Option(t.sDefault, ""));
    const lim = h("div", "ra-lim");
    const effortSel = h("select");
    const effortNote = h("div", "ra-lim");
    const chosenModel = () => { const id = modelSel.value || modelsCache?.find((m) => m.is_default)?.id; return modelsCache?.find((x) => x.id === id); };
    const showLim = () => {
      const m = chosenModel();
      lim.textContent = m ? `${t.context} ${kTok(m.max_input_tokens)} · ${t.sMaxTokens} ${kTok(m.max_tokens)}` : "";
      // Thinking levels follow the model: the list is the catalogue's, the first entry its default.
      const eff = effortOf(m);
      const keep = effortSel.value;
      effortSel.replaceChildren(new Option(eff?.def ? `${t.sEffortDefault} · ${eff.def}` : t.sEffortDefault, ""));
      for (const l of eff?.levels ?? []) effortSel.append(new Option(l, l));
      effortSel.disabled = !eff;
      effortSel.value = eff && eff.levels.includes(keep) ? keep : "";
      effortNote.textContent = eff ? "" : t.sEffortNone;
      effortNote.style.display = eff ? "none" : "";
    };
    modelSel.addEventListener("change", showLim);
    if (client) {
      await loadModels();
      if (menu !== mine) return;
      for (const m of modelsCache ?? []) modelSel.append(new Option(`${m.id}${m.is_default ? " ★" : ""} · ${kTok(m.max_input_tokens)} / ${kTok(m.max_tokens)}`, m.id));
    }
    if (cur.model && !Array.from(modelSel.options).some((o) => o.value === cur.model)) modelSel.append(new Option(cur.model, cur.model));
    modelSel.value = cur.model ?? "";
    showLim();
    if (cur.reasoningEffort && Array.from(effortSel.options).some((o) => o.value === cur.reasoningEffort)) effortSel.value = cur.reasoningEffort;
    const turns = h("input"); turns.type = "number"; turns.min = "1"; turns.max = "1000"; turns.step = "1"; turns.value = String(cur.maxTurns);
    const tokMode = h("select"); tokMode.append(new Option(t.sAuto, "auto"), new Option(t.sMaxTokens, "n"));
    const tokN = h("input"); tokN.type = "number"; tokN.min = "256"; tokN.step = "256"; tokN.value = String(typeof cur.maxTokens === "number" ? cur.maxTokens : 8192);
    tokMode.value = typeof cur.maxTokens === "number" ? "n" : "auto"; tokN.style.display = tokMode.value === "n" ? "" : "none";
    tokMode.addEventListener("change", () => { tokN.style.display = tokMode.value === "n" ? "" : "none"; });
    const perm = h("select"); perm.append(new Option(t.sAsk, "ask"), new Option(t.sAutoPerm, "auto"));
    if (cur.permissions === "custom") { perm.append(new Option(t.sCustom, "custom")); }
    perm.value = cur.permissions;
    const field = (label: string, ...els: HTMLElement[]) => { const l = h("label"); l.append(h("span", "", label), ...els); return l; };
    const tokRow = h("div", "ra-row"); tokRow.append(tokMode, tokN);
    menu.append(field(t.sModel, modelSel), lim, field(t.sEffort, effortSel), effortNote, field(t.sMaxTurns, turns), field(t.sMaxTokens, tokRow), field(t.sPerms, perm));
    const btns = h("div", "ra-btns");
    const resetB = h("button", "ra-btn xs ghost", t.reset); resetB.type = "button";
    const applyB = h("button", "ra-btn xs solid", t.apply); applyB.type = "button";
    btns.append(resetB, applyB);
    menu.append(btns);
    resetB.addEventListener("click", () => { userSettings = {}; writeSettings({}); permChoice = null; for (const ag of live.values()) applyTo(ag, {}, null); closeMenu(); ui.notify(t.applied); showUsage_(agent); });
    applyB.addEventListener("click", () => {
      const next: UserSettings = {};
      if (modelSel.value) next.model = modelSel.value;
      const n = parseInt(turns.value, 10); if (Number.isFinite(n) && n > 0) next.maxTurns = Math.min(1000, n);
      if (tokMode.value === "n") { const k = parseInt(tokN.value, 10); if (Number.isFinite(k) && k > 0) next.maxTokens = k; }
      if (effortSel.value && !effortSel.disabled) next.reasoningEffort = effortSel.value;
      if (perm.value === "ask" || perm.value === "auto") permChoice = perm.value;
      saveSettings(next);
      closeMenu(); ui.notify(t.applied);
    });
  };
  setBtn.addEventListener("click", () => void openSettings());

  /* --- sessions menu --- */
  const closeMenu = () => { menu?.remove(); menu = null; };
  const openMenu = async () => {
    if (menu) { closeMenu(); return; }
    if (!agent?.workspace) return;
    const ws = agent.workspace;
    const mine = h("div", "ra-menu");
    menu = mine;
    root.append(mine);
    let found: SessionSummary[] = [];
    try { found = await ws.sessions.list(); } catch { /* none */ }
    if (menu !== mine) return;
    if (!found.length) mine.append(h("div", "ra-none", t.noSessions));
    for (const s of found) {
      const row = h("div", "ra-mi" + (s.id === agent.id ? " ra-cur" : ""));
      const b = h("button"); b.type = "button";
      const bg = live.get(s.id);
      const state = bg && bg !== agent ? (waiting.has(s.id) ? ` · ${t.waitingAnswer}` : bg.busy || bg.queued.length ? ` · ${t.running}` : "") : "";
      // The title line: the title shortens, the "Current" tag (and a spinner for a running session) always shows.
      const name = h("span", "ra-mt");
      if (state && !waiting.has(s.id)) name.append(h("span", "ra-spin"));
      name.append(h("span", "ra-mtt", s.title || t.untitled));
      if (s.id === agent.id) { name.append(h("span", "ra-now", t.current)); row.setAttribute("aria-current", "true"); }
      b.append(name, h("small", "", `${s.messages} ${t.messages} · ${new Date(s.savedAt).toLocaleString()}${state}`));
      b.addEventListener("click", () => { closeMenu(); void resume(s.id).catch((err) => ui.notify((err as Error).message, "error")); });
      const x = h("button", "ra-x"); x.type = "button"; x.innerHTML = I.trash(); x.title = t.delete; x.setAttribute("aria-label", t.delete);
      x.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeMenu();
        if (await modalConfirm(root, t.delete, t.confirmDelete, { danger: true, ok: t.delete, cancel: t.cancel })) await deleteSession(s.id, false, s.workspace).catch((err) => ui.notify((err as Error).message, "error"));
      });
      row.append(b, x);
      mine.append(row);
    }
    if (found.length) {
      const foot = h("div", "ra-mf");
      const all = h("button", "ra-btn xs ghost"); all.type = "button"; all.innerHTML = I.trash() + escapeHTML(t.deleteAll);
      all.addEventListener("click", async () => {
        closeMenu();
        if (!(await modalConfirm(root, t.deleteAll, t.confirmDeleteAll, { danger: true, ok: t.deleteAll, cancel: t.cancel }))) return;
        try {
          for (const s of found) await deleteSession(s.id, true, s.workspace);
          await newSession();
        } catch (err) { ui.notify((err as Error).message, "error"); }
      });
      foot.append(all);
      mine.append(foot);
    }
  };
  histBtn.addEventListener("click", () => void openMenu());
  newBtn.addEventListener("click", () => { closeMenu(); void newSession().catch((err) => ui.notify((err as Error).message, "error")); });
  document.addEventListener("click", onDocClick, true);
  function onDocClick(e: Event) { if (menu && !menu.contains(e.target as Node) && !histBtn.contains(e.target as Node) && !setBtn.contains(e.target as Node)) closeMenu(); }

  /* --- built-in commands --- */
  type Builtin = { name: string; aliases?: string[]; args?: string; run: (arg: string) => void | Promise<void> };
  const fail = (err: unknown) => ui.notify((err as Error).message, "error");
  let compacting = false;
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); return; } catch { /* not focused, or no permission: the old way */ }
    const area = h("textarea"); area.value = text; area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    root.append(area); area.select();
    const ok = document.execCommand("copy");
    area.remove(); ta.focus();
    if (!ok) throw new Error(t.error);
  };
  const lastReply = (): string => {
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      const m = agent.messages[i]!;
      if (m.role !== "assistant") continue;
      const text = textOfContent(m.content as string | ContentPart[]).trim();
      if (text) return text;
    }
    return "";
  };
  /** The conversation as Markdown: what was said, and the tools each turn called. */
  const transcriptMarkdown = (a: Agent): string => {
    const out = [`# ${titleOfAgent(a)}`, ""];
    for (const m of a.messages) {
      if (m.role === "tool" || m.role === "system") continue;
      const text = textOfContent(m.content as string | ContentPart[]).trim();
      const s = m.role === "user" && typeof m.content === "string" ? summaryOf(m) : null;
      if (s !== null) { out.push(`> **${t.compacted}**`, ">", ...s.split("\n").map((l) => `> ${l}`), ""); continue; }
      const calls = m.role === "assistant" ? (m.tool_calls ?? []) : [];
      if (!text && !calls.length) continue;
      out.push(`## ${m.role === "user" ? t.user : t.assistant}`, "");
      if (text) out.push(text, "");
      for (const c of calls) {
        let args: unknown = c.function.arguments;
        try { args = JSON.parse(c.function.arguments); } catch { /* as sent */ }
        const what = summarizeArgs(c.function.name, args);
        out.push(`- \`${c.function.name}\`${what ? ` ${what}` : ""}`);
      }
      if (calls.length) out.push("");
    }
    return out.join("\n");
  };
  const pickModel = (models: CatModel[], q: string): CatModel | undefined => {
    const l = q.toLowerCase();
    const exact = models.find((m) => m.id.toLowerCase() === l);
    if (exact) return exact;
    const part = models.filter((m) => m.id.toLowerCase().includes(l));
    return part.length === 1 ? part[0] : part.find((m) => m.id.toLowerCase().startsWith(l));
  };
  const builtins: Builtin[] = [
    { name: "help", run: () => {
      const lines = builtinCommands().map((c) => `- \`/${c.name}${c.args ? ` ${c.args}` : ""}\` — ${c.description}`);
      addNote(t.cmdsTitle, [...lines, "", t.cmdsMore].join("\n"));
    } },
    { name: "new", aliases: ["clear"], run: () => { closeMenu(); return newSession().then(() => undefined); } },
    { name: "resume", run: () => openMenu() },
    { name: "compact", args: t.cmdArgs.compact, run: async (focus) => {
      const a = agent;
      if (a.busy) { ui.notify(t.busyCmd, "warning"); return; }
      compacting = true;
      ui.notify(t.compacting);
      try {
        // The compaction event draws the summary.
        if (!(await a.compact(focus))) ui.notify(t.nothingToCompact);
      } finally { compacting = false; if (agent === a) showUsage_(a); }
    } },
    { name: "continue", run: async () => {
      if (agent.busy) { ui.notify(t.busyCmd, "warning"); return; }
      if (!agent.messages.length) { ui.notify(t.nothingToContinue); return; }
      await agent.continue();
    } },
    { name: "model", args: t.cmdArgs.model, run: async (q) => {
      if (!q) return openSettings();
      const m = pickModel(await loadModels(), q);
      if (!m) { ui.notify(t.unknownModel.replace("{name}", q), "warning"); return; }
      const next = { ...userSettings };
      if (m.is_default && !agentOpts.model) delete next.model; else next.model = m.id;
      // A thinking level the new model does not have would be refused.
      const eff = effortOf(m);
      if (next.reasoningEffort && !eff?.levels.includes(next.reasoningEffort)) delete next.reasoningEffort;
      saveSettings(next);
      ui.notify(t.modelSet.replace("{name}", m.id));
    } },
    { name: "effort", args: t.cmdArgs.effort, run: async (q) => {
      const models = await loadModels();
      const id = agent.model || models.find((x) => x.is_default)?.id;
      const m = models.find((x) => x.id === id);
      const eff = effortOf(m);
      const name = m?.id ?? id ?? "?";
      if (!eff) { ui.notify(`${name}: ${t.sEffortNone}`, "warning"); return; }
      const levels = eff.levels.join(" / ");
      if (!q) { ui.notify(t.effortLevels.replace("{model}", name).replace("{levels}", levels)); return; }
      const next = { ...userSettings };
      if (/^(default|auto|默认)$/i.test(q)) delete next.reasoningEffort;
      else if (eff.levels.includes(q.toLowerCase())) next.reasoningEffort = q.toLowerCase();
      else { ui.notify(t.unknownEffort.replace("{name}", q).replace("{model}", name).replace("{levels}", levels), "warning"); return; }
      saveSettings(next);
      ui.notify(t.effortSet.replace("{name}", next.reasoningEffort ?? (eff.def ? `${t.sEffortDefault} · ${eff.def}` : t.sEffortDefault)));
    } },
    { name: "context", run: async () => {
      const a = agent;
      const [c, lim] = await Promise.all([a.context(), a.limits()]);
      const pct = Math.round((c.used / c.window) * 100);
      const u = a.usage;
      const comp = agentOpts.compaction;
      const lines = [
        `- ${t.sModel}: ${a.model || (await loadModels()).find((m) => m.is_default)?.id || t.sDefault}`,
        `- ${t.context}: ${pct < 1 && c.used ? "<1" : pct}% · ${fmtTokens(c.used)} / ${fmtTokens(c.window)} tokens · ${t.sMaxTokens} ${fmtTokens(lim.output)}`,
        `- ${t.messagesLabel}: ${a.messages.length}`,
        u.calls ? `- ${fill(t.usageLine.replace("{cost}", fmtCost(u.total_cost)).replace("{tokens}", fmtTokens(u.prompt_tokens + u.completion_tokens)).replace("{calls}", String(u.calls)))}` : "",
        comp === false ? "" : `- ${t.autoCompact}: ${t.autoCompactAt.replace("{n}", fmtTokens(Math.min(16_384, Math.floor(c.window * 0.2))))}`,
        a.workspace ? `- ${t.directory}: \`${a.workspace.id}\`` : "",
      ].filter(Boolean);
      addNote(t.context, lines.join("\n"));
    } },
    { name: "copy", run: async () => {
      const text = lastReply();
      if (!text) { ui.notify(t.nothingToCopy); return; }
      await copyText(text);
      ui.notify(t.copiedReply);
    } },
    { name: "export", run: () => {
      if (!agent.messages.length) { ui.notify(t.nothingToCopy); return; }
      const name = titleOfAgent(agent).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "conversation";
      downloadBlob(`${name}.md`, transcriptMarkdown(agent), "text/markdown;charset=utf-8");
    } },
    { name: "files", run: () => filesBtn.click() },
    { name: "settings", run: () => openSettings() },
    { name: "debug", run: () => { if (debugOn) debugBtn.click(); else ui.notify(t.debugOff); } },
  ];
  /** The built-ins this chat offers now (the files, settings and debug ones only where their button shows). */
  const builtinCommands = (): Command[] => builtins
    .filter((b) => (b.name !== "files" || !!agent?.workspace) && (b.name !== "settings" || hasSettings) && (b.name !== "debug" || debugOn) && (!["new", "resume"].includes(b.name) || !givenAgent) && (b.name !== "resume" || !!agent?.workspace))
    .map((b) => ({ name: b.name, description: (t.cmd as Record<string, string>)[b.name] ?? "", kind: t.command, args: b.args, builtin: true }));
  /** `/name [arg]` naming a built-in: run it here (nothing goes to the model). */
  const runBuiltin = (text: string): boolean => {
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) return false;
    const key = m[1]!.toLowerCase();
    const b = builtins.find((x) => x.name === key || x.aliases?.includes(key));
    if (!b || !builtinCommands().some((c) => c.name === b.name)) return false;
    ta.value = ""; renderCmds();
    try { void Promise.resolve(b.run((m[2] ?? "").trim())).catch(fail); } catch (err) { fail(err); }
    return true;
  };
  /** A suggestion picked: a built-in runs at once when it needs no argument or its name is typed out; anything else is filled in for its arguments. */
  const pickCommand = (c: Command) => {
    if (c.builtin && (!c.args || ta.value.trim() === `/${c.name}`)) { ta.value = `/${c.name}`; void send("prompt"); return; }
    ta.value = `/${c.name} `; renderCmds();
  };

  /* --- wiring an agent --- */
  const showUsage_ = (a: Agent) => {
    const u = a.usage;
    usageText.textContent = u.calls ? t.usageLine.replace("{cost}", fmtCost(u.total_cost)).replace("{tokens}", fmtTokens(u.prompt_tokens + u.completion_tokens)).replace("{calls}", String(u.calls)) : "";
    if (!a.messages.length) { ring.style.display = "none"; return; }
    void a.context().then((c) => {
      if (agent !== a) return;
      // How full the context is, as a ring (like the app's own indicator); the numbers are in its tooltip.
      const ratio = Math.min(1, c.used / c.window);
      const pct = ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`;
      const r = 6, len = 2 * Math.PI * r;
      ring.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle class="tr" cx="8" cy="8" r="${r}"/><circle class="pr" cx="8" cy="8" r="${r}" stroke-dasharray="${len.toFixed(2)}" stroke-dashoffset="${(len * (1 - Math.max(ratio, 0.02))).toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
      ring.className = "ra-ring" + (ratio >= 0.9 ? " hi" : ratio >= 0.7 ? " mid" : "");
      ring.title = `${t.context} ${pct} · ${fmtTokens(c.used)} / ${fmtTokens(c.window)} tokens`;
      ring.setAttribute("aria-label", ring.title);
      ring.style.display = "";
    });
  };

  const attach = async (a: Agent) => {
    for (const u of unsub) u();
    unsub = [];
    if (agent && agent !== a) parked.set(agent.id, ui.park());
    agent = a;
    live.set(a.id, a);
    unwatchBackground(a);
    ui.restore(parked.get(a.id) ?? []);
    parked.delete(a.id);
    wake(a.id);
    markBackground();
    cards.clear();
    active = null;
    awaitingRow = null;
    modelEl.textContent = a.model ?? "";
    modelEl.style.display = a.model ? "" : "none";
    // A host's own agent has no sessions to switch between: the chat cannot make a new one.
    const hasSessions = !givenAgent && (sessions ?? !!a.workspace);
    histBtn.style.display = newBtn.style.display = hasSessions && a.workspace ? "" : "none";
    filesBtn.style.display = a.workspace ? "" : "none";
    panel.setWorkspace(a.workspace);
    dpanel.setAgent(a);
    list.clear();
    showEmpty();
    setBusy(a.busy);
    setAlert();
    if (!givenAgent) writeLast(project, a.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (name: string, fn: (ev: any) => void) => unsub.push(a.on(name as never, fn as never));
    on("run_start", (ev: { message: ChatMessage | null }) => {
      // A prompt sent from here was drawn then (awaitingRow); one from a queued follow-up or the host is drawn now; continue() has none.
      if (ev.message) {
        if (awaitingRow && !awaitingRow.msg) { awaitingRow.msg = ev.message; awaitingRow.update(); }
        else addUser(ev.message.content as string | ContentPart[], ev.message);
        void checkpoint(a, ev.message);
      }
      awaitingRow = null;
      active = null;
      replyStart = Date.now();
      setBusy(true);
    });
    on("turn_start", () => {
      flushActive(true);
      // A run's turns share one row (folded into "Worked for …" at the end); a turn starts its own text and thinking,
      // and consecutive text-less turns (thinking and tool calls) share one group, so a chain of calls reads as one step.
      if (active) { active.text = null; active.md = ""; active.drawn = undefined; active.drawnFinal = undefined; active.think = null; active.thinkBody = null; active.reasoning = ""; }
      queueMicrotask(renderQueue);
    });
    // Steering is drawn when it lands in the history (at a turn, or before the next prompt), once.
    on("steered", (ev: { messages: ChatMessage[] }) => {
      // The row in progress ends here: what the agent does after the steer is drawn below the user's message, not above it.
      closeActive();
      replyStart = Date.now();
      for (const m of ev.messages) addUser(m.content as string | ContentPart[], m);
      renderQueue();
    });
    on("queued", () => renderQueue());
    // The host rewound the agent itself: show what it has now.
    on("rewind", () => { if (agent === a) { renderHistory(a.messages); showUsage_(a); } });
    on("text_delta", (ev: { text: string }) => {
      const act = ensureActive();
      if (!act.text) { act.text = h("div", "ra-md"); act.body.append(act.text); }
      act.md = ev.text;
      scheduleRender();
    });
    on("reasoning_delta", (ev: { text: string }) => {
      const act = ensureActive();
      if (!act.think) {
        [act.think, act.thinkBody] = thinkEl("", false);
        // Inside the running group when the chain has started; otherwise before this turn's text.
        const last = act.body.lastElementChild;
        if (last instanceof HTMLDetailsElement && last.classList.contains("ra-tg") && !act.text) last.querySelector(".ra-tgb")!.append(act.think);
        else if (act.text) act.body.insertBefore(act.think, act.text);
        else act.body.append(act.think);
      }
      act.reasoning = ev.text;
      scheduleRender();
    });
    on("message_reset", () => { if (active) { active.md = ""; active.reasoning = ""; active.text?.remove(); active.text = null; active.think?.remove(); active.think = null; active.thinkBody = null; } });
    on("message_end", () => flushActive(true));
    on("tool_start", (ev: { id: string; name: string; args: unknown }) => { flushActive(true); addCard(ev.id, ev.name, ev.args, ensureActive().body); });
    on("tool_update", (ev: { id: string; content: string }) => {
      const c = cards.get(ev.id); if (!c) return;
      if (!c.update) { c.update = h("div", "ra-tupd"); c.el.append(c.update); }
      c.update.textContent = ev.content;
      list.schedule();
    });
    on("tool_end", (ev: { id: string; name: string; status: ToolStatus; result: string; durationMs: number }) => {
      const c = cards.get(ev.id);
      if (c) finishCard(c, ev.status, ev.result, ev.durationMs);
      else { const hc = histCalls.get(ev.id); if (hc) { hc.status = ev.status; hc.result = ev.result; histCalls.delete(ev.id); } }
      // tool_end carries no arguments: the card has them.
      const path = c?.args && typeof c.args === "object" ? (c.args as { path?: unknown }).path : undefined;
      if (ev.status === "ok" && typeof path === "string" && /^(write_file|edit_file|delete_file)$/.test(ev.name)) panel.changed(path);
    });
    on("compaction", (ev: { summary: boolean }) => {
      const first = a.messages[0];
      const s = first && typeof first.content === "string" ? summaryOf(first) : null;
      addNote(ev.summary ? t.compacted : t.trimmed, ev.summary && s ? s : undefined);
    });
    on("run_end", (r: RunResult) => {
      closeActive();
      ui.cancelAll();
      if (r.reason === "error" && r.error) addError(r.error.message, a.messages.length ? () => void a.continue().catch((e) => ui.notify((e as Error).message, "error")) : undefined);
      else if (r.reason === "max_turns") addWarn(t.maxTurns.replace("{n}", String(a.settings.maxTurns)), { label: t.continueRun, onClick: () => { try { void a.continue().catch((e) => ui.notify((e as Error).message, "error")); } catch (e) { ui.notify((e as Error).message, "error"); } } }, t.maxTurnsHint);
      else if (r.reason === "aborted") addNote(t.stopped);
      setBusy(false);
      showUsage_(a);
      void refreshCommands();
      void panel.refresh();
    });

    try { await a.ready(); } catch (err) { addError((err as Error).message); }
    if (agent !== a || !mounted) return;
    onSession?.(a);
    renderHistory(a.messages);
    showUsage_(a);
    await refreshCommands();
  };

  const newId = () => `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  /** An agent for session `id`; with a workspace factory, the session's own directory (opened under the same id). */
  const makeAgent = async (id?: string): Promise<Agent> => {
    const sid = id ?? newId();
    const workspace = typeof wsOpt === "function" ? await wsOpt(sid) : wsOpt ?? null;
    const instructions = workspace ? [agentOpts.instructions, filesHint(uploadsDir)].filter(Boolean).join("\n\n") : agentOpts.instructions;
    const over: Partial<AgentOptions> = {};
    if (userSettings.model) over.model = userSettings.model;
    if (userSettings.maxTurns) over.maxTurns = userSettings.maxTurns;
    if (userSettings.maxTokens) over.maxTokens = userSettings.maxTokens;
    if (userSettings.reasoningEffort) over.extra = { ...(agentOpts.extra ?? {}), reasoning_effort: userSettings.reasoningEffort };
    if (permChoice) over.permissions = permChoice;
    return new Agent(client!, { ...agentOpts, ...over, instructions, id: sid, workspace, ui: agentOpts.ui ?? uiFor(sid) });
  };

  /** Closes the workspace the chat opened for a session it no longer holds (it reopens on resume). */
  const release = (a: Agent) => { if (typeof wsOpt === "function") a.workspace?.close(); };
  let switching: Promise<Agent> | null = null;
  const switchTo = (id?: string): Promise<Agent> => {
    if (givenAgent) return Promise.reject(new Error("runapps agent: newSession/resume need the chat to own its agent (pass a client, not an agent)"));
    // One switch at a time: a double click on New chat makes one new session, not two.
    if (switching) return switching;
    const run = (async () => {
      if (id && id === agent?.id) return agent;
      const prev = agent;
      if (prev) {
        if (prev.busy || prev.queued.length > 0) {
          if (background().length >= MAX_BACKGROUND) { ui.notify(t.bgLimit.replace("{n}", String(background().length)), "warning"); return prev; }
          watchBackground(prev);  // keeps running; its questions wait for the user to come back
        } else { live.delete(prev.id); release(prev); }  // idle and saved: rebuilt from storage when resumed
      }
      const a = (id && live.get(id)) || await makeAgent(id);
      await attach(a);
      return a;
    })();
    switching = run;
    void run.finally(() => { if (switching === run) switching = null; }).catch(() => undefined);
    return run;
  };
  const newSession = () => switchTo();
  const resume = (id: string) => switchTo(id);
  const deleteSession = async (id: string, keepOpen = false, space?: string) => {
    await ready;
    if (givenAgent) throw new Error("runapps agent: deleteSession needs the chat to own its agent (pass a client, not an agent)");
    const ws = agent.workspace;
    if (!ws) return;
    if (id !== agent.id) {
      const bg = live.get(id);
      if (bg) {
        // Its questions are answered "no" first, so the abort does not wait on a dialog nobody will see.
        wake(id, false);
        parked.delete(id);
        await bg.abort();
        live.delete(id); unwatchBackground(bg); release(bg); markBackground();
      }
      await ws.sessions.delete(id, space);
      return;
    }
    // The open session: stop it, drop its directory (files, skills, the saved session) and start afresh.
    ui.cancelAll();
    await agent.abort();
    if (typeof wsOpt === "function") await ws.destroy(); else await ws.sessions.delete(id, ws.id);
    writeLast(project, null);
    if (!keepOpen) await newSession();
  };

  // Which session opens first: an explicit id, else the one last open here, else a new one.
  const firstId = agentOpts.id ?? (typeof resumeOpt === "string" ? resumeOpt : resumeOpt === false ? undefined : readLast(project) ?? undefined);
  const starting = givenAgent ? Promise.resolve(givenAgent) : makeAgent(firstId);
  const ready = starting.then((a) => attach(a));
  ready.catch((err) => {
    // No session could be opened (the workspace factory or the agent threw): say so instead of a dead chat.
    addError(`${(err as Error).message}`);
    setBusy(false);
  });

  // `prompt()` from the host: draw the message here, not from run_start.
  const promptFromHost = async (text: string) => {
    await ready;
    if (!agent.busy) awaitingRow = addUser(text);
    return agent.prompt(text);
  };
  return {
    get agent() { return agent ?? givenAgent!; },
    get ready() { return ready; },
    element: root,
    ui,
    prompt: promptFromHost,
    setInput(text) { ta.value = text; ta.focus(); renderCmds(); },
    newSession,
    resume,
    deleteSession: (id) => deleteSession(id),
    setDebug(on) { debugOn = on; applyDebug(); },
    setAppearance(o) {
      if (o.theme) themeNow = o.theme;
      if (o.palette) paletteNow = o.palette;
      if (o.vars !== undefined) varsNow = o.vars;
      applyAppearance();
    },
    refresh: refreshCommands,
    unmount() {
      if (!mounted) return;
      mounted = false;
      for (const u of unsub) u();
      ui.cancelAll(true);
      closeMenu();
      document.removeEventListener("click", onDocClick, true);
      media?.removeEventListener?.("change", onScheme);
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (cmdFrame !== null) cancelAnimationFrame(cmdFrame);
      list.dispose();
      panel.dispose();
      dpanel.dispose();
      for (const f of pendingFiles) if (f.preview) URL.revokeObjectURL(f.preview);
      for (const id of [...waiters.keys()]) wake(id, false);
      if (!givenAgent) for (const a of live.values()) { unwatchBackground(a); void a.abort().finally(() => release(a)); }
      root.remove();
    },
  };
}
