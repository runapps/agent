// A small Markdown → HTML renderer for chat replies: fenced code, headings,
// lists, blockquotes, tables, rules, paragraphs; inline code, bold, italic,
// strikethrough and links. Everything is HTML-escaped; links are kept only
// for http(s)/mailto. Good enough for model output, with no dependency.
// A fence left open (a reply still streaming) renders as code.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^(\/|\.\/|\.\.\/|#)/.test(u) && !/^\/\//.test(u)) return u;
  return null;
}

const WORD = /[\p{L}\p{N}]/u;
const TICKS = /`+/y;
const LINK = /\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/y;
const BARE = /https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+/y;

/** Inline markup within one block (text already raw; escapes here). */
export function renderInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  // Searches that already failed from an earlier position fail from any later one: remember them, so
  // pathological input (many "*" or "[" with nothing to close them) stays linear.
  const noClose = new Map<string, number>();
  let nextLink = -2;
  while (i < n) {
    const c = text[i]!;
    // Inline code: `…` (any run of backticks, matched by the same run).
    if (c === "`") {
      TICKS.lastIndex = i;
      const run = TICKS.exec(text)![0];
      const close = text.indexOf(run, i + run.length);
      if (close > 0) {
        out += `<code>${escapeHTML(text.slice(i + run.length, close).trim())}</code>`;
        i = close + run.length;
        continue;
      }
      out += escapeHTML(run);
      i += run.length;
      continue;
    }
    // Links: [label](url) — the label may hold inline markup; the url may hold balanced parentheses.
    if (c === "[") {
      if (nextLink !== -1 && nextLink < i) nextLink = text.indexOf("](", i);
      if (nextLink !== -1) {
        LINK.lastIndex = i;
        const m = LINK.exec(text);
        if (m) {
          const href = safeHref(m[2]!);
          const label = renderInline(m[1]!);
          out += href ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
          i += m[0].length;
          continue;
        }
      }
    }
    // Bare URLs (balanced parentheses kept, trailing punctuation left out).
    if (c === "h" && text.startsWith("http", i) && (i === 0 || !WORD.test(text[i - 1]!))) {
      BARE.lastIndex = i;
      const m = BARE.exec(text);
      if (m) {
        const url = m[0].replace(/[.,;:!?'"]+$/, "");
        if (url.length > 8) {
          out += `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`;
          i += url.length;
          continue;
        }
      }
    }
    // Strong / emphasis / strikethrough. "_" never opens or closes inside a word (my_file_name).
    if (c === "*" || c === "_" || c === "~") {
      const run = text[i + 1] === c ? c + c : c;
      const opens = (run.length === 2 || c !== "~")
        && i + run.length < n && !/\s/.test(text[i + run.length]!)
        && !(c === "_" && i > 0 && WORD.test(text[i - 1]!));
      if (opens && (noClose.get(run) ?? Infinity) > i) {
        const close = findClose(text, i + run.length, run);
        if (close > 0) {
          const inner = renderInline(text.slice(i + run.length, close));
          out += run === "~~" ? `<del>${inner}</del>` : run.length === 2 ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
          i = close + run.length;
          continue;
        }
        noClose.set(run, Math.min(noClose.get(run) ?? Infinity, i));
      }
      out += escapeHTML(run);
      i += run.length;
      continue;
    }
    if (c === "\\" && i + 1 < n && /[\\`*_{}\[\]()#+\-.!~|>]/.test(text[i + 1]!)) {
      out += escapeHTML(text[i + 1]!);
      i += 2;
      continue;
    }
    if (c === "\n") {
      out += "<br>";
      i++;
      continue;
    }
    out += escapeHTML(c);
    i++;
  }
  return out;
}

/** The closing delimiter of an emphasis run: not preceded by a space, not an empty span; "_" not followed by a letter. */
function findClose(text: string, from: number, run: string): number {
  let j = from;
  while ((j = text.indexOf(run, j)) > 0) {
    const ok = j > from && text[j - 1] !== " " && text[j - 1] !== "\n"
      && !(run[0] === "_" && j + run.length < text.length && WORD.test(text[j + run.length]!));
    if (ok) return j;
    j += run.length;
  }
  return -1;
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)/;

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code (an unclosed fence runs to the end).
    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === "`" && line.slice(fence[0].length).includes("`"))) {
      flush();
      const marker = fence[2]!;
      const lang = fence[3] ?? "";
      const body: string[] = [];
      i++;
      const closes = (l: string) => { const t = l.trim(); return t.length >= marker.length && t === marker[0]!.repeat(t.length); };
      while (i < lines.length && !closes(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      const cls = lang ? ` class="language-${escapeHTML(lang)}"` : "";
      html.push(`<pre><code${cls}>${escapeHTML(body.join("\n"))}\n</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flush();
      html.push(`<h${heading[1]!.length}>${renderInline(heading[2]!)}</h${heading[1]!.length}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
      continue;
    }
    // Table: a header row, a delimiter row, then rows.
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const aligns = cells(lines[i + 1]!).map((d) => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : ""));
      const row = (l: string, tag: string) => `<tr>${cells(l).map((c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${renderInline(c)}</${tag}>`).join("")}</tr>`;
      let t = `<table><thead>${row(line, "th")}</thead><tbody>`;
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        t += row(lines[i]!, "td");
        i++;
      }
      html.push(t + "</tbody></table>");
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      flush();
      const { html: h, next } = renderList(lines, i, list[1]!.length);
      html.push(h);
      i = next;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return html.join("\n");
}

/** A list starting at `start` with items indented by `indent`; nested items follow deeper indentation. */
function renderList(lines: string[], start: number, indent: number): { html: string; next: number } {
  const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const startNum = ordered ? parseInt(first[2]!, 10) : 1;
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
    const bodyLines = [m[3]!];
    i++;
    // Continuation lines: deeper indentation (nested lists or wrapped text) until the next sibling / blank+dedent.
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        // A blank line ends the item unless more indented content follows.
        if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && (lines[i + 1]!.match(/^\s*/)![0].length > indent)) {
          bodyLines.push("");
          i++;
          continue;
        }
        break;
      }
      const ind = l.match(/^\s*/)![0].length;
      if (ind > indent) {
        bodyLines.push(l);
        i++;
        continue;
      }
      break;
    }
    const task = /^\[([ xX])\]\s+/.exec(bodyLines[0]!);
    if (task) bodyLines[0] = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ` + bodyLines[0]!.slice(task[0].length);
    items.push(`<li>${renderItemBody(bodyLines, indent, !!task)}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  const attr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return { html: `<${tag}${attr}>${items.join("")}</${tag}>`, next: i };
}

function renderItemBody(bodyLines: string[], indent: number, rawFirst: boolean): string {
  // First line inline; the rest (dedented) as nested markdown.
  const firstLine = bodyLines[0]!;
  const rest = bodyLines.slice(1).map((l) => l.replace(new RegExp(`^\\s{0,${indent + 2}}`), "")).join("\n").trim();
  const head = rawFirst ? firstLine.replace(/^(<input[^>]*> )/, "$1") : "";
  const first = rawFirst ? head.slice(0, head.indexOf("> ") + 2) + renderInline(head.slice(head.indexOf("> ") + 2)) : renderInline(firstLine);
  if (!rest) return first;
  const nested = renderMarkdown(rest);
  // A lone paragraph in a nested block stays inline with the item.
  return first + (nested.startsWith("<p>") && !nested.includes("</p>\n") ? `<br>${nested.slice(3, -4)}` : nested);
}
