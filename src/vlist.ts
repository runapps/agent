// A virtual list for the transcript: rows are built on first view and
// only the rows around the viewport are in the DOM (react-virtuoso's job
// in the harness app, done here with spacers and measured heights).
// Rows keep their element once built, so a card's open state and a live
// row's updates survive leaving and re-entering the window.

export interface VRow {
  /** Builds the row's element once; later calls return the same one. */
  render(): HTMLElement;
  /** Set by the list: the element once built. */
  el?: HTMLElement | null;
  /** Measured (or estimated) height, kept across detach. */
  height?: number;
}

export interface VListOptions {
  /** Height assumed for a row not yet measured. */
  estimate?: number;
  /** Pixels rendered beyond the viewport on each side. */
  overscan?: number;
  /** Class of the wrapper around each row. */
  rowClass?: string;
  /** Within this distance of the bottom the list follows new output. */
  followWithin?: number;
}

export class VirtualList {
  readonly rows: VRow[] = [];
  /** Whether the list sticks to the bottom as rows grow (true until the user scrolls up). */
  follow = true;
  private readonly top: HTMLElement;
  private readonly win: HTMLElement;
  private readonly bottom: HTMLElement;
  private readonly wrappers = new Map<VRow, HTMLElement>();
  private readonly ro: ResizeObserver | null;
  private readonly estimate: number;
  private readonly overscan: number;
  private readonly rowClass: string;
  private readonly followWithin: number;
  private offsets: number[] = [];
  private first = 0;
  private last = -1;
  private frame: number | null = null;
  private disposed = false;

  constructor(readonly scroller: HTMLElement, readonly inner: HTMLElement, opts: VListOptions = {}) {
    this.estimate = opts.estimate ?? 96;
    this.overscan = opts.overscan ?? 400;
    this.rowClass = opts.rowClass ?? "";
    this.followWithin = opts.followWithin ?? 80;
    this.top = document.createElement("div");
    this.win = document.createElement("div");
    this.bottom = document.createElement("div");
    inner.append(this.top, this.win, this.bottom);
    scroller.style.overflowAnchor = "none";
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.schedule());
    if (this.ro) this.ro.observe(scroller);
  }

  private onScroll = () => {
    const s = this.scroller;
    this.follow = s.scrollHeight - s.scrollTop - s.clientHeight < this.followWithin;
    this.schedule();
  };

  get length(): number { return this.rows.length; }

  push(row: VRow): void {
    row.height ??= this.estimate;
    this.rows.push(row);
    this.schedule();
  }

  /** Removes a row (its element is dropped from the DOM if shown). */
  remove(row: VRow): void {
    const i = this.rows.indexOf(row);
    if (i < 0) return;
    this.rows.splice(i, 1);
    this.detach(row);
    this.schedule();
  }

  clear(): void {
    for (const r of this.rows) this.detach(r);
    this.rows.length = 0;
    this.offsets = [];
    this.first = 0;
    this.last = -1;
    this.follow = true;
    this.win.replaceChildren();
    this.top.style.height = this.bottom.style.height = "0px";
  }

  /** Jumps to the end and follows new output. */
  scrollToBottom(): void {
    this.follow = true;
    this.layout();
  }

  /** Something changed size or was added: lay out on the next frame. */
  schedule(): void {
    if (this.disposed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.layout(); });
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.ro?.disconnect();
  }

  private detach(row: VRow): void {
    const w = this.wrappers.get(row);
    if (!w) return;
    this.ro?.unobserve(w);
    w.remove();
    this.wrappers.delete(row);
  }

  private wrapper(row: VRow): HTMLElement {
    let w = this.wrappers.get(row);
    if (w) return w;
    w = document.createElement("div");
    if (this.rowClass) w.className = this.rowClass;
    if (!row.el) row.el = row.render();
    w.append(row.el);
    this.wrappers.set(row, w);
    this.ro?.observe(w);
    return w;
  }

  private computeOffsets(): number {
    const n = this.rows.length;
    this.offsets.length = n + 1;
    let y = 0;
    for (let i = 0; i < n; i++) { this.offsets[i] = y; y += this.rows[i]!.height ?? this.estimate; }
    this.offsets[n] = y;
    return y;
  }

  /** First index whose bottom edge is past `y`. */
  private indexAt(y: number): number {
    let lo = 0, hi = this.rows.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.offsets[mid + 1]! <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }

  layout(): void {
    if (this.disposed) return;
    const s = this.scroller;
    const n = this.rows.length;
    if (!n) { this.win.replaceChildren(); this.top.style.height = this.bottom.style.height = "0px"; return; }
    const view = s.clientHeight || 600;
    for (let pass = 0; pass < 4; pass++) {
      const total = this.computeOffsets();
      // Keep the row at the top of the viewport where it is unless following the end.
      const scrollTop = this.follow ? Math.max(0, total - view) : s.scrollTop;
      const anchor = this.indexAt(scrollTop);
      const anchorDelta = this.offsets[anchor]! - scrollTop;
      const first = this.indexAt(Math.max(0, scrollTop - this.overscan));
      const last = Math.min(n - 1, this.indexAt(Math.min(total - 1, scrollTop + view + this.overscan)));
      // Reconcile the window.
      if (first !== this.first || last !== this.last || this.win.childElementCount !== last - first + 1) {
        for (const [row, w] of this.wrappers) { const i = this.rows.indexOf(row); if (i < first || i > last) { this.ro?.unobserve(w); w.remove(); this.wrappers.delete(row); } }
        const kids: HTMLElement[] = [];
        for (let i = first; i <= last; i++) kids.push(this.wrapper(this.rows[i]!));
        this.win.replaceChildren(...kids);
        this.first = first; this.last = last;
      }
      this.top.style.height = `${this.offsets[first]}px`;
      this.bottom.style.height = `${total - this.offsets[last + 1]!}px`;
      // Measure what is shown; a change means another pass with the new sizes.
      let changed = false;
      for (let i = first; i <= last; i++) {
        const row = this.rows[i]!;
        const hgt = this.wrappers.get(row)!.offsetHeight;
        if (hgt && hgt !== row.height) { row.height = hgt; changed = true; }
      }
      if (changed) {
        const total2 = this.computeOffsets();
        s.scrollTop = this.follow ? Math.max(0, total2 - view) : Math.max(0, this.offsets[anchor]! - anchorDelta);
        continue;
      }
      if (this.follow && Math.abs(s.scrollTop - Math.max(0, total - view)) > 1) {
        s.scrollTop = Math.max(0, total - view);
      }
      return;
    }
  }
}
