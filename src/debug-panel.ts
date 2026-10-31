// The chat's debug panel (renderChat `debug: true`): what the agent did,
// as the harness app's DebugPanel shows it — the call chain (runs, turns,
// tool calls with arguments and results), the requests sent to the model
// with their responses, the raw event log, the context (system prompt,
// messages, limits, usage) and the tools declared to the model. It
// records from the moment the chat opens a session, background runs too.

import type { Agent } from "./index.js";
import { h, I } from "./dom.js";

export interface DebugStrings {
  debug: string; dCalls: string; dRequests: string; dEvents: string; dContext: string; dTools: string;
  dClear: string; dFilter: string; dNoCalls: string; dNoRequests: string; dNoEvents: string; dSystem: string; dMessages: string;
  dPayload: string; dResponse: string; dRun: string; dTurn: string; args: string; result: string; close: string;
}

interface Span { id: string; name: string; args: unknown; status: string; result?: string; startedAt: number; durationMs?: number; runId: string; turn: number }
interface Req { runId: string; turn: number; at: number; params: unknown; durationMs?: number; finishReason?: string; usage?: unknown; message?: unknown; error?: string }
interface Ev { at: number; name: string; detail: string; data: unknown }
interface Trace { spans: Span[]; requests: Req[]; events: Ev[]; turn: Map<string, number>; runs: string[] }

const MAX = { spans: 400, requests: 120, events: 600 };
const NOISY = new Set(["text_delta", "reasoning_delta", "tool_update"]);

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
function json(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? "undefined"; } catch { return String(v); }
}
const cap = <T,>(a: T[], n: number) => { if (a.length > n) a.splice(0, a.length - n); };

export interface DebugPanel {
  readonly el: HTMLElement;
  readonly visible: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Starts recording an agent (once per agent) and shows it. */
  setAgent(agent: Agent): void;
  dispose(): void;
}

export function debugPanel(opts: { t: DebugStrings; root: HTMLElement; onShow?: (visible: boolean) => void }): DebugPanel {
  const { t, root } = opts;
  const traces = new WeakMap<Agent, Trace>();
  const subs: Array<() => void> = [];
  let agent: Agent | null = null;
  let visible = false;
  type Tab = "calls" | "requests" | "events" | "context" | "tools";
  let tab: Tab = "calls";
  let filter = "";
  let frame: ReturnType<typeof setTimeout> | null = null;

  const el = h("div", "ra-fp ra-dp"); el.setAttribute("role", "complementary"); el.style.display = "none";
  const head = h("div", "ra-fph");
  const tabs = h("div", "ra-dtabs");
  const closeBtn = h("button", "ra-ib"); closeBtn.type = "button"; closeBtn.innerHTML = I.x(14); closeBtn.title = t.close; closeBtn.setAttribute("aria-label", t.close);
  closeBtn.addEventListener("click", () => close());
  head.append(tabs, h("span", "ra-sp"), closeBtn);
  const body = h("div", "ra-dbody");
  el.append(head, body);

  const TABS: Array<[Tab, string]> = [["calls", t.dCalls], ["requests", t.dRequests], ["events", t.dEvents], ["context", t.dContext], ["tools", t.dTools]];
  const drawTabs = () => {
    const tr = agent ? traces.get(agent) : undefined;
    const count: Record<string, number> = { calls: tr?.spans.length ?? 0, requests: tr?.requests.length ?? 0 };
    tabs.replaceChildren(...TABS.map(([k, label]) => {
      const b = h("button", "ra-dtab" + (k === tab ? " on" : "")); b.type = "button";
      b.append(label);
      if (count[k]) b.append(h("span", "ra-dcount", String(count[k])));
      b.addEventListener("click", () => { tab = k; draw(); });
      return b;
    }));
  };

  /** A folded row: a head line, and a body built only when opened. */
  const fold = (headEls: (Node | string)[], build: () => Node[]): HTMLElement => {
    const d = h("details", "ra-dfold") as HTMLDetailsElement;
    const s = h("summary");
    const chev = h("span", "ra-chev"); chev.innerHTML = I.chev(12);
    s.append(chev, ...headEls);
    d.append(s);
    let built = false;
    d.addEventListener("toggle", () => { if (d.open && !built) { built = true; const inner = h("div", "ra-dfb"); inner.append(...build()); d.append(inner); } });
    return d;
  };
  const pre = (v: unknown, cls = "") => { const p = h("pre", "ra-dpre " + cls); p.textContent = typeof v === "string" ? v : json(v); return p; };
  const label = (text: string) => h("div", "ra-dlabel", text);
  const muted = (text: string) => h("span", "ra-dmuted", text);
  const mono = (text: string) => h("span", "ra-dmono", text);
  const empty = (text: string) => h("div", "ra-fpe", text);
  const status = (s: string) => {
    const e = h("span", "ra-dst " + (s === "running" ? "run" : s === "ok" ? "ok" : "fail"));
    if (s === "running") e.append(h("span", "ra-spin")); else e.innerHTML = s === "ok" ? I.check(13) : I.xcircle(13);
    return e;
  };

  const drawCalls = (tr: Trace): Node[] => {
    if (!tr.spans.length) return [empty(t.dNoCalls)];
    // The chain: newest run first; within a run, its turns in order, each with its tool calls.
    const out: Node[] = [];
    for (const runId of [...tr.runs].reverse()) {
      const spans = tr.spans.filter((s) => s.runId === runId);
      const reqs = tr.requests.filter((r) => r.runId === runId);
      if (!spans.length && !reqs.length) continue;
      const run = h("div", "ra-drun");
      run.append(h("div", "ra-drh", `${t.dRun} ${clock(reqs[0]?.at ?? spans[0]?.startedAt ?? Date.now())} · ${runId.slice(-4)}`));
      const turns = [...new Set([...reqs.map((r) => r.turn), ...spans.map((s) => s.turn)])].sort((a, b) => a - b);
      for (const turn of turns) {
        const req = reqs.find((r) => r.turn === turn);
        const line = h("div", "ra-dturn");
        line.append(muted(t.dTurn.replace("{n}", String(turn))));
        if (req) line.append(mono(` · ${(req.params as { model?: string }).model || "default"}`), muted(req.durationMs !== undefined ? ` · ${Math.round(req.durationMs)}ms` : " · …"), req.error ? h("span", "ra-dst fail", ` ${req.error}`) : muted(req.finishReason ? ` · ${req.finishReason}` : ""));
        run.append(line);
        for (const s of spans.filter((x) => x.turn === turn)) {
          run.append(fold([status(s.status), mono(s.name), muted(s.durationMs !== undefined ? `${Math.round(s.durationMs)}ms · ${clock(s.startedAt)}` : clock(s.startedAt))], () => [
            h("div", "ra-dmuted", s.id), label(t.args), pre(s.args), ...(s.result !== undefined ? [label(t.result), pre(s.result)] : []),
          ]));
        }
      }
      out.push(run);
    }
    return out;
  };

  const drawRequests = (tr: Trace): Node[] => {
    if (!tr.requests.length) return [empty(t.dNoRequests)];
    return [...tr.requests].reverse().map((r) => {
      const p = r.params as { model?: string; messages?: unknown[]; tools?: unknown[]; max_tokens?: number };
      const u = r.usage as { prompt_tokens?: number; completion_tokens?: number; total_cost?: number } | undefined;
      const badge = h("span", "ra-dbadge " + (r.error ? "fail" : r.durationMs === undefined ? "" : "ok"), r.error ? "error" : r.durationMs === undefined ? "…" : (r.finishReason ?? "ok"));
      return fold([badge, mono(p.model || "default"), muted(`${p.messages?.length ?? 0} msgs · ${p.tools?.length ?? 0} tools${u ? ` · ${u.prompt_tokens ?? 0}→${u.completion_tokens ?? 0} tok` : ""}${u?.total_cost ? ` · $${u.total_cost.toFixed(4)}` : ""}`), muted(` ${r.durationMs !== undefined ? `${Math.round(r.durationMs)}ms · ` : ""}${clock(r.at)}`)], () => [
        label(t.dPayload), pre(r.params, "tall"), ...(r.message !== undefined || r.error ? [label(t.dResponse), pre(r.error ?? r.message)] : []), ...(u ? [pre(u)] : []),
      ]);
    });
  };

  const drawEvents = (tr: Trace): Node[] => {
    const bar = h("div", "ra-dbar");
    const input = h("input", "ra-field"); input.type = "text"; input.placeholder = t.dFilter; input.value = filter;
    input.addEventListener("input", () => { filter = input.value; schedule(); });
    const clear = h("button", "ra-ib"); clear.type = "button"; clear.innerHTML = I.trash(13); clear.title = t.dClear; clear.setAttribute("aria-label", t.dClear);
    clear.addEventListener("click", () => { tr.events.length = 0; tr.spans.length = 0; tr.requests.length = 0; tr.runs.length = 0; draw(); });
    bar.append(input, clear);
    const list = tr.events.filter((e) => !filter || e.name.includes(filter) || e.detail.includes(filter));
    if (!list.length) return [bar, empty(t.dNoEvents)];
    return [bar, ...[...list].reverse().slice(0, 300).map((e) => fold([muted(clock(e.at)), mono(e.name), muted(e.detail)], () => [pre(e.data)]))];
  };

  const drawContext = (a: Agent): Node[] => {
    const box = h("div", "ra-dctx");
    const rows = h("div", "ra-dkv");
    const add = (k: string, v: string) => { rows.append(h("span", "ra-dmuted", k), h("span", "ra-dmono", v)); };
    const u = a.usage, msgs = a.messages;
    add("session", a.id);
    add("directory", a.workspace?.id ?? "—");
    add("model", a.settings.model ?? "(default)");
    add("messages", `${msgs.filter((m) => m.role === "user").length} user · ${msgs.filter((m) => m.role === "assistant").length} assistant · ${msgs.filter((m) => m.role === "tool").length} tool`);
    add("usage", `${u.prompt_tokens} in · ${u.completion_tokens} out · ${u.calls} calls · $${u.total_cost.toFixed(4)}`);
    const ctx = h("span", "ra-dmono", "…");
    rows.append(h("span", "ra-dmuted", "context"), ctx);
    void a.context().then((c) => { ctx.textContent = `${c.used} / ${c.window} (${((c.used / c.window) * 100).toFixed(2)}%)`; }).catch(() => { ctx.textContent = "—"; });
    const sys = pre("…", "tall");
    void a.systemPrompt().then((p) => { sys.textContent = p; }).catch((err) => { sys.textContent = String(err); });
    box.append(rows, label(t.dSystem), sys, label(`${t.dMessages} (${msgs.length})`), pre(msgs, "tall"));
    return [box];
  };

  const drawTools = (a: Agent): Node[] => a.tools.map((tool) => fold([mono(tool.name), muted(tool.destructive ? " destructive" : "")], () => [h("div", "ra-ddesc", tool.description ?? ""), pre(tool.parameters)]));

  function draw(): void {
    frame = null;
    if (!visible) return;
    drawTabs();
    if (!agent) { body.replaceChildren(); return; }
    const tr = traces.get(agent)!;
    // Keep the open folds and the scroll position across redraws: only the events and calls lists change.
    const scroll = body.scrollTop;
    const focusFilter = document.activeElement?.classList.contains("ra-field") && body.contains(document.activeElement);
    const nodes = tab === "calls" ? drawCalls(tr) : tab === "requests" ? drawRequests(tr) : tab === "events" ? drawEvents(tr) : tab === "context" ? drawContext(agent) : drawTools(agent);
    body.replaceChildren(...nodes);
    body.scrollTop = scroll;
    if (focusFilter) { const f = body.querySelector<HTMLInputElement>(".ra-field"); f?.focus(); f?.setSelectionRange(f.value.length, f.value.length); }
  }
  /** Redraw at most every 300 ms, and not the context/tools tabs (they redraw on demand) or a tab with a fold open. */
  const schedule = () => {
    if (!visible || frame) return;
    if ((tab === "context" || tab === "tools") || body.querySelector("details[open]")) { drawTabs(); return; }
    frame = setTimeout(draw, 300);
  };

  const record = (a: Agent) => {
    if (traces.has(a)) return;
    const tr: Trace = { spans: [], requests: [], events: [], turn: new Map(), runs: [] };
    traces.set(a, tr);
    subs.push(a.on("*", (name: string, ev: unknown) => {
      const e = (ev ?? {}) as Record<string, unknown>;
      const runId = String(e.runId ?? "");
      if (name === "run_start") { tr.runs.push(runId); cap(tr.runs, 60); }
      if (name === "turn_start") tr.turn.set(runId, Number(e.turn) || 1);
      if (name === "request") { tr.requests.push({ runId, turn: Number(e.turn), at: Date.now(), params: e.params }); cap(tr.requests, MAX.requests); }
      if (name === "response") {
        const r = [...tr.requests].reverse().find((x) => x.runId === runId && x.turn === Number(e.turn) && x.durationMs === undefined);
        if (r) Object.assign(r, { durationMs: e.durationMs, finishReason: e.finishReason, usage: e.usage, message: e.message, error: e.error });
      }
      if (name === "tool_start") { tr.spans.push({ id: String(e.id), name: String(e.name), args: e.args, status: "running", startedAt: Date.now(), runId, turn: tr.turn.get(runId) ?? 1 }); cap(tr.spans, MAX.spans); }
      if (name === "tool_end") {
        const s = [...tr.spans].reverse().find((x) => x.id === String(e.id));
        if (s) Object.assign(s, { status: String(e.status), result: e.result, durationMs: e.durationMs });
      }
      if (!NOISY.has(name)) {
        const detail = name === "tool_start" || name === "tool_end" ? String(e.name ?? "") : name === "run_end" ? String(e.reason ?? "") : name === "response" ? String(e.error ?? e.finishReason ?? "") : "";
        tr.events.push({ at: Date.now(), name, detail, data: name === "request" ? { runId, turn: e.turn, model: (e.params as { model?: string })?.model } : ev });
        cap(tr.events, MAX.events);
      }
      if (a === agent) schedule();
    }));
  };

  const open = () => { visible = true; el.style.display = ""; root.classList.add("ra-files-open"); opts.onShow?.(true); draw(); };
  function close(): void { if (!visible) return; visible = false; el.style.display = "none"; root.classList.remove("ra-files-open"); opts.onShow?.(false); }

  return {
    el,
    get visible() { return visible; },
    open,
    close,
    toggle: () => (visible ? close() : open()),
    setAgent(a) { record(a); agent = a; if (visible) draw(); },
    dispose() { for (const u of subs) u(); if (frame) clearTimeout(frame); el.remove(); },
  };
}
