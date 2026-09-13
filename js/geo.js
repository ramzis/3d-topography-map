/**
 * Geo + tile plumbing for the streaming terrain.
 * All world coordinates: mercator meters offset from the Vilnius center,
 * scaled to scene units (1 unit = 100 m):  wx = (mx - CX) * V,  wz = -(my - CY) * V
 * (so north = -z).  Vertical: wy = elevation_m * V * exaggeration.
 */

export const V = 0.01; // 1 scene unit = 100 m

import { decodePNG } from './png-decoder.js';
export const TILE_PX = 256;

export const TERRAIN_ZOOM = 13; // one chunk = one z13 tile ≈ 2.83 km (z12 tiles have source-datum seams)
export const IMAGERY_ZOOM = 13; // one imagery tile per chunk ≈ 11 m/px — matches v1's effective 9.8 m/px

export const CENTER_LON = 25.2848;
export const CENTER_LAT = 54.6858;

const R = 6378137;
const DEG = Math.PI / 180;

// --- web mercator ------------------------------------------------------------
export function lonToMercX(lon) {
  return (lon * DEG * R);
}
export function latToMercY(lat) {
  const s = Math.sin(lat * DEG);
  return (R / 2) * Math.log((1 + s) / (1 - s));
}
export function mercXToLon(mx) {
  return mx / R / DEG;
}
export function mercYToLat(my) {
  return (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG;
}

export const CX = lonToMercX(CENTER_LON);
export const CY = latToMercY(CENTER_LAT);
// Mercator meters are stretched by 1/cos(lat) relative to true ground meters.
// Apply the local scale factor so 1 scene unit ≈ 100 ground meters both ways.
const GC = Math.cos(CENTER_LAT * DEG);
export const WORLD_SCALE = V * GC;

/** mercator meters -> scene units (x east, z south) */
export function mercToWorld(mx, my) {
  return [(mx - CX) * WORLD_SCALE, -(my - CY) * WORLD_SCALE];
}
/** scene units -> mercator meters */
export function worldToMerc(wx, wz) {
  return [wx / WORLD_SCALE + CX, -wz / WORLD_SCALE + CY];
}

/** tile span in mercator meters at a zoom */
export function tileSpanMeters(zoom) {
  return (2 * Math.PI * R) / 2 ** zoom;
}

/** mercator y of the top of the tile grid (north edge of tile y=0) */
export const MERC_NORTH = Math.PI * R;

/** chunk/tile x,y at TERRAIN_ZOOM for a world point
 *  (tile x counts eastward from -180°, tile y southward from +85°) */
export function worldToChunk(wx, wz) {
  const [mx, my] = worldToMerc(wx, wz);
  const ts = tileSpanMeters(TERRAIN_ZOOM);
  return [Math.floor((mx + MERC_NORTH) / ts), Math.floor((MERC_NORTH - my) / ts)];
}

// --- tile fetch + decode -------------------------------------------------------
const TILE_TTL = 1000 * 60 * 30; // memory cache 30 min
const decodedCache = new Map(); // "kind:z/x/y" -> { promise, ts }
let activeFetches = 0;
const MAX_CONCURRENCY = 6;
const waitQueue = [];

function acquire() {
  if (activeFetches < MAX_CONCURRENCY) {
    activeFetches++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}
function release() {
  activeFetches--;
  const next = waitQueue.shift();
  if (next) {
    activeFetches++;
    next();
  }
}

async function fetchBlob(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function blobToImageData(blob) {
  // Pure-JS PNG decode: bypasses the browser's color-managed ImageBitmap
  // path, which on wide-gamut displays perturbs elevation-encoded RGB
  // (±1 on the R channel = ±256 m spikes) — deck.gl issue #10400.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return decodePNG(bytes);
}

function cached(kind, key, loader) {
  const full = `${kind}:${key}`;
  let entry = decodedCache.get(full);
  if (entry && Date.now() - entry.ts < TILE_TTL) return entry.promise;
  entry = { promise: loader(), ts: Date.now() };
  entry.promise.catch(() => decodedCache.delete(full));
  decodedCache.set(full, entry);
  return entry.promise;
}

/**
 * Terrarium elevation tile -> Float32Array(TILE_PX*TILE_PX) of meters.
 * Row 0 = north, col 0 = west (standard image orientation).
 */
export function fetchElevationGrid(tx, ty, zoom = TERRAIN_ZOOM) {
  return cached('elev', `${zoom}/${tx}/${ty}`, async () => {
    await acquire();
    try {
      const blob = await fetchBlob(
        `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`
      );
      const img = await blobToImageData(blob);
      const out = new Float32Array(img.width * img.height);
      for (let i = 0, p = 0; i < out.length; i++, p += img.bpp) {
        out[i] = img.data[p] * 256 + img.data[p + 1] + img.data[p + 2] / 256 - 32768;
      }
      return out;
    } finally {
      release();
    }
  });
}

/**
 * Esri World Imagery canvas for one terrain tile at IMAGERY_ZOOM
 * (4 child tiles composited into a single 512×512 canvas).
 */
export function fetchImageryCanvas(tx, ty, zoom = IMAGERY_ZOOM) {
  return cached('img', `${zoom}/${tx}/${ty}`, async () => {
    const k = 2 ** (zoom - TERRAIN_ZOOM);
    const loaders = [];
    for (let dy = 0; dy < k; dy++) {
      for (let dx = 0; dx < k; dx++) {
        const x = tx * k + dx;
        const y = ty * k + dy;
        loaders.push(
          (async () => {
            await acquire();
            try {
              const blob = await fetchBlob(
                `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`
              );
              return await createImageBitmap(blob);
            } finally {
              release();
            }
          })()
        );
      }
    }
    const bitmaps = await Promise.all(loaders);
    const size = TILE_PX * k;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    bitmaps.forEach((bmp, i) => {
      const dx = (i % k) * TILE_PX;
      const dy = Math.floor(i / k) * TILE_PX;
      ctx.drawImage(bmp, dx, dy, TILE_PX, TILE_PX);
      bmp.close();
    });
    return canvas;
  });
}
