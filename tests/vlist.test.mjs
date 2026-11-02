// The transcript's virtual window. A small DOM stand-in records every removal, so the tests can say which
// rows were taken out and what the spacers read at that moment.
import { test } from "node:test";
import assert from "node:assert/strict";

const log = [];
class El {
  constructor() { this.children = []; this.parentNode = null; this.style = {}; }
  // A wrapper measures as its row: the stand-in has no layout.
  get offsetHeight() { return this.children[0]?.rowHeight ?? 0; }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() { const c = this.parentNode.children; return c[c.indexOf(this) + 1] ?? null; }
  addEventListener() {} removeEventListener() {}
  _take(kid) { if (kid.parentNode) { const c = kid.parentNode.children; c.splice(c.indexOf(kid), 1); log.push({ kid, top: tops.top?.style.height }); kid.parentNode = null; } }
  append(...kids) { for (const k of kids) { this._take(k); k.parentNode = this; this.children.push(k); } }
  insertBefore(k, ref) { this._take(k); k.parentNode = this; this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, k); }
  replaceChildren(...kids) { for (const k of [...this.children]) this._take(k); for (const k of kids) this.append(k); }
  remove() { this.parentNode?._take(this); }
}
const tops = {};
globalThis.document = { createElement: () => new El() };
globalThis.requestAnimationFrame = () => 0;
const { VirtualList } = await import("../dist/vlist.js");

function setup(heights, view = 500) {
  log.length = 0;
  const scroller = new El(), inner = new El();
  scroller.clientHeight = view; scroller.scrollTop = 0; scroller.scrollHeight = 0;
  const list = new VirtualList(scroller, inner, { estimate: 100, overscan: 100 });
  tops.top = inner.children[0];
  const rows = heights.map((h) => ({ height: h, render() { const e = new El(); e.rowHeight = h; return e; } }));
  for (const r of rows) list.push(r);
  list.follow = false;
  list.layout();
  return { list, rows, scroller, win: inner.children[1] };
}

const shown = (win) => win.children.map((w) => w.children[0]);

test("rows that stay in the window are never taken out of it", () => {
  const { list, rows, scroller, win } = setup(Array(20).fill(300));
  const before = shown(win);
  assert.deepEqual(before, rows.slice(0, 3).map((r) => r.el));
  log.length = 0;
  scroller.scrollTop = 600;
  list.layout();
  assert.deepEqual(shown(win), rows.slice(1, 5).map((r) => r.el));
  assert.deepEqual(log.map((e) => e.kid.children[0]), [rows[0].el], "only the row that left");
});

test("scrolling back up keeps the order and leaves the rows in view alone", () => {
  const { list, rows, scroller, win } = setup(Array(20).fill(300));
  scroller.scrollTop = 3000;
  list.layout();
  log.length = 0;
  scroller.scrollTop = 2400;
  list.layout();
  const want = rows.slice(7, 11).map((r) => r.el);
  assert.deepEqual(shown(win), want);
  assert.ok(log.every((e) => !want.includes(e.kid.children[0])), "a kept row was moved");
});

test("the top spacer already covers a row when it leaves, so a forced layout cannot shorten the scroller", () => {
  const { list, scroller } = setup(Array(20).fill(300));
  log.length = 0;
  scroller.scrollTop = 1500;
  list.layout();
  assert.ok(log.length > 0);
  for (const e of log) assert.equal(e.top, "1200px");
});

test("a removed row leaves the others in place and in order", () => {
  const { list, rows, win } = setup(Array(5).fill(100));
  log.length = 0;
  list.remove(rows[1]);
  list.layout();
  assert.deepEqual(shown(win), [rows[0], rows[2], rows[3], rows[4]].map((r) => r.el));
  assert.deepEqual(log.map((e) => e.kid.children[0]), [rows[1].el]);
});
