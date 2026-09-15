import * as THREE from 'three';
import {
  V,
  TILE_PX,
  TERRAIN_ZOOM,
  tileSpanMeters,
  MERC_NORTH,
  worldToChunk,
  mercToWorld,
  fetchElevationGrid,
  fetchImageryCanvas,
  imageryCooling,
} from './geo.js';

export const CHUNK_SEGS = 36; // 79 m vertex spacing — matches v1's 78 m (20000/255); finer sampling amplifies facet speckle

const chunkSpan = tileSpanMeters(TERRAIN_ZOOM);
export const CHUNK_WORLD_SIZE = chunkSpan * V * Math.cos((54.6858 * Math.PI) / 180);

class Chunk {
  constructor(tx, ty, scene, satelliteOn) {
    this.tx = tx;
    this.ty = ty;
    this.key = `${tx},${ty}`;
    this.scene = scene;
    this.group = new THREE.Group();

    const [cx, cz] = mercToWorld(
      (tx + 0.5) * chunkSpan - MERC_NORTH,
      MERC_NORTH - (ty + 0.5) * chunkSpan
    );
    this.group.position.set(cx, 0, cz);
    this.group.visible = false; // hidden until satellite imagery is applied
    this.wx0 = cx; // chunk center in world units
    this.wz0 = cz;

    // chunk bounds in world units
    const half = CHUNK_WORLD_SIZE / 2;
    this.minX = cx - half;
    this.maxX = cx + half;
    this.minZ = cz - half;
    this.maxZ = cz + half;

    this.grid = null; // Float32Array 256x256 elevations (tile space)
    this.state = 'loading'; // loading | ready | failed
    this.satelliteOn = satelliteOn;
    this.material = null;
    this.terrain = null;
    this.borderLines = null;
    this.wardLines = null; // built externally via setWardLines()
  }

  sampleElev(u, v) {
    const g = this.grid;
    if (!g) return 0;
    const n = TILE_PX;
    const fx = Math.max(0, Math.min(n - 1.0001, u * (n - 1)));
    const fy = Math.max(0, Math.min(n - 1.0001, v * (n - 1)));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const dx = fx - x0, dy = fy - y0;
    const e00 = g[y0 * n + x0], e10 = g[y0 * n + x0 + 1];
    const e01 = g[(y0 + 1) * n + x0], e11 = g[(y0 + 1) * n + x0 + 1];
    return e00 * (1 - dx) * (1 - dy) + e10 * dx * (1 - dy) + e01 * (1 - dx) * dy + e11 * dx * dy;
  }

  worldToUV(wx, wz) {
    return [(wx - this.minX) / CHUNK_WORLD_SIZE, (wz - this.minZ) / CHUNK_WORLD_SIZE];
  }

  buildMesh(defaultColor) {
    const S = CHUNK_WORLD_SIZE;
    const segs = CHUNK_SEGS;
    const n = segs + 1;

    this.vertexElevs = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        this.vertexElevs[r * n + c] = this.sampleElev(c / segs, r / segs);
      }
    }

    // border ring (grid indices), clockwise seen from above: north L→R,
    // east N→S, south R→L, west S→N — gives outward-facing skirt triangles
    const ring = [];
    for (let c = 0; c < n; c++) ring.push(c);
    for (let r = 1; r < n; r++) ring.push(r * n + n - 1);
    for (let c = n - 2; c >= 0; c--) ring.push((n - 1) * n + c);
    for (let r = n - 2; r >= 1; r--) ring.push(r * n);
    this.skirtRing = ring;
    this.gridN = n;

    const vertCount = n * n + ring.length;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        positions[i * 3] = -S / 2 + (c / segs) * S;
        positions[i * 3 + 1] = 0; // heights applied by setHeights()
        positions[i * 3 + 2] = -S / 2 + (r / segs) * S;
        uvs[i * 2] = c / segs;
        uvs[i * 2 + 1] = 1 - r / segs; // v=1 at north — matches PlaneGeometry+rotateX(-π/2) parity
      }
    }
    for (let k = 0; k < ring.length; k++) {
      const g = ring[k];
      positions[(n * n + k) * 3] = positions[g * 3];
      positions[(n * n + k) * 3 + 1] = 0;
      positions[(n * n + k) * 3 + 2] = positions[g * 3 + 2];
      uvs[(n * n + k) * 2] = uvs[g * 2];
      uvs[(n * n + k) * 2 + 1] = uvs[g * 2 + 1];
    }

    const indices = [];
    for (let r = 0; r < segs; r++) {
      for (let c = 0; c < segs; c++) {
        const i0 = r * n + c, i1 = i0 + 1, i2 = i0 + n, i3 = i2 + 1;
        indices.push(i0, i2, i1, i1, i2, i3); // upward-facing
      }
    }
    const rl = ring.length;
    for (let k = 0; k < rl; k++) {
      const k2 = (k + 1) % rl;
      const a = ring[k], b = ring[k2];
      const a2 = n * n + k, b2 = n * n + k2;
      indices.push(a, b, b2, a, b2, a2); // outward-facing skirt wall
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    this.material = new THREE.MeshStandardMaterial({
      color: defaultColor,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
    });
    this.terrain = new THREE.Mesh(geo, this.material);
    this.terrain.frustumCulled = false; // skirt hangs below the surface bbox
    this.group.add(this.terrain);

    this.scene.add(this.group);
  }

  setWardLines(geometry, pairs) {
    geometry.dispose();
    this.wardPairs = [];
  }

  applyImagery(canvas, zoom = 13) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8; // v1 parity
    if (zoom === 13 || !this.baseTex) this.baseTex = tex; // base tier is kept for downgrades
    if (this.imageryTex && this.imageryTex !== this.baseTex) this.imageryTex.dispose();
    this.imageryTex = tex;
    this.imageryZoom = zoom;
    if (this.satelliteOn) {
      this.material.map = tex;
      this.material.color.set(0xffffff);
      this.material.needsUpdate = true;
    }
    this.group.visible = true; // imagery ready — show the chunk
  }

  downgradeImagery() {
    if ((this.imageryZoom ?? 13) <= 13 || !this.baseTex) return;
    if (this.imageryTex && this.imageryTex !== this.baseTex) this.imageryTex.dispose();
    this.imageryTex = this.baseTex;
    this.imageryZoom = 13;
    if (this.satelliteOn && this.material) {
      this.material.map = this.baseTex;
      this.material.needsUpdate = true;
    }
  }

  revealWithoutImagery() {
    this.group.visible = true;
  }

  setTerrainVisible(v) {
    if (this.terrain) this.terrain.visible = v;
  }

  setWireframe(v) {
    if (this.material) this.material.wireframe = v;
  }

  setFlatShading(v) {
    if (this.material) {
      this.material.flatShading = v;
      this.material.needsUpdate = true;
    }
  }

  setSatellite(on) {
    this.satelliteOn = on;
    if (!this.material) return;
    if (on && this.imageryTex) {
      this.material.map = this.imageryTex;
      this.material.color.set(0xffffff);
    } else {
      this.material.map = null;
      this.material.color.copy(sharedMats.terrainColor);
    }
    this.material.needsUpdate = true;
  }

  setHeights(exaggeration) {
    this.exaggeration = exaggeration;
    if (!this.terrain) return;
    const pos = this.terrain.geometry.attributes.position;
    for (let i = 0; i < this.vertexElevs.length; i++) {
      pos.setY(i, this.vertexElevs[i] * V * exaggeration);
    }
    // skirt ring follows the border heights, dropped below the surface
    if (this.skirtRing) {
      const base = this.gridN * this.gridN;
      for (let k = 0; k < this.skirtRing.length; k++) {
        pos.setY(base + k, this.vertexElevs[this.skirtRing[k]] * V * exaggeration - SKIRT_DEPTH);
      }
    }
    pos.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();

    const setPairs = (obj, pairs, offset) => {
      if (!obj) return;
      const p = obj.geometry.attributes.position;
      for (const [vi, elev] of pairs) p.setY(vi, elev * V * exaggeration + offset);
      p.needsUpdate = true;
    };
    setPairs(this.borderLines, this.borderPairs, 0.12);
    setPairs(this.wardLines, this.wardPairs || [], 0.15);
  }

  dispose() {
    // dispose BOTH texture tiers — after a z16 upgrade imageryTex and
    // baseTex are distinct, and leaking the base GPU texture on every
    // chunk churn was OOM-killing mobile GPUs
    if (this.imageryTex) this.imageryTex.dispose();
    if (this.baseTex && this.baseTex !== this.imageryTex) this.baseTex.dispose();
    if (this.terrain) {
      this.terrain.geometry.dispose();
      this.material.dispose();
    }
    if (this.borderLines) {
      this.borderLines.geometry.dispose();
      this.borderLines.material.dispose();
    }
    if (this.wardLines) this.wardLines.geometry.dispose();
    this.scene.remove(this.group);
  }
}

const sharedMats = {
  grid: new THREE.LineBasicMaterial({ color: 0xe8eaed, transparent: true, opacity: 0.45 }),
  wards: new THREE.LineBasicMaterial({ color: 0xff5964 }),
  terrainColor: new THREE.Color(0xb8a47e),
};

// touch detection (guarded for headless tests, where matchMedia is absent)
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const MAX_CHUNKS = IS_TOUCH ? 80 : 120; // hard cap so a zoom-out cannot queue thousands of tiles
// z16 imagery is a 2048×2048 canvas (16 MB RGBA) per chunk — doubled by the
// GPU upload and parked in the decoded cache. Phones can't afford 3 of
// those on top of everything else, so touch caps the LOD at z15 (512²).
const MAX_IMAGERY_ZOOM = IS_TOUCH ? 15 : 16;
// how many chunks may hold top-tier imagery at once — each is a big canvas
// (16 MB at z16 desktop, 1 MB at z15 touch, doubled again by canvas backing).
// Without this cap every chunk within 120 units upgraded on touch and the
// accumulated ~2.5 MB/chunk OOM-killed phones at ~70 chunks.
const TOP_TIER_MAX = IS_TOUCH ? 8 : 3;
const SKIRT_DEPTH = 1.5; // scene units (1 unit = 100 m) — covers inter-chunk height mismatch
const DISPATCH_LIMIT = 10; // loads in flight; the rest wait and re-sort as you look around

export class ChunkManager {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.pending = new Set();
    this.queue = []; // wanted-but-not-yet-dispatched chunk keys, view-priority sorted
    this.satelliteOn = true; // streaming build: imagery is the default mode
    this.onChunkReady = []; // callbacks(chunk)
    this.onStatus = []; // callbacks({loaded, loading})
  }

  get readyCount() {
    let n = 0;
    for (const c of this.chunks.values()) if (c.state === 'ready') n++;
    return n;
  }

  _emitStatus() {
    const s = { loaded: this.readyCount, loading: this.pending.size };
    for (const cb of this.onStatus) cb(s);
  }

  _wantedChunks(camera, target) {
    // HOW FAR we load is altitude-driven; WHERE is camera position + view
    // yaw. Pitch never changes the set — looking up/down loads/unloads
    // nothing, looking around shifts the cone, moving shifts the circle.
    const MAX_GROUND_RADIUS = 500; // scene units — don't chase the horizon
    const R = Math.max(120, Math.min(MAX_GROUND_RADIUS, 50 + camera.position.y));

    // horizontal view direction only (yaw): project forward onto the xz plane
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    camera.getWorldDirection(fwd);
    let fx = fwd.x, fz = fwd.z;
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = 0; fz = 0; }

    // cone: a circle offset toward the yaw — roughly R behind the camera,
    // roughly 2R ahead (looking straight down gives a plain circle)
    const off = 0.5 * R;
    const r = 1.5 * R;
    const gx = camera.position.x + fx * off;
    const gz = camera.position.z + fz * off;
    let minX = gx - r, maxX = gx + r;
    let minZ = gz - r, maxZ = gz + r;

    // include the orbit target and pad generously (2 tiles so screen
    // edges never sit on the load boundary)
    minX = Math.min(minX, target.x) - 2 * CHUNK_WORLD_SIZE;
    maxX = Math.max(maxX, target.x) + 2 * CHUNK_WORLD_SIZE;
    minZ = Math.min(minZ, target.z) - 2 * CHUNK_WORLD_SIZE;
    maxZ = Math.max(maxZ, target.z) + 2 * CHUNK_WORLD_SIZE;

    const [cxa, cya] = worldToChunk(minX, minZ); // north-west (higher tile-y)
    const [cxb, cyb] = worldToChunk(maxX, maxZ); // south-east (lower tile-y)
    const cx0 = Math.min(cxa, cxb), cx1 = Math.max(cxa, cxb);
    const cy0 = Math.min(cya, cyb), cy1 = Math.max(cya, cyb);
    const keys = [];
    for (let ty = cy0; ty <= cy1; ty++)
      for (let tx = cx0; tx <= cx1; tx++) keys.push(`${tx},${ty}`);
    // when capping, keep what's ahead of the camera first, then near.
    // terrain is hard-capped at 120 chunks — when zoomed out far, terrain
    // detail doesn't matter; the satellite fill (filler.js, uncapped far
    // ring) is what keeps covering the view
    const cap = MAX_CHUNKS;
    if (keys.length > cap) {
      keys.sort((a, b) => this._viewPriority(a, camera) - this._viewPriority(b, camera));
      keys.length = cap;
    }
    return keys;
  }

  chunkCenterWorld(tx, ty) {
    return mercToWorld(
      (tx + 0.5) * chunkSpan - MERC_NORTH,
      MERC_NORTH - (ty + 0.5) * chunkSpan
    );
  }

  _viewPriority(key, camera) {
    const [tx, ty] = key.split(',').map(Number);
    const [cx, cz] = this.chunkCenterWorld(tx, ty);
    const dx = cx - camera.position.x;
    const dz = cz - camera.position.z;
    const dist = Math.hypot(dx, dz) || 1;
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    camera.getWorldDirection(fwd);
    const alignment = (dx * fwd.x + dz * fwd.z) / dist; // 1 ahead … -1 behind
    // near-first with a moderate view-cone bonus: a near chunk to the side
    // loads before a distant one straight ahead (0.8x ahead … 1.7x behind)
    return dist * (1.25 - 0.45 * alignment);
  }

  update(camera, target) {
    const wanted = new Set(this._wantedChunks(camera, target));

    for (const [key, chunk] of this.chunks) {
      if (!wanted.has(key)) {
        chunk.dispose();
        this.chunks.delete(key);
        this._emitStatus();
      }
    }

    // maintain the waiting queue; it is re-sorted every update so turning
    // to look elsewhere immediately re-prioritizes what loads next
    this.queue = this.queue.filter((k) => wanted.has(k) && !this.chunks.has(k));
    for (const key of wanted) {
      if (!this.chunks.has(key) && !this.pending.has(key) && !this.queue.includes(key)) {
        this.queue.push(key);
      }
    }
    this.queue.sort((a, b) => this._viewPriority(a, camera) - this._viewPriority(b, camera));

    // dispatch a limited number of loads; the rest wait (and re-sort as you look)
    while (this.queue.length && this.pending.size < DISPATCH_LIMIT) {
      const key = this.queue.shift();
      if (this.chunks.has(key) || this.pending.has(key)) continue;
      const [tx, ty] = key.split(',').map(Number);
      this._loadChunk(tx, ty);
    }
    this._updateLod(camera);
  }

  // (re)dispatch base imagery for a chunk — retried with a 10s backoff
  // after failures, so a transient outage (rate limit, network handoff)
  // leaves chunks flat only until the next retry, not forever
  _ensureImagery(chunk) {
    if (chunk.imageryTex || chunk.imageryPending) return;
    chunk.imageryPending = true;
    fetchImageryCanvas(chunk.tx, chunk.ty)
      .then((canvas) => {
        if (this.chunks.get(chunk.key) === chunk) chunk.applyImagery(canvas);
      })
      .catch(() => {
        chunk.imageryFailedAt = performance.now();
        chunk.revealWithoutImagery(); // visible flat while the retry runs
      })
      .finally(() => {
        chunk.imageryPending = false;
      });
  }

  _updateLod(camera) {
    const cam = camera.position;
    const ready = [...this.chunks.values()].filter((c) => c.state === 'ready');
    ready.sort(
      (a, b) => cam.distanceToSquared(a.group.position) - cam.distanceToSquared(b.group.position)
    );
    let atTop = 0;
    // imagery retry pass: chunks that failed their base imagery get
    // re-dispatched every 10s (max 3 per pass so a throttled server isn't
    // hammered) — previously one transient failure meant flat terrain forever
    const now = performance.now();
    let retries = 0;
    if (!imageryCooling()) {
      for (const c of ready) {
        if (retries >= 3) break;
        if (!c.imageryTex && !c.imageryPending && now - (c.imageryFailedAt || 0) > 10000) {
          this._ensureImagery(c);
          retries++;
        }
      }
    }
    for (const c of ready) {
      const d = cam.distanceTo(c.group.position);
      // touch: only the nearest TOP_TIER_MAX chunks get z15 — the rest stay
      // at base z13 (desktop keeps its z15 mid-tier inside 120 units)
      let target = d < 25 ? MAX_IMAGERY_ZOOM : d < 120 && !IS_TOUCH ? 15 : 13;
      if (target === MAX_IMAGERY_ZOOM) {
        if (atTop >= TOP_TIER_MAX) target = IS_TOUCH ? 13 : 15;
        else atTop++;
      }
      const cur = c.imageryZoom ?? 13;
      if (target > cur && !c.imageryUpgrade) {
        if (target === MAX_IMAGERY_ZOOM && (this._topInFlight || this.pending.size > 0)) continue; // don't starve chunk loads
        if (target === MAX_IMAGERY_ZOOM) this._topInFlight = true;
        c.imageryUpgrade = true;
        fetchImageryCanvas(c.tx, c.ty, target)
          .then((canvas) => {
            if (this.chunks.get(c.key) === c) c.applyImagery(canvas, target);
          })
          .catch(() => { /* keep the current tier */ })
          .finally(() => {
            c.imageryUpgrade = false;
            if (target === MAX_IMAGERY_ZOOM) this._topInFlight = false;
          });
      } else if (IS_TOUCH ? (cur > 13 && d > 50) : (target < cur && cur === 16)) {
        // touch: downgrade z15 only well past the upgrade radius (25) — a
        // hard boundary makes movement flap chunks between tiers, and each
        // flap re-fetches 16 sub-tiles through the shared fetch queue
        c.downgradeImagery();
      }
    }
  }

  _stitchChunk(chunk) {
    const n = chunk.gridN;
    if (!n) return;
    const touched = new Set([chunk]);
    const neighbor = (dx, dy) => this.chunks.get(`${chunk.tx + dx},${chunk.ty + dy}`);
    const glueEdge = (other, mine, theirs) => {
      // mine/theirs: (r) => vertex index on the shared edge
      if (!other || !other.gridN) return;
      for (let r = 0; r < n; r++) {
        const i = mine(r), j = theirs(r);
        const avg = (chunk.vertexElevs[i] + other.vertexElevs[j]) / 2;
        chunk.vertexElevs[i] = avg;
        other.vertexElevs[j] = avg;
      }
      touched.add(other);
    };
    glueEdge(neighbor(1, 0), (r) => r * n + (n - 1), (r) => r * n);             // east ↔ west
    glueEdge(neighbor(-1, 0), (r) => r * n, (r) => r * n + (n - 1));             // west ↔ east
    glueEdge(neighbor(0, -1), (r) => r, (r) => (n - 1) * n + r);                 // north ↔ south
    glueEdge(neighbor(0, 1), (r) => (n - 1) * n + r, (r) => r);                  // south ↔ north
    for (const c of touched) c.setHeights(this.effectiveExaggeration);
  }

  async _loadChunk(tx, ty) {
    const key = `${tx},${ty}`;
    this.pending.add(key);
    this._emitStatus();
    const chunk = new Chunk(tx, ty, this.scene, this.satelliteOn);
    this.chunks.set(key, chunk);
    try {
      const grid = await fetchElevationGrid(tx, ty);
      chunk.grid = grid;
      chunk.buildMesh(sharedMats.terrainColor);
      chunk.setHeights(this.effectiveExaggeration);
      this._stitchChunk(chunk);
      chunk.setSatellite(this.satelliteOn);
      chunk.setWireframe(this.wireframe ?? false);
      chunk.setFlatShading(this.flatShading ?? true);
      chunk.setTerrainVisible(this.terrainVisible ?? true);
      chunk.state = 'ready';
      for (const cb of this.onChunkReady) cb(chunk);
      this._emitStatus();
      // imagery streams in after the mesh is built; the chunk stays hidden
      // until it arrives (or fails, in which case reveal in flat color — the
      // _updateLod retry pass re-dispatches every 10s until it succeeds)
      this._ensureImagery(chunk);
    } catch (err) {
      chunk.state = 'failed';
      this.chunks.delete(key);
      console.warn(`chunk ${key} failed:`, err.message);
      this._emitStatus();
    } finally {
      this.pending.delete(key);
      this._emitStatus();
    }
  }

  setExaggeration(f) {
    this.exaggeration = f;
    this.updateHeights();
  }

  setFlatten(on) {
    this.flatten = on;
    this.updateHeights();
  }

  get effectiveExaggeration() {
    return this.flatten ? 0 : (this.exaggeration ?? 15);
  }

  updateHeights() {
    for (const chunk of this.chunks.values()) chunk.setHeights(this.effectiveExaggeration);
  }

  groundWorldY(wx, wz) {
    for (const chunk of this.chunks.values()) {
      if (wx >= chunk.minX && wx < chunk.maxX && wz >= chunk.minZ && wz < chunk.maxZ) {
        const [u, v] = chunk.worldToUV(wx, wz);
        return chunk.sampleElev(u, v) * V * this.effectiveExaggeration;
      }
    }
    return null;
  }

  setTerrainVisibleAll(v) {
    this.terrainVisible = v;
    for (const chunk of this.chunks.values()) chunk.setTerrainVisible(v);
  }

  setWireframeAll(v) {
    this.wireframe = v;
    for (const chunk of this.chunks.values()) chunk.setWireframe(v);
  }

  setFlatShadingAll(v) {
    this.flatShading = v;
    for (const chunk of this.chunks.values()) chunk.setFlatShading(v);
  }

  setTerrainColor(color) {
    sharedMats.terrainColor.set(color);
    for (const chunk of this.chunks.values()) {
      if (chunk.material && !chunk.satelliteOn) chunk.material.color.set(color);
    }
  }

  setGridColor(color) {
    sharedMats.grid.color.set(color);
    for (const chunk of this.chunks.values()) {
      if (chunk.borderLines) chunk.borderLines.material.color.set(color);
    }
  }

  setWardColor(color) {
    sharedMats.wards.color.set(color);
  }

  setSatellite(on) {
    this.satelliteOn = on;
    for (const chunk of this.chunks.values()) chunk.setSatellite(on);
  }

  setGridVisible(v) {
    for (const chunk of this.chunks.values()) {
      if (chunk.borderLines) chunk.borderLines.visible = v;
    }
  }

  setWardVisible(v) {
    for (const chunk of this.chunks.values()) {
      if (chunk.wardLines) chunk.wardLines.visible = v;
    }
  }
}
