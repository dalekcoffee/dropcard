// protoflux.mjs — reusable encoder for Resonite ProtoFlux → .resonitepackage.
//
// Generalized from the VR-confirmed "Pulse Beacon" encoder. You build a graph with
// these primitives, then call exportPackage() — it serializes to FrDT/Brotli/BSON,
// zips a .resonitepackage, AND self-validates (round-trip-safe types + 0 dangling refs).
//
//   import { ProtoFlux } from './protoflux.mjs';
//   const pf = ProtoFlux();
//   const wt  = pf.node('WorldTimeFloat', T.WorldTime, {}, [-0.5, 0.2, 0]);
//   const drv = pf.driveField({ valueType:'float3', sourceId: pack.id,
//                               targetFieldId: cube.scaleFieldId, pos:[0.5,0,0] });
//   const flux = pf.makeSlot('ProtoFlux', [], [0,0.6,0], [wt.slot, /*…*/, drv.slot]);
//   const root = pf.makeSlot('My Gadget', [], [0,0,0], [cube.slot, flux], null, pf.rootId);
//   await pf.exportPackage({ name:'My Gadget', root, assets:[] });
//
// Deps (installed on demand wherever you export): bson, brotli-wasm, jszip.
// Read references/node-catalog.md for node classpaths, field names, and the rules
// this library encodes (strict BSON types, the addressing rule, the drive pair, etc.).

import { serialize, Int32, Long, Double } from 'bson';
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const FRDT_HEADER = new Uint8Array([0x46, 0x72, 0x44, 0x54, 0x00, 0x00, 0x00, 0x00, 0x03]); // "FrDT"+nulls+Brotli
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NULL_GUID = '00000000-0000-0000-0000-000000000000';

// Classpaths that follow the doubled-`FrooxEngine` / `[FrooxEngine]` quirks for the drive pair.
// `<T>` is substituted. See node-catalog.md "drive a field".
const VALUE_FIELD_DRIVE = (T) => `[ProtoFluxBindings]FrooxEngine.FrooxEngine.ProtoFlux.CoreNodes.ValueFieldDrive<${T}>`;
const FIELD_DRIVE_PROXY = (T) => `[FrooxEngine]FrooxEngine.ProtoFlux.CoreNodes.FieldDriveBase<${T}>+Proxy`;

export function ProtoFlux() {
  let _id = 0;
  const nextId = () => `${(_id++).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
  const rootId = nextId(); // reserve 00000000 for the ROOT object (keeps the null-sentinel off real fields)

  const types = [];
  const typeMap = new Map();
  const typeIndex = (name) => { let i = typeMap.get(name); if (i === undefined) { i = types.length; types.push(name); typeMap.set(name, i); } return new Int32(i); };

  // ── value helpers ──────────────────────────────────────────────────────────
  const D = (n) => new Double(n);
  const vec = (...xs) => xs.map(D);                 // float2/3/4/Q/colorX components (append a profile string yourself for colorX)
  // A leading '@' marks a URL in the data tree: DataTreeValue.IsURL is true for any string
  // starting with a single '@', and Extract<string> THROWS on one ("is an URL, not a raw
  // string"). So a plain string beginning with '@' has to be escaped by doubling it, which is
  // exactly what DataTreeValue.PreprocessString does on the way out. Without this a handle
  // like "@SampleVT" fails to load and its TextRenderer draws nothing at all.
  // Deliberate URLs keep their single '@' — they always carry a scheme ("@https://",
  // "@packdb:///"), which is what tells the two apart.
  const URL_LIKE = /^@[a-zA-Z][a-zA-Z0-9+.-]*:/;
  const escapeDataTree = (v) =>
    (typeof v === 'string' && v.length > 1 && v[0] === '@' && !URL_LIKE.test(v)) ? '@' + v : v;
  const fd = (data) => ({ ID: nextId(), Data: escapeDataTree(data) });   // {ID,Data} field wrapper
  const fi = (n) => ({ ID: nextId(), Data: new Int32(n) });     // Int32 field (byte/int)
  const longField = (n) => ({ ID: nextId(), Data: Long.fromNumber(n) });
  // variadic field value: an array of {ID,Data} sub-edges (Operands/Inputs/Calls/ValueOutputs)
  const list = (items) => items.map((d) => ({ ID: nextId(), Data: d }));

  // ── component + slot builders ───────────────────────────────────────────────
  // fields: { fieldName: <data> } where <data> is a ref-id string, a Double/Int32/Long,
  // an array, null (a sentinel/unbound), etc. Each is wrapped {ID,Data} automatically.
  function component(classpath, fields = {}) {
    const id = nextId();
    const data = { ID: id, 'persistent-ID': nextId(), UpdateOrder: fi(0), Enabled: fd(true) };
    for (const [k, v] of Object.entries(fields)) data[k] = fd(v);
    return { comp: { Type: typeIndex(classpath), Data: data }, id };
  }

  // A ProtoFlux node = one slot carrying one logic component. Returns {slot, id};
  // `id` is the component ID = the node's data output (downstream fields reference it).
  function node(name, classpath, fields = {}, pos = [0, 0, 0]) {
    const { comp, id } = component(classpath, fields);
    return { slot: makeSlot(name, [comp], pos), id };
  }

  function makeSlot(name, components = [], pos = [0, 0, 0], children = [], tag = null, id = nextId()) {
    const position = fd(vec(pos[0], pos[1], pos[2]));
    const rotation = fd([D(0), D(0), D(0), D(1)]);
    const scale = fd(vec(1, 1, 1));
    return {
      // convenience handles (non-serialized; stripped on export) — use these field IDs
      // as drive targets, e.g. driveField({ ..., targetFieldId: slot._slot.scaleFieldId }).
      _slot: { id, positionFieldId: position.ID, rotationFieldId: rotation.ID, scaleFieldId: scale.ID },
      ID: id,
      Components: { ID: nextId(), Data: components },
      Name: fd(name), Tag: fd(tag), Active: fd(true), 'Persistent-ID': nextId(),
      Position: position, Rotation: rotation, Scale: scale,
      OrderOffset: longField(0),
      ParentReference: null,                        // Resonite rebuilds parenting from nesting
      Children: children,
    };
  }

  // The drive pair: writes `sourceId`'s value into a scene field every frame.
  // targetFieldId is the field the graph writes (e.g. a slot's Scale field ID, or any IField).
  // Pass targetFieldId=null to emit an UNBOUND hook the user binds in-world.
  function driveField({ valueType, sourceId, targetFieldId = null, name = 'ValueFieldDrive`1', pos = [0, 0, 0] }) {
    const drive = component(VALUE_FIELD_DRIVE(valueType), { Value: sourceId });
    const proxy = component(FIELD_DRIVE_PROXY(valueType), { Node: drive.id, Path: [], Drive: targetFieldId });
    return { slot: makeSlot(name, [drive.comp, proxy.comp], pos), id: drive.id };
  }

  // ── capture→emit: clone verified components from a decoded fragment ──────────
  // Deep-revive tagged JSON ({__f64}/{__i32}/{__i64}) → BSON types, remap every counter-GUID
  // through a fresh map, and remap component Type indices from srcTypes into this registry.
  function cloneNode(srcNode, srcTypes, map = new Map()) {
    const revive = (n) => {
      if (n === null) return null;
      if (typeof n === 'string') {
        if (n === NULL_GUID) return n;
        if (GUID.test(n)) { let m = map.get(n); if (!m) { m = nextId(); map.set(n, m); } return m; }
        return n;
      }
      if (typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map(revive);
      if ('__f64' in n) return new Double(n.__f64);
      if ('__i32' in n) return new Int32(n.__i32);
      if ('__i64' in n) return Long.fromNumber(n.__i64);
      if (n.Type && typeof n.Type === 'object' && '__i32' in n.Type && n.Data) // component → remap Type by name
        return { Type: typeIndex(srcTypes[n.Type.__i32]), Data: revive(n.Data) };
      const out = {};
      for (const [k, v] of Object.entries(n)) out[k] = revive(v);
      return out;
    };
    return revive(srcNode);
  }

  // ── in-memory validation (mirrors find_dangling_refs.mjs) ────────────────────
  function validate(doc) {
    const defs = new Set(), refs = new Map(), unbound = [];
    const isIdKey = (k) => k === 'ID' || k === 'persistent-ID' || k === 'Persistent-ID' || k.endsWith('-ID');
    const walk = (n, p) => {
      if (n == null || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${p}[${i}]`));
      for (const [k, v] of Object.entries(n)) {
        if ((k === 'Reference' || k === 'Drive') && v && typeof v === 'object' && 'Data' in v && v.Data === null) unbound.push(`${p}.${k}`);
        if (typeof v === 'string' && GUID.test(v)) {
          if (isIdKey(k)) defs.add(v);
          else if (v !== NULL_GUID && k !== 'ParentReference') { const e = refs.get(v) ?? { n: 0 }; e.n++; refs.set(v, e); }
        } else walk(v, `${p}.${k}`);
      }
    };
    walk(doc.Object, '$');
    walk(doc.Assets, '$.Assets'); // assets define IDs too (e.g. materials referenced by MeshRenderers)
    const dangling = [...refs.keys()].filter((g) => !defs.has(g));
    return { defs: defs.size, refs: refs.size, dangling, unbound };
  }

  function stripHandles(n) { // remove the non-serialized _slot convenience field before encoding
    if (n == null || typeof n !== 'object') return n;
    if (n._bsontype) return n; // BSON value instance (Double/Int32/Long/…) — recursing would destructure it into a plain {value} object
    if (Array.isArray(n)) return n.map(stripHandles);
    const out = {};
    for (const [k, v] of Object.entries(n)) { if (k === '_slot') continue; out[k] = stripHandles(v); }
    return out;
  }

  // ── assemble → FrDT/Brotli/BSON → .resonitepackage (+ self-validate) ─────────
  // embeddedAssets: raw binary sub-assets (textures/meshes) bundled INTO the package so
  //   the item is self-contained. Each: { hash, bytes (Uint8Array), metadata?, metadataExt='bitmap' }.
  //   `hash` MUST be sha256(bytes) (content-addressed); a component references it via a
  //   URL `@packdb:///<hash>` (e.g. StaticTexture2D.URL). They go to `Assets/<hash>` (raw bytes,
  //   NOT FrDT-wrapped) + optional `Metadata/<hash>.<ext>`, and each is listed in the record's
  //   assetManifest (hash + byte length). Verbatim reuse of an existing asset (same bytes ⇒ same
  //   hash ⇒ same metadata) is guaranteed valid. See Projects/FireSpark for the worked example.
  async function exportPackage({ name, root, assets = [], embeddedAssets = [], outPath, version = '2026.6.2.275', typeVersions = {} }) {
    // TypeVersions MUST carry the component version for any used type that has one in
    // real saves (e.g. Grabbable=2, BoxCollider=1) — an empty map declares version 0
    // and the engine migrates the fields on import, silently mangling them.
    const tv = {};
    for (const t of types) if (typeVersions[t] !== undefined) tv[t] = new Int32(typeVersions[t]);
    const doc = {
      VersionNumber: version,
      FeatureFlags: { ColorManagement: new Int32(0), ResetGUID: new Int32(0), ProtoFlux: new Int32(0),
        TEXTURE_QUALITY: new Int32(0), TypeManagement: new Int32(0), ALIGNER_FILTERING: new Int32(0),
        PhotonDust: new Int32(0), Awwdio: new Int32(0), NetCore: new Int32(0), RESONITE_LINK: new Int32(0) },
      Types: types, TypeVersions: tv, Object: stripHandles(root), Assets: stripHandles(assets),
    };
    const report = validate(doc);

    const brotli = await (require('brotli-wasm').default ?? require('brotli-wasm'));
    const compressed = brotli.compress(serialize(doc), { quality: 4 });
    const blob = new Uint8Array(FRDT_HEADER.length + compressed.length);
    blob.set(FRDT_HEADER, 0); blob.set(compressed, FRDT_HEADER.length);
    const mainHash = createHash('sha256').update(blob).digest('hex');

    // manifest lists ONLY the embedded sub-assets — the main object blob is NOT a manifest entry
    // (matches real packages: Assets/ holds main blob + sub-assets, manifest holds sub-assets only).
    for (const a of embeddedAssets) {
      const got = createHash('sha256').update(a.bytes).digest('hex');
      if (got !== a.hash) throw new Error(`embeddedAsset hash mismatch: declared ${a.hash.slice(0, 12)} but bytes hash ${got.slice(0, 12)}`);
    }
    const assetManifest = embeddedAssets.map((a) => ({ hash: a.hash, bytes: a.bytes.length }));

    const now = '2026-06-03T00:00:00.0000000Z';
    const record = { id: 'R-Main', ownerId: 'U-JustDalek-', assetUri: `packdb:///${mainHash}`,
      version: { globalVersion: 0, localVersion: 0, lastModifyingUserId: null, lastModifyingMachineId: null },
      name, description: null, recordType: 'object', ownerName: null, tags: null, path: null, thumbnailUri: null,
      lastModificationTime: now, creationTime: now, firstPublishTime: null, isDeleted: false, isPublic: false,
      isForPatrons: false, isListed: false, isReadOnly: false, visits: 0, rating: 0, randomOrder: 0,
      submissions: null, assetManifest, migrationMetadata: null };

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('R-Main.record', JSON.stringify(record));
    zip.file(`Assets/${mainHash}`, blob);
    for (const a of embeddedAssets) {
      zip.file(`Assets/${a.hash}`, a.bytes);
      if (a.metadata != null) zip.file(`Metadata/${a.hash}.${a.metadataExt ?? 'bitmap'}`, a.metadata);
    }
    const zipBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    const out = outPath ?? path.join(process.cwd(), 'out', `${name.replace(/[^\w.-]+/g, '_')}.resonitepackage`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, zipBytes);

    const ok = report.dangling.length === 0;
    console.log(`${ok ? '✓' : '✗ DANGLING REFS!'} ${out}`);
    console.log(`  ids=${_id} types=${types.length} blob=${blob.length}b pkg=${zipBytes.length}b embedded=${embeddedAssets.length}`);
    console.log(`  validate: ${report.dangling.length} dangling, ${report.unbound.length} unbound external hooks (Reference/Drive=null → bind in-world)`);
    if (report.dangling.length) console.log('  DANGLING:', report.dangling.map((g) => g.slice(0, 8)).join(', '));
    return { path: out, mainHash, ids: _id, ...report, ok };
  }

  return { nextId, id: nextId, rootId, typeIndex, D, vec, fd, fi, longField, list,
           component, node, makeSlot, driveField, cloneNode, validate, exportPackage,
           VALUE_FIELD_DRIVE, FIELD_DRIVE_PROXY };
}
