// The chat's file manager: the session's directory as a tree (folders
// fold, files open), an editor for text files (save with ⌘S), a preview
// for pictures, download for anything, upload (picker or drop) and
// delete. Modelled on the harness app's sidebar + editor pane, in one
// panel beside the transcript.

import type { Workspace } from "./workspace.js";
import type { FileStat } from "./types.js";
import { h, I, modalConfirm, modalInput, downloadBlob } from "./dom.js";

export interface FilesStrings {
  files: string; upload: string; newFile: string; refresh: string; close: string; save: string; download: string; delete: string; cancel: string; ok: string;
  confirmDeleteFile: string; newFilePath: string; noPreview: string; changedByAgent: string; noFiles: string; discard: string; saved: string; pickFile: string; folder: string;
}

export interface FilesPanelOptions {
  t: FilesStrings;
  /** The element dialogs are placed over. */
  root: HTMLElement;
  /** Where the editor goes when a file is open: it covers this element (the transcript and composer) until closed. */
  editorHost: HTMLElement;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /** Called after the panel changed the directory (a save, upload or delete). */
  onChange?: () => void;
}

export interface FilesPanel {
  readonly el: HTMLElement;
  readonly visible: boolean;
  /** Shows the panel; with a path, opens that file. */
  open(path?: string): Promise<void>;
  close(): Promise<void>;
  toggle(): Promise<void>;
  setWorkspace(ws: Workspace | null): void;
  refresh(): Promise<void>;
  /** The agent wrote or deleted a path: marks it and reloads it if open. */
  changed(path: string): void;
  download(path: string): Promise<void>;
  dispose(): void;
}

interface Node { name: string; path: string; folder: boolean; stat?: FileStat; children: Node[] }

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

function buildTree(files: FileStat[]): Node {
  const root: Node = { name: "", path: "/", folder: true, children: [] };
  const folders = new Map<string, Node>([["/", root]]);
  const folderOf = (path: string): Node => {
    let f = folders.get(path);
    if (f) return f;
    const parent = folderOf(dirname(path));
    f = { name: basename(path), path, folder: true, children: [] };
    parent.children.push(f);
    folders.set(path, f);
    return f;
  };
  for (const s of files) folderOf(dirname(s.path)).children.push({ name: basename(s.path), path: s.path, folder: false, stat: s, children: [] });
  const sort = (n: Node) => { n.children.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)); n.children.forEach(sort); };
  sort(root);
  return root;
}

/** A free path for `name` in `dir` (`-2`, `-3`… when taken). */
export async function freePath(ws: Workspace, dir: string, name: string): Promise<string> {
  const base = dir === "/" ? "" : dir;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const p = `${base}/${i === 1 ? name : `${stem}-${i}${ext}`}`;
    if (!(await ws.exists(p))) return p;
  }
  return `${base}/${Date.now()}-${name}`;
}

export function filesPanel(opts: FilesPanelOptions): FilesPanel {
  const { t, root, notify, editorHost } = opts;
  let ws: Workspace | null = null;
  let visible = false;
  let active: string | null = null;
  let draft: string | null = null;
  let loaded: string | null = null;
  let previewURL: string | null = null;
  let selectedDir = "/";
  const collapsed = new Set<string>(["/.agent"]);
  const changedPaths = new Set<string>();
  let disposed = false;

  const el = h("aside", "ra-fp");
  el.style.display = "none";
  const head = h("div", "ra-fph");
  const title = h("span", "ra-fpt", t.files);
  const ibtn = (icon: string, label: string, onClick: () => void) => { const b = h("button", "ra-ib"); b.type = "button"; b.innerHTML = icon; b.title = label; b.setAttribute("aria-label", label); b.addEventListener("click", onClick); return b; };
  const fileInput = h("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.style.display = "none";
  const uploadBtn = ibtn(I.upload(), t.upload, () => fileInput.click());
  const newBtn = ibtn(I.filePlus(14), t.newFile, () => void newFile());
  const refreshBtn = ibtn(I.refresh(), t.refresh, () => void refresh());
  const closeBtn = ibtn(I.x(14), t.close, () => void close());
  head.append(title, h("span", "ra-sp"), uploadBtn, newBtn, refreshBtn, closeBtn);
  const tree = h("div", "ra-tree");
  const editor = h("div", "ra-ed"); editor.style.display = "none";
  const edHead = h("div", "ra-edh");
  const edPath = h("span", "ra-edp");
  const edActs = h("div", "ra-eda");
  const saveBtn = h("button", "ra-btn xs solid"); saveBtn.type = "button"; saveBtn.innerHTML = I.save() + t.save; saveBtn.style.display = "none"; saveBtn.addEventListener("click", () => void save());
  const dlBtn = ibtn(I.download(), t.download, () => { if (active) void download(active); });
  const delBtn = ibtn(I.trash(), t.delete, () => { if (active) void remove(active); });
  const edClose = ibtn(I.x(14), t.close, () => void closeFile());
  edActs.append(saveBtn, dlBtn, delBtn, edClose);
  edHead.append(edPath, edActs);
  const edBody = h("div", "ra-edb");
  const ta = h("textarea", "ra-edta"); ta.spellcheck = false; ta.setAttribute("aria-label", t.files);
  const preview = h("div", "ra-edpv");
  edBody.append(ta, preview);
  editor.append(edHead, edBody);
  const drop = h("div", "ra-fpdrop", t.upload);
  el.append(head, tree, fileInput, drop);
  editorHost.append(editor);

  const setDraft = (v: string | null) => { draft = v; saveBtn.style.display = v === null ? "none" : ""; };
  ta.addEventListener("input", () => setDraft(ta.value === loaded ? null : ta.value));
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); }
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText("  ", s, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
  });

  const confirmDiscard = async (): Promise<boolean> => draft === null || modalConfirm(root, t.discard, "", { ok: t.ok, cancel: t.cancel, danger: true });

  const render = (node: Node, depth: number, frag: DocumentFragment) => {
    for (const c of node.children) {
      const row = h("div", "ra-fr" + (c.path === active ? " ra-cur" : ""));
      row.style.paddingLeft = `${depth * 14 + 6}px`;
      row.dataset.path = c.path;
      const open = c.folder && !collapsed.has(c.path);
      const chev = h("span", "ra-frc");
      chev.innerHTML = c.folder ? (open ? I.chevDown() : I.chev(12)) : "";
      const icon = h("span", "ra-fri");
      icon.innerHTML = c.folder ? (open ? I.folderOpen() : I.folder()) : I.file();
      const name = h("span", "ra-frn", c.name); name.title = c.path;
      row.append(chev, icon, name);
      if (changedPaths.has(c.path)) { const dot = h("span", "ra-dot"); dot.title = t.changedByAgent; row.append(dot); }
      const acts = h("span", "ra-fra");
      if (!c.folder) acts.append(ibtn(I.download(13), t.download, () => void download(c.path)));
      acts.append(ibtn(I.trash(12), t.delete, () => void remove(c.path)));
      row.append(acts);
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".ra-fra")) return;
        if (c.folder) { selectedDir = c.path; if (!collapsed.delete(c.path)) collapsed.add(c.path); void refresh(); }
        else { selectedDir = dirname(c.path); void openFile(c.path); }
      });
      frag.append(row);
      if (c.folder && open) render(c, depth + 1, frag);
    }
  };

  const refresh = async () => {
    if (!ws || !visible || disposed) return;
    const frag = document.createDocumentFragment();
    try {
      const files = await ws.list("/");
      if (!files.length) frag.append(h("div", "ra-fpe", t.noFiles));
      else render(buildTree(files), 0, frag);
    } catch (err) { frag.append(h("div", "ra-fpe", (err as Error).message)); }
    if (disposed) return;
    tree.replaceChildren(frag);
  };

  const showEditor = (on: boolean) => { editor.style.display = on ? "" : "none"; root.classList.toggle("ra-editing", on); };

  const openFile = async (path: string) => {
    if (!ws) return;
    if (path !== active && !(await confirmDiscard())) return;
    active = path;
    changedPaths.delete(path);
    setDraft(null);
    edPath.textContent = path;
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
    preview.replaceChildren();
    showEditor(true);
    try {
      const r = await ws.read(path);
      if (active !== path) return;
      const image = IMAGE_RE.test(path) || /^image\//.test(r.contentType ?? "");
      let text: string | null = null;
      if (!image) {
        if (typeof r.data === "string") text = r.data;
        else { try { text = new TextDecoder("utf-8", { fatal: true }).decode(r.data); } catch { text = null; } }
      }
      if (text !== null) {
        loaded = text; ta.value = text; ta.style.display = ""; preview.style.display = "none"; ta.readOnly = false;
      } else {
        loaded = null; ta.style.display = "none"; preview.style.display = "";
        if (image) {
          const blob = new Blob([r.data as BlobPart], { type: r.contentType || "image/*" });
          previewURL = URL.createObjectURL(blob);
          const img = h("img"); img.src = previewURL; img.alt = basename(path);
          preview.append(img);
        } else preview.append(h("div", "ra-fpe", t.noPreview));
        preview.append(h("div", "ra-fpe", `${r.size} B`));
      }
    } catch (err) {
      loaded = null; ta.style.display = "none"; preview.style.display = "";
      preview.replaceChildren(h("div", "ra-fpe", (err as Error).message));
    }
    await refresh();
  };

  const closeFile = async (): Promise<boolean> => {
    if (!active) return true;
    if (!(await confirmDiscard())) return false;
    active = null; loaded = null; setDraft(null);
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
    showEditor(false);
    await refresh();
    return true;
  };

  const save = async () => {
    if (!ws || !active || draft === null) return;
    const path = active, text = draft;
    try {
      await ws.write(path, text);
      loaded = text; setDraft(null);
      notify(`${t.saved}: ${path}`);
      opts.onChange?.();
    } catch (err) { notify((err as Error).message, "error"); }
  };

  const download = async (path: string) => {
    if (!ws) return;
    try {
      const r = await ws.read(path);
      downloadBlob(basename(path), r.data, r.contentType);
    } catch (err) { notify((err as Error).message, "error"); }
  };

  const remove = async (path: string) => {
    if (!ws) return;
    if (!(await modalConfirm(root, t.delete, t.confirmDeleteFile.replace("{path}", path), { ok: t.delete, cancel: t.cancel, danger: true }))) return;
    try {
      if (await ws.isFolder(path)) { for (const f of await ws.list(path)) if (f.path !== path) await ws.delete(f.path); }
      else await ws.delete(path);
      if (active === path || (active && active.startsWith(path + "/"))) { active = null; loaded = null; setDraft(null); showEditor(false); }
      opts.onChange?.();
      await refresh();
    } catch (err) { notify((err as Error).message, "error"); }
  };

  const newFile = async () => {
    if (!ws) return;
    const base = selectedDir === "/" ? "/" : selectedDir + "/";
    const p = await modalInput(root, t.newFilePath, { ok: t.ok, cancel: t.cancel, initial: `${base}untitled.md` });
    if (!p) return;
    const path = "/" + p.replace(/^\/+/, "");
    try {
      if (!(await ws.exists(path))) await ws.write(path, "");
      opts.onChange?.();
      await refresh();
      await openFile(path);
      ta.focus();
    } catch (err) { notify((err as Error).message, "error"); }
  };

  const upload = async (list: ArrayLike<File> | null | undefined) => {
    if (!ws || !list?.length) return;
    let last: string | null = null;
    for (const file of Array.from(list)) {
      try {
        const path = await freePath(ws, selectedDir, basename(file.name.replace(/\\/g, "/")) || "file");
        await ws.write(path, new Uint8Array(await file.arrayBuffer()), file.type || undefined);
        last = path;
      } catch (err) { notify((err as Error).message, "error"); }
    }
    opts.onChange?.();
    await refresh();
    if (last && list.length === 1) await openFile(last);
  };
  fileInput.addEventListener("change", () => { void upload(fileInput.files); fileInput.value = ""; });
  let dragDepth = 0;
  el.addEventListener("dragenter", (e) => { if (!e.dataTransfer?.types.includes("Files")) return; e.preventDefault(); e.stopPropagation(); dragDepth++; el.dataset.drop = "1"; });
  el.addEventListener("dragover", (e) => { if (el.dataset.drop) { e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = "copy"; } });
  el.addEventListener("dragleave", (e) => { if (el.dataset.drop) { e.stopPropagation(); if (--dragDepth <= 0) { dragDepth = 0; delete el.dataset.drop; } } });
  el.addEventListener("drop", (e) => { if (!el.dataset.drop) return; e.preventDefault(); e.stopPropagation(); dragDepth = 0; delete el.dataset.drop; void upload(e.dataTransfer?.files); });

  const open = async (path?: string) => {
    visible = true;
    el.style.display = "";
    root.classList.add("ra-files-open");
    await refresh();
    if (path) await openFile(path);
  };
  /** Hides the tree and closes the open file with it (unsaved changes are asked about; declining keeps both open). */
  const close = async (): Promise<void> => {
    if (!(await closeFile())) return;
    visible = false;
    el.style.display = "none";
    root.classList.remove("ra-files-open");
  };

  return {
    el,
    get visible() { return visible; },
    open,
    close,
    toggle: () => (visible ? close() : open()),
    setWorkspace(next) {
      ws = next;
      active = null; loaded = null; setDraft(null); showEditor(false); changedPaths.clear(); selectedDir = "/";
      if (!next) { visible = false; el.style.display = "none"; root.classList.remove("ra-files-open"); } else void refresh();
    },
    refresh,
    changed(path) {
      changedPaths.add(path);
      if (path === active && draft === null) void openFile(path);
      else void refresh();
    },
    download,
    dispose() {
      disposed = true;
      if (previewURL) URL.revokeObjectURL(previewURL);
      el.remove();
      editor.remove();
      root.classList.remove("ra-editing");
    },
  };
}
