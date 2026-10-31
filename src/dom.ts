// DOM helpers shared by the chat and its files panel: element factory,
// inline lucide icons, the Markdown → DOM renderer, and the chat's own
// dialogs (over the chat, not in the agent's question area).

import { renderMarkdown } from "./markdown.js";

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const svg = (size: number, body: string, stroke = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const I = {
  tick: (s = 14) => svg(s, '<path d="M20 6 9 17l-5-5"/>'),
  enter: (s = 14) => svg(s, '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>'),
  lock: (s = 12) => svg(s, '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  puzzle: (s = 14) => svg(s, '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>'),
  spark: (s = 14) => svg(s, '<path d="M9.9 2.1a1 1 0 0 1 1.9 0l1.3 4.1a4 4 0 0 0 2.6 2.6l4.1 1.3a1 1 0 0 1 0 1.9l-4.1 1.3a4 4 0 0 0-2.6 2.6l-1.3 4.1a1 1 0 0 1-1.9 0l-1.3-4.1a4 4 0 0 0-2.6-2.6L2.1 12a1 1 0 0 1 0-1.9l4.1-1.3a4 4 0 0 0 2.6-2.6z"/><path d="M20 3v4M22 5h-4"/>'),
  send: (s = 16) => svg(s, '<path d="M14.5 9.5 22 2M22 2l-7 20-4-9-9-4z"/>'),
  hist: (s = 14) => svg(s, '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/>'),
  eraser: (s = 14) => svg(s, '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>'),
  pointer: (s = 14) => svg(s, '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>'),
  plus: (s = 14) => svg(s, '<path d="M12 5v14M5 12h14"/>'),
  chev: (s = 14) => svg(s, '<path d="m9 18 6-6-6-6"/>'),
  brain: (s = 13) => svg(s, '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.6 6.5a3 3 0 0 0 .4 1M6.4 6.5a3 3 0 0 1-.4 1M12 18v-5"/>'),
  layers: (s = 14) => svg(s, '<path d="m12.8 2.2 8.5 4a1 1 0 0 1 0 1.6l-8.5 4a2 2 0 0 1-1.6 0l-8.5-4a1 1 0 0 1 0-1.6l8.5-4a2 2 0 0 1 1.6 0"/><path d="m2.4 11.9 8.8 4.1a2 2 0 0 0 1.6 0l8.8-4.1"/><path d="m2.4 16.9 8.8 4.1a2 2 0 0 0 1.6 0l8.8-4.1"/>'),
  check: (s = 15) => svg(s, '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  xcircle: (s = 15) => svg(s, '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>'),
  ban: (s = 15) => svg(s, '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
  square: (s = 12) => svg(s, '<rect x="3" y="3" width="18" height="18" rx="2"/>'),
  corner: (s = 14) => svg(s, '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>'),
  x: (s = 12) => svg(s, '<path d="M18 6 6 18M6 6l12 12"/>'),
  trash: (s = 13) => svg(s, '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  clip: (s = 16) => svg(s, '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  file: (s = 14) => svg(s, '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  folder: (s = 14) => svg(s, '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  folderOpen: (s = 14) => svg(s, '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
  upload: (s = 14) => svg(s, '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  download: (s = 14) => svg(s, '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  refresh: (s = 13) => svg(s, '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>'),
  save: (s = 12) => svg(s, '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>'),
  chevDown: (s = 12) => svg(s, '<path d="m6 9 6 6 6-6"/>'),
  checks: (s = 13) => svg(s, '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>'),
  undo: (s = 13) => svg(s, '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  gear: (s = 14) => svg(s, '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.2a2 2 0 0 1 1 1.7V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.2a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  wrap: (s = 14) => svg(s, '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>'),
  eye: (s = 14) => svg(s, '<path d="M2.1 12.4a1 1 0 0 1 0-.8 10.5 10.5 0 0 1 19.8 0 1 1 0 0 1 0 .8 10.5 10.5 0 0 1-19.8 0"/><circle cx="12" cy="12" r="3"/>'),
  pen: (s = 14) => svg(s, '<path d="M21.2 6.4a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L4 16.4V20h3.6z"/><path d="m15 5 4 4"/>'),
  alert: (s = 14) => svg(s, '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  arrowDown: (s = 15) => svg(s, '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  bug: (s = 14) => svg(s, '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>'),
  copy: (s = 14) => svg(s, '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  fileText: (s = 13) => svg(s, '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8M16 13H8M16 17H8"/>'),
  filePlus: (s = 13) => svg(s, '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6M12 18v-6"/>'),
  filePen: (s = 13) => svg(s, '<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M13.4 20.3a1 1 0 0 0 .5-.3l6.9-6.9a1.4 1.4 0 0 0-2-2l-6.9 6.9a1 1 0 0 0-.3.5l-.4 1.8z"/>'),
  fileX: (s = 13) => svg(s, '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m14.5 12.5-5 5M9.5 12.5l5 5"/>'),
  search: (s = 13) => svg(s, '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  braces: (s = 13) => svg(s, '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>'),
  message: (s = 13) => svg(s, '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  wrench: (s = 13) => svg(s, '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
};

/**
 * The chat's own dialog over `root`: title, message, optional extra
 * content, Cancel / OK. Resolves true for OK; Escape and the backdrop
 * cancel. `submitOnEnter` makes Enter (not while composing) press OK.
 */
export function modal(root: HTMLElement, o: { title: string; message?: string; body?: HTMLElement[]; ok: string; cancel: string; danger?: boolean; focus?: "ok" | "cancel" | HTMLElement; submitOnEnter?: boolean }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = h("div", "ra-modal");
    const dlg = h("div", "ra-dlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-label", o.title);
    dlg.append(h("div", "ra-dt", o.title));
    if (o.message) dlg.append(h("div", "ra-dm", o.message));
    if (o.body) dlg.append(...o.body);
    const row = h("div", "ra-btns");
    const done = (v: boolean) => { overlay.remove(); resolve(v); };
    const cancel = h("button", "ra-btn", o.cancel); cancel.type = "button"; cancel.addEventListener("click", () => done(false));
    const ok = h("button", "ra-btn " + (o.danger ? "red" : "solid"), o.ok); ok.type = "button"; ok.addEventListener("click", () => done(true));
    row.append(cancel, ok);
    dlg.append(row);
    overlay.append(dlg);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      if (o.submitOnEnter && e.key === "Enter" && !(e as KeyboardEvent).isComposing && (e as KeyboardEvent).keyCode !== 229) { e.preventDefault(); done(true); }
    });
    root.append(overlay);
    const f = o.focus === "ok" ? ok : o.focus instanceof HTMLElement ? o.focus : cancel;
    queueMicrotask(() => { f.focus(); if (f instanceof HTMLInputElement) f.select(); });
  });
}

/** A yes/no question of the chat's own (deleting a session). */
export function modalConfirm(root: HTMLElement, title: string, message: string, opts: { ok: string; cancel: string; danger?: boolean }): Promise<boolean> {
  return modal(root, { title, message, ...opts });
}

/** A one-line question of the chat's own (a new file's path); null when cancelled or empty. */
export async function modalInput(root: HTMLElement, title: string, opts: { ok: string; cancel: string; initial?: string; placeholder?: string }): Promise<string | null> {
  const field = h("input", "ra-field"); field.type = "text"; field.value = opts.initial ?? ""; if (opts.placeholder) field.placeholder = opts.placeholder;
  const ok = await modal(root, { title, body: [field], ok: opts.ok, cancel: opts.cancel, focus: field, submitOnEnter: true });
  return ok ? field.value.trim() || null : null;
}

/** Hands the browser a file to save. */
export function downloadBlob(name: string, data: string | Uint8Array, type?: string): void {
  const blob = new Blob([data as BlobPart], { type: type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = h("a"); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Markdown → DOM, with a header (language, copy) on each code block and a scroll wrapper on tables. */
export function renderMD(el: HTMLElement, md: string, streaming: boolean): void {
  el.innerHTML = renderMarkdown(md);
  el.classList.toggle("ra-cursor", streaming);
  for (const pre of Array.from(el.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const lang = code?.className.match(/language-([\w+#-]+)/)?.[1] ?? "";
    const box = h("div", "ra-cb");
    const head = h("div", "ra-cbh");
    head.append(h("span", "", lang));
    const copy = h("button", "ra-copy"); copy.type = "button"; copy.innerHTML = I.copy(); copy.title = /^zh/i.test(document.documentElement.lang || navigator.language || "") ? "复制" : "Copy"; copy.setAttribute("aria-label", copy.title);
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText((code?.textContent ?? "").replace(/\n$/, "")).then(() => { copy.innerHTML = I.check(14); setTimeout(() => { copy.innerHTML = I.copy(); }, 1200); });
    });
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
