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
