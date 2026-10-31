// Skills straight from their zips: a zip is read in place — its central
// directory parsed once, an entry inflated the first time it is read and
// kept in memory — and each skill folder in it is served as a read-only
// file tree. The workspace puts these trees, with the user's skill
// folders, under the generated `<skillsDir>/<name>/`.

import type { AgentFS, FileStat } from "./types.js";
import { listZip, readZipEntry, type Inflate, type ZipEntry } from "./zip.js";

interface Parsed {
  /** Every file, by path inside the zip. */
  entries: Map<string, ZipEntry>;
  /** Skill folders: name → prefix inside the zip ("" for a zip with SKILL.md at its root). */
  folders: Map<string, string>;
  bytes: Uint8Array;
  /** Decoded entries, by path inside the zip. */
  cache: Map<string, string | Uint8Array>;
}

const parsedCache = new Map<string, Parsed>();
const MAX_PARSED = 64;

/** A cleaned path inside a zip, or null for what is skipped (folders, macOS litter, `..`). */
function cleanEntry(name: string): string | null {
  if (name.endsWith("/") || name.includes("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) return null;
  const rel = name.replace(/^\.?\/+/, "").replace(/\/{2,}/g, "/");
  if (!rel || rel.split("/").some((s) => s === "..")) return null;
  return rel;
}

/**
 * Where the skills are in a zip: SKILL.md at the root is one skill named
 * `base`; otherwise every folder with a SKILL.md (a leading `skills/` is
 * looked through) is a skill of that folder's name.
 */
export function skillFoldersOf(paths: Iterable<string>, base: string): Map<string, string> {
  const all = [...paths];
  const out = new Map<string, string>();
  if (all.includes("SKILL.md")) { out.set(base, ""); return out; }
  for (const p of all) {
    const m = /^(?:skills\/)?([^/]+)\/SKILL\.md$/.exec(p);
    if (!m) continue;
    const name = m[1]!;
    const prefix = p.slice(0, -"SKILL.md".length);
    if (!out.has(name) || prefix.length < out.get(name)!.length) out.set(name, prefix);
  }
  return out;
}

/** The files of a zip (cleaned paths → entries), without caching. */
export function zipFiles(bytes: Uint8Array): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  for (const e of listZip(bytes)) {
    const rel = cleanEntry(e.name);
    if (rel) entries.set(rel, e);
  }
  return entries;
}

/** A zip already parsed under `key` (this zip, this version), without its bytes. */
export function cachedSkillZip(key: string): Parsed | undefined {
  return parsedCache.get(key);
}

/** The zip, parsed; `key` names this zip and version (the same key reuses the parse and its decoded entries). */
export function parseSkillZip(name: string, bytes: Uint8Array, key: string): Parsed {
  const hit = parsedCache.get(key);
  if (hit && hit.bytes.byteLength === bytes.byteLength) return hit;
  const entries = zipFiles(bytes);
  const parsed: Parsed = { entries, folders: skillFoldersOf(entries.keys(), name), bytes, cache: new Map() };
  if (parsedCache.size >= MAX_PARSED) parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(key, parsed);
  return parsed;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const asText = (bytes: Uint8Array): string | null => { try { return decoder.decode(bytes); } catch { return null; } };

/** One skill folder of a zip as a read-only file tree (paths relative to the folder). */
export function skillZipFS(parsed: Parsed, prefix: string, mtime: number, inflate?: Inflate): AgentFS {
  const files = new Map<string, string>(); // "/rel" → path inside the zip
  for (const p of parsed.entries.keys()) if (p.startsWith(prefix)) files.set("/" + p.slice(prefix.length), p);
  const stat = (rel: string): FileStat | null => {
    const p = files.get(rel);
    return p ? { path: rel, size: parsed.entries.get(p)!.size, mtime } : null;
  };
  return {
    async list(at) {
      const base = at === "/" ? "/" : at.replace(/\/+$/, "") + "/";
      const out: FileStat[] = [];
      for (const rel of files.keys()) if (base === "/" || rel.startsWith(base) || rel === at) out.push(stat(rel)!);
      return out;
    },
    async stat(rel) { return stat(rel); },
    async read(rel) {
      const p = files.get(rel);
      if (!p) throw new Error(`No such file: ${rel}`);
      const hit = parsed.cache.get(p);
      if (hit !== undefined) return hit;
      const bytes = await readZipEntry(parsed.bytes, parsed.entries.get(p)!, inflate);
      const value = asText(bytes) ?? bytes;
      parsed.cache.set(p, value);
      return value;
    },
  };
}

/** The part of `fs` under `base`, as its own read-only tree. */
export function subFS(fs: AgentFS, base: string): AgentFS {
  return {
    async list(at) {
      const out: FileStat[] = [];
      for (const f of await fs.list(at === "/" ? base : base + at)) {
        const p = f.path.startsWith(base + "/") ? f.path.slice(base.length) : null;
        if (p) out.push({ ...f, path: p });
      }
      return out;
    },
    async stat(at) { const s = fs.stat ? await fs.stat(base + at) : null; return s ? { ...s, path: at } : null; },
    read: (at) => fs.read(base + at),
  };
}
