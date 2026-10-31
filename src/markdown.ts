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

/** Inline markup within one block (text already raw; escapes here). */
export function renderInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    // Inline code: `…` (any run of backticks, matched by the same run).
    if (c === "`") {
      const m = /^`+/.exec(text.slice(i))!;
      const close = text.indexOf(m[0], i + m[0].length);
      if (close > 0) {
        out += `<code>${escapeHTML(text.slice(i + m[0].length, close).trim())}</code>`;
        i = close + m[0].length;
        continue;
      }
    }
    // Links: [label](url) — the label may hold inline markup.
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(i));
      if (m) {
        const href = safeHref(m[2]!);
        const label = renderInline(m[1]!);
        out += href ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
        i += m[0].length;
        continue;
      }
    }
    // Bare URLs.
    if ((c === "h" && /^https?:\/\//.test(text.slice(i, i + 8))) ) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(text.slice(i));
      if (m) {
        out += `<a href="${escapeHTML(m[0])}" target="_blank" rel="noopener noreferrer">${escapeHTML(m[0])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    // Strong / emphasis / strikethrough.
    if (c === "*" || c === "_" || c === "~") {
      const run = text[i + 1] === c ? c + c : c;
      if (run.length === 2 || c !== "~") {
        const close = findClose(text, i + run.length, run);
        if (close > 0) {
          const inner = renderInline(text.slice(i + run.length, close));
          out += run === "~~" ? `<del>${inner}</del>` : run.length === 2 ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
          i = close + run.length;
          continue;
        }
      }
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

/** The closing delimiter of an emphasis run: not preceded by a space, not an empty span. */
function findClose(text: string, from: number, run: string): number {
  let j = from;
  while ((j = text.indexOf(run, j)) > 0) {
    if (j > from && text[j - 1] !== " " && text[j - 1] !== "\n") return j;
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
    if (fence) {
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
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
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
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
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
