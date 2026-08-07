// Everything needed to write a .resonitepackage from a browser tab, with no dependencies:
// BSON, a Brotli stream, a zip, and SHA-256. The Node builders reach for `bson`,
// `brotli-wasm` and `jszip`; none of those belong in a 7MB single-file app, and two of them
// have no browser build worth shipping.
//
// Runs unchanged in Node 22, which is how it is tested — the same document is encoded here
// and by the Node path, and the two packages are decoded and compared.
//
// The one real constraint: `DataTreeConverter` rejects `Compression.None`, so the object blob
// MUST be LZ4, LZMA or Brotli. See brotliStore below for how that is satisfied without
// shipping a compressor.

const enc = new TextEncoder();

// ── BSON ────────────────────────────────────────────────────────────────────
// Only the types this format actually uses. Values are tagged rather than sniffed, because
// a Double that serialises as an Int32 changes the meaning of a field: `OrderOffset` is an
// Int64 and colour components are Doubles, and the engine reads them by type.
export const I32 = v => ({ $t: 'i32', v });
export const I64 = v => ({ $t: 'i64', v });
export const F64 = v => ({ $t: 'f64', v });

class Buf {
  constructor() { this.b = new Uint8Array(1 << 16); this.n = 0; }
  need(k) { if (this.n + k <= this.b.length) return;
    let cap = this.b.length; while (cap < this.n + k) cap *= 2;
    const next = new Uint8Array(cap); next.set(this.b.subarray(0, this.n)); this.b = next; }
  u8(v) { this.need(1); this.b[this.n++] = v; }
  i32(v) { this.need(4); new DataView(this.b.buffer).setInt32(this.n, v, true); this.n += 4; }
  i64(v) { this.need(8); new DataView(this.b.buffer).setBigInt64(this.n, BigInt(v), true); this.n += 8; }
  f64(v) { this.need(8); new DataView(this.b.buffer).setFloat64(this.n, v, true); this.n += 8; }
  raw(a) { this.need(a.length); this.b.set(a, this.n); this.n += a.length; }
  cstr(s) { this.raw(enc.encode(s)); this.u8(0); }
  out() { return this.b.slice(0, this.n); }
}

function writeDoc(buf, doc, isArray) {
  const start = buf.n;
  buf.i32(0);                                        // length placeholder
  const entries = isArray ? doc.map((v, i) => [String(i), v]) : Object.entries(doc);
  for (const [k, v] of entries) writeElem(buf, k, v);
  buf.u8(0);
  new DataView(buf.b.buffer).setInt32(start, buf.n - start, true);
}

function writeElem(buf, key, v) {
  const put = (type) => { buf.u8(type); buf.cstr(key); };
  if (v === null || v === undefined)      { put(0x0A); return; }
  switch (typeof v) {
    case 'string': { put(0x02); const b = enc.encode(v); buf.i32(b.length + 1); buf.raw(b); buf.u8(0); return; }
    case 'boolean': { put(0x08); buf.u8(v ? 1 : 0); return; }
    case 'number': { put(0x01); buf.f64(v); return; }        // untagged numbers are Doubles
    case 'bigint': { put(0x12); buf.i64(v); return; }
  }
  if (v instanceof Uint8Array) { put(0x05); buf.i32(v.length); buf.u8(0); buf.raw(v); return; }
  if (Array.isArray(v)) { put(0x04); writeDoc(buf, v, true); return; }
  switch (v.$t) {
    case 'i32': put(0x10); buf.i32(v.v); return;
    case 'i64': put(0x12); buf.i64(v.v); return;
    case 'f64': put(0x01); buf.f64(v.v); return;
  }
  put(0x03); writeDoc(buf, v, false);
}

export function bson(doc) { const b = new Buf(); writeDoc(b, doc, false); return b.out(); }

// ── Brotli, stored ──────────────────────────────────────────────────────────
// The engine will not accept an uncompressed data tree, but it will accept Brotli — and
// Brotli's own format has an uncompressed meta-block, so a valid stream can be emitted
// without a compressor. That is the whole trick: no WASM blob, no build step.
//
// Per RFC 7932 §9.2, each meta-block here is: ISLAST=0, MNIBBLES=11 (2 bits, value 0),
// MLEN-1 in 16 bits, ISUNCOMPRESSED=1, then padding to a byte boundary and the raw bytes.
// The stream opens with WBITS=16 (1 bit, value 0) and closes with an empty ISLAST block.
//
// It costs about four bytes per 64KB. The object blob is ~14KB of BSON and everything large
// in the package — PNGs, fonts — is stored beside it already compressed, so the difference
// against real Brotli is a few kilobytes on a package of a megabyte or more.
export function brotliStore(data) {
  const out = [];
  let acc = 0, nbits = 0;
  const bits = (value, count) => { acc |= value << nbits; nbits += count;
    while (nbits >= 8) { out.push(acc & 0xff); acc >>>= 8; nbits -= 8; } };
  const align = () => { if (nbits > 0) { out.push(acc & 0xff); acc = 0; nbits = 0; } };

  bits(0, 1);                                        // WBITS = 16
  for (let off = 0; off < data.length; off += 0x10000) {
    const chunk = data.subarray(off, Math.min(off + 0x10000, data.length));
    bits(0, 1);                                      // ISLAST = 0
    bits(0, 2);                                      // MNIBBLES = 4 nibbles => 16-bit MLEN
    bits(chunk.length - 1, 16);                      // MLEN - 1
    bits(1, 1);                                      // ISUNCOMPRESSED
    align();
    for (const b of chunk) out.push(b);
  }
  bits(1, 1);                                        // ISLAST = 1
  bits(1, 1);                                        // ISLASTEMPTY = 1
  align();
  return new Uint8Array(out);
}

// ── zip ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => { const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0; } return t; })();
const crc32 = (a) => { let c = 0xFFFFFFFF;
  for (let i = 0; i < a.length; i++) c = CRC_TABLE[(c ^ a[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0; };

const deflateRaw = async (bytes) => {
  // `deflate-raw` is exactly the bit stream a zip entry wants — no zlib wrapper to strip
  const cs = new CompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
};

export async function zip(files) {          // [{ name, bytes }]
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const comp = await deflateRaw(f.bytes);
    // a stored entry is smaller than a deflated one for data that is already compressed
    const useDeflate = comp.length < f.bytes.length;
    const body = useDeflate ? comp : f.bytes;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(f.bytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.bytes.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, body);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.bytes.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + body.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const total = all.reduce((n, a) => n + a.length, 0);
  const outBytes = new Uint8Array(total);
  let p = 0; for (const a of all) { outBytes.set(a, p); p += a.length; }
  return outBytes;
}

export const sha256 = async (bytes) => {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
};

// ── the package ─────────────────────────────────────────────────────────────
const FRDT = new Uint8Array([0x46, 0x72, 0x44, 0x54, 0, 0, 0, 0, 0x03]);   // "FrDT" + Brotli

export async function buildPackage({ name, types, typeVersions = {}, object, assets = [],
                                     embeddedAssets = [], version = '2026.6.2.275' }) {
  const tv = {};
  for (const t of types) if (typeVersions[t] !== undefined) tv[t] = I32(typeVersions[t]);
  const flags = {};
  for (const k of ['ColorManagement','ResetGUID','ProtoFlux','TEXTURE_QUALITY','TypeManagement',
                   'ALIGNER_FILTERING','PhotonDust','Awwdio','NetCore','RESONITE_LINK']) flags[k] = I32(0);

  const blobBody = bson({ VersionNumber: version, FeatureFlags: flags, Types: types,
                          TypeVersions: tv, Object: object, Assets: assets });
  const compressed = brotliStore(blobBody);
  const blob = new Uint8Array(FRDT.length + compressed.length);
  blob.set(FRDT, 0); blob.set(compressed, FRDT.length);
  const mainHash = await sha256(blob);

  for (const a of embeddedAssets) {
    const got = await sha256(a.bytes);
    if (got !== a.hash) throw new Error(`embedded asset hash mismatch for ${a.hash.slice(0, 12)}`);
  }
  const now = '2026-06-03T00:00:00.0000000Z';
  const record = { id: 'R-Main', ownerId: 'U-JustDalek-', assetUri: `packdb:///${mainHash}`,
    version: { globalVersion: 0, localVersion: 0, lastModifyingUserId: null, lastModifyingMachineId: null },
    name, description: null, recordType: 'object', ownerName: null, tags: null, path: null,
    thumbnailUri: null, lastModificationTime: now, creationTime: now, firstPublishTime: null,
    isDeleted: false, isPublic: false, isForPatrons: false, isListed: false, isReadOnly: false,
    visits: 0, rating: 0, randomOrder: 0, submissions: null,
    assetManifest: embeddedAssets.map(a => ({ hash: a.hash, bytes: a.bytes.length })),
    migrationMetadata: null };

  return zip([
    { name: 'R-Main.record', bytes: enc.encode(JSON.stringify(record)) },
    { name: `Assets/${mainHash}`, bytes: blob },
    ...embeddedAssets.map(a => ({ name: `Assets/${a.hash}`, bytes: a.bytes })),
  ]);
}
