// Workspace: the directory the agent works in — a POSIX-style tree kept
// in IndexedDB (one database per app; `id` names a directory in it, so a
// chat can give every session its own), or a directory the app
// provides (`dir`: a local folder through the File System Access API,
// any `AgentFS`), plus mount points an app fills with its own files (its
// document, a cloud folder). Skills: `<skillsDir>` (default
// `/.agent/skills`) is virtual and read-only, generated in memory when the
// workspace opens and whenever the user's skills change — one folder per
// skill, from the app's zips (`skills` option: URLs or Blobs, never
// stored) and from `<userSkillsDir>` (default `/skills`), the user's own
// skills shared by every directory of the app: zips (uploaded, read in
// place, never unpacked) and folders (written by the user or the agent).
// The file tools in file-tools.ts and the sandbox's `fs` work on it.

import { toProvider, type ModelProvider, type RunAppsClientLike } from "./provider.js";
import type { AgentFS, FileStat, SessionData, SessionSummary, Skill } from "./types.js";
import { listZip, readZipEntry, type Inflate, MAX_ZIP_BYTES } from "./zip.js";
import { parseSkill } from "./skills.js";
import { applyEdits, type TextEdit } from "./edit.js";
import { summaryOf } from "./compaction.js";
import { cachedSkillZip, parseSkillZip, skillFoldersOf, skillZipFS, subFS, zipFiles } from "./skill-zips.js";
import { extractPdfText, formatPdfText, isPdf } from "./pdf.js";

/** Where a workspace keeps its skills unless `skillsDir` says otherwise. */
export const DEFAULT_SKILLS_DIR = "/.agent/skills";
/** @deprecated use DEFAULT_SKILLS_DIR / `workspace.skillsDir` */
export const SKILLS_ROOT = DEFAULT_SKILLS_DIR;
const DB_PREFIX = "__runapps_agent_ws";
/** Where the user's skills live unless `userSkillsDir` says otherwise. */
export const DEFAULT_USER_SKILLS_DIR = "/skills";
/** The app's shared skills (the user's skills folder): a space no directory id can be. */
const LIB_SPACE = "\u0000skills";

/**
 * A skill known up front by its name and description, whose zip is fetched only the first time
 * it is used (the agent reads a file of it, or `/skill:name`): `load` returns the zip — a Blob,
 * an ArrayBuffer, a Uint8Array, or a URL / `files:` path to fetch. Loaded once per page.
 */
export interface LazySkill {
  name: string;
  description: string;
  load: () => Blob | ArrayBuffer | Uint8Array | string | Promise<Blob | ArrayBuffer | Uint8Array | string>;
  /** Only used when asked for (`/skill:name`), never picked by the model. */
  disableModelInvocation?: boolean;
}
/** A skills zip the app provides: a URL / bundle path / `files:<path>`, the bytes, either with a name, or a LazySkill. */
export type SkillSource = string | Blob | Uint8Array | { name: string; data: string | Blob | Uint8Array } | LazySkill;
const isLazy = (s: SkillSource): s is LazySkill => typeof s === "object" && !(s instanceof Uint8Array) && typeof (s as LazySkill).load === "function";
/** A LazySkill's zip, once asked for (per page: every workspace shares it). */
const lazyLoads = new WeakMap<LazySkill, Promise<Uint8Array>>();

/** The app's zips, per page: a URL is fetched once (the browser's HTTP cache does the rest). */
const builtinFetches = new Map<string, Promise<{ bytes: Uint8Array; at: number }>>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const idOf = (o: object) => { let id = objectIds.get(o); if (!id) { id = nextObjectId++; objectIds.set(o, id); } return id; };

/** One skill in the generated skills folder; `lazy` ones are listed from what the app said, before their zip is loaded. */
interface SkillView { fs: AgentFS; builtin: boolean; from?: string; lazy?: LazySkill }

type Layer = "skills" | "work";

/** A file as a WorkspaceStore keeps it. */
export interface FileRecord {
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

/**
 * Where a workspace keeps its files (when it has no `dir`), its meta data
 * and the app's sessions: one store per directory (`space`) of an app's
 * database. IndexedDB in browsers, memory elsewhere, or a store of your
 * own through the `store` option (`nodeStore()` keeps it on disk).
 */
export interface WorkspaceStore {
  get(path: string): Promise<FileRecord | undefined>;
  /** A file's size and time without its content (optional; else `get`). */
  stat?(path: string): Promise<FileStat | null>;
  put(rec: FileRecord): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<FileRecord[]>;
  /** The files under `prefix` without their content (optional; else `list`). */
  listStats?(prefix: string): Promise<FileStat[]>;
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta(key: string, value: unknown): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  /** Meta values whose key starts with `prefix`. */
  listMeta<T>(prefix: string): Promise<T[]>;
  /** Meta keys that start with `prefix`. */
  listMetaKeys(prefix: string): Promise<string[]>;
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
/** Opens the store of one directory (`space`) of an app's database (`dbName`). */
export interface WorkspaceStoreFactory {
  open(dbName: string, space: string): Promise<WorkspaceStore>;
}
type Store = WorkspaceStore;
/** A store's files or one file, without their content when the store can. */
const statsOf = async (store: Store, prefix: string): Promise<FileStat[]> => (store.listStats ? store.listStats(prefix) : (await store.list(prefix)).map(statOf));
const statIn = async (store: Store, p: string): Promise<FileStat | null> => {
  if (store.stat) return store.stat(p);
  const rec = await store.get(p);
  return rec ? statOf(rec) : null;
};

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
  /** The app the database belongs to; `openWorkspace` fills it in from the provider's `name`. */
  project?: string;
  /**
   * The app's skills zip(s): a path or URL (`/skills.zip` in the bundle,
   * a public link), `files:<path>` for a file in the user's RunApps
   * storage (fetched with the SDK's token), a Blob / File / Uint8Array,
   * or `{ name, data }`. Read in place each time the page opens them —
   * never stored; a URL is fetched once per page. They are the app's:
   * the user cannot remove them. A `LazySkill` (`{ name, description,
   * load }`) is listed at once and its zip fetched only when first used.
   * A function returning the list (sync or async) is called at open and
   * on `refreshSkills()`.
   */
  skills?: SkillSource | SkillSource[] | (() => SkillSource[] | Promise<SkillSource[]>);
  /** The generated, read-only skills folder, `<skillsDir>/<name>/SKILL.md` (default `/.agent/skills`). */
  skillsDir?: string;
  /**
   * The user's skills, shared by every directory of the app (default
   * `/skills`; `false`: none): skill zips (read in place) and skill
   * folders (`<userSkillsDir>/<name>/SKILL.md`, which the agent may
   * write). Each shows up in `skillsDir`.
   */
  userSkillsDir?: string | false;
  /**
   * Whether the user has skills of their own (default true). `false`:
   * only the app's `skills` — no `userSkillsDir`, nothing to upload,
   * remove or write, and the agent is not told it may make skills.
   */
  userSkills?: boolean;
  /**
   * The directory itself, instead of the IndexedDB tree: `directoryFS(handle)`
   * for a folder picked with `showDirectoryPicker()`, or any `AgentFS`.
   * Sessions and skills-zip bookkeeping still go to IndexedDB under `id`.
   */
  dir?: AgentFS;
  /** Inflate for runtimes without DecompressionStream (tests: zlib.inflateRawSync). */
  inflate?: Inflate;
  fetch?: typeof fetch;
  /** IndexedDB to use (an `IDBFactory`; tests pass fake-indexeddb's); in-memory when the runtime has none and no `store` is given. */
  indexedDB?: object | null;
  /** Keep the workspace somewhere other than IndexedDB — `nodeStore(dir)` from `@runappsai/agent/node` keeps it on disk. */
  store?: WorkspaceStoreFactory;
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
  /** The generated, read-only skills folder (`<skillsDir>/<name>/SKILL.md`). */
  readonly skillsDir: string;
  /** The user's skills folder, shared by the app's directories (null: none). */
  readonly userSkillsDir: string | null;
  /** The folder the directory lives in when opened with `dir` (null: IndexedDB). */
  readonly root: AgentFS | null;
  private store!: Store;
  /** The user's skills folder (one tree for the whole app). */
  private lib!: Store;
  private readonly mounts = new Map<string, AgentFS>();
  /** The skills in `skillsDir`, by folder name. */
  private skillViews = new Map<string, SkillView>();
  /** The app's zips, loaded at open. */
  private builtins: Array<{ name: string; bytes: Uint8Array; key: string; at: number }> = [];
  /** The app's skills that load on first use. */
  private lazySkills: LazySkill[] = [];
  /** The `skills` option resolved (a function called): what loadBuiltins worked from. */
  private resolvedSources: SkillSource[] = [];
  private readonly changeListeners = new Set<(c: WorkspaceChange) => void>();
  private channel: BroadcastChannel | null | undefined;
  private readonly sources: SkillSource[] | (() => SkillSource[] | Promise<SkillSource[]>);
  /** Reads `files:` skills sources (the provider's own storage). */
  private readonly provider: ModelProvider | null;
  private readonly inflate?: Inflate;
  private readonly fetchFn: typeof fetch;
  /** Part of the page cache key for the app's zips: a host's own fetch is its own cache. */
  private readonly fetchKey: string;
  private readonly idb: IDBFactory | null;
  private readonly storeFactory: WorkspaceStoreFactory | null;
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
        .map((d) => ({ id: d.id ?? "", title: d.title && !isMachineTitle(d.title) ? d.title : titleOf(d), model: d.model, messages: d.messages.length, createdAt: d.createdAt ?? d.savedAt, savedAt: d.savedAt, workspace: d.space }))
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
      if (!data.id) throw new Error("a session needs an id to be saved");
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

  constructor(provider: ModelProvider | RunAppsClientLike | null, opts: WorkspaceOptions = {}) {
    this.provider = provider ? toProvider(provider) : null;
    this.id = opts.id || "default";
    this.dbName = `${DB_PREFIX}:${opts.project || this.provider?.name || "app"}`;
    this.sources = typeof opts.skills === "function" ? opts.skills : opts.skills ? ([] as SkillSource[]).concat(opts.skills) : [];
    this.skillsDir = normalizePath(opts.skillsDir || DEFAULT_SKILLS_DIR);
    if (this.skillsDir === "/") throw new Error("skillsDir cannot be /");
    this.userSkillsDir = opts.userSkills === false || opts.userSkillsDir === false ? null : normalizePath(opts.userSkillsDir || DEFAULT_USER_SKILLS_DIR);
    const nested = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
    if (this.userSkillsDir === "/" || (this.userSkillsDir && nested(this.userSkillsDir, this.skillsDir))) throw new Error("userSkillsDir must be its own folder, apart from skillsDir");
    this.root = opts.dir ?? null;
    this.inflate = opts.inflate;
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.fetchKey = opts.fetch ? `f${idOf(opts.fetch)}` : "";
    this.idb = opts.indexedDB !== undefined ? (opts.indexedDB as IDBFactory | null) : (typeof indexedDB !== "undefined" ? indexedDB : null);
    this.storeFactory = opts.store ?? null;
  }

  /** Opens the database and brings the skills layer up to date. */
  static async open(provider: ModelProvider | RunAppsClientLike | null, opts: WorkspaceOptions = {}): Promise<Workspace> {
    const ws = new Workspace(provider, opts);
    await ws.ready();
    return ws;
  }

  /** Resolves once the database is open and skills are unpacked (idempotent). */
  ready(): Promise<void> {
    if (!this.opened) {
      const opening = (async () => {
        const open = (space: string): Promise<Store> => this.storeFactory ? this.storeFactory.open(this.dbName, space) : this.idb ? openIDBStore(this.idb, this.dbName, space) : Promise.resolve(memoryStore(this.dbName, space));
        this.store = await open(this.id);
        this.lib = await open(LIB_SPACE);
        this.openChannel();
        await withLock(`${this.dbName}:skills-migrate`, () => this.migrateSkills());
        this.builtins = await this.loadBuiltins();
        this.mounts.set(this.skillsDir, this.skillsFS());
        if (this.userSkillsDir) this.mounts.set(this.userSkillsDir, this.userFS());
        await this.rebuildSkills();
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
    if (this.opened) { const o = this.opened; this.opened = null; void o.then(() => { this.store.close(); this.lib.close(); }, () => undefined); }
  }

  /* ---------------- mounts ---------------- */

  /** Exposes `fs` under `prefix` (e.g. `/doc`); its paths are relative to the prefix. */
  mount(prefix: string, fs: AgentFS): void {
    const p = normalizePath(prefix);
    if (p === "/") throw new Error("cannot mount at / (open the workspace with `dir` instead)");
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
      ch.onmessage = (ev: MessageEvent<{ space?: string; path?: string; kind?: "write" | "delete"; userSkills?: boolean }>) => {
        const m = ev.data;
        // The user's skills changed (any tab, any directory): regenerate the skills folder.
        if (m?.userSkills) {
          if (this.lib && this.userSkillsDir && typeof m.path === "string" && (m.kind === "write" || m.kind === "delete")) {
            const path = this.userSkillsDir + m.path, kind = m.kind;
            void this.rebuildSkills().then(() => { this.emitChange(path, kind, true); this.emitChange(this.skillsDir, "write", true); }).catch(() => undefined);
          }
          return;
        }
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
    for (const fn of this.changeListeners) { try { fn(c); } catch (err) { console.warn("agent: onChange listener failed", err); } }
  }

  /** What the system prompt says about the tree. */
  describe(): string {
    const lines = [
      this.root
        ? `/ — ${this.root.description || "the working directory"}${this.root.write ? "" : " (read-only)"}.`
        : "/ — the working directory; it persists between conversations.",
      `${this.skillsDir}/ — skills, one folder per skill with a SKILL.md (read-only, generated from the app's skills${this.userSkillsDir ? ` and ${this.userSkillsDir}` : ""}).`,
    ];
    if (this.userSkillsDir) lines.push(`${this.userSkillsDir}/ — the user's skills, shared by every conversation: skill zips and skill folders. To add a skill, write ${this.userSkillsDir}/<name>/SKILL.md (frontmatter with name and description); it appears under ${this.skillsDir}/ at once.`);
    for (const [p, fs] of this.mounts) if (p !== this.skillsDir && p !== this.userSkillsDir) lines.push(`${p}/ — ${fs.description || "app files"}${fs.write ? "" : " (read-only)"}.`);
    return lines.join("\n");
  }

  /** The mount (or the root directory) that serves `path`; null means the IndexedDB tree. */
  private route(path: string): { fs: AgentFS; rel: string; prefix: string } | null {
    // The longest mount point that holds the path.
    let best: string | null = null;
    for (const prefix of this.mounts.keys()) {
      if ((path === prefix || path.startsWith(prefix + "/")) && (!best || prefix.length > best.length)) best = prefix;
    }
    if (best) return { fs: this.mounts.get(best)!, rel: path.slice(best.length) || "/", prefix: best };
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
      : await statsOf(this.store, p === "/" ? "/" : p + "/");
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
    return statIn(this.store, p);
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

  /**
   * A file as text for reading: text files as they are, a PDF as the text
   * of its pages (pdf.js, loaded on first use; the result is cached with
   * the directory and redone when the file changes); null for other
   * binary files.
   */
  async readAsText(path: string): Promise<{ text: string; kind: "text" | "pdf" } | null> {
    const p = normalizePath(path);
    const { data, size, contentType } = await this.read(p);
    if (typeof data === "string") return { text: data, kind: "text" };
    if (isPdf(p, contentType, data)) {
      const st = await this.stat(p);
      const key = `pdftext:${p}`;
      const cached = await this.getData<{ size: number; mtime?: number; text: string }>(key).catch(() => undefined);
      if (cached && cached.size === size && cached.mtime === st?.mtime) return { text: cached.text, kind: "pdf" };
      const text = formatPdfText(p, await extractPdfText(data));
      await this.putData(key, { size, mtime: st?.mtime, text }).catch(() => undefined);
      return { text, kind: "pdf" };
    }
    const text = decodeText(data);
    return text === null ? null : { text, kind: "text" };
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

  /**
   * Replaces each `oldText` (found once, in the original) by its `newText`.
   * A mount (or `dir`) that implements `edit` gets the edits as they are;
   * otherwise the file is read, edited (`applyEdits`: exact, then tolerant
   * of quotes, dashes and trailing spaces) and written back whole.
   */
  async edit(path: string, edits: TextEdit[]): Promise<void> {
    await this.ready();
    const p = normalizePath(path);
    const r = this.route(p);
    if (r?.fs.edit) {
      await r.fs.edit(r.rel, edits);
      this.emitChange(p, "write");
      return;
    }
    if (r && !r.fs.write) throw new Error(`${r.prefix || "/"} is read-only`);
    await this.write(p, applyEdits(p, await this.readText(p), edits));
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
  /** Whether a path is under the skills folder or the user's skills folder. */
  isSkillPath(path: string): boolean {
    const p = normalizePath(path);
    return this.inSkills(p) || (!!this.userSkillsDir && (p === this.userSkillsDir || p.startsWith(this.userSkillsDir + "/")));
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

  /** The skills: every `<skillsDir>/<name>/SKILL.md` (parsed once, until a skill changes). */
  async skills(): Promise<Skill[]> {
    await this.ready();
    if (this.skillCache) return this.skillCache;
    const out: Skill[] = [];
    const seen = new Set<string>();
    for (const [folder, v] of this.skillViews) {
      // Known by what the app said: nothing is loaded to list it.
      if (v.lazy) {
        if (seen.has(v.lazy.name)) continue;
        seen.add(v.lazy.name);
        const dir = `${this.skillsDir}/${folder}`;
        out.push({ name: v.lazy.name, description: v.lazy.description, path: `${dir}/SKILL.md`, dir, builtin: true, lazy: true, ...(v.lazy.disableModelInvocation ? { disableModelInvocation: true } : {}) });
        continue;
      }
      let text: string | null;
      try { const d = await v.fs.read("/SKILL.md"); text = typeof d === "string" ? d : decodeText(d); } catch { continue; }
      if (text === null) continue;
      const parsed = parseSkill(text, `${this.skillsDir}/${folder}/SKILL.md`);
      if (!parsed || seen.has(parsed.skill.name)) continue;
      seen.add(parsed.skill.name);
      out.push({ ...parsed.skill, ...(v.builtin ? { builtin: true } : {}), ...(v.from ? { from: v.from } : {}) });
    }
    this.skillCache = out.sort((a, b) => a.name.localeCompare(b.name));
    return this.skillCache;
  }

  /**
   * Adds a skill (or a pack of skills) from a zip — a URL / bundle path /
   * `files:<path>` string, or the bytes (a `File` from an
   * `<input type=file>`, a Blob, a Uint8Array) — to the user's skills:
   * the zip is saved as `<userSkillsDir>/<name>.zip` (the same name
   * replaces it) and read in place; `unpack: true` writes its skill
   * folders there instead, as files that can be edited. A zip with
   * SKILL.md at its root is one skill named `name` (else after the file);
   * otherwise each folder with a SKILL.md is one. Returns what was added.
   */
  async installSkill(source: string | Blob | Uint8Array, opts: { name?: string; unpack?: boolean } = {}): Promise<Skill[]> {
    await this.ready();
    if (!this.userSkillsDir) throw new Error("this workspace has no userSkillsDir to install skills into");
    let bytes: Uint8Array;
    let base: string;
    if (typeof source === "string") {
      const fetched = await this.fetchSource(source);
      if (!fetched) throw new Error("nothing fetched");
      bytes = fetched.bytes;
      base = opts.name ?? source;
    } else {
      bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
      base = opts.name ?? ((source as File).name || "skill");
    }
    if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error("skills zip too large");
    const name = zipBaseName(base);
    const files = zipFiles(bytes);
    const folders = skillFoldersOf(files.keys(), name);
    if (!folders.size) throw new Error(`${name}.zip has no SKILL.md (at its root, or one per folder)`);
    const now = Date.now();
    if (opts.unpack) {
      for (const [folder, prefix] of folders) {
        for (const old of await statsOf(this.lib, `/${folder}/`)) await this.lib.delete(old.path);
        for (const [p, e] of files) {
          if (!p.startsWith(prefix)) continue;
          const data = await readZipEntry(bytes, e, this.inflate);
          const text = decodeText(data);
          const path = normalizePath(`/${folder}/${p.slice(prefix.length)}`);
          await this.lib.put({ path, data: text ?? data, contentType: guessType(path, text ?? data), mtime: now, layer: "work" });
        }
      }
      await this.userSkillsChanged(`/${[...folders.keys()][0]}`, "write");
    } else {
      await this.lib.put({ path: `/${name}.zip`, data: bytes, contentType: "application/zip", mtime: now, layer: "work" });
      await this.userSkillsChanged(`/${name}.zip`, "write");
    }
    const dirs = new Set([...folders.keys()].map((f) => `${this.skillsDir}/${f}`));
    return (await this.skills()).filter((s) => dirs.has(s.dir));
  }

  /**
   * Removes one of the user's skills: its zip in `userSkillsDir` (with
   * every skill the zip holds) or its folder there. The app's skills
   * cannot be removed. Returns false when there is no such skill.
   */
  async removeSkill(name: string): Promise<boolean> {
    const skill = (await this.skills()).find((s) => s.name === name);
    if (!skill) return false;
    if (skill.builtin) throw new Error(`"${name}" comes with the app and cannot be removed`);
    if (!skill.from || !this.userSkillsDir || !skill.from.startsWith(this.userSkillsDir + "/")) return false;
    const rel = skill.from.slice(this.userSkillsDir.length);
    if (/\.zip$/i.test(rel)) await this.lib.delete(rel);
    else for (const f of await statsOf(this.lib, rel + "/")) await this.lib.delete(f.path);
    await this.userSkillsChanged(rel, "delete");
    return true;
  }

  /** The body (instructions) of a skill, by name. */
  async skillBody(name: string): Promise<{ skill: Skill; body: string }> {
    const skill = (await this.skills()).find((s) => s.name === name);
    if (!skill) throw new Error(`No skill named "${name}"`);
    const parsed = parseSkill(await this.readText(skill.path), skill.path);
    return { skill, body: parsed?.body ?? "" };
  }

  /** Fetches the app's skills zips again (bypassing the page's copy; lazy ones load again when next used) and regenerates the skills folder. */
  async refreshSkills(): Promise<void> {
    await this.ready();
    for (const src of this.resolvedSources) {
      if (isLazy(src)) { lazyLoads.delete(src); continue; }
      const url = typeof src === "string" ? src : !(src instanceof Uint8Array) && !isBlob(src) && typeof src.data === "string" ? src.data : null;
      if (url) builtinFetches.delete(`${this.dbName}|${this.fetchKey}|${url}`);
    }
    this.builtins = await this.loadBuiltins();
    await this.rebuildSkills();
    this.emitChange(this.skillsDir, "write");
  }

  /** The app's zips, from the `skills` option (a failed one is left out and logged); lazy ones are only noted. */
  private async loadBuiltins(): Promise<Workspace["builtins"]> {
    const out: Workspace["builtins"] = [];
    let list: SkillSource[] = [];
    try { list = typeof this.sources === "function" ? ([] as SkillSource[]).concat(await this.sources()) : this.sources; } catch (err) { console.warn("[agent] the skills list failed:", err); }
    this.resolvedSources = list;
    this.lazySkills = list.filter(isLazy);
    for (const src of list) {
      if (isLazy(src)) continue;
      try {
        const named = typeof src === "object" && !(src instanceof Uint8Array) && !isBlob(src) ? (src as { name: string; data: string | Blob | Uint8Array }) : null;
        const data = named ? named.data : (src as string | Blob | Uint8Array);
        let bytes: Uint8Array, key: string, at = 0;
        if (typeof data === "string") {
          const k = `${this.dbName}|${this.fetchKey}|${data}`;
          let f = builtinFetches.get(k);
          if (!f) {
            f = this.fetchSource(data).then((r) => { if (!r) throw new Error("nothing fetched"); return { bytes: r.bytes, at: Date.now() }; });
            builtinFetches.set(k, f);
            f.catch(() => builtinFetches.delete(k));
          }
          ({ bytes, at } = await f);
          key = `app:${k}@${at}`;
        } else {
          bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
          key = `app:${this.dbName}|obj${idOf(data)}`;
        }
        if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error("skills zip too large");
        const name = zipBaseName(named?.name ?? (typeof data === "string" ? data : (data as File).name || "skills"));
        out.push({ name, bytes, key, at });
      } catch (err) {
        // A skills pack that cannot be fetched (offline, 404) is left out; surface it for developers.
        // eslint-disable-next-line no-console
        console.warn("[agent] skills source failed:", err);
      }
    }
    return out;
  }

  /** Regenerates `skillsDir`: the app's zips, then the user's zips and folders (a user's skill of the same name wins). */
  private async rebuildSkills(): Promise<void> {
    const views = new Map<string, SkillView>();
    for (const b of this.builtins) {
      try {
        const parsed = parseSkillZip(b.name, b.bytes, b.key);
        for (const [folder, prefix] of parsed.folders) if (!views.has(folder)) views.set(folder, { fs: skillZipFS(parsed, prefix, b.at, this.inflate), builtin: true });
      } catch (err) { console.warn(`[agent] skills zip "${b.name}":`, err); }
    }
    for (const l of this.lazySkills) {
      const folder = /^[A-Za-z0-9][\w.-]*$/.test(l.name) ? l.name : zipBaseName(l.name);
      if (!views.has(folder)) views.set(folder, { fs: this.lazyFS(l, folder), builtin: true, lazy: l });
    }
    // A project folder opened with `dir` may bring skill folders of its own.
    if (this.root) {
      for (const f of await this.root.list(this.skillsDir).catch(() => [] as FileStat[])) {
        const m = new RegExp("^" + escapeRe(this.skillsDir) + "/([^/]+)/SKILL\\.md$").exec(normalizePath(f.path));
        if (m) views.set(m[1]!, { fs: subFS(this.root, `${this.skillsDir}/${m[1]}`), builtin: false, from: `${this.skillsDir}/${m[1]}` });
      }
    }
    if (this.userSkillsDir) {
      const files = await statsOf(this.lib, "/");
      for (const f of files) {
        const m = /^\/([^/]+)\.zip$/i.exec(f.path);
        if (!m) continue;
        try {
          // Only the zips are read (names are enough for the folders), and one parsed at this version already is not read again.
          const key = `user:${this.dbName}|${f.path}@${f.mtime}:${f.size}`;
          let parsed = f.mtime !== undefined ? cachedSkillZip(key) : undefined;
          if (!parsed) {
            const rec = await this.lib.get(f.path);
            if (!rec || !(rec.data instanceof Uint8Array)) continue;
            parsed = parseSkillZip(zipBaseName(m[1]!), rec.data, key);
          }
          for (const [folder, prefix] of parsed.folders) views.set(folder, { fs: skillZipFS(parsed, prefix, f.mtime ?? 0, this.inflate), builtin: false, from: this.userSkillsDir + f.path });
        } catch (err) { console.warn(`[agent] skills zip "${f.path}":`, err); }
      }
      const user = this.userFS();
      for (const f of files) {
        const m = /^\/([^/]+)\/SKILL\.md$/.exec(f.path);
        if (m) views.set(m[1]!, { fs: subFS(user, `/${m[1]}`), builtin: false, from: `${this.userSkillsDir}/${m[1]}` });
      }
    }
    this.skillViews = views;
    this.skillCache = null;
  }

  /**
   * A lazy skill's files: its SKILL.md is listed before anything is loaded; the first read (or a
   * look at any other file) loads the zip — once per page — and from then on it is the zip's tree.
   */
  private lazyFS(l: LazySkill, folder: string): AgentFS {
    let fs: AgentFS | null = null;
    const ensure = async (): Promise<AgentFS> => {
      if (fs) return fs;
      let p = lazyLoads.get(l);
      if (!p) {
        p = (async () => {
          const d = await l.load();
          if (typeof d === "string") { const r = await this.fetchSource(d); if (!r) throw new Error("nothing fetched"); return r.bytes; }
          return d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(await d.arrayBuffer());
        })();
        lazyLoads.set(l, p);
        p.catch(() => { if (lazyLoads.get(l) === p) lazyLoads.delete(l); });  // tried again next time
      }
      let bytes: Uint8Array;
      try { bytes = await p; } catch (err) { throw new Error(`the skill "${l.name}" could not be loaded: ${(err as Error).message}`); }
      if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error(`the skill "${l.name}": zip too large`);
      const parsed = parseSkillZip(folder, bytes, `lazy:${idOf(l)}:${bytes.byteLength}`);
      const prefix = parsed.folders.get(folder) ?? [...parsed.folders.values()][0];
      if (prefix === undefined) throw new Error(`the skill "${l.name}": its zip has no SKILL.md`);
      fs = skillZipFS(parsed, prefix, Date.now(), this.inflate);
      // Its real files replace the placeholder in listings (the files panel redraws).
      this.emitChange(`${this.skillsDir}/${folder}`, "write");
      return fs;
    };
    const placeholder = (at: string): FileStat[] => (at === "/" || at === "/SKILL.md" ? [{ path: "/SKILL.md", size: 0 }] : []);
    return {
      list: async (at) => (fs ? fs.list(at) : placeholder(at)),
      stat: async (rel) => {
        if (!fs && rel === "/SKILL.md") return { path: rel, size: 0 };
        const f = await ensure();
        return f.stat ? f.stat(rel) : null;
      },
      read: async (rel) => (await ensure()).read(rel),
    };
  }

  /** The generated skills folder: read-only, one subtree per skill. */
  private skillsFS(): AgentFS {
    const split = (rel: string) => { const m = /^\/([^/]+)(\/.*)?$/.exec(rel); return m ? { name: m[1]!, rest: m[2] || "/" } : null; };
    return {
      description: "skills (generated, read-only)",
      list: async (prefix) => {
        const out: FileStat[] = [];
        const sp = split(prefix);
        for (const [name, v] of this.skillViews) {
          if (sp && sp.name !== name) continue;
          for (const f of await v.fs.list(sp ? sp.rest : "/")) out.push({ ...f, path: `/${name}${normalizePath(f.path)}` });
        }
        return out;
      },
      stat: async (rel) => {
        const sp = split(rel);
        const v = sp && this.skillViews.get(sp.name);
        if (!v || !sp) return null;
        const st = v.fs.stat ? await v.fs.stat(sp.rest) : (await v.fs.list(sp.rest)).find((f) => normalizePath(f.path) === sp.rest) ?? null;
        return st ? { ...st, path: rel } : null;
      },
      read: async (rel) => {
        const sp = split(rel);
        const v = sp && this.skillViews.get(sp.name);
        if (!v || !sp) throw new Error(`No such file: ${rel}`);
        return v.fs.read(sp.rest);
      },
    };
  }

  /** The user's skills folder: one tree in the app's database, shared by every directory. */
  private userFS(): AgentFS {
    return {
      description: "the user's skills, shared by every conversation",
      list: async (prefix) => statsOf(this.lib, prefix === "/" ? "/" : prefix.replace(/\/+$/, "") + "/"),
      stat: async (p) => statIn(this.lib, p),
      read: async (p) => { const r = await this.lib.get(p); if (!r) throw new Error(`No such file: ${p}`); return r.data; },
      write: async (p, data, type) => {
        await this.lib.put({ path: p, data, contentType: type ?? guessType(p, data), mtime: Date.now(), layer: "work" });
        await this.userSkillsChanged(p, "write");
      },
      delete: async (p) => { await this.lib.delete(p); await this.userSkillsChanged(p, "delete"); },
    };
  }

  /** A file of the user's skills changed here: regenerate, tell the app's other workspaces and this one's listeners. */
  private async userSkillsChanged(rel: string, kind: "write" | "delete"): Promise<void> {
    await this.rebuildSkills();
    this.openChannel();
    try { this.channel?.postMessage({ userSkills: true, path: rel, kind }); } catch { /* closed */ }
    this.emitChange(this.skillsDir, "write");
  }

  /**
   * Moves skills from before the generated folder: once per app, the
   * user's uploads kept in the old library become zips in the user's
   * skills; once per directory, skill files stored in its `skillsDir`
   * (hand-written, written by the agent, unpacked uploads) move to the
   * user's skills and copies unpacked from the app's zips are dropped.
   */
  private async migrateSkills(): Promise<void> {
    if (!(await this.lib.getMeta("migrated:2"))) {
      for (const r of await this.lib.listMeta<{ name: string; bytes: Uint8Array; source: string; at: number }>("zip:")) {
        if (r.source === "upload" && !(await this.lib.get(`/${r.name}.zip`))) await this.lib.put({ path: `/${r.name}.zip`, data: r.bytes, contentType: "application/zip", mtime: r.at || Date.now(), layer: "work" });
      }
      for (const prefix of ["zip:", "removed:"]) for (const k of await this.lib.listMetaKeys(prefix)) await this.lib.deleteMeta(k);
      await this.lib.putMeta("migrated:2", true);
    }
    if (this.root || (await this.store.getMeta("skills-migrated:2"))) return;
    const own = await this.store.list(this.skillsDir + "/");
    if (own.length) {
      const fromApp = new Set<string>();
      for (const k of await this.store.listMetaKeys("skills:")) {
        const m = await this.store.getMeta<SkillsMeta>(k);
        if (!k.startsWith("skills:upload:")) for (const f of m?.files ?? []) fromApp.add(f);
        await this.store.deleteMeta(k);
      }
      for (const rec of own) {
        const rel = rec.path.slice(this.skillsDir.length);
        if (!fromApp.has(rec.path) && this.userSkillsDir && !(await this.lib.get(rel))) await this.lib.put({ ...rec, path: rel, layer: "work" });
        await this.store.delete(rec.path);
      }
    }
    await this.store.putMeta("skills-migrated:2", true);
  }

  private async fetchSource(
    source: string,
    prev?: { etag?: string; lastModified?: string },
  ): Promise<{ bytes: Uint8Array; etag?: string; lastModified?: string } | null> {
    if (source.startsWith("files:")) {
      if (!this.provider?.readFile) throw new Error("a files: skills source needs a provider that reads files (RunApps)");
      const got = await this.provider.readFile(source.slice(6), { etag: prev?.etag });
      if (!got) return null;
      if (got.bytes.byteLength > MAX_ZIP_BYTES) throw new Error("skills zip too large");
      return got;
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

const isBlob = (v: unknown): v is Blob => typeof Blob !== "undefined" && v instanceof Blob;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    req.onblocked = () => console.warn(`agent: ${name} is waiting for another tab to release the database`);
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
        listMeta: async <T,>(prefix: string) => (await run<Array<{ value: T }>>("meta", "readonly", (s) => s.getAll(range(space, prefix)))).map((r) => r.value),
        listMetaKeys: async (prefix) => (await run<Array<{ key: string }>>("meta", "readonly", (s) => s.getAll(range(space, prefix)))).map((r) => r.key),
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
    listMeta: async <T,>(prefix: string) => [...meta()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as T),
    listMetaKeys: async (prefix) => [...meta().keys()].filter((k) => k.startsWith(prefix)),
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
export const UNTITLED = "Untitled";
/** The first thing the user wrote: what they typed for an expanded command, never a compaction summary, an agent note or an attachment list. */
export function titleOf(d: SessionData): string {
  for (const m of d.messages) {
    if (m.role !== "user" || summaryOf(m) !== null) continue;
    const typed = (m as { typed?: unknown }).typed;
    const text = typeof typed === "string" ? typed : typeof m.content === "string" ? m.content : (m.content ?? []).find((p) => p.type === "text")?.text ?? "";
    // An attachment list or context the chat put after the typed words is not part of the title.
    const line = text.replace(/\s*\[attachments\][\s\S]*$/, "").replace(/(^|\n)\[context\] [\s\S]*$/, "").replace(/\s+/g, " ").trim();
    if (!line || isMachineTitle(line)) continue;
    return line.length > 80 ? line.slice(0, 77) + "…" : line;
  }
  return UNTITLED;
}
/** A title that is not the user's words: a compaction summary, an expanded skill, an agent note, an attachment list, the host's context. */
export function isMachineTitle(title: string): boolean {
  return /^(The conversation history before this point|<skill[\s>]|\[environment\]|\[attachments\]|\[context\] )|\[attachments\]/.test(title);
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
