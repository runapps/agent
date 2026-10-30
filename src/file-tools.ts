// The built-in file tools over a Workspace: list, read (with line
// ranges), write, edit (exact replacement), delete, search. Their
// descriptions are what the model reads, so they say what each does and
// what comes back.

import { applyEdits, type TextEdit } from "./edit.js";
import { defineTool } from "./tool.js";
import type { Tool } from "./types.js";
import { decodeText, normalizePath, type Workspace } from "./workspace.js";

const MAX_LIST = 500;
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_SEARCH_HITS = 100;

export function fileTools(ws: Workspace): Tool[] {
  return [
    defineTool<{ path?: string }>({
      name: "list_files",
      description:
        "List the files under a folder of the workspace (recursive), one per line with the size in bytes. Output is truncated to 500 entries. Start at / to see everything; /skills holds the skills.",
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
        "Read the contents of a text file in the workspace. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files; when you need the full file, continue with offset until complete. Reading a folder lists it.",
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
        const { data, size, contentType } = await ws.read(path);
        let text: string;
        if (typeof data === "string") text = data;
        else {
          const t = decodeText(data);
          if (t === null) return `${normalizePath(path)} is a binary file (${contentType ?? "unknown type"}, ${size} bytes).`;
          text = t;
        }
        const lines = text.split("\n");
        const total = lines.length;
        const start = Math.max(1, offset ?? 1);
        if (start > total) return `Offset ${start} is beyond end of file (${total} lines total)`;
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
        "Create or overwrite a text file in the workspace with the given content. Folders are implied by the path. Prefer edit_file for small changes to an existing file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute({ path, content }) {
        const existed = await ws.exists(path);
        await ws.write(path, content);
        return `${existed ? "Updated" : "Created"} ${normalizePath(path)} (${new TextEncoder().encode(content).byteLength} bytes).`;
      },
    }),

    defineTool<{ path: string; edits?: TextEdit[] | string; oldText?: string; newText?: string; old_text?: string; new_text?: string }>({
      name: "edit_file",
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
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
        let edits: TextEdit[] = [];
        if (typeof args.edits === "string") {
          try { edits = JSON.parse(args.edits) as TextEdit[]; } catch { throw new Error("Edit tool input is invalid. edits must be an array of {oldText, newText}."); }
        } else if (Array.isArray(args.edits)) edits = args.edits;
        else if (args.edits && typeof args.edits === "object") edits = [args.edits as unknown as TextEdit];
        const single = args.oldText ?? args.old_text;
        if (single !== undefined) edits.push({ oldText: single, newText: args.newText ?? args.new_text ?? "" });
        const text = await ws.readText(p);
        const next = applyEdits(p, text, edits);
        await ws.write(p, next);
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
        await ws.delete(path);
        return `Deleted ${normalizePath(path)}.`;
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
