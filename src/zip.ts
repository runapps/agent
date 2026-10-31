// A zip reader for skills packs: central directory + per-entry inflate.
// Stored and deflate entries only; zip64 is refused. Inflation uses the
// platform's DecompressionStream("deflate-raw") when it exists (browsers,
// Node ≥ 20.12) or an `inflate` function the caller supplies (tests pass
// zlib.inflateRawSync).

export interface ZipEntry {
  /** Path inside the zip, `/`-separated, no leading slash. */
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  isDir: boolean;
  /** Offset of the local header. */
  offset: number;
}

export type Inflate = (compressed: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export const MAX_ZIP_BYTES = 50 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export function listZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error(`runapps agent: zip larger than ${MAX_ZIP_BYTES} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: scan back over a possible comment (≤ 64 KB).
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("runapps agent: not a zip file");
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR) {
    throw new Error("runapps agent: zip64 archives are not supported");
  }
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("runapps agent: zip64 archives are not supported");
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const utf8 = new TextDecoder("utf-8");
  const cp437 = new TextDecoder("latin1");
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error("runapps agent: zip central directory is damaged");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new Error("runapps agent: zip64 archives are not supported");
    }
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = ((flags & 0x800) ? utf8 : cp437).decode(nameBytes).replace(/\\/g, "/");
    entries.push({ name, size, compressedSize, method, isDir: name.endsWith("/"), offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, inflate?: Inflate): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  if (p + 30 > bytes.byteLength || view.getUint32(p, true) !== SIG_LOCAL) {
    throw new Error(`runapps agent: zip entry "${entry.name}" is damaged`);
  }
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  // Sizes come from the central directory: with a data descriptor
  // (flag bit 3) the local header's are zero.
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`runapps agent: zip entry "${entry.name}" uses an unsupported compression method (${entry.method})`);
  const out = await (inflate ? inflate(data) : inflateRaw(data));
  if (out.byteLength !== entry.size) throw new Error(`runapps agent: zip entry "${entry.name}" inflated to the wrong size`);
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) {
    throw new Error("runapps agent: this runtime has no DecompressionStream; pass an `inflate` function (e.g. zlib.inflateRawSync)");
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deflates with the browser's CompressionStream when it has one; else the bytes are stored as they are. */
async function deflateRaw(data: Uint8Array): Promise<{ bytes: Uint8Array; method: 0 | 8 }> {
  if (typeof CompressionStream === "undefined" || data.length < 64) return { bytes: data, method: 0 };
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.length < data.length ? { bytes: out, method: 8 } : { bytes: data, method: 0 };
  } catch {
    return { bytes: data, method: 0 };
  }
}

function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

/**
 * A zip of `entries` (paths relative, `/`-separated; data as bytes or
 * text), deflated when the runtime can, UTF-8 names. For downloads of a
 * directory from the browser; no external dependency.
 */
export async function buildZip(entries: Array<{ path: string; data: Uint8Array | string; mtime?: number }>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path.replace(/^\/+/, ""));
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const crc = crc32(raw);
    const { bytes, method } = await deflateRaw(raw);
    const { date, time } = dosDateTime(e.mtime ?? Date.now());
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, bytes.length, true); lh.setUint32(22, raw.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, bytes.length, true); ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), name, bytes);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + bytes.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}
