import * as THREE from 'three';
import { mercToWorld, lonToMercX, latToMercY, V } from './geo.js';
import { makeLabel, recolorLabel } from './labels.js';

const WARDS_URL =
  'https://opencity.idvilnius.lt/gis/rest/services/Miesto_valdymas/Seniunijos_public/MapServer/1/query' +
  '?where=1%3D1&outFields=*&outSR=4326&f=geojson&resultOffset=';

const MIN_VERTEX_SPACING_M = 25;

function ringAreaCentroid(ring) {
  // ring in mercator meters (x, y); shoelace
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-9) return [ring[0][0], ring[0][1], 0];
  a /= 2;
  return [cx / (6 * a), cy / (6 * a), Math.abs(a)];
}

export class WardOverlay {
  constructor(manager, scene) {
    this.manager = manager;
    this.scene = scene;
    this.wards = []; // { name, ringMerc: [[mx,my],...], centroidWorld: [wx,wz] }
    this.labelSprites = new Map(); // name -> sprite
    this.labelColor = '#ffffff';
    this.labelsVisible = true;
    this.exaggeration = manager.effectiveExaggeration;

    manager.onChunkReady.push((chunk) => this._onChunkReady(chunk));
  }

  async load() {
    const res = await fetch(WARDS_URL);
    if (!res.ok) throw new Error(`wards: HTTP ${res.status}`);
    const fc = await res.json();

    for (const f of fc.features) {
      const name = f.properties?.SENIUNIJA?.trim();
      if (!name || !f.geometry) continue;
      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;

      let best = null;
      for (const poly of polygons) {
        const ring = [];
        let last = null;
        for (const [lon, lat] of poly[0]) {
          const m = [lonToMercX(lon), latToMercY(lat)];
          if (!last || Math.hypot(m[0] - last[0], m[1] - last[1]) > MIN_VERTEX_SPACING_M) {
            ring.push(m);
            last = m;
          }
        }
        // ensure closure
        if (ring.length > 1) ring.push(ring[0]);
        const [, , area] = ringAreaCentroid(ring);
        if (!best || area > best.area) best = { ring, area };
      }
      if (!best) continue;

      const [cmx, cmy] = ringAreaCentroid(best.ring);
      this.wards.push({
        name,
        ringMerc: best.ring,
        centroidWorld: mercToWorld(cmx, cmy),
        centroidMerc: [cmx, cmy],
      });
    }
    return this.wards.length;
  }

  _onChunkReady(chunk) {
    if (this.wards.length === 0 || chunk._wardDecorated) return;
    chunk._wardDecorated = true;

    // (ward boundary lines removed — only centroid labels remain)

    // spawn labels whose centroid lives in this chunk
    for (const ward of this.wards) {
      if (this.labelSprites.has(ward.name)) continue;
      const [wx, wz] = ward.centroidWorld;
      if (wx < chunk.minX || wx >= chunk.maxX || wz < chunk.minZ || wz >= chunk.maxZ) continue;
      const sprite = makeLabel(ward.name, this.labelColor, 7);
      sprite.position.set(wx, 0, wz);
      sprite.userData.ward = {
        chunk,
        elev: chunk.sampleElev(...chunk.worldToUV(wx, wz)),
        clearance: 6.5,
      };
      sprite.visible = this.labelsVisible;
      this.scene.add(sprite);
      this.labelSprites.set(ward.name, sprite);
      this._updateLabelY(sprite);
    }
  }

  decorateLoaded() {
    for (const chunk of this.manager.chunks.values()) {
      if (chunk.state === 'ready') this._onChunkReady(chunk);
    }
  }

  _updateLabelY(sprite) {
    const { elev, clearance } = sprite.userData.ward;
    sprite.position.y = elev * V * this.exaggeration + clearance;
  }

  updateExaggeration(f) {
    this.exaggeration = f;
    for (const sprite of this.labelSprites.values()) this._updateLabelY(sprite);
  }

  setLabelColor(color) {
    this.labelColor = color;
    for (const sprite of this.labelSprites.values()) recolorLabel(sprite, color);
  }

  setLabelsVisible(v) {
    this.labelsVisible = v;
    for (const sprite of this.labelSprites.values()) sprite.visible = v;
  }

  get counts() {
    return { wards: this.wards.length, labels: this.labelSprites.size };
  }
}
