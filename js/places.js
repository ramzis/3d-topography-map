import * as THREE from 'three';
import { makeLabel } from './labels.js';
import { worldToMerc, mercXToLon, mercYToLat, lonToMercX, latToMercY, mercToWorld } from './geo.js';

const QUERY_COOLDOWN_MS = 6000;
const MOVE_THRESHOLD = 0.4; // re-query after moving 40% of the query radius

// Overpass public instances — on failure we rotate to the next mirror, and
// back off exponentially so a refused/unreachable endpoint doesn't get
// hammered every cooldown (each refused request logs a browser console
// error, which is what made the noise)
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const FAIL_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]; // after 1st..4th+ consecutive failure

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
    this.mirror = 0;        // index into MIRRORS — rotates on failure
    this.fails = 0;         // consecutive failures (drives the backoff)
    this.retryAt = 0;       // animation-timestamp gate: no queries before this
  }

  update(camera, target, tNow) {
    if (this.inFlight || tNow < this.retryAt || tNow - this.lastQueryAt < QUERY_COOLDOWN_MS) return;
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
    fetch(MIRRORS[this.mirror], {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        this.fails = 0;
        this.retryAt = 0;
        this.addPlaces(json.elements || []);
      })
      .catch(() => {
        // transient or dead endpoint — rotate to the next mirror and back
        // off, so a refused connection isn't retried every cooldown
        this.fails++;
        this.mirror = (this.mirror + 1) % MIRRORS.length;
        const backoff = FAIL_BACKOFF_MS[Math.min(this.fails, FAIL_BACKOFF_MS.length) - 1];
        this.retryAt = tNow + backoff;
      })
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

  updatePositions(groundYAt) {
    for (const p of this.places.values()) {
      const gy = groundYAt(p.wx, p.wz);
      if (gy === null) continue;
      p.sprite.position.y = gy + p.sprite.userData.place.clearance;
    }
  }
}
