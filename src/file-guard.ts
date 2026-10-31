// Read before write: what the model has seen of each file, so that it does
// not overwrite, edit or delete a file from a stale or partial view — the
// user may edit files while it works. One guard per agent, shared by the
// file tools and run_js's `fs`; when the conversation is compacted or
// rewound it forgets the files whose contents the model no longer has.

import { decodeText, type Workspace } from "./workspace.js";

/** Content larger than this is versioned by time and size alone (not read to fingerprint it). */
const FINGERPRINT_MAX = 4 * 1024 * 1024;

/** FNV-1a over the text (or, for binary, the bytes): the same for a file stored as bytes or as its decoded text. */
function fingerprint(data: string | Uint8Array): string {
  const text = typeof data === "string" ? data : decodeText(data);
  let h = 0x811c9dc5;
  if (text !== null) for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  else for (const b of data as Uint8Array) { h ^= b; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

interface Seen {
  version: string;
  /** Lines 1..coveredTo were read (Infinity: all of it). */
  coveredTo: number;
  total: number;
  /** Every range of lines read at this version, merged (for "was anything new read?"). */
  ranges: Array<[number, number]>;
}

/** Adds [start, end] to merged ranges; whether it covered any line they did not. */
function addRange(ranges: Array<[number, number]>, start: number, end: number): boolean {
  if (end < start) return false;
  const covered = ranges.some(([a, b]) => a <= start && b >= end);
  ranges.push([start, end]);
  ranges.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  ranges.splice(0, ranges.length, ...merged);
  return !covered;
}

/** An overwrite refused because the model read only lines 1..coveredTo of the file (write_file shows it the rest). */
export class PartialReadError extends Error {
  constructor(message: string, readonly path: string, readonly coveredTo: number) { super(message); this.name = "PartialReadError"; }
}

export interface FileGuard {
  /** Whether it checks anything (`readBeforeWrite`). */
  readonly enabled: boolean;
  /**
   * The model read `path`: lines `start`..`end` of `total` (all of it when
   * left out). `text`, when it is the file's content as read, saves reading
   * it again to fingerprint it. Resolves whether any of those lines had
   * not been read before at this version (undefined when the guard is off).
   */
  saw(path: string, opts?: { start?: number; end?: number; total?: number; text?: string }): Promise<boolean | undefined>;
  /** The model wrote the whole file itself: it knows all of it. */
  wrote(path: string): Promise<void>;
  /** `to` is now a copy of `from` (copied or moved): what was read of `from` counts as read of `to`. */
  copied(from: string, to: string): Promise<void>;
  /** The model changed part of the file (an edit): what it had read stays read, at the new version. */
  edited(path: string): Promise<void>;
  /**
   * Throws, with a message for the model, when `verb` must not happen:
   * overwrite/edit of a file it has not read (or, for overwrite, read only
   * in part), or any of them on a file changed since it read it. A file
   * that does not exist passes; so does deleting one it never read.
   */
  check(path: string, verb: "overwrite" | "edit" | "delete"): Promise<void>;
  /** How much of the file as it is now the model has read: all of it, part of it, or none (never, or before it changed). */
  known(path: string): Promise<"all" | "part" | "none">;
  forget(path: string): void;
  /** Forget every file but these (after compaction or a rewind: the ones whose contents the model still has). */
  retain(paths: Iterable<string>): void;
  /** Forget everything. */
  clear(): void;
}

export function fileGuard(ws: Workspace, opts: { enabled?: boolean } = {}): FileGuard {
  const enabled = opts.enabled !== false;
  const seen = new Map<string, Seen>();
  const versionOf = async (p: string, text?: string): Promise<string | null> => {
    const st = await ws.stat(p);
    if (!st) return null;
    // Time and size, plus the content's fingerprint (a same-size change within one tick of a coarse clock still shows).
    const fp = st.size > FINGERPRINT_MAX ? "" : fingerprint(text ?? (await ws.read(p)).data);
    return `${st.mtime ?? ""}:${st.size}:${fp}`;
  };
  return {
    enabled,
    async saw(p, o = {}) {
      if (!enabled) return undefined;
      const version = await versionOf(p, o.text).catch(() => null);
      if (!version) { seen.delete(p); return true; }
      const start = o.start ?? 1;
      const end = o.end ?? Infinity;
      const total = o.total ?? Infinity;
      const was = seen.get(p);
      const same = !!was && was.version === version;
      // Reading on from where it stopped extends what it has read; a new version starts over.
      const coveredTo = same && start <= was!.coveredTo + 1 ? Math.max(was!.coveredTo, end) : start <= 1 ? end : 0;
      const ranges = same ? was!.ranges : [];
      const fresh = addRange(ranges, start, end) || !same;
      seen.set(p, { version, coveredTo, total, ranges });
      return fresh;
    },
    async wrote(p) {
      if (!enabled) return;
      const version = await versionOf(p).catch(() => null);
      if (version) seen.set(p, { version, coveredTo: Infinity, total: Infinity, ranges: [[1, Infinity]] }); else seen.delete(p);
    },
    async copied(from, to) {
      if (!enabled) return;
      const was = seen.get(from);
      const version = was ? await versionOf(to).catch(() => null) : null;
      if (was && version) seen.set(to, { ...was, version, ranges: was.ranges.map(([a, b]) => [a, b]) }); else seen.delete(to);
    },
    async edited(p) {
      if (!enabled) return;
      const was = seen.get(p);
      const version = await versionOf(p).catch(() => null);
      // The lines moved: what was read stays read, but any later read shows the new text.
      if (version && was) seen.set(p, { ...was, version, total: Infinity, ranges: [] }); else seen.delete(p);
    },
    async check(p, verb) {
      if (!enabled) return;
      const now = await versionOf(p);
      if (now === null) return;   // nothing there
      const was = seen.get(p);
      if (!was) {
        if (verb === "delete") return;
        throw new Error(`${p} already exists and you have not read it in this conversation: read it with read_file first, then ${verb} it.`);
      }
      if (was.version !== now) throw new Error(`${p} has changed since you last read it (the user or another process edited it): read it again with read_file, then ${verb === "delete" ? "decide whether to delete it" : "make your change on the current content"}.`);
      if (verb === "overwrite" && was.coveredTo < was.total) {
        throw new PartialReadError(`You have read only lines 1-${was.coveredTo} of ${p}: read the rest (read_file with offset=${was.coveredTo + 1}) before overwriting it, or change it with edit_file instead.`, p, was.coveredTo);
      }
    },
    async known(p) {
      const was = seen.get(p);
      if (!was) return "none";
      const now = await versionOf(p).catch(() => null);
      if (now !== was.version) return "none";
      return was.coveredTo >= was.total ? "all" : was.coveredTo > 0 ? "part" : "none";
    },
    forget(p) { seen.delete(p); },
    retain(paths) {
      const keep = new Set(paths);
      for (const p of [...seen.keys()]) if (!keep.has(p)) seen.delete(p);
    },
    clear() { seen.clear(); },
  };
}
