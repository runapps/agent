// Read before write: what the model has seen of each file, so that it does
// not overwrite, edit or delete a file from a stale or partial view — the
// user may edit files while it works. One guard per agent, shared by the
// file tools and run_js's `fs`; it forgets everything when the conversation
// is compacted or rewound (the model no longer has those contents).

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
}

export interface FileGuard {
  /** Whether it checks anything (`readBeforeWrite`). */
  readonly enabled: boolean;
  /**
   * The model read `path`: lines `start`..`end` of `total` (all of it when
   * left out). `text`, when it is the file's content as read, saves reading
   * it again to fingerprint it.
   */
  saw(path: string, opts?: { start?: number; end?: number; total?: number; text?: string }): Promise<void>;
  /** The model wrote the whole file itself: it knows all of it. */
  wrote(path: string): Promise<void>;
  /** The model changed part of the file (an edit): what it had read stays read, at the new version. */
  edited(path: string): Promise<void>;
  /**
   * Throws, with a message for the model, when `verb` must not happen:
   * overwrite/edit of a file it has not read (or, for overwrite, read only
   * in part), or any of them on a file changed since it read it. A file
   * that does not exist passes; so does deleting one it never read.
   */
  check(path: string, verb: "overwrite" | "edit" | "delete"): Promise<void>;
  forget(path: string): void;
  /** Forget everything (after compaction or a rewind). */
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
      if (!enabled) return;
      const version = await versionOf(p, o.text).catch(() => null);
      if (!version) { seen.delete(p); return; }
      const start = o.start ?? 1;
      const end = o.end ?? Infinity;
      const total = o.total ?? Infinity;
      const was = seen.get(p);
      // Reading on from where it stopped extends what it has read; a new version starts over.
      const coveredTo = was && was.version === version && start <= was.coveredTo + 1 ? Math.max(was.coveredTo, end) : start <= 1 ? end : 0;
      seen.set(p, { version, coveredTo, total });
    },
    async wrote(p) {
      if (!enabled) return;
      const version = await versionOf(p).catch(() => null);
      if (version) seen.set(p, { version, coveredTo: Infinity, total: Infinity }); else seen.delete(p);
    },
    async edited(p) {
      if (!enabled) return;
      const was = seen.get(p);
      const version = await versionOf(p).catch(() => null);
      if (version && was) seen.set(p, { ...was, version, total: Infinity }); else seen.delete(p);
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
        throw new Error(`You have read only lines 1-${was.coveredTo} of ${p}: read the rest (read_file with offset=${was.coveredTo + 1}) before overwriting it, or change it with edit_file instead.`);
      }
    },
    forget(p) { seen.delete(p); },
    clear() { seen.clear(); },
  };
}
