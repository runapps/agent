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
/* A folder as the directory                                           */
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
 * Paths cannot leave the folder.
 */
export function nodeFS(root: string, opts: NodeFSOptions = {}): AgentFS {
  const base = path.resolve(root);
  const ignore = new Set(opts.ignore ?? [".git", "node_modules"]);
  const abs = (p: string): string => {
    const full = path.join(base, normalizePath(p));
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`${p} is outside the folder`);
    return full;
  };
  const rel = (full: string): string => "/" + path.relative(base, full).split(path.sep).join("/");
  const statOf = async (full: string): Promise<FileStat | null> => {
    const st = await fsp.stat(full).catch(() => null);
    return st && st.isFile() ? { path: rel(full), size: st.size, mtime: st.mtimeMs, contentType: guessType(full, new Uint8Array()) } : null;
  };
  const walk = async (dir: string, out: FileStat[]): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!ignore.has(e.name)) await walk(full, out); }
      else if (e.isFile()) { const s = await statOf(full); if (s) out.push(s); }
    }
  };
  const fs: AgentFS = {
    description: opts.description ?? `the folder ${base}`,
    async list(prefix) {
      const full = abs(prefix);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) return [];
      if (st.isFile()) return [(await statOf(full))!];
      const out: FileStat[] = [];
      await walk(full, out);
      return out;
    },
    async stat(p) { return statOf(abs(p)); },
    async read(p) {
      const buf = await fsp.readFile(abs(p)).catch((err: NodeJS.ErrnoException) => {
        throw new Error(err.code === "ENOENT" ? `No such file: ${normalizePath(p)}` : err.message);
      });
      return contentOf(buf);
    },
  };
  if (!opts.readonly) {
    fs.write = async (p, content) => {
      const full = abs(p);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content);
    };
    fs.delete = async (p) => { await fsp.rm(abs(p), { force: false }); };
  }
  return fs;
}

/* ------------------------------------------------------------------ */
/* The workspace's storage on disk                                     */
/* ------------------------------------------------------------------ */

const enc = (s: string): string => encodeURIComponent(s).replace(/\*/g, "%2A");
const dec = (s: string): string => decodeURIComponent(s);
/** JSON that keeps Uint8Arrays (meta values, session attachments). */
const toJSON = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { __u8: Buffer.from(x).toString("base64") } : x));
const fromJSON = <T,>(s: string): T => JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.__u8 === "string" ? new Uint8Array(Buffer.from(x.__u8, "base64")) : x)) as T;

async function readJSON<T>(file: string): Promise<T | undefined> {
  try { return fromJSON<T>(await fsp.readFile(file, "utf8")); } catch { return undefined; }
}
/** Written to a temporary file and renamed, so a crash never leaves half a file. */
async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

/**
 * The workspace's storage in a folder (default `~/.runapps-agent`): give it
 * to a workspace as `store` and its sessions, meta data and the user's
 * skills — and its files, when it has no `dir` — survive the process.
 *
 *     <root>/<app>/spaces/<directory id>/files/…   the directory's files
 *     <root>/<app>/spaces/<directory id>/meta/…    its meta data (JSON)
 *     <root>/<app>/sessions/<directory id>/<session id>.json
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
      const fileOf = (p: string) => path.join(filesDir, ...normalizePath(p).split("/").filter(Boolean));
      const recordOf = async (full: string): Promise<FileRecord | undefined> => {
        const [buf, st] = await Promise.all([fsp.readFile(full).catch(() => null), fsp.stat(full).catch(() => null)]);
        if (!buf || !st) return undefined;
        const p = "/" + path.relative(filesDir, full).split(path.sep).join("/");
        const data = contentOf(buf);
        return { space, path: p, data, contentType: guessType(p, data), mtime: st.mtimeMs, layer: "work" };
      };
      const metaFile = (key: string) => path.join(metaDir, `${enc(key)}.json`);
      const metaKeys = async (): Promise<string[]> =>
        (await fsp.readdir(metaDir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).map((n) => dec(n.slice(0, -5)));
      const sessionFile = (s: string, id: string) => path.join(sessionsDir, enc(s), `${enc(id)}.json`);
      return {
        get: async (p) => recordOf(fileOf(p)),
        put: async (rec) => { await writeAtomic(fileOf(rec.path), rec.data); },
        delete: async (p) => { await fsp.rm(fileOf(p), { force: true }); },
        list: async (prefix) => {
          const out: FileRecord[] = [];
          for (const full of await filesUnder(filesDir)) {
            const r = await recordOf(full);
            if (r && (prefix === "/" || r.path.startsWith(prefix))) out.push(r);
          }
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
          for (const full of await filesUnder(sessionsDir)) if (full.endsWith(".json")) { const d = await readJSON<SessionData>(full); if (d) out.push(d); }
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
/* Dialogs in the terminal                                             */
/* ------------------------------------------------------------------ */

export interface TerminalUIOptions {
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
  /** A readline interface the app already has (questions go through it instead of a new one each time). */
  rl?: Interface;
  /**
   * How a line is read, for an app with its own input loop: write `prompt`, resolve the line the
   * user typed, or null when `signal` aborts or the input ends. Takes over from `input`/`rl`.
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
  const ask = async (q: string, signal?: AbortSignal): Promise<string | null> => {
    if (opts.ask) return opts.ask(q, signal);
    const rl = opts.rl ?? createInterface({ input, output, terminal: color });
    try {
      return await rl.question(q, signal ? { signal } : {});
    } catch {
      return null;   // aborted (the run was stopped) or the input closed
    } finally {
      if (!opts.rl) rl.close();
    }
  };
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
