// The chat's file manager: the session's directory as a tree (folders
// fold, files open), an editor for text files (save with ⌘S), a preview
// for pictures, download for anything, upload (picker or drop) and
// delete. Modelled on the harness app's sidebar + editor pane, in one
// panel beside the transcript.

import type { Workspace } from "./workspace.js";
import type { FileStat } from "./types.js";
import { h, I, modalConfirm, modalInput, downloadBlob, renderMD } from "./dom.js";
import { buildZip } from "./zip.js";

export interface FilesStrings {
  files: string; upload: string; newFile: string; refresh: string; close: string; save: string; download: string; delete: string; cancel: string; ok: string;
  confirmDeleteFile: string; newFilePath: string; noPreview: string; changedByAgent: string; noFiles: string; discard: string; saved: string; pickFile: string; folder: string; downloadZip: string; zipping: string; wrap: string; preview: string; edit: string; tooBig: string; conflict: string; readOnly: string; autoSaved: string;
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
  let offChange: (() => void) | null = null;
  let gen = 0;
  let lastFiles: FileStat[] | null = null;
  const MAX_EDIT = 2 * 1024 * 1024;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Many writes in a burst (a skills zip unpacking, a folder delete) redraw once. */
  const scheduleRefresh = () => { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 150); };
  const changedPaths = new Set<string>();
  let disposed = false;

  const el = h("div", "ra-fp"); el.setAttribute("role", "complementary");
  el.style.display = "none";
  const head = h("div", "ra-fph");
  const title = h("span", "ra-fpt", t.files);
  const ibtn = (icon: string, label: string, onClick: () => void) => { const b = h("button", "ra-ib"); b.type = "button"; b.innerHTML = icon; b.title = label; b.setAttribute("aria-label", label); b.addEventListener("click", onClick); return b; };
  const fileInput = h("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.style.display = "none";
  const uploadBtn = ibtn(I.upload(), t.upload, () => fileInput.click());
  const zipBtn = ibtn(I.download(), t.downloadZip, () => void downloadFolder("/"));
  const newBtn = ibtn(I.filePlus(14), t.newFile, () => void newFile());
  const refreshBtn = ibtn(I.refresh(), t.refresh, () => void refresh());
  const closeBtn = ibtn(I.x(14), t.close, () => void close());
  head.append(title, h("span", "ra-sp"), zipBtn, uploadBtn, newBtn, refreshBtn, closeBtn);
  const tree = h("div", "ra-tree");
  const editor = h("div", "ra-ed"); editor.style.display = "none";
  const edHead = h("div", "ra-edh");
  const edPath = h("span", "ra-edp");
  const edActs = h("div", "ra-eda");
  const saveBtn = h("button", "ra-btn xs solid"); saveBtn.type = "button"; saveBtn.innerHTML = I.save() + t.save; saveBtn.style.display = "none"; saveBtn.addEventListener("click", () => void save());
  // Word wrap (remembered) and a Markdown preview rendered by the same renderer as the chat's replies.
  const WRAP_KEY = "__runapps_agent_files:wrap";
  let wrap = (() => { try { return localStorage.getItem(WRAP_KEY) !== "0"; } catch { return true; } })();
  let previewing = false;
  const wrapBtn = ibtn(I.wrap(), t.wrap, () => { wrap = !wrap; try { localStorage.setItem(WRAP_KEY, wrap ? "1" : "0"); } catch { /* private mode */ } applyWrap(); });
  const mdBtn = ibtn(I.eye(), t.preview, () => { previewing = !previewing; applyView(); });
  const md = h("div", "ra-md ra-edmd"); md.style.display = "none";
  md.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    const href = a?.getAttribute("href") ?? "";
    if (!a || !href.startsWith("/") || href.startsWith("//") || !ws) return;
    e.preventDefault();
    const target = ws;
    void target.exists(href).then((ok) => { if (ok && target === ws) void openFile(href); });
  });
  const applyWrap = () => { ta.classList.toggle("ra-wrap", wrap); wrapBtn.classList.toggle("on", wrap); };
  const isMarkdown = (path: string | null) => !!path && /\.(md|markdown|mdx)$/i.test(path);
  const applyView = () => {
    const text = loaded !== null;
    mdBtn.style.display = text && isMarkdown(active) ? "" : "none";
    if (!text || !isMarkdown(active)) previewing = false;
    mdBtn.innerHTML = previewing ? I.pen() : I.eye(); mdBtn.title = previewing ? t.edit : t.preview; mdBtn.setAttribute("aria-label", mdBtn.title); mdBtn.classList.toggle("on", previewing);
    if (previewing) renderMD(md, draft ?? ta.value, false);
    md.style.display = previewing ? "" : "none";
    ta.style.display = text && !previewing ? "" : "none";
  };
  const dlBtn = ibtn(I.download(), t.download, () => { if (active) void download(active); });
  const delBtn = ibtn(I.trash(), t.delete, () => { if (active) void remove(active); });
  const edClose = ibtn(I.x(14), t.close, () => void closeFile());
  edActs.append(saveBtn, wrapBtn, mdBtn, dlBtn, delBtn, edClose);
  edHead.append(edPath, edActs);
  const edBody = h("div", "ra-edb");
  const ta = h("textarea", "ra-edta"); ta.spellcheck = false; ta.setAttribute("aria-label", t.files);
  const preview = h("div", "ra-edpv");
  edBody.append(ta, md, preview);
  applyWrap();
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
      acts.append(c.folder ? ibtn(I.download(13), t.downloadZip, () => void downloadFolder(c.path)) : ibtn(I.download(13), t.download, () => void download(c.path)));
      acts.append(ibtn(I.trash(12), t.delete, () => void remove(c.path)));
      row.append(acts);
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".ra-fra")) return;
        if (c.folder) { selectedDir = c.path; if (!collapsed.delete(c.path)) collapsed.add(c.path); draw(); }
        else { selectedDir = dirname(c.path); void openFile(c.path); }
      });
      frag.append(row);
      if (c.folder && open) render(c, depth + 1, frag);
    }
  };

  /** Draws the tree from the last listing (folding and highlighting need no new listing). */
  const draw = () => {
    if (!lastFiles) return;
    const frag = document.createDocumentFragment();
    if (!lastFiles.length) frag.append(h("div", "ra-fpe", t.noFiles));
    else render(buildTree(lastFiles), 0, frag);
    tree.replaceChildren(frag);
  };
  /** Lists the directory again; an answer that arrives after a newer request (or another workspace) is dropped. */
  const refresh = async () => {
    if (!ws || !visible || disposed) return;
    const mine = ++gen, target = ws;
    try {
      const files = await target.list("/");
      if (mine !== gen || target !== ws || disposed) return;
      lastFiles = files;
      draw();
    } catch (err) {
      if (mine !== gen || disposed) return;
      tree.replaceChildren(h("div", "ra-fpe", (err as Error).message));
    }
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
      if (text !== null && r.size > MAX_EDIT) text = null;
      const readOnly = ws.isReadOnly(path);
      delBtn.style.display = readOnly ? "none" : "";
      if (text !== null) {
        loaded = text; ta.value = text; preview.style.display = "none"; ta.readOnly = readOnly;
        ta.title = readOnly ? t.readOnly : "";
        applyView();
      } else {
        loaded = null; ta.style.display = "none"; md.style.display = "none"; mdBtn.style.display = "none"; preview.style.display = "";
        if (image) {
          const blob = new Blob([r.data as BlobPart], { type: r.contentType || "image/*" });
          previewURL = URL.createObjectURL(blob);
          const img = h("img"); img.src = previewURL; img.alt = basename(path);
          preview.append(img);
        } else preview.append(h("div", "ra-fpe", r.size > MAX_EDIT && !image ? t.tooBig : t.noPreview));
        preview.append(h("div", "ra-fpe", `${r.size} B`));
      }
    } catch (err) {
      loaded = null; ta.style.display = "none"; md.style.display = "none"; mdBtn.style.display = "none"; preview.style.display = "";
      preview.replaceChildren(h("div", "ra-fpe", (err as Error).message));
    }
    draw();
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
    const path = active, text = draft, target = ws;
    try {
      // Changed under the editor since it was opened (the agent, another tab): ask before overwriting.
      const now = await target.readText(path).catch(() => null);
      if (now !== null && loaded !== null && now !== loaded && !(await modalConfirm(root, t.conflict, path, { ok: t.save, cancel: t.cancel, danger: true }))) return;
      await target.write(path, text);
      if (active !== path || target !== ws) return;
      loaded = text;
      // Typing that went on while saving is still unsaved.
      setDraft(ta.value === text ? null : ta.value);
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

  /** A folder (or the whole directory) as a zip, built in the browser. */
  const downloadFolder = async (path: string) => {
    if (!ws) return;
    try {
      const prefix = path === "/" ? "/" : path + "/";
      const files = (await ws.list(path)).filter((f) => f.path.startsWith(prefix));
      if (!files.length) { notify(t.noFiles, "warning"); return; }
      notify(`${t.zipping} ${files.length}…`);
      const entries = [];
      for (const f of files) { const r = await ws.read(f.path); entries.push({ path: f.path.slice(prefix.length), data: r.data, mtime: f.mtime }); }
      const zip = await buildZip(entries);
      downloadBlob(`${path === "/" ? (ws.id || "directory") : basename(path)}.zip`, zip, "application/zip");
    } catch (err) { notify((err as Error).message, "error"); }
  };

  const remove = async (path: string) => {
    if (!ws) return;
    if (!(await modalConfirm(root, t.delete, t.confirmDeleteFile.replace("{path}", path), { ok: t.delete, cancel: t.cancel, danger: true }))) return;
    const failed: string[] = [];
    try {
      const targets = (await ws.isFolder(path)) ? (await ws.list(path)).map((f) => f.path).filter((p) => p !== path) : [path];
      for (const p of targets) {
        if (ws.isReadOnly(p)) { failed.push(p); continue; }
        try { await ws.delete(p); } catch { failed.push(p); }
      }
    } catch (err) { notify((err as Error).message, "error"); }
    if (active && (active === path || active.startsWith(path + "/")) && !(await ws.exists(active))) { active = null; loaded = null; setDraft(null); showEditor(false); }
    if (failed.length) notify(`${t.readOnly}: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ` +${failed.length - 3}` : ""}`, "warning");
    opts.onChange?.();
    await refresh();
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
  fileInput.addEventListener("change", () => { const picked = Array.from(fileInput.files ?? []); fileInput.value = ""; void upload(picked); });
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
      if (next === ws) return;
      // An unsaved edit is written to the file it belongs to before the panel moves on, not dropped.
      if (ws && active && draft !== null) {
        const [old, path, text] = [ws, active, draft];
        void old.write(path, text).then(() => notify(`${t.autoSaved}: ${path}`), (err) => notify((err as Error).message, "error"));
      }
      offChange?.(); offChange = null;
      ws = next;
      if (next) offChange = next.onChange((c) => {
        if (!visible) return;
        scheduleRefresh();
        if (c.path !== active || draft !== null) return;
        // The open file changed under the editor: reload it, or close it when it is gone (unless the user has unsaved edits).
        if (c.kind === "write") void openFile(c.path);
        else { active = null; loaded = null; showEditor(false); }
      });
      if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
      lastFiles = null;
      active = null; loaded = null; setDraft(null); showEditor(false); changedPaths.clear(); selectedDir = "/";
      if (!next) { visible = false; el.style.display = "none"; root.classList.remove("ra-files-open"); } else void refresh();
    },
    refresh,
    // The agent touched a path: mark it (onChange already redraws and reloads the open file).
    changed(path) {
      changedPaths.add(path);
      draw();
    },
    download,
    dispose() {
      disposed = true;
      offChange?.();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (previewURL) URL.revokeObjectURL(previewURL);
      el.remove();
      editor.remove();
      root.classList.remove("ra-editing");
    },
  };
}
