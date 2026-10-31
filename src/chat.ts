// `renderChat(target, opts)`: the element becomes a chat with an agent —
// transcript (Markdown replies, thinking, tool cards, compaction notes),
// composer (Enter sends, steer / follow-up while running, slash
// commands for skills and templates), questions the agent asks rendered
// inline, a session menu when there is a workspace. Plain DOM, no
// framework, styles injected once; the host gives the element a height.

import type { RunApps } from "@runappsai/sdk";
import type { ChatMessage, ChatToolCall, ContentPart } from "@runappsai/sdk";
import { Agent } from "./agent.js";
import type { Workspace } from "./workspace.js";
import { summaryOf } from "./compaction.js";
import { escapeHTML, renderMarkdown } from "./markdown.js";
import { listTemplates } from "./templates.js";
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
  /** Re-reads the workspace's skills and templates for `/` completion (after installing a skill). */
  refresh(): Promise<void>;
  unmount(): void;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const STRINGS = {
  en: {
    assistant: "Assistant", placeholder: "Ask the assistant… type / for commands", placeholderBusy: "Running: Enter steers, Alt+Enter queues a follow-up",
    send: "Send", stop: "Stop", steer: "Steer", followUp: "Follow-up", queued: "Queued", clear: "Clear", thinking: "Thinking…", thought: "Thought process",
    hint: "Enter to send · Shift+Enter for a new line", empty: "Start a conversation", history: "History", newChat: "New chat", noSessions: "No saved conversations",
    compacted: "Earlier conversation summarised", trimmed: "Earlier conversation trimmed to fit the context", allow: "Allow", decline: "Decline", cancel: "Cancel", submit: "Submit", ok: "OK",
    other: "Other…", typeAnswer: "Type your answer", args: "Arguments", result: "Result", error: "Error", running: "running", declined: "declined", blocked: "blocked", skipped: "skipped",
    open: "Open", stopped: "Stopped.", maxTurns: "Stopped after the maximum number of turns.", retry: "Retry", messages: "messages", model: "model", skill: "skill", template: "template",
  },
  zh: {
    assistant: "助手", placeholder: "问问助手… 输入 / 查看命令", placeholderBusy: "运行中：Enter 插入指令，Alt+Enter 排队到任务之后",
    send: "发送", stop: "停止", steer: "插入", followUp: "排队", queued: "排队中", clear: "清空", thinking: "思考中…", thought: "思考过程",
    hint: "Enter 发送 · Shift+Enter 换行", empty: "开始对话", history: "历史", newChat: "新对话", noSessions: "还没有保存的对话",
    compacted: "较早的对话已压缩为摘要", trimmed: "较早的对话已裁剪以适应上下文", allow: "允许", decline: "拒绝", cancel: "取消", submit: "提交", ok: "确定",
    other: "其他…", typeAnswer: "请输入", args: "参数", result: "结果", error: "错误", running: "运行中", declined: "已拒绝", blocked: "已拦截", skipped: "已跳过",
    open: "打开", stopped: "已停止。", maxTurns: "达到最大轮数，已停止。", retry: "重试", messages: "条消息", model: "模型", skill: "技能", template: "模板",
  },
};
type Strings = typeof STRINGS.en;

function pickLocale(opt?: "zh" | "en"): "zh" | "en" {
  if (opt) return opt;
  const lang = (typeof document !== "undefined" && document.documentElement.lang) || (typeof navigator !== "undefined" ? navigator.language : "") || "";
  return /^zh/i.test(lang) ? "zh" : "en";
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const STYLE_ID = "runapps-agent-chat-style";
const CSS = `
.ra-chat{--ra-bg:#fff;--ra-fg:#111827;--ra-muted:#6b7280;--ra-border:#e5e7eb;--ra-panel:#f9fafb;--ra-user:#e8f0fe;--ra-accent:#2563eb;--ra-accent-fg:#fff;--ra-danger:#dc2626;--ra-ok:#16a34a;--ra-code:#f3f4f6;--ra-radius:12px;
  display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--ra-bg);color:var(--ra-fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;position:relative;overflow:hidden}
.ra-chat[data-theme=dark]{--ra-bg:#111317;--ra-fg:#e5e7eb;--ra-muted:#9ca3af;--ra-border:#2a2f3a;--ra-panel:#181b21;--ra-user:#1e2a44;--ra-accent:#3b82f6;--ra-code:#1c2029;color-scheme:dark}
@media (prefers-color-scheme:dark){.ra-chat[data-theme=auto]{--ra-bg:#111317;--ra-fg:#e5e7eb;--ra-muted:#9ca3af;--ra-border:#2a2f3a;--ra-panel:#181b21;--ra-user:#1e2a44;--ra-accent:#3b82f6;--ra-code:#1c2029;color-scheme:dark}}
.ra-chat *,.ra-chat *::before,.ra-chat *::after{box-sizing:border-box}
.ra-chat button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
.ra-chat button:disabled{opacity:.45;cursor:default}
.ra-chat textarea,.ra-chat input[type=text]{font:inherit;color:inherit;background:transparent;border:0;outline:0;width:100%}
.ra-col{max-width:820px;margin:0 auto;padding:0 16px;width:100%}
.ra-head{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--ra-border);flex-shrink:0;min-height:42px}
.ra-head .ra-title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-badge{font-size:11px;color:var(--ra-muted);border:1px solid var(--ra-border);border-radius:999px;padding:1px 8px;white-space:nowrap}
.ra-head .ra-sp{flex:1}
.ra-chat .ra-ibtn{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--ra-muted);padding:4px 8px;border-radius:8px}
.ra-chat .ra-ibtn:hover{background:var(--ra-panel);color:var(--ra-fg)}
.ra-menu{position:absolute;right:12px;top:40px;z-index:6;min-width:260px;max-width:min(380px,calc(100% - 24px));max-height:60%;overflow:auto;background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px}
.ra-menu button{display:block;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:13px}
.ra-menu button:hover{background:var(--ra-panel)}
.ra-menu button.ra-cur{background:var(--ra-user)}
.ra-menu small{display:block;color:var(--ra-muted);font-size:11px}
.ra-menu .ra-none{padding:8px 10px;color:var(--ra-muted);font-size:13px}
.ra-log{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 0}
.ra-empty{padding:48px 16px 24px;text-align:center;color:var(--ra-muted)}
.ra-sugs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px}
.ra-sugs button{border:1px solid var(--ra-border);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--ra-fg)}
.ra-sugs button:hover{background:var(--ra-panel)}
.ra-row{padding:6px 0}
.ra-user{display:flex;justify-content:flex-end}
.ra-user .ra-bubble{max-width:85%;background:var(--ra-user);border-radius:16px 16px 4px 16px;padding:8px 14px;white-space:pre-wrap;word-break:break-word}
.ra-user img{display:block;max-width:240px;border-radius:8px;margin-top:6px}
.ra-asst{display:flex;gap:10px;align-items:flex-start}
.ra-avatar{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--ra-user);color:var(--ra-accent);display:flex;align-items:center;justify-content:center;margin-top:2px}
.ra-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.ra-md{word-break:break-word;overflow-wrap:anywhere}
.ra-md>:first-child{margin-top:0}.ra-md>:last-child{margin-bottom:0}
.ra-md p{margin:0 0 .7em}.ra-md h1,.ra-md h2,.ra-md h3,.ra-md h4{margin:1em 0 .4em;line-height:1.3}.ra-md h1{font-size:1.35em}.ra-md h2{font-size:1.2em}.ra-md h3{font-size:1.05em}
.ra-md ul,.ra-md ol{margin:0 0 .7em;padding-left:1.5em}.ra-md li{margin:.15em 0}
.ra-md code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--ra-code);padding:1px 5px;border-radius:5px}
.ra-md pre{position:relative;background:var(--ra-code);border-radius:8px;padding:10px 12px;overflow:auto;margin:0 0 .7em}
.ra-md pre code{background:none;padding:0;font-size:12.5px;line-height:1.5}
.ra-md pre .ra-copy{position:absolute;top:6px;right:6px;font-size:11px;color:var(--ra-muted);border:1px solid var(--ra-border);border-radius:6px;padding:2px 7px;background:var(--ra-bg);opacity:0;transition:opacity .15s}
.ra-md pre:hover .ra-copy{opacity:1}
.ra-md blockquote{margin:0 0 .7em;padding:2px 12px;border-left:3px solid var(--ra-border);color:var(--ra-muted)}
.ra-md table{border-collapse:collapse;margin:0 0 .7em;font-size:13px;display:block;overflow-x:auto;max-width:100%}
.ra-md th,.ra-md td{border:1px solid var(--ra-border);padding:4px 10px;text-align:left}.ra-md th{background:var(--ra-panel)}
.ra-md hr{border:0;border-top:1px solid var(--ra-border);margin:1em 0}
.ra-md a{color:var(--ra-accent);text-decoration:none}.ra-md a:hover{text-decoration:underline}
.ra-md img{max-width:100%;border-radius:8px}
.ra-cursor::after{content:"";display:inline-block;width:7px;height:14px;background:var(--ra-muted);margin-left:2px;vertical-align:-2px;animation:ra-blink 1s steps(2) infinite;border-radius:1px}
@keyframes ra-blink{50%{opacity:0}}
.ra-think summary{cursor:pointer;color:var(--ra-muted);font-size:12px;list-style:none;display:inline-flex;align-items:center;gap:6px;user-select:none}
.ra-think summary::-webkit-details-marker{display:none}
.ra-think summary::before{content:"▸";font-size:11px}.ra-think[open] summary::before{content:"▾"}
.ra-think .ra-think-body{font-size:12px;color:var(--ra-muted);white-space:pre-wrap;border-left:2px solid var(--ra-border);padding-left:10px;margin:4px 0 0 4px;max-height:280px;overflow:auto}
.ra-tool{border:1px solid var(--ra-border);border-radius:8px;overflow:hidden;font-size:13px}
.ra-tool.fail{border-color:var(--ra-danger)}
.ra-tool>summary{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;list-style:none;user-select:none}
.ra-tool>summary::-webkit-details-marker{display:none}
.ra-tool>summary:hover{background:var(--ra-panel)}
.ra-tool .ra-tname{font-weight:600;white-space:nowrap}
.ra-tool .ra-tsum{flex:1;min-width:0;color:var(--ra-muted);font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-tool .ra-tstat{font-size:11px;color:var(--ra-muted);white-space:nowrap}
.ra-tool .ra-tstat.ok{color:var(--ra-ok)}.ra-tool .ra-tstat.fail{color:var(--ra-danger)}
.ra-spin{width:12px;height:12px;border:2px solid var(--ra-border);border-top-color:var(--ra-accent);border-radius:50%;animation:ra-spin .8s linear infinite;flex-shrink:0}
@keyframes ra-spin{to{transform:rotate(360deg)}}
.ra-tool .ra-tbody{border-top:1px solid var(--ra-border);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.ra-tool .ra-tlabel{font-size:11px;color:var(--ra-muted)}
.ra-tool pre{margin:0;background:var(--ra-code);border-radius:6px;padding:8px;max-height:280px;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.ra-tool .ra-tupd{font-size:12px;color:var(--ra-muted);padding:0 10px 6px;white-space:pre-wrap}
.ra-tool .ra-open{font-size:12px;color:var(--ra-accent);align-self:flex-start}
.ra-card{border:1px solid var(--ra-border);background:var(--ra-panel);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--ra-muted)}
.ra-card.err{border-color:var(--ra-danger);color:var(--ra-danger);background:transparent;white-space:pre-wrap}
.ra-card.err button{margin-left:8px;border:1px solid var(--ra-danger);border-radius:6px;padding:1px 8px;font-size:12px;color:var(--ra-danger)}
.ra-card details summary{cursor:pointer}
.ra-card .ra-md{color:var(--ra-fg);margin-top:6px;font-size:13px}
.ra-ask{flex-shrink:0;max-height:45%;overflow-y:auto}
.ra-q{border:1px solid var(--ra-accent);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--ra-panel)}
.ra-q .ra-qt{font-weight:600;font-size:13px;margin-bottom:4px}
.ra-q .ra-qm{font-size:13px;white-space:pre-wrap;color:var(--ra-muted);margin-bottom:8px}
.ra-q .ra-opts{display:flex;flex-direction:column;gap:6px;margin:6px 0 10px}
.ra-q .ra-opt{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--ra-border);border-radius:8px;padding:7px 10px;text-align:left;width:100%;background:var(--ra-bg)}
.ra-q .ra-opt:hover{border-color:var(--ra-accent)}
.ra-q .ra-opt input[type=radio],.ra-q .ra-opt input[type=checkbox]{width:auto;flex:none;margin:3px 0 0}
.ra-q .ra-opt>div,.ra-q .ra-opt>span{flex:1;min-width:0}
.ra-q .ra-opt small{display:block;color:var(--ra-muted);font-size:12px}
.ra-q .ra-field{border:1px solid var(--ra-border);border-radius:8px;padding:7px 10px;background:var(--ra-bg);margin:4px 0 10px;width:100%}
.ra-q textarea.ra-field{min-height:80px;resize:vertical}
.ra-btns{display:flex;justify-content:flex-end;gap:8px}
.ra-chat .ra-btn{border:1px solid var(--ra-border);border-radius:8px;padding:5px 12px;font-size:13px}
.ra-chat .ra-btn.pri{background:var(--ra-accent);border-color:var(--ra-accent);color:var(--ra-accent-fg)}
.ra-chat .ra-btn.dng{background:var(--ra-danger);border-color:var(--ra-danger);color:#fff}
.ra-queue{border:1px solid var(--ra-border);border-radius:8px;padding:6px 10px;margin:8px 0 0;font-size:12px}
.ra-queue .ra-qh{display:flex;justify-content:space-between;color:var(--ra-muted);margin-bottom:2px}
.ra-queue .ra-qi{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-queue .ra-qi b{font-weight:500;color:var(--ra-muted);margin-right:6px}
.ra-comp{flex-shrink:0;border-top:1px solid var(--ra-border);padding:10px 0 8px}
.ra-box{position:relative;border:1px solid var(--ra-border);border-radius:14px;padding:8px 10px 6px;background:var(--ra-bg)}
.ra-box:focus-within{border-color:var(--ra-accent)}
.ra-box textarea{resize:none;min-height:40px;max-height:160px;padding:2px 4px;line-height:1.45}
.ra-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}
.ra-bar .ra-hint{font-size:11px;color:var(--ra-muted)}
.ra-bar .ra-acts{display:flex;gap:6px;align-items:center}
.ra-chat .ra-send{width:32px;height:32px;border-radius:50%;background:var(--ra-accent);color:var(--ra-accent-fg);display:inline-flex;align-items:center;justify-content:center}
.ra-chat .ra-sbtn{border:1px solid var(--ra-border);border-radius:8px;padding:4px 10px;font-size:12px}
.ra-chat .ra-sbtn.stop{border-color:var(--ra-danger);color:var(--ra-danger)}
.ra-cmds{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:5;background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px;max-height:240px;overflow:auto}
.ra-cmds button{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;padding:6px 8px;border-radius:6px;font-size:13px}
.ra-cmds button:hover,.ra-cmds button.ra-cur{background:var(--ra-panel)}
.ra-cmds .ra-cn{font:600 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ra-cmds .ra-ck{font-size:11px;color:var(--ra-muted);border:1px solid var(--ra-border);border-radius:999px;padding:0 6px}
.ra-cmds .ra-cd{font-size:12px;color:var(--ra-muted);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-usage{font-size:11px;color:var(--ra-muted);text-align:right;margin-top:4px;min-height:14px}
.ra-toasts{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:7;display:flex;flex-direction:column;gap:6px;pointer-events:none;max-width:calc(100% - 32px)}
.ra-toast{background:#111827;color:#fff;font-size:13px;padding:8px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);white-space:pre-wrap;word-break:break-word}
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
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const ICON_SPARK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/></svg>';
const ICON_SEND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>';
const ICON_HIST = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/></svg>';
const ICON_NEW = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';

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

/* ------------------------------------------------------------------ */
/* Inline dialogs                                                      */
/* ------------------------------------------------------------------ */

interface Pending { card: HTMLElement; cancel: () => void }

/** `AgentUI` whose questions are cards above the composer and whose notices are toasts in the chat. */
function inlineUI(host: HTMLElement, askArea: HTMLElement, toasts: HTMLElement, t: Strings, onChange: () => void): AgentUI & { cancelAll(): void } {
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
      const focus = card.querySelector<HTMLElement>("input,textarea,button.pri,button");
      queueMicrotask(() => focus?.focus());
    });
  const head = (card: HTMLElement, title: string, message?: string) => {
    card.append(h("div", "ra-qt", title));
    if (message) card.append(h("div", "ra-qm", message));
  };
  const btn = (label: string, cls: string, onClick: () => void) => { const b = h("button", "ra-btn " + cls, label); b.type = "button"; b.addEventListener("click", onClick); return b; };

  return {
    confirm: (title, message, opts = {}) => open<boolean>((card, done) => {
      head(card, title, message);
      const row = h("div", "ra-btns");
      row.append(btn(opts.cancel ?? t.decline, "", () => done(false)), btn(opts.ok ?? t.allow, opts.danger ? "dng pri" : "pri", () => done(true)));
      card.append(row);
    }, false),

    select: (title, options: SelectOption[], opts = {}) => open<string[] | null>((card, done) => {
      head(card, title, opts.message);
      const list = h("div", "ra-opts");
      if (!opts.multi && !opts.allowOther) {
        // Single choice: a click answers.
        for (const o of options) {
          const b = h("button", "ra-opt"); b.type = "button";
          b.append(h("span", "", o.label ?? o.value));
          if (o.description) b.append(h("small", "", o.description));
          b.addEventListener("click", () => done([o.value]));
          list.append(b);
        }
        card.append(list, (() => { const r = h("div", "ra-btns"); r.append(btn(t.cancel, "", () => done(null))); return r; })());
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
      row.append(btn(t.cancel, "", () => done(null)), btn(t.ok, "pri", () => {
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
      row.append(btn(t.cancel, "", () => done(null)), btn(t.submit, "pri", () => done(field.value)));
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
/* The chat                                                            */
/* ------------------------------------------------------------------ */

type Command = { name: string; description: string; kind: string };

interface ToolCard { el: HTMLDetailsElement; name: string; args: unknown; status: HTMLElement; body: HTMLElement; update: HTMLElement | null; result: HTMLElement | null }

export function renderChat(target: HTMLElement, opts: ChatOptions): ChatHandle {
  if (typeof document === "undefined") throw new Error("runapps agent: renderChat needs a document");
  if (!opts.agent && !opts.client) throw new Error("runapps agent: renderChat needs a client (or an agent)");
  injectStyles();
  const t = STRINGS[pickLocale(opts.locale)];
  const { client, agent: givenAgent, workspace: wsOpt, title, placeholder, emptyState, suggestions, sessions, locale: _l, theme, showUsage, onOpenFile, onSession, ...agentOpts } = opts;

  // Shell.
  const root = h("div", "ra-chat");
  root.dataset.theme = theme ?? "auto";
  const head = h("div", "ra-head");
  const titleEl = h("div", "ra-title", title === false ? "" : title || agentOpts.appName || t.assistant);
  const modelEl = h("span", "ra-badge");
  const histBtn = h("button", "ra-ibtn"); histBtn.type = "button"; histBtn.innerHTML = ICON_HIST + `<span>${escapeHTML(t.history)}</span>`;
  const newBtn = h("button", "ra-ibtn"); newBtn.type = "button"; newBtn.innerHTML = ICON_NEW + `<span>${escapeHTML(t.newChat)}</span>`;
  head.append(titleEl, modelEl, h("span", "ra-sp"), histBtn, newBtn);
  if (title === false) head.style.display = "none";
  const log = h("div", "ra-log");
  const inner = h("div", "ra-col");
  log.append(inner);
  const askArea = h("div", "ra-ask");
  const askCol = h("div", "ra-col");
  askArea.append(askCol);
  const comp = h("div", "ra-comp");
  const compCol = h("div", "ra-col");
  const queueEl = h("div", "ra-queue"); queueEl.style.display = "none";
  const box = h("div", "ra-box");
  const cmds = h("div", "ra-cmds"); cmds.style.display = "none";
  const ta = h("textarea"); ta.rows = 2; ta.setAttribute("aria-label", "Message");
  const bar = h("div", "ra-bar");
  const hint = h("span", "ra-hint", t.hint);
  const acts = h("div", "ra-acts");
  const sendBtn = h("button", "ra-send"); sendBtn.type = "button"; sendBtn.innerHTML = ICON_SEND; sendBtn.setAttribute("aria-label", t.send);
  const steerBtn = h("button", "ra-sbtn", t.steer); steerBtn.type = "button";
  const fuBtn = h("button", "ra-sbtn", t.followUp); fuBtn.type = "button";
  const stopBtn = h("button", "ra-sbtn stop", t.stop); stopBtn.type = "button";
  acts.append(steerBtn, fuBtn, stopBtn, sendBtn);
  bar.append(hint, acts);
  box.append(cmds, ta, bar);
  const usageEl = h("div", "ra-usage");
  if (showUsage === false) usageEl.style.display = "none";
  compCol.append(queueEl, box, usageEl);
  comp.append(compCol);
  const toasts = h("div", "ra-toasts");
  root.append(head, log, askArea, comp, toasts);
  target.replaceChildren(root);

  // State.
  let agent: Agent;
  let atBottom = true;
  let active: { body: HTMLElement; text: HTMLElement | null; think: HTMLElement | null; thinkBody: HTMLElement | null; md: string; reasoning: string } | null = null;
  let renderTimer: number | null = null;
  const cards = new Map<string, ToolCard>();
  let commands: Command[] = [];
  let cmdIndex = 0;
  let queuedShown = new Set<ChatMessage>();
  let unsub: Array<() => void> = [];
  let menu: HTMLElement | null = null;
  let mounted = true;

  const ui = inlineUI(root, askCol, toasts, t, () => scrollIfFollowing());
  const emptyEl = h("div", "ra-empty");

  const scrollToBottom = () => { log.scrollTop = log.scrollHeight; atBottom = true; };
  const scrollIfFollowing = () => { if (atBottom) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }); };
  log.addEventListener("scroll", () => { atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80; });

  const showEmpty = () => {
    if (emptyState === null) return;
    emptyEl.replaceChildren();
    if (emptyState instanceof HTMLElement) emptyEl.append(emptyState);
    else emptyEl.append(h("div", "", typeof emptyState === "string" ? emptyState : t.empty));
    if (suggestions?.length) {
      const row = h("div", "ra-sugs");
      for (const s of suggestions) { const b = h("button", "", s); b.type = "button"; b.addEventListener("click", () => { ta.value = s; ta.focus(); autosize(); }); row.append(b); }
      emptyEl.append(row);
    }
    inner.append(emptyEl);
  };
  const hideEmpty = () => emptyEl.remove();

  /* --- transcript --- */
  const addRow = (cls: string): HTMLElement => { hideEmpty(); const r = h("div", "ra-row " + cls); inner.append(r); return r; };

  const addUser = (content: string | ContentPart[]) => {
    const row = addRow("ra-user");
    const b = h("div", "ra-bubble");
    const text = textOfContent(content);
    b.textContent = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
    for (const url of imagesOf(content)) { const img = h("img"); img.src = url; img.alt = ""; b.append(img); }
    row.append(b);
    scrollToBottom();
  };

  const addAssistant = (): HTMLElement => {
    const row = addRow("ra-asst");
    const av = h("div", "ra-avatar"); av.innerHTML = ICON_SPARK;
    const body = h("div", "ra-body");
    row.append(av, body);
    return body;
  };

  const ensureActive = () => {
    if (!active) active = { body: addAssistant(), text: null, think: null, thinkBody: null, md: "", reasoning: "" };
    return active;
  };

  const renderText = (el: HTMLElement, md: string, streaming: boolean) => {
    el.innerHTML = renderMarkdown(md);
    el.classList.toggle("ra-cursor", streaming);
    if (!streaming) for (const pre of el.querySelectorAll("pre")) { const b = h("button", "ra-copy", "copy"); b.type = "button"; pre.append(b); }
  };

  const flushActive = (final: boolean) => {
    if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
    if (!active) return;
    if (active.text) renderText(active.text, active.md, !final);
    if (active.thinkBody) active.thinkBody.textContent = active.reasoning;
    if (active.think && final) (active.think.querySelector("summary span") as HTMLElement).textContent = t.thought;
    scrollIfFollowing();
  };
  const scheduleRender = () => { if (renderTimer === null) renderTimer = window.setTimeout(() => { renderTimer = null; flushActive(false); }, 100); };

  const addCard = (id: string, name: string, args: unknown, body: HTMLElement): ToolCard => {
    const el = h("details", "ra-tool") as HTMLDetailsElement;
    const sum = h("summary");
    const status = h("span", "ra-tstat");
    status.innerHTML = '<span class="ra-spin"></span>';
    sum.append(h("span", "ra-tname", name), h("span", "ra-tsum", summarizeArgs(name, args)), status);
    const tb = h("div", "ra-tbody");
    tb.append(h("div", "ra-tlabel", t.args), h("pre", "", typeof args === "string" ? args : JSON.stringify(args, null, 2)));
    const path = args && typeof args === "object" && typeof (args as { path?: unknown }).path === "string" ? (args as { path: string }).path : null;
    if (onOpenFile && path) { const b = h("button", "ra-open", `${t.open} ${path}`); b.type = "button"; b.addEventListener("click", () => onOpenFile(path)); tb.append(b); }
    el.append(sum, tb);
    body.append(el);
    const card: ToolCard = { el, name, args, status, body: tb, update: null, result: null };
    cards.set(id, card);
    scrollIfFollowing();
    return card;
  };

  const finishCard = (card: ToolCard, status: ToolStatus, result: string, durationMs?: number) => {
    const ok = status === "ok";
    const fail = status === "error" || status === "blocked";
    card.status.className = "ra-tstat " + (ok ? "ok" : fail ? "fail" : "");
    card.status.textContent = (durationMs !== undefined ? `${Math.round(durationMs)} ms · ` : "") + (ok ? "✓" : status === "error" ? "✕" : t[status as "declined" | "blocked" | "skipped"] ?? status);
    card.el.classList.toggle("fail", fail);
    card.update?.remove();
    if (!card.result) {
      card.result = h("pre", "");
      card.body.append(h("div", "ra-tlabel", status === "error" ? t.error : t.result), card.result);
    }
    card.result.textContent = result.length > 20_000 ? result.slice(0, 20_000) + "…" : result || "(empty)";
    scrollIfFollowing();
  };

  const addNote = (text: string, summary?: string) => {
    const row = addRow("");
    const card = h("div", "ra-card");
    if (summary) {
      const d = h("details");
      d.append(h("summary", "", text));
      const md = h("div", "ra-md"); md.innerHTML = renderMarkdown(summary);
      d.append(md);
      card.append(d);
    } else card.textContent = text;
    row.append(card);
    scrollIfFollowing();
  };

  const addError = (message: string, retry?: () => void) => {
    const row = addRow("");
    const card = h("div", "ra-card err", message);
    if (retry) { const b = h("button", "", t.retry); b.type = "button"; b.addEventListener("click", () => { row.remove(); retry(); }); card.append(b); }
    row.append(card);
    scrollIfFollowing();
  };

  /** Draws a saved transcript. */
  const renderHistory = (messages: ChatMessage[]) => {
    inner.replaceChildren();
    cards.clear();
    active = null;
    let body: HTMLElement | null = null;
    for (const m of messages) {
      if (m.role === "user") {
        const s = typeof m.content === "string" ? summaryOf(m) : null;
        if (s !== null) { addNote(t.compacted, s); body = null; continue; }
        addUser(m.content as string | ContentPart[]);
        body = null;
      } else if (m.role === "assistant") {
        body = addAssistant();
        const text = textOfContent(m.content);
        if (text) { const el = h("div", "ra-md"); renderText(el, text, false); body.append(el); }
        for (const c of m.tool_calls ?? []) {
          let args: unknown = c.function.arguments;
          try { args = JSON.parse(c.function.arguments); } catch { /* keep the string */ }
          addCard(c.id ?? "", c.function.name, args, body);
        }
      } else if (m.role === "tool") {
        const card = cards.get(m.tool_call_id ?? "");
        if (card) finishCard(card, /^(Error|Skipped)/.test(textOfContent(m.content)) ? (textOfContent(m.content).startsWith("Skipped") ? "skipped" : "error") : "ok", textOfContent(m.content));
      }
    }
    if (!messages.length) showEmpty();
    scrollToBottom();
  };

  /* --- composer --- */
  const autosize = () => { ta.style.height = "auto"; ta.style.height = Math.min(160, Math.max(40, ta.scrollHeight)) + "px"; };
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
    const clear = h("button", "", t.clear); clear.type = "button"; clear.addEventListener("click", () => { agent.clearQueue(); queuedShown.clear(); renderQueue(); });
    hd.append(clear);
    queueEl.append(hd);
    for (const item of q) { const l = h("div", "ra-qi"); l.append(h("b", "", item.kind === "steer" ? t.steer : t.followUp), document.createTextNode(textOfContent(item.message.content))); queueEl.append(l); }
  };

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
    const list = currentSuggestions();
    cmds.style.display = list.length ? "" : "none";
    cmds.replaceChildren();
    if (cmdIndex >= list.length) cmdIndex = 0;
    list.forEach((c, i) => {
      const b = h("button", i === cmdIndex ? "ra-cur" : ""); b.type = "button";
      b.append(h("span", "ra-cn", `/${c.name}`), h("span", "ra-ck", c.kind), h("span", "ra-cd", c.description));
      b.addEventListener("mousedown", (e) => { e.preventDefault(); ta.value = `/${c.name} `; renderCmds(); ta.focus(); });
      cmds.append(b);
    });
  };

  const send = async (mode: "prompt" | "steer" | "followUp") => {
    const text = ta.value.trim();
    if (!text || !agent) return;
    ta.value = ""; autosize(); renderCmds();
    if (!agent.busy) mode = "prompt";
    if (mode === "prompt") { addUser(text); root.dataset.sent = "1"; void agent.prompt(text).catch(() => undefined); return; }
    if (mode === "steer") agent.steer(text);
    else void agent.followUp(text).catch(() => undefined);
    renderQueue();
  };

  ta.addEventListener("input", () => { autosize(); renderCmds(); });
  ta.addEventListener("keydown", (e) => {
    const list = currentSuggestions();
    if (list.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = (cmdIndex + 1) % list.length; renderCmds(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = (cmdIndex - 1 + list.length) % list.length; renderCmds(); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); ta.value = `/${list[cmdIndex]!.name} `; renderCmds(); return; }
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
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.ra-copy");
    if (!b) return;
    const code = b.parentElement?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard?.writeText(code.replace(/\n$/, "")).then(() => { b.textContent = "✓"; setTimeout(() => { b.textContent = "copy"; }, 1200); });
  });

  /* --- sessions menu --- */
  const closeMenu = () => { menu?.remove(); menu = null; };
  const openMenu = async () => {
    if (menu) { closeMenu(); return; }
    menu = h("div", "ra-menu");
    root.append(menu);
    const ws = agent.workspace!;
    let list: SessionSummary[] = [];
    try { list = await ws.sessions.list(); } catch { /* none */ }
    if (!menu) return;
    if (!list.length) menu.append(h("div", "ra-none", t.noSessions));
    for (const s of list) {
      const b = h("button", s.id === agent.id ? "ra-cur" : ""); b.type = "button";
      b.append(document.createTextNode(s.title || "…"), h("small", "", `${s.messages} ${t.messages} · ${new Date(s.savedAt).toLocaleString()}`));
      b.addEventListener("click", () => { closeMenu(); void resume(s.id); });
      menu.append(b);
    }
  };
  histBtn.addEventListener("click", () => void openMenu());
  newBtn.addEventListener("click", () => { closeMenu(); void newSession(); });
  document.addEventListener("click", onDocClick, true);
  function onDocClick(e: Event) { if (menu && !menu.contains(e.target as Node) && e.target !== histBtn && !histBtn.contains(e.target as Node)) closeMenu(); }

  /* --- wiring an agent --- */
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
    inner.replaceChildren();
    showEmpty();
    setBusy(a.busy);

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
        act.think = h("details", "ra-think");
        const s = h("summary"); s.append(h("span", "", t.thinking)); act.think.append(s);
        act.thinkBody = h("div", "ra-think-body");
        act.think.append(act.thinkBody);
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
      scrollIfFollowing();
    });
    on("tool_end", (ev: { id: string; status: ToolStatus; result: string; durationMs: number }) => { const c = cards.get(ev.id); if (c) finishCard(c, ev.status, ev.result, ev.durationMs); });
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
      const u = a.usage;
      usageEl.textContent = u.calls ? `${fmtCost(u.total_cost)} · ${fmtTokens(u.prompt_tokens + u.completion_tokens)} tokens · ${u.calls} calls` : "";
      void refreshCommands();
    });

    try { await a.ready(); } catch (err) { addError((err as Error).message); }
    if (agent !== a || !mounted) return;
    onSession?.(a);
    renderHistory(a.messages);
    const u = a.usage;
    usageEl.textContent = u.calls ? `${fmtCost(u.total_cost)} · ${fmtTokens(u.prompt_tokens + u.completion_tokens)} tokens · ${u.calls} calls` : "";
    await refreshCommands();
  };

  const newId = () => `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  /** An agent for session `id`; with a workspace factory, the session's own directory (opened under the same id). */
  const makeAgent = async (id?: string): Promise<Agent> => {
    const sid = id ?? newId();
    const workspace = typeof wsOpt === "function" ? await wsOpt(sid) : wsOpt ?? null;
    return new Agent(client!, { ...agentOpts, id: sid, workspace, ui: agentOpts.ui ?? ui });
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

  const starting = givenAgent ? Promise.resolve(givenAgent) : makeAgent(agentOpts.id);
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
    setInput(text) { ta.value = text; autosize(); ta.focus(); renderCmds(); },
    newSession,
    resume,
    refresh: refreshCommands,
    unmount() {
      if (!mounted) return;
      mounted = false;
      for (const u of unsub) u();
      ui.cancelAll();
      closeMenu();
      document.removeEventListener("click", onDocClick, true);
      if (renderTimer !== null) clearTimeout(renderTimer);
      root.remove();
    },
  };
}
