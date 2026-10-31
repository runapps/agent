// The built-in file tools over a Workspace: list, read (with line
// ranges), write, edit (exact replacement), delete, search. Their
// descriptions are what the model reads, so they say what each does and
// what comes back.

import type { TextEdit } from "./edit.js";
import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";
import { normalizePath, type Workspace } from "./workspace.js";
import { fileGuard, type FileGuard } from "./file-guard.js";

const MAX_LIST = 500;
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_SEARCH_HITS = 100;

export interface FileToolsOptions {
  /**
   * Refuse to overwrite or edit an existing file the model has not read in
   * this conversation (or, to overwrite it, read only in part), or that
   * changed since it last read it — by the user, the host or another
   * process — and tell it to read the file again (default true). A new
   * file can always be written.
   */
  readBeforeWrite?: boolean;
  /** The agent's guard, shared with run_js (made here when not given). */
  guard?: FileGuard;
}

export function fileTools(ws: Workspace, opts: FileToolsOptions = {}): Tool[] {
  const files = opts.guard ?? fileGuard(ws, { enabled: opts.readBeforeWrite !== false });
  const guard = files.enabled;

  return [
    defineTool<{ path?: string }>({
      name: "list_files",
      description:
        `List the files under a folder of the workspace (recursive), one per line with the size in bytes. Output is truncated to 500 entries. Start at / to see everything; ${ws.skillsDir} holds the skills.`,
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Folder to list. Default /" } },
        additionalProperties: false,
      },
      async execute({ path }) {
        const files = await ws.list(path || "/");
        if (!files.length) return `No files under ${normalizePath(path || "/")}.`;
        const lines = files.slice(0, MAX_LIST).map((f) => `${f.path}  (${f.size} B)`);
        if (files.length > MAX_LIST) lines.push(`\n[${MAX_LIST} entries limit reached (${files.length} in all). List a sub-folder.]`);
        return lines.join("\n");
      },
    }),

    defineTool<{ path: string; offset?: number; limit?: number }>({
      name: "read_file",
      description:
        "Read the contents of a text file in the workspace; a PDF is read as the text of its pages, each under a `--- page N ---` line. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files; when you need the full file, continue with offset until complete. Reading a folder lists it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path in the workspace" },
          offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed)" },
          limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute({ path, offset, limit }) {
        if (await ws.isFolder(path)) {
          const files = await ws.list(path);
          return `${normalizePath(path)} is a folder with ${files.length} file${files.length === 1 ? "" : "s"}:\n` +
            files.slice(0, MAX_LIST).map((f) => `${f.path}  (${f.size} B)`).join("\n");
        }
        let doc: { text: string; kind: "text" | "pdf" } | null;
        try {
          doc = await ws.readAsText(path);
        } catch (err) {
          const st = await ws.stat(path);
          if (st && /\.pdf$/i.test(path)) return `Could not read the PDF ${normalizePath(path)}: ${(err as Error).message}`;
          throw err;
        }
        if (!doc) {
          await files.saw(normalizePath(path));
          const st = await ws.stat(path);
          return `${normalizePath(path)} is a binary file (${st?.contentType ?? "unknown type"}, ${st?.size ?? 0} bytes).`;
        }
        const text = doc.text;
        const lines = text.split("\n");
        const total = lines.length;
        const start = Math.max(1, offset ?? 1);
        if (start > total) { await files.saw(normalizePath(path), { start: total + 1, end: total, total }); return `Offset ${start} is beyond end of file (${total} lines total)`; }
        const want = limit !== undefined ? Math.min(limit, MAX_READ_LINES) : MAX_READ_LINES;
        const out: string[] = [];
        let bytes = 0;
        let end = start - 1;
        for (let i = start - 1; i < total && out.length < want; i++) {
          const b = new TextEncoder().encode(lines[i]!).byteLength + 1;
          if (bytes + b > MAX_READ_BYTES && out.length > 0) break;
          out.push(lines[i]!);
          bytes += b;
          end = i + 1;
        }
        // What it has now seen of the file (a PDF's text is not its content: no fingerprint from it).
        await files.saw(normalizePath(path), { start, end, total, text: doc.kind === "text" ? text : undefined });
        let notice = "";
        if (end < total) {
          const next = end + 1;
          if (bytes >= MAX_READ_BYTES || (limit === undefined && out.length >= MAX_READ_LINES)) notice = `\n\n[Showing lines ${start}-${end} of ${total}${bytes >= MAX_READ_BYTES ? " (50.0KB limit)" : ""}. Use offset=${next} to continue.]`;
          else notice = `\n\n[${total - end} more lines in file. Use offset=${next} to continue.]`;
        }
        return out.join("\n") + notice;
      },
    }),

    defineTool<{ path: string; content: string }>({
      name: "write_file",
      description:
        "Create or overwrite a text file in the workspace with the given content. Folders are implied by the path. Prefer edit_file for small changes to an existing file." +
        (guard ? " To overwrite an existing file, read it with read_file first; if it changed since you read it, read it again." : ""),
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute({ path, content }) {
        const p = normalizePath(path);
        const existed = await ws.exists(p);
        if (existed) await files.check(p, "overwrite");
        await ws.write(p, content);
        await files.wrote(p);
        return `${existed ? "Updated" : "Created"} ${p} (${new TextEncoder().encode(content).byteLength} bytes).`;
      },
    }),

    defineTool<{ path: string; edits?: TextEdit[]; oldText?: string; newText?: string }>({
      name: "edit_file",
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes." +
        (guard ? " Read the file with read_file before editing it; if it changed since you read it (the user may edit files while you work), read it again." : ""),
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path in the workspace" },
          edits: {
            type: "array",
            minItems: 1,
            description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Exact text for one targeted replacement. It must be unique in the original file." },
                newText: { type: "string", description: "Replacement text for this targeted edit." },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
          oldText: { type: "string", description: "Shorthand for a single edit" },
          newText: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      guidelines: [
        "Use edit_file for precise changes (oldText must match exactly); when changing several places in one file, use one edit_file call with several entries in edits[].",
        "Keep oldText as small as possible while still being unique in the file.",
      ],
      async execute(args) {
        const p = normalizePath(args.path);
        // The schema allows `edits` (an array) and the `oldText`/`newText` shorthand; nothing else gets this far.
        const edits: TextEdit[] = Array.isArray(args.edits) ? [...args.edits] : [];
        if (args.oldText !== undefined) edits.push({ oldText: args.oldText, newText: args.newText ?? "" });
        await files.check(p, "edit");
        // The workspace applies them: a mount with its own edit() gets them as they are, anything else is read, edited and written back.
        await ws.edit(p, edits);
        await files.edited(p);
        return `Successfully replaced ${edits.length} block(s) in ${p}.`;
      },
    }),

    defineTool<{ path: string }>({
      name: "delete_file",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      destructive: true,
      confirm: ({ path }) => `Delete ${normalizePath(path)}?`,
      async execute({ path }) {
        const p = normalizePath(path);
        await files.check(p, "delete");
        await ws.delete(p);
        files.forget(p);
        return `Deleted ${p}.`;
      },
    }),

    defineTool<{ query: string; path?: string; regex?: boolean }>({
      name: "search_files",
      description:
        "Search the text files of the workspace for a pattern (a literal string, or a regular expression with regex: true). Returns matching lines as path:line: text, at most 100; long lines are cut to 200 chars.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string", description: "Folder to search. Default /" },
          regex: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute({ query, path, regex }, ctx) {
        let re: RegExp;
        try {
          re = regex ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch (e) {
          throw new Error(`Invalid regular expression: ${(e as Error).message}`);
        }
        const hits: string[] = [];
        let scanned = 0;
        for (const f of await ws.list(path || "/")) {
          ctx.signal.throwIfAborted();
          if (f.size > 2_000_000) continue;
          let text: string;
          try {
            text = await ws.readText(f.path);
          } catch {
            continue;
          }
          scanned++;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
            if (re.test(lines[i]!)) hits.push(`${f.path}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
          if (hits.length >= MAX_SEARCH_HITS) break;
        }
        if (!hits.length) return `No matches found (${scanned} text files searched).`;
        return hits.join("\n") + (hits.length >= MAX_SEARCH_HITS ? `\n\n[${MAX_SEARCH_HITS} matches limit reached. Refine the pattern or search a sub-folder.]` : "");
      },
    }),
  ];
}
