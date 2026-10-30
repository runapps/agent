// The default dialogs (plain <dialog>s, light/dark, zh/en) and the
// `ask_user` tool. An app with its own design implements `AgentUI`
// itself and passes it to the agent.

import { defineTool } from "./tool.js";
import type { AgentUI, SelectOption, Tool } from "./types.js";

function isZh(): boolean {
  if (typeof document === "undefined") return false;
  return /^zh/i.test(document.documentElement.lang || (typeof navigator !== "undefined" ? navigator.language : "") || "");
}

const DIALOG_STYLE = [
  "border:1px solid rgba(127,127,127,.3)", "border-radius:12px", "padding:18px 18px 14px", "width:min(420px,calc(100vw - 32px))",
  "font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif", "color-scheme:light dark",
  "color:CanvasText", "background:Canvas", "box-shadow:0 12px 40px rgba(0,0,0,.25)",
].join(";");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.setAttribute("style", style);
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, primary: boolean, danger: boolean, onClick: () => void): HTMLButtonElement {
  const b = el("button");
  b.type = "button";
  b.textContent = label;
  b.setAttribute("style", "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;" + (primary
    ? `border:0;background:${danger ? "#dc2626" : "#2563eb"};color:#fff`
    : "border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit"));
  b.addEventListener("click", onClick);
  return b;
}

function openDialog(build: (d: HTMLDialogElement, done: (value: unknown) => void) => void): Promise<unknown> {
  const d = el("dialog", DIALOG_STYLE);
  let value: unknown = null;
  const done = (v: unknown) => { value = v; d.close(); };
  build(d, done);
  document.body.append(d);
  return new Promise((resolve) => {
    d.addEventListener("close", () => { d.remove(); resolve(value); }, { once: true });
    d.showModal();
  });
}

/** `AgentUI` on plain `<dialog>` elements; outside a document it refuses everything. */
export function domUI(): AgentUI {
  if (typeof document === "undefined" || typeof HTMLDialogElement === "undefined") return nullUI();
  return {
    async confirm(title, message, opts = {}) {
      const zh = isZh();
      const v = await openDialog((d, done) => {
        d.append(el("div", "font-weight:600;font-size:15px;margin-bottom:6px", title));
        if (message) d.append(el("div", "white-space:pre-wrap;opacity:.8;font-size:13px;margin-bottom:14px;word-break:break-word", message));
        const row = el("div", "display:flex;justify-content:flex-end;gap:8px;margin-top:10px");
        row.append(
          button(opts.cancel ?? (zh ? "取消" : "Cancel"), false, false, () => done(false)),
          button(opts.ok ?? (zh ? "确定" : "OK"), true, !!opts.danger, () => done(true)),
        );
        d.append(row);
        queueMicrotask(() => (row.lastElementChild as HTMLButtonElement).focus());
      });
      return v === true;
    },

    async select(title, options, opts = {}) {
      const zh = isZh();
      const v = await openDialog((d, done) => {
        d.append(el("div", "font-weight:600;font-size:15px;margin-bottom:6px", title));
        if (opts.message) d.append(el("div", "white-space:pre-wrap;opacity:.8;font-size:13px;margin-bottom:10px", opts.message));
        const list = el("div", "display:flex;flex-direction:column;gap:6px;margin:8px 0 12px");
        const name = "ra_sel_" + Math.random().toString(36).slice(2, 8);
        const inputs: HTMLInputElement[] = [];
        const addOption = (o: SelectOption) => {
          const label = el("label", "display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid rgba(127,127,127,.3);border-radius:8px;cursor:pointer");
          const input = el("input");
          input.type = opts.multi ? "checkbox" : "radio";
          input.name = name;
          input.value = o.value;
          input.setAttribute("style", "margin-top:3px");
          inputs.push(input);
          const text = el("div");
          text.append(el("div", "", o.label ?? o.value));
          if (o.description) text.append(el("div", "opacity:.7;font-size:12px", o.description));
          label.append(input, text);
          list.append(label);
        };
        options.forEach(addOption);
        let other: HTMLInputElement | null = null;
        if (opts.allowOther) {
          addOption({ value: "__other__", label: zh ? "其他…" : "Other…" });
          other = el("input", "font:inherit;padding:6px 8px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;width:100%;box-sizing:border-box;margin-top:-4px");
          other.placeholder = zh ? "请输入" : "Type your answer";
          other.addEventListener("focus", () => { const o = inputs.find((i) => i.value === "__other__"); if (o) o.checked = true; });
          list.append(other);
        }
        d.append(list);
        const row = el("div", "display:flex;justify-content:flex-end;gap:8px");
        row.append(
          button(zh ? "取消" : "Cancel", false, false, () => done(null)),
          button(zh ? "确定" : "OK", true, false, () => {
            const picked = inputs.filter((i) => i.checked).map((i) => (i.value === "__other__" ? (other?.value.trim() || "") : i.value)).filter(Boolean);
            if (!picked.length) return;
            done(picked);
          }),
        );
        d.append(row);
        queueMicrotask(() => inputs[0]?.focus());
      });
      return Array.isArray(v) ? (v as string[]) : null;
    },

    async input(title, opts = {}) {
      const zh = isZh();
      const v = await openDialog((d, done) => {
        d.append(el("div", "font-weight:600;font-size:15px;margin-bottom:6px", title));
        if (opts.message) d.append(el("div", "white-space:pre-wrap;opacity:.8;font-size:13px;margin-bottom:10px", opts.message));
        const field = el(opts.multiline ? "textarea" : "input", "font:inherit;padding:8px 10px;border:1px solid rgba(127,127,127,.35);border-radius:8px;background:transparent;color:inherit;width:100%;box-sizing:border-box;margin:6px 0 12px" + (opts.multiline ? ";min-height:96px;resize:vertical" : ""));
        if (opts.placeholder) field.placeholder = opts.placeholder;
        if (opts.initial) field.value = opts.initial;
        if (!opts.multiline) field.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") done(field.value); });
        d.append(field);
        const row = el("div", "display:flex;justify-content:flex-end;gap:8px");
        row.append(
          button(zh ? "取消" : "Cancel", false, false, () => done(null)),
          button(zh ? "确定" : "OK", true, false, () => done(field.value)),
        );
        d.append(row);
        queueMicrotask(() => field.focus());
      });
      return typeof v === "string" ? v : null;
    },

    notify(message, level = "info") {
      const host = el("div", [
        "position:fixed", "right:16px", "bottom:16px", "z-index:2147483647", "max-width:min(360px,calc(100vw - 32px))",
        "padding:10px 14px", "border-radius:10px", "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        "color:#fff", `background:${level === "error" ? "#dc2626" : level === "warning" ? "#d97706" : "#111827"}`,
        "box-shadow:0 8px 24px rgba(0,0,0,.25)", "white-space:pre-wrap", "word-break:break-word",
      ].join(";"), message);
      document.body.append(host);
      setTimeout(() => host.remove(), level === "error" ? 8000 : 4000);
    },
  };
}

/** An `AgentUI` with no user: every question is declined. */
export function nullUI(): AgentUI {
  return {
    confirm: async () => false,
    select: async () => null,
    input: async () => null,
    notify: (message, level = "info") => {
      // eslint-disable-next-line no-console
      (level === "error" ? console.error : console.log)(`[runapps agent] ${message}`);
    },
  };
}

interface Question {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  allow_other?: boolean;
  multi?: boolean;
}

/** The `ask_user` tool: up to three questions, each with options or free text. */
export function askUserTool(): Tool {
  return defineTool<{ questions: Question[] }>({
    name: "ask_user",
    description:
      "Ask the user one to three questions when the request is genuinely ambiguous and the answer changes what you would do. Give 2–5 short options when there are natural choices (allow_other adds a free-text choice); leave options out for a free-text answer. Do not ask what you can reasonably decide yourself.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1 },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 5,
                items: {
                  type: "object",
                  properties: { label: { type: "string", minLength: 1 }, description: { type: "string" } },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
              allow_other: { type: "boolean" },
              multi: { type: "boolean" },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    async execute({ questions }, ctx) {
      const answers: Array<{ question: string; answer: string | string[] | null }> = [];
      for (const q of questions) {
        ctx.signal.throwIfAborted();
        let answer: string | string[] | null;
        if (q.options && q.options.length) {
          const picked = await ctx.ui.select(q.question, q.options.map((o) => ({ value: o.label, label: o.label, description: o.description })), { multi: !!q.multi, allowOther: q.allow_other !== false });
          answer = picked === null ? null : q.multi ? picked : (picked[0] ?? null);
        } else {
          answer = await ctx.ui.input(q.question, { multiline: true });
        }
        answers.push({ question: q.question, answer });
        if (answer === null) break;
      }
      const unanswered = answers.some((a) => a.answer === null) || answers.length < questions.length;
      return {
        content: unanswered
          ? "The user dismissed the question without answering. Proceed with a reasonable default and say which you chose, or stop if you cannot."
          : answers.map((a) => `Q: ${a.question}\nA: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer}`).join("\n\n"),
        details: { answers },
      };
    },
  });
}
