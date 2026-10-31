// The chat's Markdown renderer: blocks, inline markup, escaping, open fences.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderInline } from "../dist/index.js";

test("inline markup and escaping", () => {
  assert.equal(renderInline("a **b** _c_ `d<e>` ~~f~~"), "a <strong>b</strong> <em>c</em> <code>d&lt;e&gt;</code> <del>f</del>");
  assert.equal(renderInline("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
  assert.equal(renderInline("[ok](https://a.b/c) [bad](javascript:alert)"), '<a href="https://a.b/c" target="_blank" rel="noopener noreferrer">ok</a> bad');
  assert.equal(renderInline("see https://x.y/z."), 'see <a href="https://x.y/z" target="_blank" rel="noopener noreferrer">https://x.y/z</a>.');
  assert.equal(renderInline("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(renderInline("\\*not\\*"), "*not*");
});

test("blocks", () => {
  const html = renderMarkdown("# Title\n\nPara one\nline two\n\n- a\n- b\n  - nested\n\n1. x\n2. y\n\n> quote\n\n---\n\n| h1 | h2 |\n|---|:-:|\n| 1 | 2 |\n");
  assert.match(html, /^<h1>Title<\/h1>/);
  assert.match(html, /<p>Para one<br>line two<\/p>/);
  assert.match(html, /<ul><li>a<\/li><li>b<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>x<\/li><li>y<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<table><thead><tr><th>h1<\/th><th style="text-align:center">h2<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td style="text-align:center">2<\/td><\/tr><\/tbody><\/table>/);
});

test("fenced code, closed and still open", () => {
  assert.equal(renderMarkdown("```js\nlet a = 1 < 2;\n```\nafter"), '<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>\n<p>after</p>');
  assert.equal(renderMarkdown("text\n```\npartial"), "<p>text</p>\n<pre><code>partial\n</code></pre>");
  assert.equal(renderMarkdown("~~~~\n```\ninner\n~~~~"), "<pre><code>```\ninner\n</code></pre>");
});

test("task lists and ordered start", () => {
  assert.equal(renderMarkdown("- [x] done\n- [ ] todo"), '<ul><li><input type="checkbox" disabled checked> done</li><li><input type="checkbox" disabled> todo</li></ul>');
  assert.equal(renderMarkdown("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
});

test("review fixes — intraword underscores, URLs with parentheses, closing hashes, inline triple backticks, table edge cases, linear time", () => {
  assert.equal(renderMarkdown("my_file_name.py and _em_"), "<p>my_file_name.py and <em>em</em></p>");
  assert.match(renderMarkdown("[Foo](https://e.org/Foo_(bar))"), /href="https:\/\/e\.org\/Foo_\(bar\)"/);
  assert.match(renderMarkdown("see https://e.org/Foo_(bar)."), /href="https:\/\/e\.org\/Foo_\(bar\)"[^]*<\/a>\.<\/p>/);
  assert.equal(renderMarkdown("## Using C#"), "<h2>Using C#</h2>");
  assert.equal(renderMarkdown("## Title ##"), "<h2>Title</h2>");
  assert.equal(renderMarkdown("```foo``` text\nmore"), "<p><code>foo</code> text<br>more</p>");
  assert.doesNotMatch(renderMarkdown("a | b\n---\nafter"), /<table>/, "a delimiter row without a pipe is not a table");
  assert.match(renderMarkdown("| a | b |\n|---|---|\n| x \\| y | z |"), /<td>x \| y<\/td><td>z<\/td>/);
  assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /href/);
  const t0 = Date.now();
  renderMarkdown(" *a".repeat(20000));
  renderMarkdown("[a ".repeat(20000));
  assert.ok(Date.now() - t0 < 500, `pathological input renders fast (${Date.now() - t0} ms)`);
});
