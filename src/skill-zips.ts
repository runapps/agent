// Skills straight from their zips: a zip is kept whole (once per app, in
// the app's database) and read in place — its central directory parsed
// once, an entry inflated the first time it is read and kept in memory.
// Each skill folder in it appears read-only at `<skillsDir>/<name>/`, so
// the agent and the files panel see ordinary paths and nothing is
// unpacked into a directory.

import type { AgentFS, FileStat } from "./types.js";
import { listZip, readZipEntry, type Inflate, type ZipEntry } from "./zip.js";

/** A skills zip kept in the app's library. */
export interface SkillZipRecord {
  /** The library name: the zip's file name without `.zip`, lowercased (a skill zip with SKILL.md at its root is the skill of this name). */
  name: string;
  bytes: Uint8Array;
  /** When it was stored. */
  at: number;
  /** Where it came from: a URL / bundle path / `files:` path (the `skills` option), or `upload`. */
  source: string;
  etag?: string;
  lastModified?: string;
  /** Last time the source was asked whether it changed. */
  checkedAt?: number;
}

/** A skill zip as the UI lists it. */
export interface SkillZipInfo {
  name: string;
  size: number;
  at: number;
  source: string;
  /** The skill folders it holds (names under skillsDir). */
  folders: string[];
}

interface Parsed {
  /** Every file, by path inside the zip. */
  entries: Map<string, ZipEntry>;
  /** Skill folders: name under skillsDir → prefix inside the zip ("" for a zip with SKILL.md at its root). */
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

/** The zip, parsed (once per name and version, shared by every workspace of the page). */
export function parseSkillZip(rec: Pick<SkillZipRecord, "name" | "bytes" | "at">, scope = ""): Parsed {
  // Records come back from IndexedDB as new objects: the key says which zip and which version.
  const cacheKey = `${scope}|${rec.name}@${rec.at}:${rec.bytes.byteLength}`;
  const hit = parsedCache.get(cacheKey);
  if (hit) return hit;
  const entries = new Map<string, ZipEntry>();
  for (const e of listZip(rec.bytes)) {
    const rel = cleanEntry(e.name);
    if (rel) entries.set(rel, e);
  }
  const parsed: Parsed = { entries, folders: skillFoldersOf(entries.keys(), rec.name), bytes: rec.bytes, cache: new Map() };
  if (parsedCache.size >= MAX_PARSED) parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(cacheKey, parsed);
  return parsed;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const asText = (bytes: Uint8Array): string | null => { try { return decoder.decode(bytes); } catch { return null; } };

/** A skill zip as the UI shows it. */
export function zipInfo(rec: SkillZipRecord, parsed: Parsed): SkillZipInfo {
  return { name: rec.name, size: rec.bytes.byteLength, at: rec.at, source: rec.source, folders: [...parsed.folders.keys()].sort() };
}

/** One skill folder of a zip as a read-only file tree (paths relative to the folder). */
export interface SkillZipFS extends AgentFS {
  /** The library zip it comes from. */
  readonly zip: string;
}

export function skillZipFS(parsed: Parsed, zip: string, prefix: string, mtime: number, inflate?: Inflate): SkillZipFS {
  const files = new Map<string, string>(); // "/rel" → path inside the zip
  for (const p of parsed.entries.keys()) if (p.startsWith(prefix)) files.set("/" + p.slice(prefix.length), p);
  const stat = (rel: string): FileStat | null => {
    const p = files.get(rel);
    return p ? { path: rel, size: parsed.entries.get(p)!.size, mtime } : null;
  };
  return {
    zip,
    description: `skill from ${zip}.zip (read-only)`,
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
