// Workspace: the directory the agent works in — a POSIX-style tree kept
// in IndexedDB (one database per app; `id` names a directory in it, so a
// chat can give every session its own), or a directory the app
// provides (`dir`: a local folder through the File System Access API,
// any `AgentFS`), plus mount points an app fills with its own files (its
// document, a cloud folder). Skills are ordinary folders with a SKILL.md
// under `<skillsDir>` (default `/.agent/skills`, as pi keeps them in the
// project): hand-written, unpacked there from skills zips (`skills`
// option, ETag-cached), or installed with `installSkill`. The file tools
// in file-tools.ts and the sandbox's `fs` work on it.

import type { RunApps } from "@runappsai/sdk";
import type { AgentFS, FileStat, SessionData, SessionSummary, Skill } from "./types.js";
import { listZip, readZipEntry, type Inflate, MAX_ZIP_BYTES } from "./zip.js";
import { parseSkill } from "./skills.js";

/** Where a workspace keeps its skills unless `skillsDir` says otherwise. */
export const DEFAULT_SKILLS_DIR = "/.agent/skills";
/** @deprecated use DEFAULT_SKILLS_DIR / `workspace.skillsDir` */
export const SKILLS_ROOT = DEFAULT_SKILLS_DIR;
const DB_PREFIX = "__runapps_agent_ws";

type Layer = "skills" | "work";

interface FileRecord {
  /** The directory (workspace id) the file belongs to. */
  space?: string;
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
  deleteMeta(key: string): Promise<void>;
  getSession(space: string, id: string): Promise<SessionData | undefined>;
  /** Saved under `data.space`. */
  putSession(data: SessionData): Promise<void>;
  deleteSession(space: string, id: string): Promise<void>;
  /** Every session in the app's database, whichever directory saved it. */
  listSessions(): Promise<SessionData[]>;
  /** Drops a directory's files, meta and sessions (this one by default). */
  clear(space?: string): Promise<void>;
  close(): void;
}

interface SkillsMeta {
  etag?: string;
  lastModified?: string;
  files: string[];
  at?: number;
}

/** Saved agent sessions of a workspace (`workspace.sessions`). */
export interface SessionStore {
  /** Newest first. */
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<SessionData | null>;
  save(data: SessionData): Promise<void>;
  /**
   * Deletes a session — of this directory, else the one in the directory
   * named after it (the chat's layout); `space` picks one exactly (a
   * summary's `workspace`). A session saved from a directory of its own
   * id takes that directory with it.
   */
  delete(id: string, space?: string): Promise<void>;
  /** Deletes every session of the app (and the directories made for them). */
  clear(): Promise<void>;
}

export interface WorkspaceOptions {
  /**
   * Which directory: ids are separate trees in the app's database (give
   * each chat session its own id to isolate them); the same id (default
   * `"default"`) opens the same tree, also across tabs and reloads.
   */
  id?: string;
  /** The app the database belongs to; `openWorkspace` fills it in from the client. */
  project?: string;
  /**
   * Skills zip(s): a path or URL fetched as is (`/skills.zip` in the
   * bundle, a public link), or `files:<path>` for a file in the user's
   * RunApps storage (fetched with the SDK's token). Unpacked under
   * `skillsDir`, re-fetched only when the server's ETag changes.
   */
  skills?: string | string[];
  /** The folder skills live in, `<skillsDir>/<name>/SKILL.md` (default `/.agent/skills`). */
  skillsDir?: string;
  /**
   * The directory itself, instead of the IndexedDB tree: `directoryFS(handle)`
   * for a folder picked with `showDirectoryPicker()`, or any `AgentFS`.
   * Sessions and skills-zip bookkeeping still go to IndexedDB under `id`.
   */
  dir?: AgentFS;
  /** Inflate for runtimes without DecompressionStream (tests: zlib.inflateRawSync). */
  inflate?: Inflate;
  fetch?: typeof fetch;
  /** IndexedDB to use (tests); in-memory when the runtime has none. */
  indexedDB?: IDBFactory | null;
}

/** A file of the directory was written or deleted — by this page, or (`remote`) by another tab of the app. */
export interface WorkspaceChange { path: string; kind: "write" | "delete"; remote?: boolean }

export interface WorkspaceRead {
  data: string | Uint8Array;
  contentType?: string;
  size: number;
}

export class Workspace {
  /** The directory's id. */
  readonly id: string;
  /** The app's database (shared by every id of the app). */
  readonly dbName: string;
  /** Where skills live (`<skillsDir>/<name>/SKILL.md`). */
  readonly skillsDir: string;
  /** The folder the directory lives in when opened with `dir` (null: IndexedDB). */
  readonly root: AgentFS | null;
  private store!: Store;
  private readonly mounts = new Map<string, AgentFS>();
  private readonly changeListeners = new Set<(c: WorkspaceChange) => void>();
  private channel: BroadcastChannel | null | undefined;
  private readonly sources: string[];
  private readonly client: RunApps | null;
  private readonly inflate?: Inflate;
  private readonly fetchFn: typeof fetch;
  private readonly idb: IDBFactory | null;
  private skillCache: Skill[] | null = null;
  private opened: Promise<void> | null = null;

  /**
   * The agent sessions saved in the app's database — every directory's,
   * each summary naming its `workspace` (the directory id it was saved
   * from), so a chat that gives each session its own directory can list
   * them all from any one.
   */
  readonly sessions: SessionStore = {
    list: async () => {
      await this.ready();
      return (await this.store.listSessions())
        .map((d) => ({ id: d.id ?? "", title: d.title ?? titleOf(d), model: d.model, messages: d.messages.length, createdAt: d.createdAt ?? d.savedAt, savedAt: d.savedAt, workspace: d.space }))
        .sort((a, b) => b.savedAt - a.savedAt);
    },
    // This directory's session of that id, else the session in the directory named after it (the chat
    // gives each session one); never another directory's session that merely shares the id.
    get: async (id) => {
      await this.ready();
      return (await this.store.getSession(this.id, id)) ?? (id !== this.id ? await this.store.getSession(id, id) : undefined) ?? null;
    },
    save: async (data) => {
      await this.ready();
      if (!data.id) throw new Error("runapps agent: a session needs an id to be saved");
      await this.store.putSession({ ...data, space: this.id });
    },
    delete: async (id, space) => {
      await this.ready();
      const where = space
        ?? ((await this.store.getSession(this.id, id)) ? this.id
          : (await this.store.getSession(id, id)) ? id
          : (await this.store.listSessions()).find((d) => d.id === id)?.space ?? this.id);
      await this.store.deleteSession(where, id);
      // A session saved from a directory of its own id (the chat gives each session one) takes the directory with it.
      if (where === id && id !== this.id) await this.store.clear(id);
    },
    clear: async () => {
      await this.ready();
      for (const d of await this.store.listSessions()) if (d.id) await this.sessions.delete(d.id, d.space ?? this.id);
    },
  };

  constructor(client: RunApps | null, opts: WorkspaceOptions = {}) {
    this.client = client;
    this.id = opts.id || "default";
    this.dbName = `${DB_PREFIX}:${opts.project || "app"}`;
    this.sources = opts.skills ? ([] as string[]).concat(opts.skills) : [];
    this.skillsDir = normalizePath(opts.skillsDir || DEFAULT_SKILLS_DIR);
    if (this.skillsDir === "/") throw new Error("runapps agent: skillsDir cannot be /");
    this.root = opts.dir ?? null;
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
      const opening = (async () => {
        this.store = this.idb ? await openIDBStore(this.idb, this.dbName, this.id) : memoryStore(this.dbName, this.id);
        await withLock(`${this.dbName}:${this.id}:skills`, () => this.refreshSkills());
      })();
      this.opened = opening;
      // A failed open (blocked, quota, a skills fetch) is tried again next time instead of failing for good.
      opening.catch(() => { if (this.opened === opening) this.opened = null; });
    }
    return this.opened;
  }

  /**
   * Releases the database connection and the change channel. The
   * workspace stays usable: the next call opens them again. A host that
   * makes a workspace per session closes the ones it no longer shows.
   */
  close(): void {
    try { this.channel?.close(); } catch { /* closed */ }
    this.channel = undefined;
    if (this.opened) { const o = this.opened; this.opened = null; void o.then(() => this.store.close(), () => undefined); }
  }

  /* ---------------- mounts ---------------- */

  /** Exposes `fs` under `prefix` (e.g. `/doc`); its paths are relative to the prefix. */
  mount(prefix: string, fs: AgentFS): void {
    const p = normalizePath(prefix);
    if (p === "/") throw new Error("runapps agent: cannot mount at / (open the workspace with `dir` instead)");
    this.mounts.set(p, fs);
  }

  unmount(prefix: string): void {
    this.mounts.delete(normalizePath(prefix));
  }

  /**
   * Called for every write and delete in this directory, from any code in
   * this page and from other tabs of the app (`remote: true`, relayed over
   * a BroadcastChannel). Returns the unsubscribe function. A files view
   * refreshes on this instead of guessing when the agent wrote something.
   */
  onChange(fn: (change: WorkspaceChange) => void): () => void {
    this.changeListeners.add(fn);
    this.openChannel();
    return () => { this.changeListeners.delete(fn); };
  }

  private openChannel(): void {
    if (this.channel !== undefined) return;
    if (typeof BroadcastChannel === "undefined") { this.channel = null; return; }
    try {
      const ch = new BroadcastChannel(`${this.dbName}:changes`);
      ch.onmessage = (ev: MessageEvent<{ space?: string; path?: string; kind?: "write" | "delete" }>) => {
        const m = ev.data;
        if (m && m.space === this.id && typeof m.path === "string" && (m.kind === "write" || m.kind === "delete")) this.emitChange(m.path, m.kind, true);
      };
      (ch as unknown as { unref?: () => void }).unref?.();
      this.channel = ch;
    } catch { this.channel = null; }
  }

  private emitChange(path: string, kind: "write" | "delete", remote = false): void {
    if (remote && (path === "/" || this.inSkills(path))) this.skillCache = null;
    if (!remote) { this.openChannel(); try { this.channel?.postMessage({ space: this.id, path, kind }); } catch { /* channel closed */ } }
    if (!this.changeListeners.size) return;
    const c: WorkspaceChange = { path, kind, remote };
    for (const fn of this.changeListeners) { try { fn(c); } catch (err) { console.warn("runapps agent: onChange listener failed", err); } }
  }

  /** What the system prompt says about the tree. */
  describe(): string {
    const lines = [
      this.root
        ? `/ — ${this.root.description || "the working directory"}${this.root.write ? "" : " (read-only)"}.`
        : "/ — the working directory; it persists between conversations.",
      `${this.skillsDir}/ — skills, one folder per skill with a SKILL.md.`,
    ];
    for (const [p, fs] of this.mounts) lines.push(`${p}/ — ${fs.description || "app files"}${fs.write ? "" : " (read-only)"}.`);
    return lines.join("\n");
  }

  /** The mount (or the root directory) that serves `path`; null means the IndexedDB tree. */
  private route(path: string): { fs: AgentFS; rel: string; prefix: string } | null {
    for (const [prefix, fs] of this.mounts) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        return { fs, rel: path.slice(prefix.length) || "/", prefix };
      }
    }
    return this.root ? { fs: this.root, rel: path, prefix: "" } : null;
  }

  private inSkills(path: string): boolean {
    return path === this.skillsDir || path.startsWith(this.skillsDir + "/");
  }

  /* ---------------- raw access to the tree (root dir or IndexedDB) ---------------- */

  private async putFile(path: string, data: string | Uint8Array, contentType: string | undefined, layer: Layer, source?: string): Promise<void> {
    if (this.inSkills(path)) this.skillCache = null;
    if (this.root) {
      if (!this.root.write) throw new Error("/ is read-only");
      await this.root.write(path, data, contentType ?? guessType(path, data));
      this.emitChange(path, "write");
      return;
    }
    await this.store.put({ path, data, contentType: contentType ?? guessType(path, data), mtime: Date.now(), layer, source });
    this.emitChange(path, "write");
  }

  private async rmFile(path: string): Promise<void> {
    if (this.inSkills(path)) this.skillCache = null;
    if (this.root) {
      if (!this.root.delete) throw new Error("/ is read-only");
      await this.root.delete(path);
      this.emitChange(path, "delete");
      return;
    }
    await this.store.delete(path);
    this.emitChange(path, "delete");
  }

  /* ---------------- files ---------------- */

  async list(prefix = "/"): Promise<FileStat[]> {
    await this.ready();
    const p = normalizePath(prefix);
    const out: FileStat[] = [];
    const r = this.route(p);
    if (r && r.prefix) {
      for (const f of await r.fs.list(r.rel)) out.push({ ...f, path: r.prefix + normalizePath(f.path) });
      return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    const own: FileStat[] = this.root
      ? (await this.root.list(p)).map((f) => ({ ...f, path: normalizePath(f.path) }))
      : (await this.store.list(p === "/" ? "/" : p + "/")).map(statOf);
    for (const f of own) {
      if (this.route(f.path)?.prefix) continue; // shadowed by a mount
      out.push(f);
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
      const f = (await r.fs.list(r.rel)).find((x) => normalizePath(x.path) === normalizePath(r.rel));
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
    if (p === "/") throw new Error("Cannot write to /");
    const r = this.route(p);
    if (r && r.prefix) {
      if (!r.fs.write) throw new Error(`${r.prefix} is read-only`);
      await r.fs.write(r.rel, content, contentType);
      this.emitChange(p, "write");
      return;
    }
    await this.putFile(p, content, contentType, "work");
  }

  async delete(path: string): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    const r = this.route(p);
    if (r && r.prefix) {
      if (!r.fs.delete) throw new Error(`${r.prefix} is read-only`);
      await r.fs.delete(r.rel);
      this.emitChange(p, "delete");
      return;
    }
    if (!(await this.stat(p))) throw new Error(`No such file: ${p}`);
    await this.rmFile(p);
  }

  /** The mount a path falls under, or null for the directory itself. */
  mountOf(path: string): string | null {
    return this.route(normalizePath(path))?.prefix || null;
  }
  /** Whether writes to a path are refused (a read-only mount, or a `dir` root without write). */
  isReadOnly(path: string): boolean {
    const r = this.route(normalizePath(path));
    if (r) return !r.fs.write;
    return false;
  }
  /** Whether a path is under the skills folder. */
  isSkillPath(path: string): boolean {
    return this.inSkills(normalizePath(path));
  }

  /** A value of the host's kept with this directory (checkpoints, settings); `null` deletes it. */
  async getData<T>(key: string): Promise<T | undefined> {
    await this.ready();
    const v = await this.store.getMeta<T | null>("data:" + key);
    return v === null ? undefined : v;
  }
  async putData(key: string, value: unknown): Promise<void> {
    await this.ready();
    if (value === null || value === undefined) await this.store.deleteMeta("data:" + key);
    else await this.store.putMeta("data:" + key, value);
  }
  async deleteData(key: string): Promise<void> {
    await this.ready();
    await this.store.deleteMeta("data:" + key);
  }

  /** Removes every file outside the skills folder (mounts and skills stay). */
  async clearWork(): Promise<void> {
    await this.ready();
    for (const f of await this.list("/")) {
      if (this.inSkills(f.path) || this.route(f.path)?.prefix) continue;
      await this.rmFile(f.path);
    }
  }

  /* ---------------- skills ---------------- */

  /** The skills in `skillsDir` — every `<skillsDir>/<name>/SKILL.md` (parsed once, until a file there changes). */
  async skills(): Promise<Skill[]> {
    await this.ready();
    if (this.skillCache) return this.skillCache;
    const out: Skill[] = [];
    const seen = new Set<string>();
    const re = new RegExp("^" + this.skillsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[^/]+/SKILL\\.md$");
    for (const f of await this.list(this.skillsDir)) {
      if (!re.test(f.path)) continue;
      let text: string;
      try {
        text = await this.readText(f.path);
      } catch {
        continue;
      }
      const parsed = parseSkill(text, f.path);
      if (!parsed || seen.has(parsed.skill.name)) continue;
      seen.add(parsed.skill.name);
      out.push(parsed.skill);
    }
    this.skillCache = out.sort((a, b) => a.name.localeCompare(b.name));
    return this.skillCache;
  }

  /**
   * Adds a skill (or a pack of skills) from a zip: a URL / bundle path /
   * `files:<path>` string, or the bytes themselves (a `File` from an
   * `<input type=file>`, a Blob, a Uint8Array). A zip with SKILL.md at its
   * root is one skill, named `name` (else after the file); a zip of
   * folders is one skill per folder. Returns what was installed.
   */
  async installSkill(source: string | Blob | Uint8Array, opts: { name?: string } = {}): Promise<Skill[]> {
    await this.ready();
    let bytes: Uint8Array;
    let key: string;
    let base: string;
    if (typeof source === "string") {
      const fetched = await this.fetchSource(source);
      if (!fetched) throw new Error("runapps agent: nothing fetched");
      bytes = fetched.bytes;
      key = `skills:${source}`;
      base = opts.name ?? zipBaseName(source);
    } else {
      bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
      if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error("skills zip too large");
      const fileName = (source as File).name ?? "";
      base = opts.name ?? zipBaseName(fileName || "skill");
      key = `skills:upload:${base}`;
    }
    const before = new Set((await this.skills()).map((s) => s.name));
    const prev = await this.store.getMeta<SkillsMeta>(key);
    await withLock(`${this.dbName}:${this.id}:skills`, () => this.unpackZip(bytes, key, base, prev));
    this.skillCache = null;
    const after = await this.skills();
    const written = (await this.store.getMeta<SkillsMeta>(key))?.files ?? [];
    return after.filter((s) => written.includes(s.path) || !before.has(s.name));
  }

  /** Deletes the skill's folder. Returns false when there is no such skill. */
  async removeSkill(name: string): Promise<boolean> {
    const skill = (await this.skills()).find((s) => s.name === name);
    if (!skill) return false;
    for (const f of await this.list(skill.dir)) await this.rmFile(f.path);
    this.skillCache = null;
    return true;
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
    const prev = await this.store.getMeta<SkillsMeta>(metaKey);
    // Files recorded outside the current skills folder (a workspace from
    // before skillsDir, or a changed skillsDir) are unpacked afresh.
    const moved = !!prev?.files.some((f) => !this.inSkills(f));
    const fetched = await this.fetchSource(source, force || moved ? undefined : prev);
    if (!fetched) return; // unchanged
    await this.unpackZip(fetched.bytes, metaKey, zipBaseName(source), prev, fetched);
  }

  /** Writes a zip's files under `skillsDir` and records them under `metaKey`, dropping files an earlier unpack of it wrote that are gone now. */
  private async unpackZip(zip: Uint8Array, metaKey: string, base: string, prev?: SkillsMeta, fetched?: { etag?: string; lastModified?: string }): Promise<void> {
    const entries = listZip(zip).filter((e) => !e.isDir && !e.name.includes("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(e.name));
    const atRoot = entries.some((e) => e.name === "SKILL.md");
    const written: string[] = [];
    const now = Date.now();
    for (const e of entries) {
      let rel = e.name.replace(/^\.?\/+/, "");
      if (rel.startsWith("skills/")) rel = rel.slice(7);
      if (!rel || rel.split("/").some((seg) => seg === "..")) continue;
      const path = normalizePath(`${this.skillsDir}/${atRoot ? base + "/" : ""}${rel}`);
      if (!this.inSkills(path) || path === this.skillsDir) continue;
      const bytes = await readZipEntry(zip, e, this.inflate);
      const text = decodeText(bytes);
      await this.putFile(path, text ?? bytes, guessType(path, text ?? bytes), "skills", metaKey);
      written.push(path);
    }
    // Files of this source that the new zip no longer has.
    for (const old of prev?.files ?? []) if (!written.includes(old)) await this.rmFile(old).catch(() => undefined);
    await this.store.putMeta(metaKey, { etag: fetched?.etag, lastModified: fetched?.lastModified, files: written, at: now });
    this.skillCache = null;
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

  /** Deletes this directory: its files, its skills bookkeeping and the sessions saved from it. Other ids of the app stay. */
  async destroy(): Promise<void> {
    await this.ready();
    await this.store.clear();
    this.emitChange("/", "delete");
    this.close();
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

const DB_VERSION = 4;

/**
 * The app's database: `files` and `meta` keyed by [space, key] so every
 * directory (space) is its own tree; `sessions` keyed by [space, id].
 * Version 3 (2026-10-31) was the first with spaces (sessions keyed by id
 * alone); version 4 keys sessions per space too and keeps what version 3
 * stored. An upgrade never drops files or sessions.
 */
function openIDBStore(idb: IDBFactory, name: string, space: string): Promise<Store> {
  return new Promise((resolve, reject) => {
    const req = idb.open(name, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction!;
      const old = ev.oldVersion;
      const makeSessions = () => db.createObjectStore("sessions", { keyPath: ["space", "id"] }).createIndex("space", "space");
      if (old < 3) {
        // Nothing of ours yet (or a layout from before spaces): start clean.
        for (const n of ["files", "meta", "sessions"]) if (db.objectStoreNames.contains(n)) db.deleteObjectStore(n);
        db.createObjectStore("files", { keyPath: ["space", "path"] });
        db.createObjectStore("meta", { keyPath: ["space", "key"] });
        makeSessions();
        return;
      }
      if (old < 4) {
        // Sessions were keyed by id alone: move them under [space, id].
        const all = tx.objectStore("sessions").getAll();
        all.onsuccess = () => {
          const rows = all.result as SessionData[];
          db.deleteObjectStore("sessions");
          makeSessions();
          const ns = tx.objectStore("sessions");
          for (const r of rows) if (r.id) ns.put({ ...r, space: r.space ?? "default" });
        };
      }
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    // Another tab still has the old version open: wait for it (it closes on versionchange) rather than fail.
    req.onblocked = () => console.warn(`runapps agent: ${name} is waiting for another tab to release the database`);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      // A result counts once its transaction has committed: a quota error aborts after onsuccess.
      const run = <T,>(store: "files" | "meta" | "sessions", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise<T>((res, rej) => {
          const tx = db.transaction(store, mode);
          const r = fn(tx.objectStore(store));
          let value: T;
          r.onsuccess = () => { value = r.result; if (mode === "readonly") res(value); };
          r.onerror = () => rej(r.error ?? new Error("indexedDB request failed"));
          tx.oncomplete = () => res(value);
          tx.onabort = () => rej(tx.error ?? new Error("indexedDB transaction aborted"));
        });
      const range = (which: string, prefix: string) => IDBKeyRange.bound([which, prefix], [which, prefix + "\uffff"], false, false);
      resolve({
        get: (path) => run<FileRecord | undefined>("files", "readonly", (s) => s.get([space, path])),
        put: async (rec) => { await run("files", "readwrite", (s) => s.put({ ...rec, space })); },
        delete: async (path) => { await run("files", "readwrite", (s) => s.delete([space, path])); },
        list: (prefix) => run<FileRecord[]>("files", "readonly", (s) => s.getAll(range(space, prefix))),
        getMeta: async <T,>(key: string) => (await run<{ space: string; key: string; value: T } | undefined>("meta", "readonly", (s) => s.get([space, key])))?.value,
        putMeta: async (key, value) => { await run("meta", "readwrite", (s) => s.put({ space, key, value })); },
        deleteMeta: async (key) => { await run("meta", "readwrite", (s) => s.delete([space, key])); },
        getSession: (which, id) => run<SessionData | undefined>("sessions", "readonly", (s) => s.get([which, id])),
        putSession: async (data) => { await run("sessions", "readwrite", (s) => s.put(data)); },
        deleteSession: async (which, id) => { await run("sessions", "readwrite", (s) => s.delete([which, id])); },
        listSessions: () => run<SessionData[]>("sessions", "readonly", (s) => s.getAll()),
        clear: async (which = space) => {
          await run("files", "readwrite", (s) => s.delete(range(which, "/")));
          await run("meta", "readwrite", (s) => s.delete(range(which, "")));
          await run("sessions", "readwrite", (s) => s.delete(range(which, "")));
        },
        close: () => db.close(),
      });
    };
  });
}

interface MemoryDB {
  files: Map<string, Map<string, FileRecord>>;
  meta: Map<string, Map<string, unknown>>;
  sessions: Map<string, SessionData>;
}
const memoryStores = new Map<string, MemoryDB>();

function memoryStore(name: string, space: string): Store {
  let m = memoryStores.get(name);
  if (!m) {
    m = { files: new Map(), meta: new Map(), sessions: new Map() };
    memoryStores.set(name, m);
  }
  const mem = m;
  const files = () => { let f = mem.files.get(space); if (!f) { f = new Map(); mem.files.set(space, f); } return f; };
  const meta = () => { let f = mem.meta.get(space); if (!f) { f = new Map(); mem.meta.set(space, f); } return f; };
  return {
    get: async (path) => files().get(path),
    put: async (rec) => { files().set(rec.path, { ...rec, space }); },
    delete: async (path) => { files().delete(path); },
    list: async (prefix) => [...files().values()].filter((r) => prefix === "/" || r.path.startsWith(prefix)),
    getMeta: async <T,>(key: string) => meta().get(key) as T | undefined,
    putMeta: async (key, value) => { meta().set(key, value); },
    deleteMeta: async (key) => { meta().delete(key); },
    getSession: async (which, id) => mem.sessions.get(`${which}\u0000${id}`),
    putSession: async (data) => { mem.sessions.set(`${data.space ?? space}\u0000${data.id}`, data); },
    deleteSession: async (which, id) => { mem.sessions.delete(`${which}\u0000${id}`); },
    listSessions: async () => [...mem.sessions.values()],
    clear: async (which = space) => {
      mem.files.delete(which);
      mem.meta.delete(which);
      for (const [id, d] of mem.sessions) if (d.space === which) mem.sessions.delete(id);
    },
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
