import * as THREE from 'three';
import { makeLabel } from './labels.js';
import { worldToMerc, mercXToLon, mercYToLat, lonToMercX, latToMercY, mercToWorld } from './geo.js';

/**
 * Streaming place-name layer: fetches city/town/village labels from
 * OpenStreetMap (Overpass API) for the area currently in view, so names
 * keep appearing as you fly around the world.
 */
const QUERY_COOLDOWN_MS = 6000;
const MOVE_THRESHOLD = 0.4; // re-query after moving 40% of the query radius

const HEIGHT = { city: 7, town: 5, village: 3.5 };
const CLEARANCE = { city: 5, town: 3.5, village: 2.5 };

export class PlacesLayer {
  constructor(scene) {
    this.scene = scene;
    this.places = new Map(); // osm id -> { name, kind, wx, wz, sprite }
    this.lastQueryAt = 0;
    this.lastCenter = null;
    this.lastRadius = 0;
    this.inFlight = false;
  }

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} target   orbit/fly target (world units)
   * @param {number} tNow             animation timestamp (ms)
   */
  update(camera, target, tNow) {
    if (this.inFlight || tNow - this.lastQueryAt < QUERY_COOLDOWN_MS) return;
    const radius = Math.max(10, Math.min(120, camera.position.distanceTo(target) * 1.4));
    if (this.lastCenter && target.distanceTo(this.lastCenter) < this.lastRadius * MOVE_THRESHOLD) {
      return;
    }
    this.lastQueryAt = tNow;
    this.lastCenter = target.clone();
    this.lastRadius = radius;

    // world bbox -> lat/lon bbox (south, west, north, east)
    const [mx0, myN] = worldToMerc(target.x - radius, target.z - radius);
    const [mx1, myS] = worldToMerc(target.x + radius, target.z + radius);
    const bbox = [mercYToLat(myS), mercXToLon(mx0), mercYToLat(myN), mercXToLon(mx1)]
      .map((v) => v.toFixed(5))
      .join(',');

    const query =
      `[out:json][timeout:25];` +
      `node["place"~"^(city|town|village)$"]["name"](${bbox});` +
      `out body 400;`;

    this.inFlight = true;
    fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => this.addPlaces(json.elements || []))
      .catch(() => { /* transient Overpass issues — next movement retries */ })
      .finally(() => { this.inFlight = false; });
  }

  addPlaces(elements) {
    for (const el of elements) {
      if (this.places.has(el.id)) continue;
      const kind = el.tags?.place;
      const name = el.tags?.name;
      if (!name || !HEIGHT[kind]) continue;
      const [wx, wz] = mercToWorld(lonToMercX(el.lon), latToMercY(el.lat));
      const sprite = makeLabel(name, '#ffffff', HEIGHT[kind]);
      sprite.position.set(wx, 0, wz);
      sprite.userData.place = { kind, clearance: CLEARANCE[kind] };
      sprite.visible = false; // shown once ground height is known
      this.scene.add(sprite);
      this.places.set(el.id, { name, kind, wx, wz, sprite });
    }
  }

  /**
   * Keep sprites at the terrain surface (called each frame).
   * @param {(wx, wz) => number|null} groundYAt  terrain world y or null if unloaded
   */
  updatePositions(groundYAt) {
    for (const p of this.places.values()) {
      const gy = groundYAt(p.wx, p.wz);
      if (gy === null) continue;
      p.sprite.position.y = gy + p.sprite.userData.place.clearance;
    }
  }
}
