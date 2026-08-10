// The scene encoder, in a browser tab.
//
// Presents exactly the surface scene.mjs expects — the same one protoflux.mjs presents in Node
// — over pack.mjs's dependency-free BSON/Brotli/zip instead of bson/brotli-wasm/jszip.
//
// The only real difference is how a typed value is carried. Node uses the bson classes; here a
// value is a tagged object, `{ $t:'f64', v }`, which pack.mjs writes by tag. Those tags also
// answer to valueOf() and .value, because the facing check reads the numbers back out of the
// tree it is handed and must not care which encoder built it.

import { I32, I64, F64, buildPackage } from './pack.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NULL_GUID = '00000000-0000-0000-0000-000000000000';

// tagged, but still readable as a number by anything that inspects the tree
const num = (tag, n) => ({ ...tag(n), value: n, valueOf: () => n });

export function ProtoFlux() {
  let _id = 0;
  const nextId = () => `${(_id++).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
  const rootId = nextId();   // reserve 00000000 for the ROOT object

  const types = [];
  const typeMap = new Map();
  const typeIndex = (name) => {
    let i = typeMap.get(name);
    if (i === undefined) { i = types.length; types.push(name); typeMap.set(name, i); }
    return num(I32, i);
  };

  const D = (n) => num(F64, n);
  const i32 = (n) => num(I32, n);
  const vec = (...xs) => xs.map(D);
  // A leading '@' marks a URL in the data tree: DataTreeValue.IsURL is true for any string
  // starting with a single '@', and Extract<string> THROWS on one. A plain string beginning
  // with '@' is escaped by doubling it, exactly as DataTreeValue.PreprocessString does on the
  // way out — without this a handle like "@SampleVT" draws nothing at all. Deliberate URLs keep
  // their single '@'; they always carry a scheme, which is what tells the two apart.
  const URL_LIKE = /^@[a-zA-Z][a-zA-Z0-9+.-]*:/;
  const escapeDataTree = (v) =>
    (typeof v === 'string' && v.length > 1 && v[0] === '@' && !URL_LIKE.test(v)) ? '@' + v : v;
  const fd = (data) => ({ ID: nextId(), Data: escapeDataTree(data) });
  const fi = (n) => ({ ID: nextId(), Data: i32(n) });
  const longField = (n) => ({ ID: nextId(), Data: num(I64, n) });
  const list = (items) => items.map((d) => ({ ID: nextId(), Data: d }));

  function component(classpath, fields = {}) {
    const id = nextId();
    const data = { ID: id, 'persistent-ID': nextId(), UpdateOrder: fi(0), Enabled: fd(true) };
    for (const [k, v] of Object.entries(fields)) data[k] = fd(v);
    return { comp: { Type: typeIndex(classpath), Data: data }, id };
  }

  function makeSlot(name, components = [], pos = [0, 0, 0], children = [], tag = null, id = nextId()) {
    const position = fd(vec(pos[0], pos[1], pos[2]));
    const rotation = fd([D(0), D(0), D(0), D(1)]);
    const scale = fd(vec(1, 1, 1));
    return {
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
          else if (v !== NULL_GUID && k !== 'ParentReference') refs.set(v, (refs.get(v) ?? 0) + 1);
        } else walk(v, `${p}.${k}`);
      }
    };
    walk(doc.Object, '$');
    walk(doc.Assets, '$.Assets');
    return { defs: defs.size, refs: refs.size,
             dangling: [...refs.keys()].filter((g) => !defs.has(g)), unbound };
  }

  // drop the non-serialised _slot handle; leave tagged values alone, since recursing into one
  // would destructure it into a plain object and lose its type
  function stripHandles(n) {
    if (n == null || typeof n !== 'object') return n;
    if (n.$t) return n;
    if (Array.isArray(n)) return n.map(stripHandles);
    const out = {};
    for (const [k, v] of Object.entries(n)) { if (k === '_slot') continue; out[k] = stripHandles(v); }
    return out;
  }

  async function exportPackage({ name, root, assets = [], embeddedAssets = [],
                                 version = '2026.6.2.275', typeVersions = {} }) {
    const object = stripHandles(root);
    const assetList = stripHandles(assets);
    const report = validate({ Object: object, Assets: assetList });
    if (report.dangling.length)
      throw new Error(`refusing to write a package with ${report.dangling.length} dangling ` +
                      `reference(s): ${report.dangling.map(g => g.slice(0, 8)).join(', ')}`);
    const bytes = await buildPackage({ name, types, typeVersions, object, assets: assetList,
                                       embeddedAssets, version });
    return { bytes, ids: _id, types: types.length, ...report, ok: true };
  }

  return { nextId, id: nextId, rootId, typeIndex, D, i32, vec, fd, fi, longField, list,
           component, makeSlot, validate, exportPackage };
}

// Same shape build_batch.mjs's newEncoder returns, so scene.mjs is handed the same thing.
export function newEncoder() {
  const pf = ProtoFlux();
  const assets = [], embeds = [];
  const asset = (cp, f = {}) => {
    const id = pf.nextId();
    const data = { ID: id, persistent: pf.fd(true), UpdateOrder: pf.fi(0), Enabled: pf.fd(true) };
    for (const [k, v] of Object.entries(f)) data[k] = pf.fd(v);
    return { entry: { Type: pf.typeIndex(cp), Data: data }, id };
  };
  return { pf, asset, assets, embeds };
}
