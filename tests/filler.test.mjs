#!/usr/bin/env node
// tests/filler.test.mjs — resource + coverage tests for the view loader
// (FillerLayer): at every altitude the satellite fill must be ONE contiguous
// cone that joins the detail circle — no stray tiles far away, no holes
// between the near ring and the far ring.
//
// Runs the real FillerLayer headlessly (browser APIs stubbed, network faked).
// Run with: npm test

import assert from 'node:assert/strict';
import * as THREE from 'three';

// ---- browser stubs (filler.js + geo.js touch these only while loading) ----
globalThis.document = {
  createElement: () => {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ drawImage() {} });
    return canvas;
  },
};
globalThis.createImageBitmap = async () => ({ close() {} });

const fetched = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  return { ok: true, blob: async () => ({}) };
};

const { FillerLayer } = await import('../js/filler.js');
const { CHUNK_WORLD_SIZE } = await import('../js/chunks.js');
const { tileSpanMeters, MERC_NORTH, worldToMerc, worldToChunk } = await import('../js/geo.js');

// constants mirrored from filler.js (kept in sync deliberately)
const MIN_RADIUS = 2600, MAX_RADIUS = 9000, Z13_RADIUS = 1500;
const FAR_MAX_TILES = 550, MAX_TILES = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = new THREE.Vector3(0, 0, 0);

function makeCamera(alt, look) {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
  c.position.set(0, alt, 0);
  c.lookAt(look);
  return c;
}

function fwdOf(camera) {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  let fx = fwd.x, fz = fwd.z;
  const l = Math.hypot(fx, fz);
  if (l > 1e-4) { fx /= l; fz /= l; } else { fx = 0; fz = 0; }
  return [fx, fz];
}

/** replicate filler.update()'s cone + near-ring bboxes (the expected regions) */
function coneBBox(camera, tgt) {
  const R = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, camera.position.y * 10));
  const [fx, fz] = fwdOf(camera);
  const off = 0.5 * R, r = 1.5 * R + 2 * CHUNK_WORLD_SIZE;
  const gx = tgt.x + fx * off, gz = tgt.z + fz * off;
  const b = { R, fx, fz, minX: gx - r, maxX: gx + r, minZ: gz - r, maxZ: gz + r };
  const r13 = Math.min(R, Z13_RADIUS);
  const g13x = tgt.x + fx * 0.5 * r13, g13z = tgt.z + fz * 0.5 * r13;
  const half13 = 1.5 * r13 + 2 * CHUNK_WORLD_SIZE;
  b.nMinX = g13x - half13; b.nMaxX = g13x + half13;
  b.nMinZ = g13z - half13; b.nMaxZ = g13z + half13;
  return b;
}

/** world point -> tile cell at the given zoom (same math as filler) */
function cellOf(wx, wz, zoom) {
  const span = tileSpanMeters(zoom);
  const [mx, my] = worldToMerc(wx, wz);
  return [Math.floor((mx + MERC_NORTH) / span), Math.floor((MERC_NORTH - my) / span)];
}

/** fake chunk manager: a 3x3 block of "terrain chunks" around the target */
function makeManager() {
  const chunks = new Map();
  const [ctx, cty] = worldToChunk(0, 0);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) chunks.set(`${ctx + dx},${cty + dy}`, {});
  return { chunks, groundWorldY: () => null };
}

async function stabilize(fill, camera, maxRounds = 800) {
  let last = -1, stable = 0;
  for (let i = 0; i < maxRounds; i++) {
    fill.update(camera, target);
    await sleep(2);
    const sig = fill.tiles.size + fill.farTiles.size + fill.pending.size + fill.pendingFar.size;
    stable = sig === last ? stable + 1 : 0;
    last = sig;
    if (i > 8 && stable >= 3 && fill.pending.size === 0 && fill.pendingFar.size === 0) break;
  }
}

/**
 * Full invariant check of one stabilized view. Returns a summary row.
 * Throws (fails the test) on any violation.
 */
function checkScenario(fill, manager, camera, label) {
  const b = coneBBox(camera, target);
  const errs = [];
  const ok = (cond, msg) => { if (!cond) errs.push(msg); };

  // 1. far-ring zoom matches the altitude-driven reach
  ok(fill.farZoom === fill._pickFarZoom(b.R),
    `${label}: farZoom ${fill.farZoom} != expected ${fill._pickFarZoom(b.R)} for R=${b.R}`);

  // 2. resource budgets
  ok(fill.farTiles.size <= FAR_MAX_TILES, `${label}: far tiles ${fill.farTiles.size} > ${FAR_MAX_TILES}`);
  ok(fill.tiles.size <= MAX_TILES, `${label}: near tiles ${fill.tiles.size} > ${MAX_TILES}`);

  // 3. every far tile is INSIDE the cone bbox (+1 tile margin) and at the
  //    current zoom — no random tiles loaded far away
  const fs = fill.farTileSize;
  for (const [key, ft] of fill.farTiles) {
    const [tx, ty] = key.split(',').map(Number);
    const fb = fill._farBounds(tx, ty);
    const cxw = (fb[0] + fb[1]) / 2, czw = (fb[2] + fb[3]) / 2;
    ok(cxw >= b.minX - fs && cxw <= b.maxX + fs && czw >= b.minZ - fs && czw <= b.maxZ + fs,
      `${label}: far tile ${key} at (${cxw.toFixed(0)},${czw.toFixed(0)}) outside cone bbox`);
    ok(Math.abs(ft.mesh.geometry.parameters.width - fs) < 1e-6,
      `${label}: far tile ${key} geometry width != farTileSize (stale zoom?)`);
  }

  // 4. every near tile is inside the near-ring bbox (+1 chunk)
  for (const key of fill.tiles.keys()) {
    const [tx, ty] = key.split(',').map(Number);
    const tb = fill.tileBounds(tx, ty);
    const cxw = (tb[0] + tb[1]) / 2, czw = (tb[2] + tb[3]) / 2;
    ok(cxw >= b.nMinX - CHUNK_WORLD_SIZE && cxw <= b.nMaxX + CHUNK_WORLD_SIZE &&
       czw >= b.nMinZ - CHUNK_WORLD_SIZE && czw <= b.nMaxZ + CHUNK_WORLD_SIZE,
      `${label}: near tile ${key} at (${cxw.toFixed(0)},${czw.toFixed(0)}) outside near bbox`);
  }

  // 5. THE core invariant: near ring + chunks + far ring cover the ENTIRE
  //    cone bbox with no holes (sampled on a grid)
  const step = Math.max(20, fs / 8);
  let gaps = 0, checked = 0;
  for (let x = b.minX; x <= b.maxX; x += step) {
    for (let z = b.minZ; z <= b.maxZ; z += step) {
      checked++;
      const [cx, cy] = cellOf(x, z, 13);
      if (fill.tiles.has(`${cx},${cy}`) || manager.chunks.has(`${cx},${cy}`)) continue;
      const [fx, fy] = cellOf(x, z, fill.farZoom);
      if (fill.farTiles.has(`${fx},${fy}`)) continue;
      gaps++;
    }
  }
  ok(gaps === 0, `${label}: ${gaps}/${checked} sampled points in the cone bbox have NO coverage`);

  // 6. redundancy: far tiles fully covered by near detail (load-order
  //    artifact — harmless, they sit below the near ring, but keep it rare)
  const f = 2 ** (13 - fill.farZoom);
  let redundant = 0;
  outer: for (const key of fill.farTiles.keys()) {
    const [tx, ty] = key.split(',').map(Number);
    for (let y = ty * f; y < (ty + 1) * f; y++) {
      for (let x = tx * f; x < (tx + 1) * f; x++) {
        const c = `${x},${y}`;
        if (!fill.tiles.has(c) && !manager.chunks.has(c)) continue outer;
      }
    }
    redundant++;
  }
  ok(redundant <= Math.max(4, fill.farTiles.size * 0.05),
    `${label}: ${redundant} redundant far tiles (fully covered by near ring)`);

  // 7. fog never hides loaded fill: fogFar >= distance to the farthest
  //    corner of any loaded far tile
  let maxDist = 0;
  for (const [key] of fill.farTiles) {
    const [tx, ty] = key.split(',').map(Number);
    const fb = fill._farBounds(tx, ty);
    for (const [px, pz] of [[fb[0], fb[2]], [fb[0], fb[3]], [fb[1], fb[2]], [fb[1], fb[3]]]) {
      maxDist = Math.max(maxDist, Math.hypot(px - camera.position.x, pz - camera.position.z, camera.position.y));
    }
  }
  ok(fill.fogFar >= maxDist - 0.5,
    `${label}: fogFar ${fill.fogFar?.toFixed(0)} hides loaded fill (max tile corner at ${maxDist.toFixed(0)})`);

  if (errs.length) { errs.forEach((e) => console.error('  ✘ ' + e)); throw new Error(errs.join('; ')); }

  return {
    label,
    altKm: (camera.position.y * 0.1).toFixed(1),
    R: b.R,
    farZoom: fill.farZoom,
    farTiles: fill.farTiles.size,
    nearTiles: fill.tiles.size,
    coverage: `${checked - gaps}/${checked}`,
    redundant,
    fogFar: fill.fogFar.toFixed(0),
  };
}

/** audit the tile URLs fetched during a scenario: right hosts, right zooms,
 *  tile indices inside the expected ranges */
function auditFetches(fromIndex, fill, b, label) {
  const errs = [];
  const [ftx0, fty0] = cellOf(b.minX, b.minZ, fill.farZoom);
  const [ftx1, fty1] = cellOf(b.maxX, b.maxZ, fill.farZoom);
  const [ntx0, nty0] = cellOf(b.nMinX, b.nMinZ, 13);
  const [ntx1, nty1] = cellOf(b.nMaxX, b.nMaxZ, 13);
  for (let i = fromIndex; i < fetched.length; i++) {
    const u = fetched[i];
    const m = u.match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/);
    if (!m) { errs.push(`${label}: non-imagery fetch ${u}`); continue; }
    const [z, y, x] = [+m[1], +m[2], +m[3]];
    if (z === fill.farZoom) {
      if (x < ftx0 - 1 || x > ftx1 + 1 || y < fty0 - 1 || y > fty1 + 1)
        errs.push(`${label}: far fetch z${z}/${x},${y} outside cone range ${ftx0}-${ftx1}/${fty0}-${fty1}`);
    } else if (z === 13) {
      if (x < ntx0 - 1 || x > ntx1 + 1 || y < nty0 - 1 || y > nty1 + 1)
        errs.push(`${label}: near fetch z13/${x},${y} outside near range ${ntx0}-${ntx1}/${nty0}-${nty1}`);
    } else {
      errs.push(`${label}: fetch at unexpected zoom z${z}`);
    }
  }
  if (errs.length) { errs.forEach((e) => console.error('  ✘ ' + e)); throw new Error(errs.join('; ')); }
  return fetched.length - fromIndex;
}

// ---- tiny test harness -------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rows = [];

test('far-tile ↔ z13-child mapping is exact at every adaptive zoom (z6–z10)', async () => {
  const fill = new FillerLayer(new THREE.Scene(), makeManager());
  const [tx, ty] = [4611, 2345];
  for (const z of [6, 7, 8, 9, 10]) {
    fill.farZoom = z;
    fill.farTileSize = fill._zoomSize(z);
    const fb = fill._farBounds(tx, ty); // [x0, x1, z0, z1] of the far tile
    const f = 2 ** (13 - z);
    // the far tile must exactly span children [tx*f, (tx+1)*f) — compare
    // edges (a child TILE's center is half a tile off the child BLOCK's
    // center when f is even, so centers cannot be compared directly)
    const west = fill.tileBounds(tx * f, ty * f);            // first child
    const east = fill.tileBounds((tx + 1) * f - 1, (ty + 1) * f - 1); // last child
    assert.ok(Math.abs(fb[0] - west[0]) < 1e-6 && Math.abs(fb[2] - west[2]) < 1e-6,
      `z${z}: far tile west edge (${fb[0]},${fb[2]}) != first child west edge (${west[0]},${west[2]})`);
    assert.ok(Math.abs(fb[1] - east[1]) < 1e-6 && Math.abs(fb[3] - east[3]) < 1e-6,
      `z${z}: far tile east edge (${fb[1]},${fb[3]}) != last child east edge (${east[1]},${east[3]})`);
    assert.ok(Math.abs((fb[1] - fb[0]) - fill.farTileSize) < 1e-6,
      `z${z}: far tile width ${fb[1] - fb[0]} != farTileSize ${fill.farTileSize}`);
  }
});

test('far-zoom selection follows altitude (R→zoom table)', async () => {
  const fill = new FillerLayer(new THREE.Scene(), makeManager());
  for (const [R, z] of [[2600, 9], [4000, 8], [5600, 8], [9000, 7]]) {
    assert.equal(fill._pickFarZoom(R), z, `_pickFarZoom(${R})`);
  }
});

// altitude sweep: each height gets its own fresh loader; verify resources
// land only inside the expected cone and the fill is contiguous
const SCENARIOS = [
  { alt: 40, look: [0, 0, -100], name: 'low 4 km, north' },      // R = 2600 (min)
  { alt: 150, look: [0, 0, -100], name: '15 km, north' },        // R = 2600, far z9
  { alt: 400, look: [0, 0, -100], name: '40 km, north' },        // R = 4000, far z8
  { alt: 560, look: [0, 0, -100], name: '56 km, north' },       // the reported bug altitude
  { alt: 560, look: [100, 0, 0], name: '56 km, east' },         // yaw independence
  { alt: 900, look: [60, 0, -60], name: '90 km, NE (R capped)' },// R = 9000 (max), far z7
];
for (const s of SCENARIOS) {
  test(`view loader at ${s.name}`, async () => {
    const camera = makeCamera(s.alt, new THREE.Vector3(...s.look));
    const manager = makeManager();
    const fill = new FillerLayer(new THREE.Scene(), manager);
    const from = fetched.length;
    await stabilize(fill, camera);
    rows.push(checkScenario(fill, manager, camera, s.name));
    auditFetches(from, fill, coneBBox(camera, target), s.name);
  });
}

test('altitude change switches far zoom and reloads contiguously (56 km → 15 km)', async () => {
  const manager = makeManager();
  const fill = new FillerLayer(new THREE.Scene(), manager);
  let camera = makeCamera(560, new THREE.Vector3(0, 0, -100));
  await stabilize(fill, camera);
  assert.equal(fill.farZoom, 8, 'initial farZoom at 56 km');

  camera = makeCamera(150, new THREE.Vector3(0, 0, -100));
  await stabilize(fill, camera);
  assert.equal(fill.farZoom, 9, 'farZoom after descending');
  rows.push(checkScenario(fill, manager, camera, 'after 56 km → 15 km descent'));

  camera = makeCamera(900, new THREE.Vector3(0, 0, -100));
  await stabilize(fill, camera);
  assert.equal(fill.farZoom, 7, 'farZoom after climbing to 90 km');
  rows.push(checkScenario(fill, manager, camera, 'after 15 km → 90 km climb'));
});

// ---- run ----------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✘ ${name}`);
    console.error('    ' + (err.message || err));
  }
}

console.log('\n  scenario            | alt   | R    | farZ | far | near | coverage      | redun | fogFar');
console.log('  ---------------------|-------|------|------|-----|------|---------------|-------|-------');
for (const r of rows) {
  console.log(`  ${r.label.padEnd(20)}| ${(r.altKm + ' km').padStart(6)}| ${String(r.R).padStart(5)}| ${String(r.farZoom).padStart(4)} | ${String(r.farTiles).padStart(3)} | ${String(r.nearTiles).padStart(4)} | ${r.coverage.padEnd(13)} | ${String(r.redundant).padStart(5)} | ${r.fogFar}`);
}
console.log(`\n  ${tests.length - failed}/${tests.length} tests passed, ${fetched.length} tile fetches audited`);
process.exit(failed ? 1 : 0);
