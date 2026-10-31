// A dropdown that looks like the rest of the chat (a native <select>
// cannot be styled where it opens): a button showing the choice, and a
// list that opens under it (above when there is no room) with the choice
// ticked, a dimmer second line or side note per option, a filter box when
// the list is long, and the keyboard: arrows, Enter, Escape, type to filter.
// It fires "change" on its element like a <select>.

import { h, I } from "./dom.js";

export interface SelectOption {
  value: string;
  label: string;
  /** Dimmer text at the right of the option (limits, a hint). */
  note?: string;
}

export interface SelectBox {
  readonly el: HTMLElement;
  value: string;
  disabled: boolean;
  setOptions(options: SelectOption[]): void;
  readonly options: readonly SelectOption[];
}

/**
 * `host` is the element the list is positioned in (the chat's root: the
 * list may leave the menu the box sits in, never the chat).
 */
export function selectBox(host: HTMLElement, opts: { options?: SelectOption[]; value?: string; filterAt?: number; placeholder?: string; filterLabel?: string } = {}): SelectBox {
  let options: SelectOption[] = opts.options ?? [];
  let value = opts.value ?? options[0]?.value ?? "";
  let disabled = false;
  const btn = h("button", "ra-sel"); btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  const label = h("span", "ra-sell");
  const chev = h("span", "ra-selc"); chev.innerHTML = I.chevDown(14);
  btn.append(label, chev);
  let pop: HTMLElement | null = null;
  let active = 0;
  let filter = "";

  const draw = () => {
    const o = options.find((x) => x.value === value);
    label.textContent = o?.label ?? opts.placeholder ?? "";
    label.classList.toggle("ph", !o);
    btn.disabled = disabled;
  };
  const shown = () => (filter ? options.filter((o) => `${o.label} ${o.note ?? ""}`.toLowerCase().includes(filter.toLowerCase())) : options);

  const close = (focus = true) => {
    if (!pop) return;
    pop.remove(); pop = null; filter = "";
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (focus) btn.focus();
  };
  const outside = (e: Event) => { if (pop && (!btn.isConnected || (!pop.contains(e.target as Node) && !btn.contains(e.target as Node)))) close(false); };
  const pick = (v: string) => {
    const changed = v !== value;
    value = v; draw(); close();
    if (changed) btn.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const renderList = (list: HTMLElement) => {
    list.replaceChildren();
    const items = shown();
    if (active >= items.length) active = Math.max(0, items.length - 1);
    items.forEach((o, i) => {
      const row = h("div", "ra-selo" + (i === active ? " act" : "") + (o.value === value ? " cur" : ""));
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(o.value === value));
      const tick = h("span", "ra-selt"); tick.innerHTML = o.value === value ? I.tick(13) : "";
      row.append(tick, h("span", "ra-selol", o.label));
      if (o.note) row.append(h("span", "ra-selon", o.note));
      row.addEventListener("pointermove", () => { if (active !== i) { active = i; list.querySelectorAll(".ra-selo").forEach((r, j) => r.classList.toggle("act", j === i)); } });
      row.addEventListener("click", () => pick(o.value));
      list.append(row);
    });
    if (!items.length) list.append(h("div", "ra-selnone", "—"));
    list.querySelector(".act")?.scrollIntoView?.({ block: "nearest" });
  };

  const open = () => {
    if (pop || disabled) return;
    pop = h("div", "ra-selp");
    pop.setAttribute("role", "listbox");
    const list = h("div", "ra-sellist");
    let input: HTMLInputElement | null = null;
    if (options.length >= (opts.filterAt ?? 10)) {
      input = h("input", "ra-self") as HTMLInputElement;
      input.type = "text"; input.placeholder = opts.filterLabel ?? "Filter…";
      input.addEventListener("input", () => { filter = input!.value; active = 0; renderList(list); });
      input.addEventListener("keydown", keys);
      pop.append(input);
    }
    pop.append(list);
    active = Math.max(0, options.findIndex((o) => o.value === value));
    renderList(list);
    host.append(pop);
    // Under the button, as wide; above it when the room below is short.
    const hr = host.getBoundingClientRect(), br = btn.getBoundingClientRect();
    const below = hr.bottom - br.bottom - 8, above = br.top - hr.top - 8;
    const want = Math.min(pop.scrollHeight, 320);
    const up = below < want && above > below;
    pop.style.left = `${br.left - hr.left}px`;
    pop.style.width = `${br.width}px`;
    pop.style.maxHeight = `${Math.max(120, Math.min(320, up ? above : below))}px`;
    if (up) pop.style.bottom = `${hr.bottom - br.top + 4}px`; else pop.style.top = `${br.bottom - hr.top + 4}px`;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    (input ?? btn).focus();
  };

  const keys = (e: KeyboardEvent) => {
    if (!pop) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      return;
    }
    const items = shown();
    const list = pop.querySelector<HTMLElement>(".ra-sellist")!;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderList(list); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); renderList(list); }
    else if (e.key === "Enter") { e.preventDefault(); const o = items[active]; if (o) pick(o.value); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") close(false);
  };
  btn.addEventListener("click", () => (pop ? close() : open()));
  btn.addEventListener("keydown", keys);
  draw();

  return {
    el: btn,
    get value() { return value; },
    set value(v: string) { value = v; draw(); },
    get disabled() { return disabled; },
    set disabled(d: boolean) { disabled = d; if (d) close(false); draw(); },
    get options() { return options; },
    setOptions(next) { options = next; if (!options.some((o) => o.value === value)) value = options[0]?.value ?? ""; draw(); },
  };
}

/** The dropdown's look, in the chat's tokens. */
export const SELECT_CSS = `
.ra-chat .ra-sel{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 10px 6px 12px;box-sizing:border-box;font:inherit;font-size:13px;color:var(--ra-fg);background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:8px;text-align:left;cursor:pointer}
.ra-chat .ra-sel:hover:not(:disabled){border-color:color-mix(in srgb,var(--ra-fg) 25%,var(--ra-border))}
.ra-chat .ra-sel:focus-visible,.ra-chat .ra-sel[aria-expanded=true]{border-color:var(--ra-accent);outline:0;box-shadow:0 0 0 3px var(--ra-accent-subtle)}
.ra-chat .ra-sel:disabled{opacity:.55;cursor:not-allowed}
.ra-chat .ra-sel .ra-sell{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-chat .ra-sel .ra-sell.ph{color:var(--ra-fg-muted)}
.ra-chat .ra-sel .ra-selc{flex:none;display:inline-flex;color:var(--ra-fg-muted);transition:transform .15s}
.ra-chat .ra-sel[aria-expanded=true] .ra-selc{transform:rotate(180deg)}
.ra-chat .ra-selp{position:absolute;z-index:30;display:flex;flex-direction:column;background:var(--ra-panel);border:1px solid var(--ra-border);border-radius:10px;box-shadow:var(--ra-shadow-md);padding:4px;box-sizing:border-box;overflow:hidden;font-size:13px}
.ra-chat .ra-selp .ra-self{flex:none;margin:2px 2px 4px;padding:6px 9px;font:inherit;font-size:13px;color:var(--ra-fg);background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:6px;outline:0}
.ra-chat .ra-selp .ra-self:focus{border-color:var(--ra-accent)}
.ra-chat .ra-selp .ra-sellist{overflow-y:auto;min-height:0}
.ra-chat .ra-selo{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;cursor:pointer;color:var(--ra-fg)}
.ra-chat .ra-selo.act{background:var(--ra-muted)}
.ra-chat .ra-selo .ra-selt{flex:none;width:14px;display:inline-flex;color:var(--ra-accent-fg)}
.ra-chat .ra-selo .ra-selol{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-chat .ra-selo.cur .ra-selol{font-weight:500}
.ra-chat .ra-selo .ra-selon{flex:none;font-size:11.5px;color:var(--ra-fg-muted);font-variant-numeric:tabular-nums}
.ra-chat .ra-selnone{padding:8px;color:var(--ra-fg-muted)}
`;
