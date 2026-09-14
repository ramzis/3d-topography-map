import * as THREE from 'three';
import {
  TERRAIN_ZOOM, tileSpanMeters, MERC_NORTH, WORLD_SCALE,
  worldToMerc, mercToWorld, fetchImageryCanvas,
} from './geo.js';
import { CHUNK_WORLD_SIZE } from './chunks.js';

const FILLER_MARGIN = 0.3;    // how far below the sampled edge heights the plane sits
const MAX_RADIUS = 2600;     // the fog edge — nothing beyond this is visible anyway
const TILES_IN_FLIGHT = 6;
const MAX_TILES = 400;
const EPS = 1;                // sample offset INTO the neighbouring chunk
const WALL_SEGMENTS = 8;      // samples along a shared edge
const REBUILD_TOL = 0.05;

export class FillerLayer {
  constructor(scene, manager) {
    this.scene = scene;
    this.manager = manager;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tiles = new Map();   // "tx,ty" -> { mesh, planeY, walls: Map, wallsKey }
    this.pending = new Set();
  }

  update(camera, target) {
    // visible ground bbox: raycast the screen corners onto the y=0 plane
    const corners = [
      new THREE.Vector2(-1, 1), new THREE.Vector2(1, 1),
      new THREE.Vector2(-1, -1), new THREE.Vector2(1, -1),
    ];
    const ray = new THREE.Raycaster();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const corner of corners) {
      ray.setFromCamera(corner, camera);
      let t = -ray.ray.origin.y / ray.ray.direction.y;
      if (t > 0) {
        t = Math.min(t, 3000);
        const p = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
        p.x = Math.max(target.x - MAX_RADIUS, Math.min(target.x + MAX_RADIUS, p.x));
        p.z = Math.max(target.z - MAX_RADIUS, Math.min(target.z + MAX_RADIUS, p.z));
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    }
    if (minX === Infinity) return;
    minX -= CHUNK_WORLD_SIZE; maxX += CHUNK_WORLD_SIZE;
    minZ -= CHUNK_WORLD_SIZE; maxZ += CHUNK_WORLD_SIZE;

    const spanMerc = tileSpanMeters(TERRAIN_ZOOM);
    const [mx, my] = worldToMerc(target.x, target.z);
    const cx = Math.floor((mx + MERC_NORTH) / spanMerc);
    const cy = Math.floor((MERC_NORTH - my) / spanMerc);

    const toTileX = (wx) => Math.floor((worldToMerc(wx, 0)[0] + MERC_NORTH) / spanMerc);
    const toTileY = (wz) => Math.floor((MERC_NORTH - worldToMerc(0, wz)[1]) / spanMerc);
    const tx0 = toTileX(minX), tx1 = toTileX(maxX);
    const ty0 = toTileY(minZ), ty1 = toTileY(maxZ);

    // drop filler tiles that scrolled out of view
    for (const [key, t] of this.tiles) {
      const [tx, ty] = key.split(',').map(Number);
      if (tx < tx0 - 1 || tx > tx1 + 1 || ty < ty0 - 1 || ty > ty1 + 1) {
        this._disposeTile(t);
        this.tiles.delete(key);
      }
    }

    this._retile();

    const wanted = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx},${ty}`;
        if (this.tiles.has(key) || this.pending.has(key)) continue;
        if (this.manager.chunks.has(key)) continue; // terrain handles it
        if (this.tiles.size + this.pending.size + wanted.length >= MAX_TILES) continue;
        wanted.push([tx, ty, Math.abs(tx - cx) + Math.abs(ty - cy)]);
      }
    }
    wanted.sort((a, b) => a[2] - b[2]);
    for (const [tx, ty] of wanted) {
      if (this.pending.size >= TILES_IN_FLIGHT) break;
      this._loadTile(tx, ty);
    }
  }

  tileBounds(tx, ty) {
    const spanMerc = tileSpanMeters(TERRAIN_ZOOM);
    const [wx, wz] = mercToWorld(
      (tx + 0.5) * spanMerc - MERC_NORTH,
      MERC_NORTH - (ty + 0.5) * spanMerc
    );
    const h = CHUNK_WORLD_SIZE / 2;
    return [wx - h, wx + h, wz - h, wz + h]; // x0, x1, z0 (north), z1 (south)
  }

  /**
   * For each side with a loaded chunk neighbour: sample the neighbour's
   * terrain heights along the shared edge (from inside the neighbour).
   * Returns [{ dx, dy, heights[] }, ...]
   */
  _edgeSamples(tx, ty) {
    const [x0, x1, z0, z1] = this.tileBounds(tx, ty);
    const g = this.manager.groundWorldY.bind(this.manager);
    const sides = [
      { dx: 0, dy: -1, at: (i) => [x0 + (x1 - x0) * (i / WALL_SEGMENTS), z0 - EPS] },
      { dx: 0, dy: 1, at: (i) => [x0 + (x1 - x0) * (i / WALL_SEGMENTS), z1 + EPS] },
      { dx: -1, dy: 0, at: (i) => [x0 - EPS, z0 + (z1 - z0) * (i / WALL_SEGMENTS)] },
      { dx: 1, dy: 0, at: (i) => [x1 + EPS, z0 + (z1 - z0) * (i / WALL_SEGMENTS)] },
    ];
    const out = [];
    for (const side of sides) {
      if (!this.manager.chunks.has(`${tx + side.dx},${ty + side.dy}`)) continue;
      const heights = [];
      let ok = true;
      for (let i = 0; i <= WALL_SEGMENTS; i++) {
        const [px, pz] = side.at(i);
        const gy = g(px, pz);
        if (gy === null) { ok = false; break; } // neighbour not fully usable
        heights.push(gy);
      }
      if (ok) out.push({ dx: side.dx, dy: side.dy, heights, x0, x1, z0, z1 });
    }
    return out;
  }

  /** Plane height: a hair below the lowest sampled neighbour edge. */
  _planeY(tx, ty, edges) {
    let min = Infinity;
    for (const e of edges) min = Math.min(min, ...e.heights);
    if (min !== Infinity) return min - FILLER_MARGIN;
    let sum = 0, n = 0;
    for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = this.tiles.get(`${tx + nx},${ty + ny}`);
      if (t) { sum += t.planeY; n++; }
    }
    return n ? sum / n : -1;
  }

  async _loadTile(tx, ty) {
    const key = `${tx},${ty}`;
    this.pending.add(key);
    try {
      const canvas = await fetchImageryCanvas(tx, ty); // same z13 imagery as terrain
      if (this.tiles.has(key)) return;

      const [x0, x1, z0, z1] = this.tileBounds(tx, ty);
      const edges = this._edgeSamples(tx, ty);
      const planeY = this._planeY(tx, ty, edges);

      const geo = new THREE.PlaneGeometry(CHUNK_WORLD_SIZE, CHUNK_WORLD_SIZE);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial(); // unlit: raw satellite colours
      mat.map = new THREE.CanvasTexture(canvas);
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.anisotropy = 8;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((x0 + x1) / 2, planeY, (z0 + z1) / 2);
      this.group.add(mesh);

      const tile = { mesh, mat, planeY, walls: new Map(), wallsKey: '' };
      this.tiles.set(key, tile);
      this._buildWalls(tile, tx, ty, edges, planeY);
    } catch {
      /* a failed tile retries on the next pass */
    } finally {
      this.pending.delete(key);
    }
  }

  /** Re-anchor seam tiles and rebuild their walls when heights change. */
  _retile() {
    for (const [key, t] of this.tiles) {
      const [tx, ty] = key.split(',').map(Number);
      let touches = false;
      for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (this.manager.chunks.has(`${tx + nx},${ty + ny}`)) { touches = true; break; }
      }
      if (!touches) continue;

      const edges = this._edgeSamples(tx, ty);
      const planeY = this._planeY(tx, ty, edges);
      if (Math.abs(planeY - t.planeY) > REBUILD_TOL) {
        t.planeY = planeY;
        t.mesh.position.y = planeY;
      }
      this._buildWalls(t, tx, ty, edges, planeY);
    }
  }

  /** Textured wall from the flat plane up to the neighbouring terrain edge,
   *  closing the vertical gap at the seam. Rebuilt only when heights change. */
  _buildWalls(tile, tx, ty, edges, planeY) {
    const wallsKey = JSON.stringify(
      edges.map((e) => e.heights.map((h) => Math.round(h * 20)))
    ) + '|' + Math.round(planeY * 20);
    if (wallsKey === tile.wallsKey) return; // nothing changed
    tile.wallsKey = wallsKey;

    for (const w of tile.walls.values()) {
      this.group.remove(w);
      w.geometry.dispose();
    }
    tile.walls.clear();

    for (const e of edges) {
      const n = e.heights.length;
      const pos = new Float32Array(n * 2 * 3);
      const uv = new Float32Array(n * 2 * 2);
      const idx = [];
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        // top (terrain edge) and bottom (plane) vertices along the shared edge
        let txp, tzp;
        if (e.dx === 0) { txp = e.x0 + (e.x1 - e.x0) * u; tzp = e.dy < 0 ? e.z0 : e.z1; }
        else { txp = e.dx < 0 ? e.x0 : e.x1; tzp = e.z0 + (e.z1 - e.z0) * u; }
        pos.set([txp, e.heights[i], tzp], i * 6);
        pos.set([txp, planeY, tzp], i * 6 + 3);
        uv.set([u, 1], i * 4);
        uv.set([u, 0], i * 4 + 2);
        if (i < n - 1) {
          const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
          idx.push(a, c, d, a, d, b);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mat = tile.mat.clone();
      mat.side = THREE.DoubleSide;
      const wall = new THREE.Mesh(geo, mat);
      this.group.add(wall);
      tile.walls.set(`${e.dx},${e.dy}`, wall);
    }
  }

  _disposeTile(t) {
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mat.map.dispose();
    t.mat.dispose();
    for (const w of t.walls.values()) {
      this.group.remove(w);
      w.geometry.dispose();
      w.material.dispose();
    }
  }
}
