// @runappsai/agent/node — what an agent needs outside a browser: a folder
// on disk as the workspace's directory (`nodeFS`), the workspace's own
// storage on disk instead of IndexedDB (`nodeStore`: sessions, the user's
// skills, meta), dialogs in the terminal (`terminalUI`), and PDFs read with
// the pdfjs-dist package (`nodePdf`). Node 18+.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { configurePdf, decodeText, guessType, normalizePath } from "./index.js";
import type { AgentFS, AgentUI, FileRecord, FileStat, PdfLib, SelectOption, SessionData, WorkspaceStore, WorkspaceStoreFactory } from "./index.js";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * A file's content as the workspace keeps it: text when it decodes as
 * UTF-8 with no control characters but whitespace and ESC; bytes otherwise
 * (a disk does not remember which one was written).
 */
function contentOf(buf: Buffer): string | Uint8Array {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  for (const b of bytes) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) return bytes;
  return decodeText(bytes) ?? bytes;
}

/** Every regular file under `dir` (symbolic links are not followed), skipping folders named in `skip` and files `keep` refuses. */
async function walkFiles(dir: string, skip: ReadonlySet<string> = new Set(), keep: (name: string) => boolean = () => true): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) await walk(full); }
      else if (e.isFile() && keep(e.name)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

/** Whether `full` is `base` or inside it. */
const within = (base: string, full: string): boolean => full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

/* ------------------------------------------------------------------ */
/* A folder as the directory                                           */
/* ------------------------------------------------------------------ */

export interface NodeFSOptions {
  /** Shown to the model (default "the folder <root>"). */
  description?: string;
  /** No write or delete. */
  readonly?: boolean;
  /** Folder names never listed or searched (default `.git`, `node_modules`). Files in them can still be read by path. */
  ignore?: string[];
}

/**
 * A folder on disk as an `AgentFS`: give it to a workspace as `dir` and the
 * agent works in that folder (`openWorkspace(provider, { dir: nodeFS(process.cwd()) })`).
 * Paths cannot leave the folder — neither by `..` nor through a symbolic
 * link pointing outside it.
 */
export function nodeFS(root: string, opts: NodeFSOptions = {}): AgentFS {
  const base = path.resolve(root);
  const ignore = new Set(opts.ignore ?? [".git", "node_modules"]);
  let realBase: Promise<string> | null = null;
  const abs = async (p: string): Promise<string> => {
    const full = path.join(base, normalizePath(p));
    if (!within(base, full)) throw new Error(`${p} is outside the folder`);
    // Where it really is: the nearest part of it that exists, with links resolved, must still be inside.
    realBase ??= fsp.realpath(base).catch(() => base);
    let probe = full;
    for (;;) {
      const real = await fsp.realpath(probe).catch(() => null);
      if (real) { if (!within(await realBase, real)) throw new Error(`${p} leads outside the folder`); break; }
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    return full;
  };
  const rel = (full: string): string => "/" + path.relative(base, full).split(path.sep).join("/");
  const statOf = async (full: string): Promise<FileStat | null> => {
    const st = await fsp.stat(full).catch(() => null);
    return st && st.isFile() ? { path: rel(full), size: st.size, mtime: st.mtimeMs, contentType: guessType(full, new Uint8Array()) } : null;
  };
  const fs: AgentFS = {
    description: opts.description ?? `the folder ${base}`,
    async list(prefix) {
      const full = await abs(prefix);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) return [];
      if (st.isFile()) return [(await statOf(full))!];
      const out: FileStat[] = [];
      for (const f of await walkFiles(full, ignore)) { const s = await statOf(f); if (s) out.push(s); }
      return out;
    },
    async stat(p) { return statOf(await abs(p)); },
    async read(p) {
      const buf = await fsp.readFile(await abs(p)).catch((err: NodeJS.ErrnoException) => {
        throw new Error(err.code === "ENOENT" ? `No such file: ${normalizePath(p)}` : err.message);
      });
      return contentOf(buf);
    },
  };
  if (!opts.readonly) {
    fs.write = async (p, content) => {
      const full = await abs(p);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content);
    };
    fs.delete = async (p) => {
      await fsp.rm(await abs(p)).catch((err: NodeJS.ErrnoException) => {
        throw new Error(err.code === "ENOENT" ? `No such file: ${normalizePath(p)}` : err.message);
      });
    };
  }
  return fs;
}

/* ------------------------------------------------------------------ */
/* The workspace's storage on disk                                     */
/* ------------------------------------------------------------------ */

/** A name safe as one path segment: nothing is left that a filesystem reads specially (`/`, `\`, `.` and `..`, `*`). */
const enc = (s: string): string => encodeURIComponent(s).replace(/[.*!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const dec = (s: string): string => decodeURIComponent(s);
/** JSON that keeps Uint8Arrays (meta values, session attachments). */
const toJSON = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { __u8: Buffer.from(x).toString("base64") } : x));
const fromJSON = <T,>(s: string): T => JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.__u8 === "string" ? new Uint8Array(Buffer.from(x.__u8, "base64")) : x)) as T;

async function readJSON<T>(file: string): Promise<T | undefined> {
  try { return fromJSON<T>(await fsp.readFile(file, "utf8")); } catch { return undefined; }
}
let tmpSeq = 0;
/** Written to a temporary file of its own and renamed, so a crash never leaves half a file and two writes never share one. */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${(tmpSeq++).toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
const notTmp = (name: string) => !name.endsWith(".tmp");

/**
 * The workspace's storage in a folder (default `~/.runapps-agent`): give it
 * to a workspace as `store` and its sessions, meta data and the user's
 * skills — and its files, when it has no `dir` — survive the process.
 * Meant for one process at a time per folder.
 *
 *     <root>/<app>/spaces/<directory id>/files/…   the directory's files
 *     <root>/<app>/spaces/<directory id>/meta/…    its meta data (JSON)
 *     <root>/<app>/sessions/<directory id>/<session id>.json
 *
 * (Names are percent-encoded, dots included.)
 */
export function nodeStore(root: string = path.join(os.homedir(), ".runapps-agent")): WorkspaceStoreFactory {
  const base = path.resolve(root);
  return {
    async open(dbName, space): Promise<WorkspaceStore> {
      const app = path.join(base, enc(dbName));
      const spaceDir = (s: string) => path.join(app, "spaces", enc(s));
      const filesDir = path.join(spaceDir(space), "files");
      const metaDir = path.join(spaceDir(space), "meta");
      const sessionsDir = path.join(app, "sessions");
      // Each segment encoded: a file named ".." or "a.b" is just a name here.
      const fileOf = (p: string) => path.join(filesDir, ...normalizePath(p).split("/").filter(Boolean).map(enc));
      const pathOf = (full: string) => "/" + path.relative(filesDir, full).split(path.sep).map(dec).join("/");
      const statOf = async (full: string): Promise<FileStat | null> => {
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isFile()) return null;
        const p = pathOf(full);
        return { path: p, size: st.size, mtime: st.mtimeMs, contentType: guessType(p, new Uint8Array()) };
      };
      const recordOf = async (full: string): Promise<FileRecord | undefined> => {
        const [buf, st] = await Promise.all([fsp.readFile(full).catch(() => null), statOf(full)]);
        if (!buf || !st) return undefined;
        const data = contentOf(buf);
        return { space, path: st.path, data, contentType: guessType(st.path, data), mtime: st.mtime ?? Date.now(), layer: "work" };
      };
      // Only the folder asked for is walked ("/a/" → files/a).
      const under = (prefix: string) => (prefix === "/" ? filesDir : fileOf(prefix));
      const filesUnder = async (prefix: string) => walkFiles(under(prefix), undefined, notTmp);
      const metaFile = (key: string) => path.join(metaDir, `${enc(key)}.json`);
      const metaKeys = async (): Promise<string[]> =>
        (await fsp.readdir(metaDir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).map((n) => dec(n.slice(0, -5)));
      const sessionFile = (s: string, id: string) => path.join(sessionsDir, enc(s), `${enc(id)}.json`);
      return {
        get: async (p) => recordOf(fileOf(p)),
        stat: async (p) => statOf(fileOf(p)),
        put: async (rec) => { await writeAtomic(fileOf(rec.path), rec.data); },
        delete: async (p) => { await fsp.rm(fileOf(p), { force: true }); },
        list: async (prefix) => {
          const out: FileRecord[] = [];
          for (const full of await filesUnder(prefix)) { const r = await recordOf(full); if (r) out.push(r); }
          return out;
        },
        listStats: async (prefix) => {
          const out: FileStat[] = [];
          for (const full of await filesUnder(prefix)) { const s = await statOf(full); if (s) out.push(s); }
          return out;
        },
        getMeta: async <T,>(key: string) => readJSON<T>(metaFile(key)),
        putMeta: async (key, value) => { await writeAtomic(metaFile(key), toJSON(value)); },
        deleteMeta: async (key) => { await fsp.rm(metaFile(key), { force: true }); },
        listMeta: async <T,>(prefix: string) => {
          const out: T[] = [];
          for (const k of await metaKeys()) if (k.startsWith(prefix)) { const v = await readJSON<T>(metaFile(k)); if (v !== undefined) out.push(v); }
          return out;
        },
        listMetaKeys: async (prefix) => (await metaKeys()).filter((k) => k.startsWith(prefix)),
        getSession: async (s, id) => readJSON<SessionData>(sessionFile(s, id)),
        putSession: async (data) => { await writeAtomic(sessionFile(data.space ?? space, data.id ?? "default"), toJSON({ ...data, space: data.space ?? space })); },
        deleteSession: async (s, id) => { await fsp.rm(sessionFile(s, id), { force: true }); },
        listSessions: async () => {
          const out: SessionData[] = [];
          for (const full of await walkFiles(sessionsDir, undefined, (n) => n.endsWith(".json"))) { const d = await readJSON<SessionData>(full); if (d) out.push(d); }
          return out;
        },
        clear: async (s = space) => {
          await fsp.rm(spaceDir(s), { recursive: true, force: true });
          await fsp.rm(path.join(sessionsDir, enc(s)), { recursive: true, force: true });
        },
        close: () => {},
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Reading lines                                                        */
/* ------------------------------------------------------------------ */

/** One reader of an input's lines: `ask` writes a prompt and resolves the next line (null once the input ends or `signal` aborts). */
export interface LineReader {
  ask(prompt: string, signal?: AbortSignal): Promise<string | null>;
  /** The readline interface underneath (its "SIGINT" event, its history). */
  readonly rl: Interface;
  close(): void;
}

const readers = new WeakMap<object, LineReader>();

/**
 * Lines of `input`, queued: a line that arrives while nobody asks (typed
 * ahead, or piped in) waits for the next question instead of being lost,
 * as it is with readline's own `question()`; questions asked at once are
 * answered in turn. One reader per input stream — a program's prompt loop
 * and `terminalUI` share it. The prompt goes through readline, so editing
 * the line keeps it on screen. A terminal is read all the time (Ctrl+C
 * reaches readline's "SIGINT" even while no question is open) but does not
 * keep the process alive between questions; a pipe is paused between them.
 */
export function lineReader(opts: { input?: Readable; output?: Writable & { isTTY?: boolean } } = {}): LineReader {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const known = readers.get(input);
  if (known) return known;
  const tty = !!(input as { isTTY?: boolean }).isTTY;
  const rl = createInterface({ input, output, terminal: tty });
  const queue: string[] = [];
  type Waiter = { prompt: string; done: (line: string | null) => void };
  const waiters: Waiter[] = [];
  let closed = false;
  const handle = input as unknown as { ref?: () => void; unref?: () => void };
  // Between questions: a terminal stays in flowing raw mode (so Ctrl+C is read) but stops holding the process; a pipe pauses.
  const idle = () => { rl.setPrompt(""); if (tty) handle.unref?.(); else rl.pause(); };
  const activate = () => {
    const w = waiters[0];
    if (!w) return idle();
    if (tty) handle.ref?.();
    rl.setPrompt(w.prompt);
    rl.prompt(true);   // writes the prompt and resumes reading
  };
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) { w.done(line); activate(); }
    else { queue.push(line); idle(); }
  });
  rl.on("close", () => {
    closed = true;
    readers.delete(input);
    for (const w of waiters.splice(0)) w.done(null);
  });
  idle();
  const reader: LineReader = {
    rl,
    ask(prompt, signal) {
      return new Promise((done) => {
        if (!waiters.length && queue.length) { output.write(prompt); return done(queue.shift()!); }
        if (closed || signal?.aborted) return done(null);
        const w: Waiter = { prompt, done };
        waiters.push(w);
        if (waiters.length === 1) activate();
        signal?.addEventListener("abort", () => {
          const i = waiters.indexOf(w);
          if (i < 0) return;
          waiters.splice(i, 1);
          if (i === 0) { output.write("\n"); activate(); }
          done(null);
        }, { once: true });
      });
    },
    close() { rl.close(); },
  };
  readers.set(input, reader);
  return reader;
}

/* ------------------------------------------------------------------ */
/* Dialogs in the terminal                                             */
/* ------------------------------------------------------------------ */

export interface TerminalUIOptions {
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
  /** A readline interface the app already has: questions go through its question(). Prefer `ask` with a `lineReader`. */
  rl?: Interface;
  /**
   * How a line is read, for an app with its own input loop: write `prompt`, resolve the line the
   * user typed, or null when `signal` aborts or the input ends. Default: `lineReader({ input, output }).ask`.
   */
  ask?: (prompt: string, signal?: AbortSignal) => Promise<string | null>;
}

/**
 * `AgentUI` in a terminal: confirmations as y/N, choices as a numbered
 * list, free text on a line (a blank line ends multi-line text). A
 * question whose run is stopped is dismissed.
 */
export function terminalUI(opts: TerminalUIOptions = {}): AgentUI {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const color = !!(output as { isTTY?: boolean }).isTTY;
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const write = (s: string) => { output.write(s); };
  const viaRl = opts.rl;
  const ask = opts.ask
    ?? (viaRl
      ? async (q: string, signal?: AbortSignal) => { try { return await viaRl.question(q, signal ? { signal } : {}); } catch { return null; } }
      : (q: string, signal?: AbortSignal) => lineReader({ input, output }).ask(q, signal));
  const head = (title: string, message?: string) => {
    write(`\n${paint("1", title)}\n`);
    if (message) write(`${paint("2", message)}\n`);
  };
  return {
    async confirm(title, message, o = {}) {
      head(title, message);
      const a = await ask(`${paint(o.danger ? "31" : "36", `${o.ok ?? "Yes"} / ${o.cancel ?? "No"}`)} [y/N] `, o.signal);
      return !!a && /^(y|yes|ok|是|好)$/i.test(a.trim());
    },
    async select(title, options: SelectOption[], o = {}) {
      head(title, o.message);
      options.forEach((opt, i) => write(`  ${paint("36", String(i + 1))}) ${opt.label ?? opt.value}${opt.description ? paint("2", ` — ${opt.description}`) : ""}\n`));
      const hint = o.multi ? "numbers, comma-separated" : "a number";
      for (;;) {
        const a = await ask(`${hint}${o.allowOther ? ", or type an answer" : ""}: `, o.signal);
        if (a === null || !a.trim()) return null;
        const picks = a.split(",").map((x) => x.trim()).filter(Boolean);
        const nums = picks.map((x) => Number(x));
        if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length) && (o.multi || nums.length === 1)) return nums.map((n) => options[n - 1]!.value);
        if (o.allowOther) return [a.trim()];
        write(paint("33", `Pick ${hint} from 1 to ${options.length}.\n`));
      }
    },
    async input(title, o = {}) {
      head(title, o.message);
      if (!o.multiline) {
        const a = await ask(`${o.placeholder ? paint("2", `(${o.placeholder}) `) : ""}> `, o.signal);
        return a === null ? null : a || o.initial || "";
      }
      write(paint("2", "(a blank line ends it)\n"));
      const lines: string[] = [];
      for (;;) {
        const a = await ask("> ", o.signal);
        if (a === null) return lines.length ? lines.join("\n") : null;
        if (!a.length) return lines.join("\n");
        lines.push(a);
      }
    },
    notify(message, level = "info") {
      write(`${level === "error" ? paint("31", "✗") : level === "warning" ? paint("33", "!") : paint("36", "i")} ${message}\n`);
    },
  };
}

/* ------------------------------------------------------------------ */
/* PDFs                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Reads PDFs with the pdfjs-dist package (`npm i pdfjs-dist`) instead of
 * the CDN copy a browser loads.
 */
export function nodePdf(): void {
  // Imported by name at run time, so neither TypeScript nor a bundler needs pdfjs-dist present.
  const load = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
  configurePdf({
    load: async () => {
      try { return (await load("pdfjs-dist/legacy/build/pdf.mjs")) as PdfLib; } catch (err) {
        throw new Error(`reading PDFs in Node needs the pdfjs-dist package (npm i pdfjs-dist): ${(err as Error).message}`);
      }
    },
  });
}
