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
} from './geo.js';

export const CHUNK_SEGS = 36; // 79 m vertex spacing — matches v1's 78 m (20000/255); finer sampling amplifies facet speckle

const chunkSpan = tileSpanMeters(TERRAIN_ZOOM);
export const CHUNK_WORLD_SIZE = chunkSpan * V * Math.cos((54.6858 * Math.PI) / 180);

/**
 * One terrain chunk = one z12 Terrarium tile + its Esri imagery.
 * Heights are absolute elevations (meters); y = elev * V * exaggeration,
 * evaluated on demand so the exaggeration slider stays live.
 */
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

  /** Bilinear elevation sample from the tile grid; u,v in 0..1 (u west->east, v north->south). */
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

  /** world (x,z) -> (u,v) in tile space */
  worldToUV(wx, wz) {
    return [(wx - this.minX) / CHUNK_WORLD_SIZE, (wz - this.minZ) / CHUNK_WORLD_SIZE];
  }

  /** Build the mesh from the elevation grid (with a skirt — a short wall
   *  dropped below the chunk border that hides the hairline cracks between
   *  neighbouring tiles, whose edge elevations never match exactly). */
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

  /** Attach ward-line overlay built by wards.js (chunk-local positions + base elevations).
   *  Line rendering disabled ("remove the grid lines") — only the ward label sprites remain. */
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

  /** Drop a high-tier texture back to the base z13 imagery. */
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

  /** Reveal without imagery (fallback when the imagery tile failed). */
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
    if (this.imageryTex) this.imageryTex.dispose();
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

const MAX_CHUNKS = 120; // hard cap so a zoom-out cannot queue thousands of tiles
const SKIRT_DEPTH = 1.5; // scene units (1 unit = 100 m) — covers inter-chunk height mismatch
const DISPATCH_LIMIT = 10; // loads in flight; the rest wait and re-sort as you look around

/**
 * Loads chunks around the camera target (viewport-driven), disposes far ones.
 */
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

  /** Which chunks should be loaded, given the camera. */
  _wantedChunks(camera, target) {
    // raycast screen corners onto the y=0 plane to get the visible ground bbox
    const corners = [
      new THREE.Vector2(-1, 1), new THREE.Vector2(1, 1),
      new THREE.Vector2(-1, -1), new THREE.Vector2(1, -1),
    ];
    const ray = new THREE.Raycaster();
    const MAX_GROUND_RADIUS = 500; // scene units — don't chase the horizon
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const corner of corners) {
      ray.setFromCamera(corner, camera);
      let t = -ray.ray.origin.y / ray.ray.direction.y;
      if (t > 0) {
        t = Math.min(t, 3000); // avoid near-horizontal ray explosions
        const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
        // clamp to a disc around the orbit target
        p.x = Math.max(target.x - MAX_GROUND_RADIUS, Math.min(target.x + MAX_GROUND_RADIUS, p.x));
        p.z = Math.max(target.z - MAX_GROUND_RADIUS, Math.min(target.z + MAX_GROUND_RADIUS, p.z));
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    }
    // look-ahead: extend the loaded ground to ~2x what is visible ahead of the
    // camera (scaled by the horizontal forward components, so diagonal looks
    // extend diagonally; looking straight down adds nothing)
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const gx = camera.position.x, gz = camera.position.z;
    if (fwd.x > 0) maxX += Math.max(0, maxX - gx) * 2 * fwd.x;
    else if (fwd.x < 0) minX -= Math.max(0, gx - minX) * -2 * fwd.x;
    if (fwd.z > 0) maxZ += Math.max(0, maxZ - gz) * 2 * fwd.z;
    else if (fwd.z < 0) minZ -= Math.max(0, gz - minZ) * -2 * fwd.z;

    // include the orbit target and pad generously
    minX = Math.min(minX, target.x) - CHUNK_WORLD_SIZE;
    maxX = Math.max(maxX, target.x) + CHUNK_WORLD_SIZE;
    minZ = Math.min(minZ, target.z) - CHUNK_WORLD_SIZE;
    maxZ = Math.max(maxZ, target.z) + CHUNK_WORLD_SIZE;

    const [cxa, cya] = worldToChunk(minX, minZ); // north-west (higher tile-y)
    const [cxb, cyb] = worldToChunk(maxX, maxZ); // south-east (lower tile-y)
    const cx0 = Math.min(cxa, cxb), cx1 = Math.max(cxa, cxb);
    const cy0 = Math.min(cya, cyb), cy1 = Math.max(cya, cyb);
    const keys = [];
    for (let ty = cy0; ty <= cy1; ty++)
      for (let tx = cx0; tx <= cx1; tx++) keys.push(`${tx},${ty}`);
    // when capping, keep what's ahead of the camera first, then near
    if (keys.length > MAX_CHUNKS) {
      keys.sort((a, b) => this._viewPriority(a, camera) - this._viewPriority(b, camera));
      keys.length = MAX_CHUNKS;
    }
    return keys;
  }

  /** Chunk-center world position for a tile coordinate. */
  chunkCenterWorld(tx, ty) {
    return mercToWorld(
      (tx + 0.5) * chunkSpan - MERC_NORTH,
      MERC_NORTH - (ty + 0.5) * chunkSpan
    );
  }

  /**
   * Loading priority: chunks in front of the camera load first.
   * score = distance × (1.5 − alignment) — aligned (ahead) chunks get a
   * discounted distance, chunks behind the viewer are penalized.
   */
  _viewPriority(key, camera) {
    const [tx, ty] = key.split(',').map(Number);
    const [cx, cz] = this.chunkCenterWorld(tx, ty);
    const dx = cx - camera.position.x;
    const dz = cz - camera.position.z;
    const dist = Math.hypot(dx, dz) || 1;
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    camera.getWorldDirection(fwd);
    const alignment = (dx * fwd.x + dz * fwd.z) / dist; // 1 ahead … -1 behind
    return dist * (1.5 - alignment);
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

  /**
   * Distance-based imagery LOD:
   *   far        — z13 (~11 m/px, one tile)
   *   < 120 u    — z15 (~2.8 m/px, 4 tiles)
   *   < 25 u     — z16 (~1.4 m/px, 64 tiles) — closest chunks only,
   *                 one heavy upgrade in flight, only when nothing else loads
   */
  _updateLod(camera) {
    const cam = camera.position;
    const ready = [...this.chunks.values()].filter((c) => c.state === 'ready');
    ready.sort(
      (a, b) => cam.distanceToSquared(a.group.position) - cam.distanceToSquared(b.group.position)
    );
    let atZ16 = 0;
    for (const c of ready) {
      const d = cam.distanceTo(c.group.position);
      let target = d < 25 ? 16 : d < 120 ? 15 : 13;
      if (target === 16) {
        if (atZ16 >= 3) target = 15;
        else atZ16++;
      }
      const cur = c.imageryZoom ?? 13;
      if (target > cur && !c.imageryUpgrade) {
        if (target === 16 && (this._z16InFlight || this.pending.size > 0)) continue; // don't starve chunk loads
        if (target === 16) this._z16InFlight = true;
        c.imageryUpgrade = true;
        fetchImageryCanvas(c.tx, c.ty, target)
          .then((canvas) => {
            if (this.chunks.get(c.key) === c) c.applyImagery(canvas, target);
          })
          .catch(() => { /* keep the current tier */ })
          .finally(() => {
            c.imageryUpgrade = false;
            if (target === 16) this._z16InFlight = false;
          });
      } else if (target < cur && cur === 16) {
        c.downgradeImagery();
      }
      // z15 is sticky — no downgrade cost worth the visual pop
    }
  }

  /** Glue chunk edges: where two loaded chunks meet, force their shared
   *  border vertex elevations to the average of both tiles' samples, so the
   *  meshes join exactly — no cracks, regardless of inter-tile sampling
   *  differences (each tile's edge pixels sit ~78 m apart in the real world). */
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
      // until it arrives (or fails, in which case reveal in flat color)
      fetchImageryCanvas(tx, ty)
        .then((canvas) => {
          if (this.chunks.get(key) === chunk) chunk.applyImagery(canvas);
        })
        .catch(() => {
          if (this.chunks.get(key) === chunk) chunk.revealWithoutImagery();
        });
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

  /** Current terrain surface height (scene units) at a world position, or null if not loaded. */
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
