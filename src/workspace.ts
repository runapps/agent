// Workspace: the agent's virtual file system — a POSIX-style tree kept in
// IndexedDB (one database per project + session id), with a read-only
// `/skills` layer unpacked from skills zips and mount points an app fills
// with its own files (its document, a cloud folder). The file tools in
// file-tools.ts and the sandbox's `fs` work on it; skills are found by
// scanning `/skills/*/SKILL.md`.

import type { RunApps } from "@runappsai/sdk";
import type { AgentFS, FileStat, SessionData, SessionSummary, Skill } from "./types.js";
import { listZip, readZipEntry, type Inflate, MAX_ZIP_BYTES } from "./zip.js";
import { parseSkill } from "./skills.js";

export const SKILLS_ROOT = "/skills";
const DB_PREFIX = "__runapps_agent_ws";

type Layer = "skills" | "work";

interface FileRecord {
  path: string;
  data: string | Uint8Array;
  contentType?: string;
  mtime: number;
  layer: Layer;
  /** The skills source the file came from (skills layer). */
  source?: string;
}

interface Store {
  get(path: string): Promise<FileRecord | undefined>;
  put(rec: FileRecord): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<FileRecord[]>;
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta(key: string, value: unknown): Promise<void>;
  getSession(id: string): Promise<SessionData | undefined>;
  putSession(data: SessionData): Promise<void>;
  deleteSession(id: string): Promise<void>;
  listSessions(): Promise<SessionData[]>;
  close(): void;
}

/** Saved agent sessions of a workspace (`workspace.sessions`). */
export interface SessionStore {
  /** Newest first. */
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<SessionData | null>;
  save(data: SessionData): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WorkspaceOptions {
  /**
   * Session id: workspaces with different ids are separate databases;
   * the same id (default `"default"`) opens the same one, also across
   * tabs and reloads.
   */
  id?: string;
  /** Scopes the database to an app; `client.workspace()` fills it in. */
  project?: string;
  /**
   * Skills zip(s): a path or URL fetched as is (`/skills.zip` in the
   * bundle, a public link), or `files:<path>` for a file in the user's
   * RunApps storage (fetched with the SDK's token). Unpacked under
   * `/skills`, re-fetched only when the server's ETag changes.
   */
  skills?: string | string[];
  /** Inflate for runtimes without DecompressionStream (tests: zlib.inflateRawSync). */
  inflate?: Inflate;
  fetch?: typeof fetch;
  /** IndexedDB to use (tests); in-memory when the runtime has none. */
  indexedDB?: IDBFactory | null;
}

export interface WorkspaceRead {
  data: string | Uint8Array;
  contentType?: string;
  size: number;
}

export class Workspace {
  readonly id: string;
  readonly dbName: string;
  private store!: Store;
  private readonly mounts = new Map<string, AgentFS>();
  private readonly sources: string[];
  private readonly client: RunApps | null;
  private readonly inflate?: Inflate;
  private readonly fetchFn: typeof fetch;
  private readonly idb: IDBFactory | null;
  private skillCache: Skill[] | null = null;
  private opened: Promise<void> | null = null;

  /** The agent sessions saved in this workspace. */
  readonly sessions: SessionStore = {
    list: async () => {
      await this.ready();
      return (await this.store.listSessions())
        .map((d) => ({ id: d.id ?? "", title: d.title ?? titleOf(d), model: d.model, messages: d.messages.length, createdAt: d.createdAt ?? d.savedAt, savedAt: d.savedAt }))
        .sort((a, b) => b.savedAt - a.savedAt);
    },
    get: async (id) => {
      await this.ready();
      return (await this.store.getSession(id)) ?? null;
    },
    save: async (data) => {
      await this.ready();
      if (!data.id) throw new Error("runapps agent: a session needs an id to be saved");
      await this.store.putSession(data);
    },
    delete: async (id) => {
      await this.ready();
      await this.store.deleteSession(id);
    },
  };

  constructor(client: RunApps | null, opts: WorkspaceOptions = {}) {
    this.client = client;
    this.id = opts.id || "default";
    this.dbName = `${DB_PREFIX}:${opts.project || "app"}:${this.id}`;
    this.sources = opts.skills ? ([] as string[]).concat(opts.skills) : [];
    this.inflate = opts.inflate;
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.idb = opts.indexedDB !== undefined ? opts.indexedDB : (typeof indexedDB !== "undefined" ? indexedDB : null);
  }

  /** Opens the database and brings the skills layer up to date. */
  static async open(client: RunApps | null, opts: WorkspaceOptions = {}): Promise<Workspace> {
    const ws = new Workspace(client, opts);
    await ws.ready();
    return ws;
  }

  /** Resolves once the database is open and skills are unpacked (idempotent). */
  ready(): Promise<void> {
    if (!this.opened) {
      this.opened = (async () => {
        this.store = this.idb ? await openIDBStore(this.idb, this.dbName) : memoryStore(this.dbName);
        await withLock(`${this.dbName}:skills`, () => this.refreshSkills());
      })();
    }
    return this.opened;
  }

  /* ---------------- mounts ---------------- */

  /** Exposes `fs` under `prefix` (e.g. `/doc`); its paths are relative to the prefix. */
  mount(prefix: string, fs: AgentFS): void {
    const p = normalizePath(prefix);
    if (p === "/" || p === SKILLS_ROOT || p.startsWith(SKILLS_ROOT + "/")) {
      throw new Error(`runapps agent: cannot mount at ${p}`);
    }
    this.mounts.set(p, fs);
  }

  unmount(prefix: string): void {
    this.mounts.delete(normalizePath(prefix));
  }

  /** What the system prompt says about the tree. */
  describe(): string {
    const lines = [
      `${SKILLS_ROOT}/ — skills (read-only).`,
      "Other paths are a scratch area that persists between conversations.",
    ];
    for (const [p, fs] of this.mounts) lines.push(`${p}/ — ${fs.description || "app files"}${fs.write ? "" : " (read-only)"}.`);
    return lines.join("\n");
  }

  private route(path: string): { fs: AgentFS; rel: string; prefix: string } | null {
    for (const [prefix, fs] of this.mounts) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        return { fs, rel: path.slice(prefix.length) || "/", prefix };
      }
    }
    return null;
  }

  /* ---------------- files ---------------- */

  async list(prefix = "/"): Promise<FileStat[]> {
    await this.ready();
    const p = normalizePath(prefix);
    const out: FileStat[] = [];
    const r = this.route(p);
    if (r) {
      for (const f of await r.fs.list(r.rel)) out.push({ ...f, path: r.prefix + normalizePath(f.path) });
      return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    for (const rec of await this.store.list(p === "/" ? "/" : p + "/")) {
      if (this.route(rec.path)) continue; // shadowed by a mount
      out.push(statOf(rec));
    }
    for (const [mp, fs] of this.mounts) {
      if (p === "/" || mp.startsWith(p + "/")) {
        for (const f of await fs.list("/")) out.push({ ...f, path: mp + normalizePath(f.path) });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string): Promise<FileStat | null> {
    await this.ready();
    const p = normalizePath(path);
    const r = this.route(p);
    if (r) {
      if (r.fs.stat) {
        const s = await r.fs.stat(r.rel);
        return s ? { ...s, path: p } : null;
      }
      const f = (await r.fs.list(r.rel)).find((x) => normalizePath(x.path) === r.rel);
      return f ? { ...f, path: p } : null;
    }
    const rec = await this.store.get(p);
    return rec ? statOf(rec) : null;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async read(path: string): Promise<WorkspaceRead> {
    await this.ready();
    const p = normalizePath(path);
    const r = this.route(p);
    if (r) {
      try {
        const data = await r.fs.read(r.rel);
        return { data, size: sizeOf(data), contentType: guessType(p, data) };
      } catch (err) {
        throw new Error(await this.missing(p, err));
      }
    }
    const rec = await this.store.get(p);
    if (!rec) throw new Error(await this.missing(p));
    return { data: rec.data, size: sizeOf(rec.data), contentType: rec.contentType };
  }

  /** Whether `path` has files under it (a folder, in a tree that stores only files). */
  async isFolder(path: string): Promise<boolean> {
    const p = normalizePath(path);
    if (p === "/") return true;
    if (this.mounts.has(p)) return true;
    return (await this.list(p)).some((f) => f.path !== p);
  }

  private async missing(p: string, cause?: unknown): Promise<string> {
    if (await this.isFolder(p)) return `${p} is a folder, not a file; use list_files to see what it holds`;
    const msg = cause instanceof Error ? cause.message : "";
    return /no such file/i.test(msg) || !msg ? `No such file: ${p}` : `${p}: ${msg}`;
  }

  /** The file as text; throws for binary files. */
  async readText(path: string): Promise<string> {
    const { data } = await this.read(path);
    if (typeof data === "string") return data;
    const text = decodeText(data);
    if (text === null) throw new Error(`${normalizePath(path)} is a binary file (${data.byteLength} bytes)`);
    return text;
  }

  async write(path: string, content: string | Uint8Array, contentType?: string): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    if (p === "/" ) throw new Error("Cannot write to /");
    if (p === SKILLS_ROOT || p.startsWith(SKILLS_ROOT + "/")) throw new Error(`${SKILLS_ROOT} is read-only`);
    const r = this.route(p);
    if (r) {
      if (!r.fs.write) throw new Error(`${r.prefix} is read-only`);
      await r.fs.write(r.rel, content, contentType);
      return;
    }
    await this.store.put({ path: p, data: content, contentType: contentType ?? guessType(p, content), mtime: Date.now(), layer: "work" });
  }

  async delete(path: string): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    if (p === SKILLS_ROOT || p.startsWith(SKILLS_ROOT + "/")) throw new Error(`${SKILLS_ROOT} is read-only`);
    const r = this.route(p);
    if (r) {
      if (!r.fs.delete) throw new Error(`${r.prefix} is read-only`);
      await r.fs.delete(r.rel);
      return;
    }
    if (!(await this.store.get(p))) throw new Error(`No such file: ${p}`);
    await this.store.delete(p);
  }

  /** Removes everything the agent wrote (mounts and skills stay). */
  async clearWork(): Promise<void> {
    await this.ready();
    for (const rec of await this.store.list("/")) if (rec.layer === "work") await this.store.delete(rec.path);
  }

  /* ---------------- skills ---------------- */

  /** The skills in `/skills` (parsed once per refresh). */
  async skills(): Promise<Skill[]> {
    await this.ready();
    if (this.skillCache) return this.skillCache;
    const out: Skill[] = [];
    const seen = new Set<string>();
    for (const rec of await this.store.list(SKILLS_ROOT + "/")) {
      if (!/\/SKILL\.md$/.test(rec.path)) continue;
      const text = typeof rec.data === "string" ? rec.data : decodeText(rec.data);
      if (text === null) continue;
      const parsed = parseSkill(text, rec.path);
      if (!parsed || seen.has(parsed.skill.name)) continue;
      seen.add(parsed.skill.name);
      out.push(parsed.skill);
    }
    this.skillCache = out.sort((a, b) => a.name.localeCompare(b.name));
    return this.skillCache;
  }

  /** The body (instructions) of a skill, by name. */
  async skillBody(name: string): Promise<{ skill: Skill; body: string }> {
    const skill = (await this.skills()).find((s) => s.name === name);
    if (!skill) throw new Error(`No skill named "${name}"`);
    const parsed = parseSkill(await this.readText(skill.path), skill.path);
    return { skill, body: parsed?.body ?? "" };
  }

  /**
   * Fetches the skills zips again. Each is skipped when the server says
   * it is unchanged (ETag / Last-Modified); `force` unpacks regardless.
   */
  async refreshSkills(force = false): Promise<void> {
    if (this.opened && !this.store) await this.opened;
    for (const source of this.sources) {
      try {
        await this.unpackSource(source, force);
      } catch (err) {
        // A skills pack that cannot be fetched (offline, 404) leaves the
        // cached copy in place; surface it for developers.
        // eslint-disable-next-line no-console
        console.warn(`[runapps agent] skills "${source}":`, err);
      }
    }
    this.skillCache = null;
  }

  private async unpackSource(source: string, force: boolean): Promise<void> {
    const metaKey = `skills:${source}`;
    const prev = await this.store.getMeta<{ etag?: string; lastModified?: string; files: string[] }>(metaKey);
    const fetched = await this.fetchSource(source, force ? undefined : prev);
    if (!fetched) return; // unchanged
    const entries = listZip(fetched.bytes).filter((e) => !e.isDir && !e.name.includes("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(e.name));
    const base = zipBaseName(source);
    const atRoot = entries.some((e) => e.name === "SKILL.md");
    const written: string[] = [];
    const now = Date.now();
    for (const e of entries) {
      let rel = e.name.replace(/^\.?\/+/, "");
      if (rel.startsWith("skills/")) rel = rel.slice(7);
      if (!rel || rel.split("/").some((seg) => seg === "..")) continue;
      const path = `${SKILLS_ROOT}/${atRoot ? base + "/" : ""}${rel}`;
      const bytes = await readZipEntry(fetched.bytes, e, this.inflate);
      const text = decodeText(bytes);
      await this.store.put({
        path,
        data: text ?? bytes,
        contentType: guessType(path, text ?? bytes),
        mtime: now,
        layer: "skills",
        source,
      });
      written.push(path);
    }
    // Files of this source that the new zip no longer has.
    for (const old of prev?.files ?? []) if (!written.includes(old)) await this.store.delete(old);
    await this.store.putMeta(metaKey, { etag: fetched.etag, lastModified: fetched.lastModified, files: written, at: now });
  }

  private async fetchSource(
    source: string,
    prev?: { etag?: string; lastModified?: string },
  ): Promise<{ bytes: Uint8Array; etag?: string; lastModified?: string } | null> {
    if (source.startsWith("files:")) {
      if (!this.client) throw new Error("a files: skills source needs a client");
      const path = source.slice(6);
      const stat = await this.client.files.stat(path);
      if (prev?.etag && stat.etag && prev.etag === stat.etag) return null;
      const blob = await this.client.files.get(path);
      if (blob.size > MAX_ZIP_BYTES) throw new Error("skills zip too large");
      return { bytes: new Uint8Array(await blob.arrayBuffer()), etag: stat.etag };
    }
    const headers: Record<string, string> = {};
    if (prev?.etag) headers["If-None-Match"] = prev.etag;
    else if (prev?.lastModified) headers["If-Modified-Since"] = prev.lastModified;
    const res = await this.fetchFn(source, { headers, cache: "no-cache" });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_ZIP_BYTES) throw new Error("skills zip too large");
    return {
      bytes: new Uint8Array(buf),
      etag: res.headers.get("ETag") ?? undefined,
      lastModified: res.headers.get("Last-Modified") ?? undefined,
    };
  }

  /** Deletes the database (tests, "reset" buttons). */
  async destroy(): Promise<void> {
    await this.ready();
    this.store.close();
    if (this.idb) {
      await new Promise<void>((resolve) => {
        const req = this.idb!.deleteDatabase(this.dbName);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    } else {
      memoryStores.delete(this.dbName);
    }
    this.opened = null;
    this.skillCache = null;
  }
}

/* ------------------------------------------------------------------ */
/* Paths and content                                                   */
/* ------------------------------------------------------------------ */

/** Absolute, `/`-separated, no `.`/`..`/doubled slashes, no trailing slash. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of String(path ?? "").replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

function statOf(rec: FileRecord): FileStat {
  return { path: rec.path, size: sizeOf(rec.data), contentType: rec.contentType, mtime: rec.mtime };
}

function sizeOf(data: string | Uint8Array): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

const TEXT_EXT = new Set(["md", "txt", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "html", "htm", "xml", "svg", "yaml", "yml", "toml", "csv", "tsv", "py", "sh", "sql", "ini", "cfg", "conf", "log", "drawio", "env", "gitignore"]);
const TYPES: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", js: "text/javascript", mjs: "text/javascript",
  ts: "text/typescript", css: "text/css", html: "text/html", xml: "application/xml", svg: "image/svg+xml",
  yaml: "application/yaml", yml: "application/yaml", csv: "text/csv", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", zip: "application/zip",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", py: "text/x-python", sh: "text/x-shellscript",
};

export function guessType(path: string, data: string | Uint8Array): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (TYPES[ext]) return TYPES[ext]!;
  if (typeof data === "string" || TEXT_EXT.has(ext)) return "text/plain";
  return "application/octet-stream";
}

/** UTF-8 text of `bytes`, or null when it is not text. */
export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function zipBaseName(source: string): string {
  const last = source.split(/[?#]/)[0]!.split("/").pop() || "skill";
  return last.replace(/\.zip$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

function openIDBStore(idb: IDBFactory, name: string): Promise<Store> {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
    req.onsuccess = () => {
      const db = req.result;
      const run = <T,>(store: "files" | "meta" | "sessions", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise<T>((res, rej) => {
          const tx = db.transaction(store, mode);
          const r = fn(tx.objectStore(store));
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error ?? new Error("indexedDB request failed"));
        });
      resolve({
        get: (path) => run<FileRecord | undefined>("files", "readonly", (s) => s.get(path)),
        put: async (rec) => { await run("files", "readwrite", (s) => s.put(rec)); },
        delete: async (path) => { await run("files", "readwrite", (s) => s.delete(path)); },
        list: (prefix) =>
          run<FileRecord[]>("files", "readonly", (s) =>
            s.getAll(prefix === "/" ? undefined : IDBKeyRange.bound(prefix, prefix + "￿", false, false)),
          ),
        getMeta: async <T,>(key: string) => (await run<{ key: string; value: T } | undefined>("meta", "readonly", (s) => s.get(key)))?.value,
        putMeta: async (key, value) => { await run("meta", "readwrite", (s) => s.put({ key, value })); },
        getSession: (id) => run<SessionData | undefined>("sessions", "readonly", (s) => s.get(id)),
        putSession: async (data) => { await run("sessions", "readwrite", (s) => s.put(data)); },
        deleteSession: async (id) => { await run("sessions", "readwrite", (s) => s.delete(id)); },
        listSessions: () => run<SessionData[]>("sessions", "readonly", (s) => s.getAll()),
        close: () => db.close(),
      });
    };
  });
}

const memoryStores = new Map<string, { files: Map<string, FileRecord>; meta: Map<string, unknown>; sessions: Map<string, SessionData> }>();

function memoryStore(name: string): Store {
  let m = memoryStores.get(name);
  if (!m) {
    m = { files: new Map(), meta: new Map(), sessions: new Map() };
    memoryStores.set(name, m);
  }
  const mem = m;
  return {
    get: async (path) => mem.files.get(path),
    put: async (rec) => { mem.files.set(rec.path, rec); },
    delete: async (path) => { mem.files.delete(path); },
    list: async (prefix) => [...mem.files.values()].filter((r) => prefix === "/" || r.path.startsWith(prefix)),
    getMeta: async <T,>(key: string) => mem.meta.get(key) as T | undefined,
    putMeta: async (key, value) => { mem.meta.set(key, value); },
    getSession: async (id) => mem.sessions.get(id),
    putSession: async (data) => { mem.sessions.set(data.id!, data); },
    deleteSession: async (id) => { mem.sessions.delete(id); },
    listSessions: async () => [...mem.sessions.values()],
    close: () => {},
  };
}

/** A title for a session without one: its first user message, shortened. */
export function titleOf(d: SessionData): string {
  const first = d.messages.find((m) => m.role === "user");
  const text = !first ? "" : typeof first.content === "string" ? first.content : (first.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? line.slice(0, 77) + "…" : line || "Untitled";
}

/** Runs fn holding the origin-wide Web Lock `name`; without Web Locks it just runs fn. */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined"
    ? (navigator as { locks?: { request(name: string, cb: () => Promise<T>): Promise<T> } }).locks
    : undefined;
  return locks && typeof locks.request === "function" ? locks.request(name, fn) : fn();
}

/** An in-memory AgentFS, for tests and for documents an app builds on the fly. */
export function memoryFS(initial: Record<string, string | Uint8Array> = {}, opts: { description?: string; readonly?: boolean } = {}): AgentFS & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  for (const [k, v] of Object.entries(initial)) files.set(normalizePath(k), v);
  const fs: AgentFS & { files: Map<string, string | Uint8Array> } = {
    files,
    description: opts.description,
    async list(prefix) {
      const p = normalizePath(prefix);
      return [...files.entries()]
        .filter(([k]) => p === "/" || k === p || k.startsWith(p + "/"))
        .map(([path, data]) => ({ path, size: sizeOf(data) }));
    },
    async read(path) {
      const v = files.get(normalizePath(path));
      if (v === undefined) throw new Error(`No such file: ${normalizePath(path)}`);
      return v;
    },
  };
  if (!opts.readonly) {
    fs.write = async (path, content) => { files.set(normalizePath(path), content); };
    fs.delete = async (path) => {
      if (!files.delete(normalizePath(path))) throw new Error(`No such file: ${normalizePath(path)}`);
    };
  }
  return fs;
}
