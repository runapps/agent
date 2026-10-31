// `renderChat(target, opts)`: the element becomes a chat with an agent —
// transcript (Markdown replies, thinking, tool cards, compaction notes),
// composer (Enter sends, steer / follow-up while running, slash
// commands for skills and templates), questions the agent asks rendered
// inline, a session menu when there is a workspace. Plain DOM, no
// framework, styles injected once; the host gives the element a height.
//
// Look and behaviour follow the harness app's chat (React/Chakra, purple
// palette): a right-aligned user bubble, a 26 px avatar before replies,
// collapsible tool cards with an icon, duration and status, a fixed-
// height composer that never resizes while typing, and a virtual
// transcript (`VirtualList`) that keeps only the rows near the viewport
// in the DOM, so a long history costs nothing to open.

import type { RunApps } from "@runappsai/sdk";
import type { ChatMessage, ContentPart } from "@runappsai/sdk";
import { Agent } from "./agent.js";
import type { Workspace } from "./workspace.js";
import { summaryOf } from "./compaction.js";
import { escapeHTML, renderMarkdown } from "./markdown.js";
import { listTemplates } from "./templates.js";
import { VirtualList, type VRow } from "./vlist.js";
import { h, I, modalConfirm, downloadBlob } from "./dom.js";
import { filesPanel, freePath, type FilesPanel } from "./files-panel.js";
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
  /** Dialog language (default: the document's). */
  locale?: "zh" | "en";
  /** `"auto"` (default) follows the system; `"light"` / `"dark"` force one. */
  theme?: "auto" | "light" | "dark";
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
  /** Removes the chat; an agent the chat made is stopped (a host's `agent` is left running). */
  unmount(): void;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const STRINGS = {
  en: {
    assistant: "Assistant", placeholder: "Ask the agent to do something…  type / for commands", placeholderBusy: "Running: Enter steers, Alt+Enter queues a follow-up",
    send: "Send", stop: "Stop", steer: "Steer", followUp: "Follow-up", steerTip: "Insert into the current task", followUpTip: "Queue after the current task",
    queued: "Queued messages", clear: "Clear queue", thinking: "Thinking…", thought: "Thought process",
    enter: "send", newline: "new line", empty: "Start a conversation", history: "History", newChat: "New chat", noSessions: "No saved conversations",
    compacted: "Context compacted", trimmed: "Earlier conversation trimmed to fit the context", allow: "Allow", decline: "Decline", cancel: "Cancel", submit: "Submit", ok: "OK",
    other: "Other…", typeAnswer: "Type your answer", args: "Arguments", result: "Result", error: "Error", declined: "declined", blocked: "blocked", skipped: "skipped",
    open: "Open in editor", stopped: "Stopped.", maxTurns: "Stopped after the maximum number of turns.", retry: "Retry", messages: "messages", skill: "Skill", template: "Template",
    delete: "Delete", deleteAll: "Delete all", confirmDelete: "Delete this conversation and its files?", confirmDeleteAll: "Delete every saved conversation and their files?", untitled: "New conversation",
    attach: "Attach files", drop: "Drop files to attach", tooLarge: "is too large (max 20 MB)", remove: "Remove", attachments: "Attachments",
    files: "Files", upload: "Upload", newFile: "New file", refresh: "Refresh", close: "Close", save: "Save", download: "Download", confirmDeleteFile: "Delete {path}?", newFilePath: "Path of the new file",
    noPreview: "No preview for this file; download it.", changedByAgent: "changed by the agent", noFiles: "The directory is empty.", discard: "Discard unsaved changes?", saved: "Saved", pickFile: "Choose files", folder: "Folder",
  },
  zh: {
    assistant: "助手", placeholder: "让 agent 做点什么…  输入 / 查看命令", placeholderBusy: "运行中：Enter 插入指令 (steer)，Alt+Enter 排队 (follow-up)",
    send: "发送", stop: "停止", steer: "Steer", followUp: "Follow-up", steerTip: "插入到当前任务 (steer)", followUpTip: "排到当前任务之后 (follow-up)",
    queued: "排队中的消息", clear: "清空队列", thinking: "思考中…", thought: "思考过程",
    enter: "发送", newline: "换行", empty: "开始对话", history: "历史", newChat: "新对话", noSessions: "还没有保存的对话",
    compacted: "上下文已压缩", trimmed: "较早的对话已裁剪以适应上下文", allow: "允许", decline: "拒绝", cancel: "取消", submit: "提交", ok: "确定",
    other: "其他…", typeAnswer: "请输入", args: "参数", result: "结果", error: "错误", declined: "已拒绝", blocked: "已拦截", skipped: "已跳过",
    open: "在编辑器中打开", stopped: "已停止。", maxTurns: "达到最大轮数，已停止。", retry: "重试", messages: "条消息", skill: "Skill", template: "模板",
    delete: "删除", deleteAll: "全部删除", confirmDelete: "删除这个对话和它的文件？", confirmDeleteAll: "删除所有已保存的对话和它们的文件？", untitled: "新对话",
    attach: "添加附件", drop: "松开即可添加附件", tooLarge: "太大了（最大 20 MB）", remove: "移除", attachments: "附件",
    files: "文件", upload: "上传", newFile: "新建文件", refresh: "刷新", close: "关闭", save: "保存", download: "下载", confirmDeleteFile: "删除 {path}？", newFilePath: "新文件的路径",
    noPreview: "这个文件无法预览，可以下载。", changedByAgent: "agent 改过", noFiles: "目录是空的。", discard: "放弃未保存的修改？", saved: "已保存", pickFile: "选择文件", folder: "文件夹",
  },
};
type Strings = typeof STRINGS.en;

function pickLocale(opt?: "zh" | "en"): "zh" | "en" {
  if (opt) return opt;
  const lang = (typeof document !== "undefined" && document.documentElement.lang) || (typeof navigator !== "undefined" ? navigator.language : "") || "";
  return /^zh/i.test(lang) ? "zh" : "en";
}

/* ------------------------------------------------------------------ */
/* Styles — Chakra's purple palette and gray scale, as the harness app  */
/* ------------------------------------------------------------------ */

const STYLE_ID = "runapps-agent-chat-style";
const LIGHT = "--ra-bg:#fff;--ra-panel:#fff;--ra-subtle:#fafafa;--ra-muted:#f4f4f5;--ra-fg:#09090b;--ra-fg-muted:#52525b;--ra-border:#e4e4e7;--ra-p-subtle:#f3e8ff;--ra-p-muted:#e9d5ff;--ra-p-fg:#7e22ce;--ra-p-solid:#9333ea;--ra-ok:#16a34a;--ra-red:#dc2626;--ra-red-subtle:#fef2f2;--ra-shadow:0 1px 2px rgba(0,0,0,.05);--ra-shadow-md:0 4px 12px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06)";
const DARK = "--ra-bg:#09090b;--ra-panel:#09090b;--ra-subtle:#101014;--ra-muted:#18181b;--ra-fg:#fafafa;--ra-fg-muted:#a1a1aa;--ra-border:#27272a;--ra-p-subtle:#3b0764;--ra-p-muted:#581c87;--ra-p-fg:#d8b4fe;--ra-p-solid:#9333ea;--ra-ok:#4ade80;--ra-red:#f87171;--ra-red-subtle:#2a1215;--ra-shadow:0 1px 2px rgba(0,0,0,.4);--ra-shadow-md:0 4px 16px rgba(0,0,0,.5),0 1px 2px rgba(0,0,0,.4);color-scheme:dark";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';
const CSS = `
.ra-chat{${LIGHT};display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--ra-bg);color:var(--ra-fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Noto Sans SC",Arial,sans-serif;position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.ra-chat[data-theme=dark]{${DARK}}
@media (prefers-color-scheme:dark){.ra-chat[data-theme=auto]{${DARK}}}
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
.ra-chat .ra-btn.subtle{border-color:transparent;background:var(--ra-p-subtle);color:var(--ra-p-fg)}
.ra-chat .ra-btn.subtle:hover{background:var(--ra-p-muted)}
.ra-chat .ra-btn.solid{border-color:var(--ra-p-solid);background:var(--ra-p-solid);color:#fff}
.ra-chat .ra-btn.solid:hover{filter:brightness(1.08)}
.ra-chat .ra-btn.red{border-color:#dc2626;background:#dc2626;color:#fff}
.ra-chat .ra-btn.red:hover{filter:brightness(1.08)}
.ra-chat .ra-btn.red-subtle{border-color:transparent;background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-head{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--ra-border);flex-shrink:0;min-height:44px}
.ra-head .ra-title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-badge{display:inline-flex;align-items:center;font-size:11px;font-weight:500;color:var(--ra-fg-muted);border:1px solid var(--ra-border);border-radius:4px;padding:0 6px;line-height:18px;white-space:nowrap}
.ra-badge.p{background:var(--ra-p-subtle);color:var(--ra-p-fg);border-color:transparent}
.ra-head .ra-sp{flex:1}
.ra-menu{position:absolute;right:12px;top:42px;z-index:6;width:min(360px,calc(100% - 24px));max-height:60%;overflow:auto;background:var(--ra-panel);border:1px solid var(--ra-border);border-radius:8px;box-shadow:var(--ra-shadow-md);padding:4px}
.ra-menu .ra-mi{display:flex;align-items:center;gap:6px;border-radius:6px}
.ra-menu .ra-mi:hover{background:var(--ra-muted)}
.ra-menu .ra-mi.ra-cur{background:var(--ra-p-subtle)}
.ra-menu .ra-mi>button:first-child{flex:1;min-width:0;text-align:left;padding:6px 8px;font-size:13px}
.ra-menu .ra-mi>button:first-child>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-menu .ra-mi small{display:block;color:var(--ra-fg-muted);font-size:11px}
.ra-menu .ra-mi .ra-x{width:24px;height:24px;margin-right:4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted);opacity:0}
.ra-menu .ra-mi:hover .ra-x{opacity:1}
.ra-menu .ra-x:hover{background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-menu .ra-none{padding:8px 10px;color:var(--ra-fg-muted);font-size:13px}
.ra-menu .ra-mf{border-top:1px solid var(--ra-border);margin-top:4px;padding-top:4px;display:flex;justify-content:flex-end}
.ra-main{flex:1;min-height:0;display:flex;position:relative}
.ra-chat{container-type:inline-size}
.ra-chatcol{flex:1;min-width:0;display:flex;flex-direction:column}
.ra-fp{flex:0 0 380px;width:380px;min-width:0;border-left:1px solid var(--ra-border);background:var(--ra-subtle);display:flex;flex-direction:column;position:relative}
@container (max-width:760px){.ra-fp{position:absolute;inset:0;width:auto;flex:none;border-left:0;z-index:4}}
.ra-fph{display:flex;align-items:center;gap:2px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--ra-border);flex-shrink:0}
.ra-fph .ra-fpt{font-size:12px;font-weight:600;color:var(--ra-fg-muted);text-transform:uppercase;letter-spacing:.04em}
.ra-fph .ra-sp{flex:1}
.ra-chat .ra-ib{width:26px;height:26px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted)}
.ra-chat .ra-ib:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-tree{flex:1;min-height:0;overflow:auto;padding:4px}
.ra-fp.ra-editing .ra-tree{flex:0 1 auto;max-height:40%;border-bottom:1px solid var(--ra-border)}
.ra-fr{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;cursor:pointer;font-size:13px;min-height:26px}
.ra-fr:hover{background:var(--ra-panel)}
.ra-fr.ra-cur{background:var(--ra-p-subtle)}
.ra-fr .ra-frc{width:12px;display:inline-flex;color:var(--ra-fg-muted);flex-shrink:0}
.ra-fr .ra-fri{display:inline-flex;color:var(--ra-fg-muted);flex-shrink:0}
.ra-fr .ra-frn{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-dot{width:6px;height:6px;border-radius:50%;background:#f97316;flex-shrink:0}
.ra-fr .ra-fra{display:none;gap:0;flex-shrink:0}
.ra-fr:hover .ra-fra{display:inline-flex}
.ra-fr .ra-fra .ra-ib{width:22px;height:22px}
.ra-fpe{padding:8px 10px;font-size:12px;color:var(--ra-fg-muted)}
.ra-ed{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--ra-bg)}
.ra-edh{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-bottom:1px solid var(--ra-border);flex-shrink:0}
.ra-edh .ra-edp{flex:1;min-width:0;font:12px ${MONO};color:var(--ra-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-edh .ra-eda{display:inline-flex;align-items:center;gap:2px}
.ra-edb{flex:1;min-height:0;display:flex;flex-direction:column}
.ra-edta{flex:1;min-height:0;resize:none;padding:10px 12px;font:13px/1.55 ${MONO};tab-size:2;white-space:pre;overflow:auto}
.ra-edpv{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px}
.ra-edpv img{max-width:100%;max-height:100%;border-radius:4px}
.ra-fpdrop{position:absolute;inset:0;z-index:5;display:none;align-items:center;justify-content:center;background:rgba(147,51,234,.08);border:2px dashed var(--ra-p-solid);color:var(--ra-p-fg);font-weight:600;pointer-events:none}
.ra-fp[data-drop="1"] .ra-fpdrop{display:flex}
.ra-md .ra-path{display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:var(--ra-p-fg);background:var(--ra-p-subtle);text-decoration:none}
.ra-md .ra-path:hover{background:var(--ra-p-muted)}
.ra-tool .ra-tacts{display:flex;gap:10px}
.ra-log{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.ra-log .ra-col{padding-top:6px;padding-bottom:6px}
.ra-row{padding:10px 0}
.ra-empty{padding:48px 0 24px;text-align:center;color:var(--ra-fg-muted)}
.ra-sugs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:16px}
.ra-sugs button{border:1px solid var(--ra-border);border-radius:999px;padding:5px 12px;font-size:13px;color:var(--ra-fg)}
.ra-sugs button:hover{background:var(--ra-muted)}
.ra-user{display:flex;justify-content:flex-end}
.ra-user .ra-bubble{max-width:85%;background:var(--ra-p-subtle);border-radius:12px;padding:8px 14px;white-space:pre-wrap;word-break:break-word;font-size:14px}
.ra-user img{display:block;max-width:240px;border-radius:4px;margin-top:6px}
.ra-asst{display:flex;gap:10px;align-items:flex-start}
.ra-avatar{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--ra-p-subtle);color:var(--ra-p-fg);display:flex;align-items:center;justify-content:center;margin-top:2px}
.ra-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.ra-md{font-size:14px;line-height:1.65;word-break:break-word;overflow-wrap:anywhere}
.ra-md>:first-child{margin-top:0}.ra-md>:last-child{margin-bottom:0}
.ra-md p{margin:.5em 0}.ra-md h1,.ra-md h2,.ra-md h3,.ra-md h4{margin:1em 0 .4em;line-height:1.3;font-weight:650}.ra-md h1{font-size:1.35em}.ra-md h2{font-size:1.2em}.ra-md h3{font-size:1.05em}
.ra-md strong{font-weight:650}
.ra-md ul,.ra-md ol{margin:.4em 0;padding-left:1.4em}.ra-md li{margin:.15em 0}
.ra-md code{font:.88em/1.5 ${MONO};background:var(--ra-muted);padding:.1em .35em;border-radius:4px}
.ra-md .ra-cb{margin:.7em 0;border:1px solid var(--ra-border);border-radius:6px;overflow:hidden}
.ra-md .ra-cbh{display:flex;align-items:center;justify-content:space-between;padding:4px 10px;border-bottom:1px solid var(--ra-border);background:var(--ra-muted);color:var(--ra-fg-muted);font:12px ${MONO}}
.ra-md .ra-cbh button{display:inline-flex;padding:3px;border-radius:4px;color:inherit}
.ra-md .ra-cbh button:hover{background:var(--ra-panel)}
.ra-md pre{margin:0;padding:10px 12px;overflow:auto;font:12.5px/1.55 ${MONO}}
.ra-md pre code{background:none;padding:0;font:inherit}
.ra-md blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid var(--ra-p-solid);color:var(--ra-fg-muted)}
.ra-md .ra-tw{margin:.7em 0;overflow:auto;border:1px solid var(--ra-border);border-radius:6px}
.ra-md table{border-collapse:collapse;width:100%;font-size:.95em}
.ra-md th,.ra-md td{padding:6px 10px;border-bottom:1px solid var(--ra-border);text-align:left}.ra-md thead{background:var(--ra-muted)}.ra-md th{font-weight:600}.ra-md tr:last-child td{border-bottom:0}
.ra-md hr{border:0;border-top:1px solid var(--ra-border);margin:1em 0}
.ra-md a{color:var(--ra-p-fg);text-decoration:underline;text-underline-offset:2px}
.ra-md img{max-width:100%;border-radius:4px}
.ra-cursor>:last-child::after{content:"";display:inline-block;width:7px;height:14px;background:var(--ra-fg-muted);margin-left:2px;vertical-align:-2px;animation:ra-blink 1s steps(2) infinite;border-radius:1px}
@keyframes ra-blink{50%{opacity:0}}
.ra-think summary{cursor:pointer;color:var(--ra-fg-muted);font-size:12px;list-style:none;display:inline-flex;align-items:center;gap:6px;user-select:none;padding:2px 0}
.ra-think summary::-webkit-details-marker{display:none}
.ra-think summary .ra-chev{transition:transform .15s}
.ra-think[open] summary .ra-chev{transform:rotate(90deg)}
.ra-think .ra-think-body{font-size:12px;color:var(--ra-fg-muted);white-space:pre-wrap;border-left:2px solid var(--ra-border);padding-left:12px;margin:4px 0 0 4px;max-height:280px;overflow:auto}
.ra-tool{border:1px solid var(--ra-border);border-radius:6px;overflow:hidden;font-size:14px}
.ra-tool.fail{border-color:var(--ra-red)}
.ra-tool>summary{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none;user-select:none}
.ra-tool>summary::-webkit-details-marker{display:none}
.ra-tool>summary:hover{background:var(--ra-muted)}
.ra-tool>summary .ra-chev{color:var(--ra-fg-muted);transition:transform .15s}
.ra-tool[open]>summary .ra-chev{transform:rotate(90deg)}
.ra-tool .ra-ticon{width:20px;height:20px;border-radius:4px;background:var(--ra-p-subtle);color:var(--ra-p-fg);display:inline-flex;align-items:center;justify-content:center}
.ra-tool.fail .ra-ticon{background:var(--ra-red-subtle);color:var(--ra-red)}
.ra-tool .ra-tname{font-weight:600;white-space:nowrap}
.ra-tool .ra-tsum{flex:1;min-width:0;color:var(--ra-fg-muted);font:13px ${MONO};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-tool .ra-tend{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:var(--ra-fg-muted);white-space:nowrap}
.ra-tool .ra-tend .ok{color:var(--ra-ok);display:inline-flex}.ra-tool .ra-tend .fail{color:var(--ra-red);display:inline-flex}
.ra-spin{width:12px;height:12px;border:2px solid var(--ra-border);border-top-color:var(--ra-p-solid);border-radius:50%;animation:ra-spin .8s linear infinite;flex-shrink:0}
@keyframes ra-spin{to{transform:rotate(360deg)}}
.ra-tool .ra-tbody{border-top:1px solid var(--ra-border);padding:4px 10px 10px;display:flex;flex-direction:column;gap:8px}
.ra-tool .ra-tlabel{font-size:12px;color:var(--ra-fg-muted);margin:4px 0}
.ra-tool pre{margin:0;background:var(--ra-muted);border-radius:4px;padding:8px;max-height:280px;overflow:auto;font:12px/1.5 ${MONO};white-space:pre-wrap;word-break:break-word}
.ra-tool .ra-tupd{font-size:12px;color:var(--ra-fg-muted);padding:0 10px 8px;white-space:pre-wrap}
.ra-tool .ra-open{font-size:12px;color:var(--ra-p-fg);align-self:flex-start;text-decoration:underline;text-underline-offset:2px}
.ra-card{border:1px solid var(--ra-border);background:var(--ra-muted);border-radius:6px;padding:12px}
.ra-card .ra-ct{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;margin-bottom:6px}
.ra-card .ra-ct.only{margin-bottom:0;font-weight:500;color:var(--ra-fg-muted)}
.ra-card .ra-md{font-size:13px}
.ra-err{border:1px solid var(--ra-red);background:var(--ra-red-subtle);border-radius:6px;padding:8px;font-size:14px;color:var(--ra-red);white-space:pre-wrap;word-break:break-word}
.ra-err .ra-btn{margin-top:6px}
.ra-ask{flex-shrink:0;max-height:45%;overflow-y:auto}
.ra-ask .ra-col{display:flex;flex-direction:column;gap:8px;padding-top:8px;padding-bottom:8px}
.ra-q{border:1px solid var(--ra-p-muted);border-radius:8px;padding:12px;background:var(--ra-subtle);display:flex;flex-direction:column;gap:10px}
.ra-q .ra-qt{font-weight:600;font-size:14px}
.ra-q .ra-qm{font-size:14px;white-space:pre-wrap}
.ra-q .ra-opts{display:flex;flex-direction:column;gap:4px}
.ra-q .ra-opt{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--ra-border);border-radius:6px;padding:6px 12px;text-align:left;width:100%;background:var(--ra-bg);font-size:14px;min-height:32px}
.ra-q .ra-opt:hover{background:var(--ra-muted)}
.ra-q .ra-opt input[type=radio],.ra-q .ra-opt input[type=checkbox]{width:auto;flex:none;margin:4px 0 0;accent-color:var(--ra-p-solid)}
.ra-q .ra-opt>div,.ra-q .ra-opt>span{flex:1;min-width:0}
.ra-q .ra-opt small{display:block;color:var(--ra-fg-muted);font-size:12px}
.ra-q .ra-field{border:1px solid var(--ra-border);border-radius:6px;padding:6px 10px;background:var(--ra-bg);width:100%;font-size:14px}
.ra-q .ra-field:focus{border-color:var(--ra-p-solid)}
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
.ra-box:focus-within{border-color:var(--ra-p-solid)}
.ra-box textarea{resize:none;height:96px;overflow-y:auto;padding:2px 4px;line-height:1.5;display:block}
.ra-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;min-height:32px}
.ra-bar .ra-hint{font-size:12px;color:var(--ra-fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-kbd{display:inline-block;font:11px/1.4 ${MONO};border:1px solid var(--ra-border);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--ra-muted);color:var(--ra-fg)}
.ra-bar .ra-acts{display:flex;gap:6px;align-items:center}
.ra-chat .ra-send{width:32px;height:32px;border-radius:50%;background:var(--ra-p-solid);color:#fff;display:inline-flex;align-items:center;justify-content:center}
.ra-chat .ra-send:hover{filter:brightness(1.08)}
.ra-cmds{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:5;background:var(--ra-panel);border:1px solid var(--ra-border);border-radius:6px;box-shadow:var(--ra-shadow-md);padding:4px;max-height:260px;overflow:auto}
.ra-cmds button{display:flex;gap:8px;align-items:center;width:100%;text-align:left;padding:6px 8px;border-radius:4px;font-size:13px}
.ra-cmds button:hover,.ra-cmds button.ra-cur{background:var(--ra-muted)}
.ra-cmds .ra-cn{font:600 14px ${MONO}}
.ra-cmds .ra-cd{font-size:12px;color:var(--ra-fg-muted);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-chat .ra-attach{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--ra-fg-muted);margin-right:4px}
.ra-chat .ra-attach:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-bar .ra-left{display:flex;align-items:center;min-width:0}
.ra-files{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 6px}
.ra-chip{display:inline-flex;align-items:center;gap:6px;max-width:min(100%,320px);border:1px solid var(--ra-border);border-radius:6px;padding:3px 6px 3px 4px;font-size:12px;background:var(--ra-subtle);white-space:nowrap}
.ra-chip img{width:28px;height:28px;object-fit:cover;border-radius:4px}
.ra-chip .ra-ci{width:28px;height:28px;border-radius:4px;background:var(--ra-p-subtle);color:var(--ra-p-fg);display:inline-flex;align-items:center;justify-content:center}
.ra-chip .ra-cn{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-chip small{flex:none;color:var(--ra-fg-muted);font-size:11px;white-space:nowrap}
.ra-chip img,.ra-chip .ra-ci,.ra-chip button{flex:none}
.ra-chip button{width:18px;height:18px;border-radius:4px;color:var(--ra-fg-muted);display:inline-flex;align-items:center;justify-content:center}
.ra-chip button:hover{background:var(--ra-muted);color:var(--ra-fg)}
.ra-user .ra-files{justify-content:flex-end;padding:0;margin-top:6px}
.ra-user .ra-chip{background:var(--ra-bg)}
.ra-drop{position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;background:rgba(147,51,234,.08);border:2px dashed var(--ra-p-solid);border-radius:8px;color:var(--ra-p-fg);font-weight:600;pointer-events:none}
.ra-chat[data-drop="1"] .ra-drop{display:flex}
.ra-usage{font-size:11px;color:var(--ra-fg-muted);text-align:right;margin-top:6px;min-height:14px}
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
  document.head.append(s);
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

function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return `$${usd.toFixed(5)}`;
  if (usd < 0.1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}
function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_IMAGE_PART = 8 * 1024 * 1024;
const MAX_INLINE_TEXT = 64 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|sql|ini|cfg|conf|log|env|svg|tex|rst)$/i;
const ATTACH_MARK = "[attachments]";
/** Added to the agent's instructions when it has a directory: how to hand a file to the user. */
const FILES_HINT = "The user can browse, edit and download every file of the directory from the chat's Files panel. When you create or change a file for the user, name its absolute path in backticks (for example `/uploads/report.csv`); in the chat that path becomes a link that opens the file, with a download button. Files the user attaches arrive under /uploads.";

/** A file the user attached: read once, saved to the directory (or inlined) when the message is sent. */
interface Attachment { file: File; name: string; bytes: Uint8Array; text: string | null; image: boolean; preview: string | null; chip: HTMLElement }

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

/** Markdown → DOM, with a header (language, copy) on each code block and a scroll wrapper on tables. */
function renderMD(el: HTMLElement, md: string, streaming: boolean): void {
  el.innerHTML = renderMarkdown(md);
  el.classList.toggle("ra-cursor", streaming);
  for (const pre of Array.from(el.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const lang = code?.className.match(/language-([\w+#-]+)/)?.[1] ?? "";
    const box = h("div", "ra-cb");
    const head = h("div", "ra-cbh");
    head.append(h("span", "", lang));
    const copy = h("button", "ra-copy"); copy.type = "button"; copy.innerHTML = I.copy(); copy.title = "copy";
    head.append(copy);
    pre.replaceWith(box);
    box.append(head, pre);
  }
  for (const table of Array.from(el.querySelectorAll("table"))) {
    const w = h("div", "ra-tw");
    table.replaceWith(w);
    w.append(table);
  }
}

/* ------------------------------------------------------------------ */
/* Inline dialogs                                                      */
/* ------------------------------------------------------------------ */

interface Pending { card: HTMLElement; cancel: () => void }

/** `AgentUI` whose questions are cards above the composer and whose notices are toasts in the chat. */
function inlineUI(askArea: HTMLElement, toasts: HTMLElement, t: Strings, onChange: () => void): AgentUI & { cancelAll(): void } {
  const pending = new Set<Pending>();
  const open = <T,>(build: (card: HTMLElement, done: (v: T) => void) => void, cancelValue: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const card = h("section", "ra-q");
      let entry: Pending;
      const done = (v: T) => { pending.delete(entry); card.remove(); onChange(); resolve(v); };
      entry = { card, cancel: () => done(cancelValue) };
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
    }, false),

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
    }, null),

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
    }, null),

    notify(message, level = "info") {
      const el = h("div", "ra-toast " + level, message);
      toasts.append(el);
      setTimeout(() => el.remove(), level === "error" ? 8000 : 4000);
    },

    cancelAll() {
      for (const p of [...pending]) p.cancel();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Transcript rows                                                     */
/* ------------------------------------------------------------------ */

type Command = { name: string; description: string; kind: string };

interface ToolCard { el: HTMLDetailsElement; name: string; args: unknown; end: HTMLElement; body: HTMLElement; update: HTMLElement | null; result: HTMLElement | null }

/** A reply: avatar + body holding thinking, text and tool cards, filled live or from a saved message. */
interface AsstRow extends VRow {
  body: HTMLElement;
  text: HTMLElement | null;
  think: HTMLDetailsElement | null;
  thinkBody: HTMLElement | null;
  md: string;
  reasoning: string;
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
  const t = STRINGS[pickLocale(opts.locale)];
  const { client, agent: givenAgent, workspace: wsOpt, resume: resumeOpt, title, placeholder, emptyState, suggestions, sessions, locale: _l, theme, showUsage, attachments: attachOpt, uploadsDir: uploadsOpt, onOpenFile, onSession, ...agentOpts } = opts;
  const uploadsDir = "/" + (uploadsOpt ?? "/uploads").replace(/^\/+|\/+$/g, "");
  const project = (client as unknown as { projectName?: string } | undefined)?.projectName ?? agentOpts.appName ?? "app";

  // Shell.
  const root = h("div", "ra-chat");
  root.dataset.theme = theme ?? "auto";
  const head = h("div", "ra-head");
  const titleEl = h("div", "ra-title", title === false ? "" : title || agentOpts.appName || t.assistant);
  const modelEl = h("span", "ra-badge");
  const filesBtn = h("button", "ra-btn ghost"); filesBtn.type = "button"; filesBtn.innerHTML = I.folder() + `<span>${escapeHTML(t.files)}</span>`;
  const histBtn = h("button", "ra-btn ghost"); histBtn.type = "button"; histBtn.innerHTML = I.hist() + `<span>${escapeHTML(t.history)}</span>`;
  const newBtn = h("button", "ra-btn ghost"); newBtn.type = "button"; newBtn.innerHTML = I.plus() + `<span>${escapeHTML(t.newChat)}</span>`;
  head.append(titleEl, modelEl, h("span", "ra-sp"), filesBtn, histBtn, newBtn);
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
  const ta = h("textarea"); ta.rows = 3; ta.setAttribute("aria-label", "Message");
  const files = h("div", "ra-files"); files.style.display = "none";
  const bar = h("div", "ra-bar");
  const left = h("div", "ra-left");
  const attachBtn = h("button", "ra-attach"); attachBtn.type = "button"; attachBtn.innerHTML = I.clip(); attachBtn.title = t.attach; attachBtn.setAttribute("aria-label", t.attach);
  const fileInput = h("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.style.display = "none";
  if (attachOpt === false) attachBtn.style.display = "none";
  const hint = h("span", "ra-hint");
  hint.innerHTML = `<span class="ra-kbd">Enter</span> ${escapeHTML(t.enter)} · <span class="ra-kbd">Shift</span>+<span class="ra-kbd">Enter</span> ${escapeHTML(t.newline)}`;
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
  if (showUsage === false) usageEl.style.display = "none";
  compCol.append(alertEl, queueEl, box, usageEl);
  comp.append(compCol);
  const toasts = h("div", "ra-toasts");
  const statusCol = h("div", "ra-col"); statusCol.append(statusEl);
  const main = h("div", "ra-main");
  const chatCol = h("div", "ra-chatcol");
  chatCol.append(log, askArea, statusCol, comp);
  main.append(chatCol);
  root.append(head, main, toasts, drop);
  target.replaceChildren(root);

  // State.
  let agent: Agent;
  const list = new VirtualList(log, inner, { estimate: 96, overscan: 400, rowClass: "ra-row" });
  let active: AsstRow | null = null;
  let renderTimer: number | null = null;
  const cards = new Map<string, ToolCard>();
  let commands: Command[] = [];
  let cmdIndex = 0;
  let cmdFrame: number | null = null;
  let queuedShown = new Set<ChatMessage>();
  let unsub: Array<() => void> = [];
  let menu: HTMLElement | null = null;
  let mounted = true;

  const ui = inlineUI(askCol, toasts, t, () => list.schedule());
  const panel = filesPanel({ t, root, notify: (m, l) => ui.notify(m, l), onChange: () => void refreshCommands() });
  main.append(panel.el);
  filesBtn.addEventListener("click", () => void panel.toggle());
  /** Opens a path: the host's editor when it has one, else the files panel. */
  const openPath = (path: string) => { if (onOpenFile) onOpenFile(path); else void panel.open(path); };
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

  const chipEl = (name: string, size: string, preview: string | null): HTMLElement => {
    const chip = h("span", "ra-chip");
    if (preview) { const img = h("img"); img.src = preview; img.alt = ""; chip.append(img); }
    else { const ic = h("span", "ra-ci"); ic.innerHTML = I.file(); chip.append(ic); }
    const n = h("span", "ra-cn", name); n.title = name;
    chip.append(n);
    if (size) chip.append(h("small", "", size));
    return chip;
  };
  const userEl = (content: string | ContentPart[]): HTMLElement => {
    const row = h("div", "ra-user");
    const b = h("div", "ra-bubble");
    // The attachment list (a text part of its own) is shown as chips, not as text.
    const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text").map((p) => p.text) : [];
    const text = parts.filter((p) => !p.startsWith(ATTACH_MARK)).join("\n");
    b.textContent = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
    const attached = parts.find((p) => p.startsWith(ATTACH_MARK));
    if (attached) {
      const chips = h("div", "ra-files");
      for (const line of attached.split("\n").slice(1)) {
        const m = /^- (.+?) \(([^)]*)\)/.exec(line);
        if (m) chips.append(chipEl(m[1]!.replace(/^.*\//, ""), m[2]!.replace(/^.*, /, ""), null));
      }
      if (chips.childElementCount) b.append(chips);
    }
    for (const url of imagesOf(content)) { const img = h("img"); img.src = url; img.alt = ""; b.append(img); }
    row.append(b);
    return row;
  };
  const addUser = (content: string | ContentPart[]) => { addRow({ render: () => userEl(content) }); list.scrollToBottom(); };

  const asstRow = (): AsstRow => {
    const el = h("div", "ra-asst");
    const av = h("div", "ra-avatar"); av.innerHTML = I.spark();
    const body = h("div", "ra-body");
    el.append(av, body);
    return { render: () => el, el, body, text: null, think: null, thinkBody: null, md: "", reasoning: "" };
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
    if (active.text) { renderMD(active.text, active.md, !final); if (final) linkPaths(active.text); }
    if (active.thinkBody) active.thinkBody.textContent = active.reasoning;
    if (active.think && final) (active.think.querySelector("summary span:last-child") as HTMLElement).textContent = t.thought;
    list.schedule();
  };
  const scheduleRender = () => { if (renderTimer === null) renderTimer = window.setTimeout(() => { renderTimer = null; flushActive(false); }, 100); };

  const makeCard = (name: string, args: unknown): ToolCard => {
    const el = h("details", "ra-tool") as HTMLDetailsElement;
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

  const addCard = (id: string, name: string, args: unknown, body: HTMLElement): ToolCard => {
    const card = makeCard(name, args);
    body.append(card.el);
    cards.set(id, card);
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
    card.result.textContent = result.length > 20_000 ? result.slice(0, 20_000) + "…" : result || "(empty)";
    list.schedule();
  };

  const noteEl = (text: string, summary?: string): HTMLElement => {
    const card = h("div", "ra-card");
    const head = h("div", "ra-ct" + (summary ? "" : " only"));
    head.innerHTML = I.layers() + `<span>${escapeHTML(text)}</span>`;
    card.append(head);
    if (summary) { const md = h("div", "ra-md"); renderMD(md, summary, false); card.append(md); }
    return card;
  };
  const addNote = (text: string, summary?: string) => { addRow({ render: () => noteEl(text, summary) }); list.schedule(); };

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
    active = null;
    let last: { text: string; reasoning: string; calls: Array<{ id: string; name: string; args: unknown; result?: string; status?: ToolStatus }> } | null = null;
    const flush = () => {
      if (!last) return;
      const m = last; last = null;
      addRow({
        render: () => {
          const r = asstRow();
          if (m.reasoning) { const [d] = thinkEl(m.reasoning, true); r.body.append(d); }
          if (m.text) { const el = h("div", "ra-md"); renderFinal(el, m.text); r.body.append(el); }
          for (const c of m.calls) { const card = makeCard(c.name, c.args); r.body.append(card.el); if (c.status) finishCard(card, c.status, c.result ?? ""); }
          return r.el!;
        },
      });
    };
    for (const m of messages) {
      if (m.role === "user") {
        flush();
        const s = typeof m.content === "string" ? summaryOf(m) : null;
        if (s !== null) { addNote(t.compacted, s); continue; }
        addRow({ render: () => userEl(m.content as string | ContentPart[]) });
      } else if (m.role === "assistant") {
        const text = textOfContent(m.content);
        const rs = (m as unknown as { reasoning?: unknown }).reasoning; const reasoning = typeof rs === "string" ? rs : "";
        // Tool-only turns join the reply before them, as they do live.
        if (!last || text || reasoning) { flush(); last = { text, reasoning, calls: [] }; }
        for (const c of m.tool_calls ?? []) {
          let args: unknown = c.function.arguments;
          try { args = JSON.parse(c.function.arguments); } catch { /* keep the string */ }
          last.calls.push({ id: c.id ?? "", name: c.function.name, args });
        }
      } else if (m.role === "tool") {
        const text = textOfContent(m.content);
        const call = last?.calls.find((c) => c.id === (m.tool_call_id ?? ""));
        if (call) { call.result = text; call.status = text.startsWith("Skipped") ? "skipped" : /^Error/.test(text) ? "error" : "ok"; }
      }
    }
    flush();
    if (!messages.length) showEmpty();
    list.scrollToBottom();
  };

  /* --- composer --- */
  const setBusy = (busy: boolean) => {
    root.dataset.busy = busy ? "1" : "";
    ta.placeholder = busy ? t.placeholderBusy : (placeholder ?? t.placeholder);
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
    clear.addEventListener("click", () => { agent.clearQueue(); queuedShown.clear(); renderQueue(); });
    hd.append(clear);
    queueEl.append(hd);
    for (const item of q) {
      const l = h("div", "ra-qi");
      const x = h("button"); x.type = "button"; x.innerHTML = I.x(11); x.title = t.remove; x.setAttribute("aria-label", t.remove);
      x.addEventListener("click", () => { agent.dequeue(item.message); queuedShown.delete(item.message); renderQueue(); });
      l.append(h("span", "ra-badge", item.kind === "steer" ? "steer" : "follow-up"), h("span", "", textOfContent(item.message.content)), x);
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
  const currentSuggestions = (): Command[] => {
    const v = ta.value;
    if (!v.startsWith("/") || /\s/.test(v)) return [];
    return commands.filter((c) => `/${c.name}`.startsWith(v)).slice(0, 8);
  };
  const renderCmds = () => {
    const found = currentSuggestions();
    cmds.style.display = found.length ? "" : "none";
    cmds.replaceChildren();
    if (cmdIndex >= found.length) cmdIndex = 0;
    found.forEach((c, i) => {
      const b = h("button", i === cmdIndex ? "ra-cur" : ""); b.type = "button";
      b.append(h("span", "ra-cn", `/${c.name}`), h("span", "ra-badge", c.kind), h("span", "ra-cd", c.description));
      b.addEventListener("mousedown", (e) => { e.preventDefault(); ta.value = `/${c.name} `; renderCmds(); ta.focus(); });
      cmds.append(b);
    });
  };
  // Typing only touches the popover, once per frame; the transcript and the box never change size.
  const scheduleCmds = () => { if (cmdFrame === null) cmdFrame = requestAnimationFrame(() => { cmdFrame = null; renderCmds(); }); };

  /* --- attachments --- */
  const pendingFiles: Attachment[] = [];
  const renderFiles = () => { files.style.display = pendingFiles.length ? "" : "none"; };
  const removeFile = (a: Attachment) => { const i = pendingFiles.indexOf(a); if (i >= 0) pendingFiles.splice(i, 1); if (a.preview) URL.revokeObjectURL(a.preview); a.chip.remove(); renderFiles(); };
  const addFiles = async (list: ArrayLike<File> | null | undefined) => {
    if (attachOpt === false || !list?.length) return;
    for (const file of Array.from(list)) {
      if (file.size > MAX_ATTACHMENT) { ui.notify(`${file.name} ${t.tooLarge}`, "warning"); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
      const text = image ? null : decodeText(file, bytes);
      const preview = image ? URL.createObjectURL(file) : null;
      const chip = chipEl(safeName(file.name), fmtSize(file.size), preview);
      const x = h("button"); x.type = "button"; x.innerHTML = I.x(); x.title = t.remove; x.setAttribute("aria-label", t.remove);
      chip.append(x);
      const a: Attachment = { file, name: safeName(file.name), bytes, text, image, preview, chip };
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
    if (items.length) { e.preventDefault(); void addFiles(items); }
  });
  let dragDepth = 0;
  root.addEventListener("dragenter", (e) => { if (attachOpt === false || !e.dataTransfer?.types.includes("Files")) return; e.preventDefault(); dragDepth++; root.dataset.drop = "1"; });
  root.addEventListener("dragover", (e) => { if (root.dataset.drop) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; } });
  root.addEventListener("dragleave", () => { if (root.dataset.drop && --dragDepth <= 0) { dragDepth = 0; delete root.dataset.drop; } });
  root.addEventListener("drop", (e) => { if (!root.dataset.drop) return; e.preventDefault(); dragDepth = 0; delete root.dataset.drop; void addFiles(e.dataTransfer?.files); });

  /** The message to send: the text, the attachment list (saved to the directory, or inlined), and pictures for the model. */
  const buildContent = async (text: string): Promise<string | ContentPart[]> => {
    if (!pendingFiles.length) return text;
    const ws = agent.workspace;
    const lines: string[] = [];
    const parts: ContentPart[] = [];
    for (const a of pendingFiles) {
      const type = a.file.type || (a.text !== null ? "text/plain" : "application/octet-stream");
      if (ws) {
        const path = await freePath(ws, uploadsDir, a.name);
        await ws.write(path, a.text ?? a.bytes, type);
        lines.push(`- ${path} (${type}, ${fmtSize(a.file.size)})`);
        void panel.refresh();
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
    for (const a of [...pendingFiles]) removeFile(a);
    return content;
  };

  const send = async (mode: "prompt" | "steer" | "followUp") => {
    const text = ta.value.trim();
    if ((!text && !pendingFiles.length) || !agent) return;
    ta.value = ""; renderCmds(); setAlert();
    if (!agent.busy) mode = "prompt";
    try {
      const content = await buildContent(text);
      if (mode === "prompt") { addUser(content); root.dataset.sent = "1"; await agent.prompt(content); return; }
      if (mode === "steer") agent.steer(content);
      else void agent.followUp(content).catch(() => undefined);
      renderQueue();
    } catch (err) { setAlert((err as Error).message); }
  };

  ta.addEventListener("input", scheduleCmds);
  ta.addEventListener("keydown", (e) => {
    const found = currentSuggestions();
    if (found.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = (cmdIndex + 1) % found.length; renderCmds(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = (cmdIndex - 1 + found.length) % found.length; renderCmds(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); ta.value = `/${found[cmdIndex]!.name} `; renderCmds(); return; }
      if (e.key === "Escape") { cmds.style.display = "none"; return; }
    }
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void send(agent?.busy ? (e.altKey ? "followUp" : "steer") : "prompt");
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
    const b = target.closest<HTMLButtonElement>("button.ra-copy");
    if (!b) return;
    const code = b.closest(".ra-cb")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard?.writeText(code.replace(/\n$/, "")).then(() => { b.innerHTML = I.check(14); setTimeout(() => { b.innerHTML = I.copy(); }, 1200); });
  });

  /* --- sessions menu --- */
  const closeMenu = () => { menu?.remove(); menu = null; };
  const openMenu = async () => {
    if (menu) { closeMenu(); return; }
    menu = h("div", "ra-menu");
    root.append(menu);
    const ws = agent.workspace!;
    let found: SessionSummary[] = [];
    try { found = await ws.sessions.list(); } catch { /* none */ }
    if (!menu) return;
    if (!found.length) menu.append(h("div", "ra-none", t.noSessions));
    for (const s of found) {
      const row = h("div", "ra-mi" + (s.id === agent.id ? " ra-cur" : ""));
      const b = h("button"); b.type = "button";
      b.append(h("span", "", s.title || t.untitled), h("small", "", `${s.messages} ${t.messages} · ${new Date(s.savedAt).toLocaleString()}`));
      b.addEventListener("click", () => { closeMenu(); void resume(s.id); });
      const x = h("button", "ra-x"); x.type = "button"; x.innerHTML = I.trash(); x.title = t.delete; x.setAttribute("aria-label", t.delete);
      x.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeMenu();
        if (await modalConfirm(root, t.delete, t.confirmDelete, { danger: true, ok: t.delete, cancel: t.cancel })) await deleteSession(s.id);
      });
      row.append(b, x);
      menu.append(row);
    }
    if (found.length) {
      const foot = h("div", "ra-mf");
      const all = h("button", "ra-btn xs ghost"); all.type = "button"; all.innerHTML = I.trash() + escapeHTML(t.deleteAll);
      all.addEventListener("click", async () => {
        closeMenu();
        if (!(await modalConfirm(root, t.deleteAll, t.confirmDeleteAll, { danger: true, ok: t.deleteAll, cancel: t.cancel }))) return;
        for (const s of found) await deleteSession(s.id, true);
        await newSession();
      });
      foot.append(all);
      menu.append(foot);
    }
  };
  histBtn.addEventListener("click", () => void openMenu());
  newBtn.addEventListener("click", () => { closeMenu(); void newSession(); });
  document.addEventListener("click", onDocClick, true);
  function onDocClick(e: Event) { if (menu && !menu.contains(e.target as Node) && e.target !== histBtn && !histBtn.contains(e.target as Node)) closeMenu(); }

  /* --- wiring an agent --- */
  const showUsage_ = (a: Agent) => {
    const u = a.usage;
    usageEl.textContent = u.calls ? `${fmtCost(u.total_cost)} · ${fmtTokens(u.prompt_tokens + u.completion_tokens)} tokens · ${u.calls} calls` : "";
  };

  const attach = async (a: Agent) => {
    for (const u of unsub) u();
    unsub = [];
    ui.cancelAll();
    agent = a;
    cards.clear();
    active = null;
    queuedShown = new Set();
    modelEl.textContent = a.model ?? "";
    modelEl.style.display = a.model ? "" : "none";
    const hasSessions = sessions ?? (!!a.workspace && !givenAgent);
    histBtn.style.display = newBtn.style.display = hasSessions && a.workspace ? "" : "none";
    filesBtn.style.display = a.workspace ? "" : "none";
    panel.setWorkspace(a.workspace);
    list.clear();
    showEmpty();
    setBusy(a.busy);
    setAlert();
    if (!givenAgent) writeLast(project, a.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const on = (name: string, fn: (ev: any) => void) => unsub.push(a.on(name as never, fn as never));
    on("run_start", (ev: { message: ChatMessage }) => {
      // A prompt sent from here was drawn then; one from a queued follow-up (or the host's agent) is drawn now.
      if (!root.dataset.sent) addUser(ev.message.content as string | ContentPart[]);
      delete root.dataset.sent;
      queuedShown = new Set(a.queued.map((q) => q.message));
      active = null;
      setBusy(true);
    });
    on("turn_start", () => {
      flushActive(true);
      // A turn that was only tool calls keeps its group, so a chain of calls reads as one step.
      if (active?.text || active?.think) active = null;
      // Queued steering joins this turn (the agent takes it right after this event): draw it now.
      for (const q of a.queued) if (q.kind === "steer" && queuedShown.delete(q.message)) addUser(q.message.content as string | ContentPart[]);
      queueMicrotask(renderQueue);
    });
    on("queued", (ev: { message: ChatMessage }) => { queuedShown.add(ev.message); renderQueue(); });
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
        act.body.prepend(act.think);
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
    on("tool_end", (ev: { id: string; name: string; args: unknown; status: ToolStatus; result: string; durationMs: number }) => {
      const c = cards.get(ev.id); if (c) finishCard(c, ev.status, ev.result, ev.durationMs);
      const path = ev.args && typeof ev.args === "object" ? (ev.args as { path?: unknown }).path : undefined;
      if (ev.status === "ok" && typeof path === "string" && /^(write_file|edit_file|delete_file)$/.test(c?.name ?? ev.name ?? "")) panel.changed(path);
    });
    on("compaction", (ev: { summary: boolean }) => {
      const first = a.messages[0];
      const s = first && typeof first.content === "string" ? summaryOf(first) : null;
      addNote(ev.summary ? t.compacted : t.trimmed, ev.summary && s ? s : undefined);
    });
    on("run_end", (r: RunResult) => {
      flushActive(true);
      active = null;
      ui.cancelAll();
      if (r.reason === "error" && r.error) addError(r.error.message);
      else if (r.reason === "max_turns") addNote(t.maxTurns);
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
    const instructions = workspace ? [agentOpts.instructions, FILES_HINT].filter(Boolean).join("\n\n") : agentOpts.instructions;
    return new Agent(client!, { ...agentOpts, instructions, id: sid, workspace, ui: agentOpts.ui ?? ui });
  };

  const switchTo = async (id?: string): Promise<Agent> => {
    if (givenAgent) throw new Error("runapps agent: newSession/resume need the chat to own its agent (pass a client, not an agent)");
    ui.cancelAll();
    await agent.abort();
    const a = await makeAgent(id);
    await attach(a);
    return a;
  };
  const newSession = () => switchTo();
  const resume = (id: string) => switchTo(id);
  const deleteSession = async (id: string, keepOpen = false) => {
    await ready;
    const ws = agent.workspace;
    if (!ws) return;
    if (id !== agent.id) { await ws.sessions.delete(id); return; }
    // The open session: stop it, drop its directory (files, skills, the saved session) and start afresh.
    await agent.abort();
    if (typeof wsOpt === "function") await ws.destroy(); else await ws.sessions.delete(id);
    writeLast(project, null);
    if (!keepOpen) await newSession();
  };

  // Which session opens first: an explicit id, else the one last open here, else a new one.
  const firstId = agentOpts.id ?? (typeof resumeOpt === "string" ? resumeOpt : resumeOpt === false ? undefined : readLast(project) ?? undefined);
  const starting = givenAgent ? Promise.resolve(givenAgent) : makeAgent(firstId);
  const ready = starting.then((a) => attach(a));
  void ready;

  // `prompt()` from the host: draw the message here, not from run_start.
  const promptFromHost = async (text: string) => {
    await ready;
    if (!agent.busy) { addUser(text); root.dataset.sent = "1"; }
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
    refresh: refreshCommands,
    unmount() {
      if (!mounted) return;
      mounted = false;
      for (const u of unsub) u();
      ui.cancelAll();
      closeMenu();
      document.removeEventListener("click", onDocClick, true);
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (cmdFrame !== null) cancelAnimationFrame(cmdFrame);
      list.dispose();
      panel.dispose();
      if (!givenAgent && agent) void agent.abort();
      root.remove();
    },
  };
}
