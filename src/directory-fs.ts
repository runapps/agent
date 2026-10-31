// `directoryFS(handle)`: an `AgentFS` over a browser directory handle —
// a local folder the user picked with `showDirectoryPicker()` (Chromium),
// or the origin private file system (`navigator.storage.getDirectory()`).
// Used as a workspace's `dir`, the agent works directly in that folder.

import type { AgentFS, FileStat } from "./types.js";
import { decodeText, guessType, normalizePath } from "./workspace.js";

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|javascript|x-sh))/;

function segments(path: string): string[] {
  const p = normalizePath(path);
  return p === "/" ? [] : p.slice(1).split("/");
}

function notFound(path: string): Error {
  return new Error(`No such file: ${normalizePath(path)}`);
}

export function directoryFS(handle: FileSystemDirectoryHandle, opts: { description?: string; readonly?: boolean } = {}): AgentFS {
  const dir = async (segs: string[], create = false): Promise<FileSystemDirectoryHandle> => {
    let cur = handle;
    for (const s of segs) cur = await cur.getDirectoryHandle(s, { create });
    return cur;
  };
  const fileHandle = async (path: string, create = false): Promise<FileSystemFileHandle> => {
    const segs = segments(path);
    if (!segs.length) throw new Error(`${normalizePath(path)} is a folder, not a file`);
    const parent = await dir(segs.slice(0, -1), create);
    return parent.getFileHandle(segs[segs.length - 1]!, { create });
  };
  const statOf = async (path: string, h: FileSystemFileHandle): Promise<FileStat> => {
    const f = await h.getFile();
    return { path: normalizePath(path), size: f.size, contentType: f.type || guessType(path, new Uint8Array()), mtime: f.lastModified };
  };
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, out: FileStat[]): Promise<void> => {
    for await (const [name, entry] of d as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      const path = `${prefix}/${name}`;
      if (entry.kind === "directory") await walk(entry as FileSystemDirectoryHandle, path, out);
      else out.push(await statOf(path, entry as FileSystemFileHandle));
    }
  };

  const fs: AgentFS = {
    description: opts.description ?? `the local folder "${handle.name}"`,

    async list(prefix) {
      const out: FileStat[] = [];
      const segs = segments(prefix);
      let d: FileSystemDirectoryHandle;
      try {
        d = await dir(segs);
      } catch {
        // A file path lists itself; anything else is empty.
        try {
          const h = await fileHandle(prefix);
          return [await statOf(prefix, h)];
        } catch {
          return out;
        }
      }
      await walk(d, segs.length ? "/" + segs.join("/") : "", out);
      return out;
    },

    async stat(path) {
      try {
        return await statOf(path, await fileHandle(path));
      } catch {
        return null;
      }
    },

    async read(path) {
      let h: FileSystemFileHandle;
      try {
        h = await fileHandle(path);
      } catch {
        throw notFound(path);
      }
      const f = await h.getFile();
      const bytes = new Uint8Array(await f.arrayBuffer());
      const type = f.type || guessType(path, bytes);
      if (TEXT_TYPES.test(type) || type === "text/plain") {
        const text = decodeText(bytes);
        if (text !== null) return text;
      }
      return bytes;
    },
  };

  if (!opts.readonly) {
    fs.write = async (path, content) => {
      const h = await fileHandle(path, true);
      const w = await h.createWritable();
      try {
        await w.write(typeof content === "string" ? content : (content as unknown as ArrayBuffer));
      } finally {
        await w.close();
      }
    };
    fs.delete = async (path) => {
      const segs = segments(path);
      if (!segs.length) throw new Error("Cannot delete /");
      const parent = await dir(segs.slice(0, -1));
      try {
        await parent.removeEntry(segs[segs.length - 1]!, { recursive: true });
      } catch {
        throw notFound(path);
      }
    };
  }
  return fs;
}
