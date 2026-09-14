import * as THREE from 'three';
import {
  TERRAIN_ZOOM, tileSpanMeters, MERC_NORTH, WORLD_SCALE,
  worldToMerc, mercToWorld, fetchImageryCanvas,
} from './geo.js';
import { CHUNK_WORLD_SIZE } from './chunks.js';

const FILLER_MARGIN = 0.3;    // how far below the sampled edge heights the plane sits
const MIN_RADIUS = 2600;     // at low altitude
const MAX_RADIUS = 9000;     // when flying very high
const Z13_RADIUS = 1500;     // near ring: full-detail z13 tiles around the target
// far ring zoom adapts to altitude (see _pickFarZoom) so the tile count
// stays ~a few hundred no matter how far out we fill
const FAR_Y_DROP = 1.5;       // far ring sits below the near ring (no z-fighting)
const TILES_IN_FLIGHT = 24;
const MAX_TILES = 900;
const FAR_TILES_IN_FLIGHT = 16;
const FAR_MAX_TILES = 550;
const WALL_SEGMENTS = 8;
const REBUILD_TOL = 0.05;

export class FillerLayer {
  constructor(scene, manager) {
    this.scene = scene;
    this.manager = manager;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tiles = new Map();     // "tx,ty" -> { mesh, mat, planeY, walls, wallsKey } (z13)
    this.pending = new Set();
    this.farTiles = new Map();  // "tx,ty" -> { mesh } (z10)
    this.pendingFar = new Set();
    this.currentRadius = MIN_RADIUS;
    this._farY = -2;
    this.fails = 0;   // consecutive-ish fetch failures
    this.farZoom = 9;          // far-ring zoom (adapts to altitude)
    this.farTileSize = this._zoomSize(9);
    this._farZoomInit = false;  // set on the first update() (see below)
    this._farZoomCandidate = null;
    this._farZoomVotes = 0;
  }

  update(camera, target) {
    // how far we fill is proportional to altitude (10 units of reach per
    // unit of height) — the visible ground grows as you climb
    const R = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, camera.position.y * 10));
    this.currentRadius = R;

    // WHERE we fill: camera yaw only — pitch never changes the set.
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    camera.getWorldDirection(fwd);
    let fx = fwd.x, fz = fwd.z;
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) { fx /= fl; fz /= fl; } else { fx = 0; fz = 0; }

    // full cone bbox (~R behind … ~2R ahead of the target), padded a couple
    // of tiles so the screen edges are never left unfilled
    const off = 0.5 * R;
    const r = 1.5 * R + 2 * CHUNK_WORLD_SIZE;
    const gx = target.x + fx * off;
    const gz = target.z + fz * off;
    const minX = gx - r, maxX = gx + r;
    const minZ = gz - r, maxZ = gz + r;

    // near ring bbox: same cone shape, capped at Z13_RADIUS, same padding
    const r13 = Math.min(R, Z13_RADIUS);
    const off13 = 0.5 * r13;
    const g13x = target.x + fx * off13, g13z = target.z + fz * off13;
    const nMinX = g13x - 1.5 * r13 - 2 * CHUNK_WORLD_SIZE, nMaxX = g13x + 1.5 * r13 + 2 * CHUNK_WORLD_SIZE;
    const nMinZ = g13z - 1.5 * r13 - 2 * CHUNK_WORLD_SIZE, nMaxZ = g13z + 1.5 * r13 + 2 * CHUNK_WORLD_SIZE;

    // far ring height: just under the lowest near-ring plane
    let minY = Infinity;
    for (const t of this.tiles.values()) minY = Math.min(minY, t.planeY);
    const farY = (minY === Infinity ? -2 : minY - FAR_Y_DROP) - 0.5;
    if (Math.abs(farY - this._farY) > 0.3) {
      this._farY = farY;
      for (const ft of this.farTiles.values()) ft.mesh.position.y = farY;
    }

    const spanMerc = tileSpanMeters(TERRAIN_ZOOM);
    const [mx, my] = worldToMerc(target.x, target.z);
    const cx = Math.floor((mx + MERC_NORTH) / spanMerc);
    const cy = Math.floor((MERC_NORTH - my) / spanMerc);

    const toTileX = (wx) => Math.floor((worldToMerc(wx, 0)[0] + MERC_NORTH) / spanMerc);
    const toTileY = (wz) => Math.floor((MERC_NORTH - worldToMerc(0, wz)[1]) / spanMerc);
    const tx0 = toTileX(nMinX), tx1 = toTileX(nMaxX);
    const ty0 = toTileY(nMinZ), ty1 = toTileY(nMaxZ);

    // drop near tiles that scrolled out of the near ring
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

    // ---- far ring: covers the cone out to R (zoom adapts to altitude) -------
    const wantedZoom = this._pickFarZoom(R);
    if (!this._farZoomInit) {
      // first update: adopt the right zoom immediately — nothing is loaded
      // yet to switch away from (defaulting to 9 first transiently fetched a
      // whole ring of wrong-zoom tiles whenever the altitude called for z6–z8)
      this._farZoomInit = true;
      this.farZoom = wantedZoom;
      this.farTileSize = this._zoomSize(wantedZoom);
    } else if (wantedZoom !== this.farZoom) {
      if (wantedZoom === this._farZoomCandidate) {
        this._farZoomVotes++;
      } else {
        this._farZoomCandidate = wantedZoom;
        this._farZoomVotes = 1;
      }
      if (this._farZoomVotes >= 2) {
        // switch: drop every far tile, they reload at the new zoom
        for (const [key, ft] of this.farTiles) {
          this.group.remove(ft.mesh);
          ft.mesh.geometry.dispose();
          ft.mesh.material.map.dispose();
          ft.mesh.material.dispose();
          this.farTiles.delete(key);
        }
        this.farZoom = wantedZoom;
        this.farTileSize = this._zoomSize(wantedZoom);
        this._farZoomVotes = 0;
        this._farZoomCandidate = null;
      }
    } else {
      this._farZoomVotes = 0;
      this._farZoomCandidate = null;
    }
    const farSpan = tileSpanMeters(this.farZoom);
    const ftx0 = Math.floor((worldToMerc(minX, 0)[0] + MERC_NORTH) / farSpan);
    const ftx1 = Math.floor((worldToMerc(maxX, 0)[0] + MERC_NORTH) / farSpan);
    const fty0 = Math.floor((MERC_NORTH - worldToMerc(0, minZ)[1]) / farSpan);
    const fty1 = Math.floor((MERC_NORTH - worldToMerc(0, maxZ)[1]) / farSpan);

    // fog ends where the fill ends AS SEEN FROM THE CAMERA: the slant
    // distance to the farthest corner of the tile-snapped fill boundary.
    // Snapping matters — floor-aligned far-tile cells poke up to a whole
    // tile past the bbox, and fogging those away re-opens the very gap this
    // is meant to close. (The cone reaches ~2R ahead of the target; the old
    // value of plain R fog-hid the outer half of the loaded fill.)
    {
      const [sxMin] = mercToWorld(ftx0 * farSpan - MERC_NORTH, 0);
      const [sxMax] = mercToWorld((ftx1 + 1) * farSpan - MERC_NORTH, 0);
      const [, szMin] = mercToWorld(0, MERC_NORTH - fty0 * farSpan);
      const [, szMax] = mercToWorld(0, MERC_NORTH - (fty1 + 1) * farSpan);
      let fogFar = 0;
      for (const [bx, bz] of [[sxMin, szMin], [sxMin, szMax], [sxMax, szMin], [sxMax, szMax]]) {
        fogFar = Math.max(
          fogFar,
          Math.hypot(bx - camera.position.x, bz - camera.position.z, camera.position.y)
        );
      }
      this.fogFar = fogFar;
    }

    for (const [key, ft] of this.farTiles) {
      const [tx, ty] = key.split(',').map(Number);
      if (tx < ftx0 - 1 || tx > ftx1 + 1 || ty < fty0 - 1 || ty > fty1 + 1) {
        this.group.remove(ft.mesh);
        ft.mesh.geometry.dispose();
        ft.mesh.material.map.dispose();
        ft.mesh.material.dispose();
        this.farTiles.delete(key);
      }
    }

    // ---- exact near-coverage test for far tiles (prefix-sum grid) ----------
    // A far tile is skipped only if EVERY z13 child under it is covered by
    // the near ring or real terrain chunks. Near coverage is budget-capped
    // to a disc, so membership must be tested per child — a far tile
    // straddling the disc edge must still load, or it leaves a hole. The
    // child factor follows the adaptive farZoom (a z-far tile spans
    // 2^(13-farZoom) z13 children per axis; a previous version hardcoded
    // *8+4 — valid only at z10 — and probed neighbouring tiles at other
    // zooms, skipping far tiles essentially at random).
    const f = 2 ** (13 - this.farZoom);
    const toChildX = (wx) => Math.floor((worldToMerc(wx, 0)[0] + MERC_NORTH) / spanMerc);
    const toChildY = (wz) => Math.floor((MERC_NORTH - worldToMerc(0, wz)[1]) / spanMerc);
    // clip the child window to the near bbox — near tiles never load
    // outside it, so coverage outside it is impossible
    const gx0 = Math.max(ftx0 * f, toChildX(nMinX));
    const gx1 = Math.min((ftx1 + 1) * f - 1, toChildX(nMaxX));
    const gy0 = Math.max(fty0 * f, toChildY(nMinZ));
    const gy1 = Math.min((fty1 + 1) * f - 1, toChildY(nMaxZ));
    let childSum = null;
    if (gx0 <= gx1 && gy0 <= gy1) {
      const w = gx1 - gx0 + 1, h = gy1 - gy0 + 1;
      const grid = new Uint8Array(w * h);
      const mark = (key) => {
        const i = key.indexOf(',');
        const kx = +key.slice(0, i), ky = +key.slice(i + 1);
        if (kx >= gx0 && kx <= gx1 && ky >= gy0 && ky <= gy1) grid[(ky - gy0) * w + (kx - gx0)] = 1;
      };
      for (const key of this.tiles.keys()) mark(key);
      for (const key of this.manager.chunks.keys()) mark(key);
      // integral image with a leading zero row/column
      const ps = new Int32Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
          row += grid[y * w + x];
          ps[(y + 1) * (w + 1) + (x + 1)] = ps[y * (w + 1) + (x + 1)] + row;
        }
      }
      // inclusive child-rect sum, clipped to the window
      childSum = (x0, y0, x1, y1) => {
        const ax = Math.max(x0, gx0), bx = Math.min(x1, gx1);
        const ay = Math.max(y0, gy0), by = Math.min(y1, gy1);
        if (ax > bx || ay > by) return 0;
        const W = w + 1;
        return (
          ps[(by - gy0 + 1) * W + (bx - gx0 + 1)] -
          ps[(ay - gy0) * W + (bx - gx0 + 1)] -
          ps[(by - gy0 + 1) * W + (ax - gx0)] +
          ps[(ay - gy0) * W + (ax - gx0)]
        );
      };
    }
    const nearCovered = (tx, ty) =>
      !!childSum && childSum(tx * f, ty * f, (tx + 1) * f - 1, (ty + 1) * f - 1) === f * f;

    const farWanted = [];
    for (let ty = fty0; ty <= fty1; ty++) {
      for (let tx = ftx0; tx <= ftx1; tx++) {
        const key = `${tx},${ty}`;
        if (this.farTiles.has(key) || this.pendingFar.has(key)) continue;
        if (nearCovered(tx, ty)) continue;
        if (this.farTiles.size + this.pendingFar.size + farWanted.length >= FAR_MAX_TILES) continue;
        farWanted.push([tx, ty, Math.abs(tx - (ftx0 + ftx1) / 2) + Math.abs(ty - (fty0 + fty1) / 2)]);
      }
    }
    farWanted.sort((a, b) => a[2] - b[2]);
    for (const [tx, ty] of farWanted) {
      if (this.pendingFar.size >= FAR_TILES_IN_FLIGHT) break;
      this._loadFarTile(tx, ty);
    }
  }

  /** world size of a far tile at the given zoom (z13 = 1x) */
  _zoomSize(z) {
    return CHUNK_WORLD_SIZE * 2 ** (13 - z);
  }

  /** pick the far-ring zoom for the current reach: the coarsest zoom that
   *  still fills the cone with <= ~550 tiles (finer while low) */
  _pickFarZoom(R) {
    const need = (3 * R) / 22; // tile size that keeps the count ~<= 550
    for (let z = 10; z >= 6; z--) {
      if (this._zoomSize(z) >= need) return z;
    }
    return 6;
  }

  _farBounds(tx, ty) {
    const farSpan = tileSpanMeters(this.farZoom);
    const [wx, wz] = mercToWorld(
      (tx + 0.5) * farSpan - MERC_NORTH,
      MERC_NORTH - (ty + 0.5) * farSpan
    );
    const h = this.farTileSize / 2;
    return [wx - h, wx + h, wz - h, wz + h];
  }

  async _loadFarTile(tx, ty) {
    const key = `${tx},${ty}`;
    this.pendingFar.add(key);
    try {
      const res = await fetch(
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${this.farZoom}/${ty}/${tx}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.farTiles.has(key)) return;
      this.fails = 0;
      const bmp = await createImageBitmap(await res.blob());
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();

      const [wx, wz] = this._farBounds(tx, ty).slice(0, 2);
      const size = this.farTileSize;
      const [x0, x1] = [wx - size / 2, wx + size / 2];
      const [z0, z1] = [wz - size / 2, wz + size / 2];
      const geo = new THREE.PlaneGeometry(size, size);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial(); // unlit: raw satellite colours
      mat.map = new THREE.CanvasTexture(canvas);
      mat.map.colorSpace = THREE.SRGBColorSpace;
      mat.map.anisotropy = 4;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((x0 + x1) / 2, this._farY, (z0 + z1) / 2);
      this.group.add(mesh);
      this.farTiles.set(key, { mesh });
    } catch (err) {
      this.fails++;
      if (this.fails < 5 || this.fails % 20 === 0) {
        console.warn('far tile failed:', key, err.message);
      }
    } finally {
      this.pendingFar.delete(key);
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

  _edgeSamples(tx, ty) {
    const [x0, x1, z0, z1] = this.tileBounds(tx, ty);
    const g = this.manager.groundWorldY.bind(this.manager);
    const sides = [
      { dx: 0, dy: -1, at: (i) => [x0 + (x1 - x0) * (i / WALL_SEGMENTS), z0 - 1] },
      { dx: 0, dy: 1, at: (i) => [x0 + (x1 - x0) * (i / WALL_SEGMENTS), z1 + 1] },
      { dx: -1, dy: 0, at: (i) => [x0 - 1, z0 + (z1 - z0) * (i / WALL_SEGMENTS)] },
      { dx: 1, dy: 0, at: (i) => [x1 + 1, z0 + (z1 - z0) * (i / WALL_SEGMENTS)] },
    ];
    const out = [];
    for (const side of sides) {
      if (!this.manager.chunks.has(`${tx + side.dx},${ty + side.dy}`)) continue;
      const heights = [];
      let ok = true;
      for (let i = 0; i <= WALL_SEGMENTS; i++) {
        const [px, pz] = side.at(i);
        const gy = g(px, pz);
        if (gy === null) { ok = false; break; }
        heights.push(gy);
      }
      if (ok) out.push({ dx: side.dx, dy: side.dy, heights, x0, x1, z0, z1 });
    }
    return out;
  }

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
      this.fails = 0;

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
    } catch (err) {
      this.fails++;
      if (this.fails < 5 || this.fails % 20 === 0) {
        console.warn('filler tile failed:', key, err.message);
      }
    } finally {
      this.pending.delete(key);
    }
  }

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

  _buildWalls(tile, tx, ty, edges, planeY) {
    const wallsKey = JSON.stringify(
      edges.map((e) => e.heights.map((h) => Math.round(h * 20)))
    ) + '|' + Math.round(planeY * 20);
    if (wallsKey === tile.wallsKey) return;
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
