// PDF text, with Mozilla's pdf.js loaded only when a PDF is first read
// (≈500 KB gzip from a CDN; nothing is bundled). Pages come back as text
// with their numbers, so the agent reads a PDF like any long file.

/** The parts of pdf.js used here. */
export interface PdfLib {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): { promise: Promise<PdfDocument>; destroy?(): Promise<void> | void };
  GlobalWorkerOptions: { workerSrc?: string; workerPort?: unknown };
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>; cleanup?(): void }>;
  destroy?(): Promise<void> | void;
}

const VERSION = "6.4.299";
const config: { url: string; workerUrl: string; load?: () => Promise<PdfLib> } = {
  url: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build/pdf.min.mjs`,
  workerUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build/pdf.worker.min.mjs`,
};
let lib: Promise<PdfLib> | null = null;

/**
 * Where pdf.js comes from: `url` / `workerUrl` (an app that hosts its own
 * copy, or pins another version), or `load` returning the library itself
 * (a bundler import, or a stub in tests).
 */
export function configurePdf(c: { url?: string; workerUrl?: string; load?: () => Promise<PdfLib> }): void {
  Object.assign(config, c);
  lib = null;
}

// A plain dynamic import, kept away from bundlers that would try to resolve the URL.
const importURL = (u: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ u);

function loadLib(): Promise<PdfLib> {
  if (!lib) {
    lib = (async () => {
      const mod = (config.load ? await config.load() : await importURL(config.url)) as unknown as PdfLib & { default?: PdfLib };
      const pdfjs: PdfLib = mod.default?.getDocument ? mod.default : mod;
      if (!config.load && typeof Worker !== "undefined" && typeof Blob !== "undefined") {
        // A module worker cannot start from another origin; a same-origin blob that imports the CDN worker can.
        try {
          const blob = new Blob([`import ${JSON.stringify(config.workerUrl)};`], { type: "text/javascript" });
          pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: "module" });
        } catch {
          pdfjs.GlobalWorkerOptions.workerSrc = config.workerUrl;
        }
      }
      return pdfjs;
    })();
    lib.catch(() => { lib = null; });
  }
  return lib;
}

/** Whether a file is a PDF: by name, type, or its `%PDF` signature. */
export function isPdf(path: string, contentType?: string, data?: string | Uint8Array): boolean {
  if (/\.pdf$/i.test(path) || contentType === "application/pdf") return true;
  return data instanceof Uint8Array && data.length > 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
}

/** The text of each page (up to `maxPages`, default 500). */
export async function extractPdfText(bytes: Uint8Array, opts: { maxPages?: number } = {}): Promise<{ pages: string[]; numPages: number }> {
  const pdfjs = await loadLib();
  // pdf.js takes ownership of the buffer it is given: hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    const n = Math.min(doc.numPages, opts.maxPages ?? 500);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n").trim());
      page.cleanup?.();
    }
    return { pages, numPages: doc.numPages };
  } finally {
    // Newer pdf.js releases free a document through its loading task; older ones on the document.
    await (task.destroy ? task.destroy() : doc.destroy?.());
  }
}

/** The pages as one text, each under a `--- page N ---` line; a PDF with no text layer says so. */
export function formatPdfText(path: string, r: { pages: string[]; numPages: number }): string {
  const head = `[PDF ${path}: ${r.numPages} page${r.numPages === 1 ? "" : "s"}${r.pages.length < r.numPages ? `, text of the first ${r.pages.length}` : ""}]`;
  if (!r.pages.some((p) => p.trim())) {
    return `${head}\nThis PDF has no text layer (it is probably scanned images), so there is no text to read. Tell the user; the pages would need to be read as pictures.`;
  }
  return [head, ...r.pages.map((p, i) => `--- page ${i + 1} ---\n${p}`)].join("\n\n");
}
