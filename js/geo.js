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

export function mercToWorld(mx, my) {
  return [(mx - CX) * WORLD_SCALE, -(my - CY) * WORLD_SCALE];
}
export function worldToMerc(wx, wz) {
  return [wx / WORLD_SCALE + CX, -wz / WORLD_SCALE + CY];
}

export function tileSpanMeters(zoom) {
  return (2 * Math.PI * R) / 2 ** zoom;
}

export const MERC_NORTH = Math.PI * R;

export function worldToChunk(wx, wz) {
  const [mx, my] = worldToMerc(wx, wz);
  const ts = tileSpanMeters(TERRAIN_ZOOM);
  return [Math.floor((mx + MERC_NORTH) / ts), Math.floor((MERC_NORTH - my) / ts)];
}

// --- tile fetch + decode -------------------------------------------------------
const TILE_TTL = 1000 * 60 * 30; // memory cache 30 min
// LRU cap: without it this cache grows unboundedly while flying and
// eventually OOM-kills the renderer (tab silently reloads). The cap sits
// above the live working set (900 near tiles + terrain chunks) so it only
// evicts the stale tail of places you've flown away from. Mobile gets a
// much smaller budget — phone browsers kill the tab far below the ~370 MB
// the desktop cap represents (canvas backing stores count hard on iOS).
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const CACHE_MAX_ENTRIES = IS_TOUCH ? 650 : 1400; // mobile ~165 MB · desktop ~370 MB — mobile cap must exceed the live tile working set (near ring + chunks) or churn becomes a refetch flood
const decodedCache = new Map(); // "kind:z/x/y" -> { promise, ts }

export function cacheStats() {
  return { size: decodedCache.size, max: CACHE_MAX_ENTRIES };
}
let activeFetches = 0;
const MAX_CONCURRENCY = 10;
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

// per-host circuit breaker: after FETCH_BURST consecutive failures the host
// fails fast for COOLDOWN ms — otherwise 3-retry fetches to a throttled
// server (403/429) clog the 10-slot fetch queue and starve EVERYTHING.
// After the cooldown expires, one real attempt decides the next round.
const FETCH_BURST = 8;
const COOLDOWN = 30_000;
const hostFails = new Map();    // host -> consecutive failures
const hostCooldown = new Map(); // host -> cooldown-until timestamp

export function imageryCooling() {
  const until = hostCooldown.get('server.arcgisonline.com') || 0;
  return until > Date.now();
}

async function fetchBlob(url) {
  const host = new URL(url).host;
  if ((hostCooldown.get(host) || 0) > Date.now()) {
    fetchStats.imgHttp++; // fail-fast while cooling down
    throw new Error(`host ${host} cooling down`);
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) {
        // rate-limit / ban: retrying immediately only deepens the block —
        // fail this call at once and let the circuit breaker cool down
        if (res.status === 403 || res.status === 429 || res.status === 401) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        }
        throw new Error(`HTTP ${res.status}`);
      }
      hostFails.set(host, 0);
      hostCooldown.delete(host);
      return await res.blob();
    } catch (err) {
      lastErr = err;
      if (err.fatal) break; // ban/rate-limit — no point retrying now
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
  const fails = (hostFails.get(host) || 0) + 1;
  hostFails.set(host, fails);
  if (fails >= FETCH_BURST) {
    hostFails.set(host, 0);
    hostCooldown.set(host, Date.now() + COOLDOWN);
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

// --- imagery decode with fallback ---------------------------------------------
// iOS Safari has been observed rejecting createImageBitmap for some blobs
// (elevations decode fine; every imagery path dies). Fall back to a classic
// <img> decode — slower, but it works everywhere. Counters in fetchStats
// tell the telemetry which path actually ran.
export const fetchStats = { elev: 0, elevFail: 0, img: 0, imgFail: 0, imgHttp: 0, lastImgAt: 0 };

export async function blobToImageBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      fetchStats.img++;
      return await createImageBitmap(blob);
    } catch (err) {
      fetchStats.imgFail++;
      // fall through to the <img> path below
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('img decode failed'));
      img.src = url;
    });
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return img; // HTMLImageElement: drawImage-compatible; no .close() — callers guard
  } catch (err) {
    URL.revokeObjectURL(url);
    fetchStats.imgFail++;
    throw err;
  }
}

function cached(kind, key, loader) {
  const full = `${kind}:${key}`;
  let entry = decodedCache.get(full);
  if (entry && Date.now() - entry.ts < TILE_TTL) {
    // LRU touch: re-insert so the eviction tail is least-recently-used
    decodedCache.delete(full);
    decodedCache.set(full, entry);
    return entry.promise;
  }
  entry = { promise: loader(), ts: Date.now() };
  entry.promise.catch(() => decodedCache.delete(full));
  decodedCache.set(full, entry);
  while (decodedCache.size > CACHE_MAX_ENTRIES) {
    decodedCache.delete(decodedCache.keys().next().value);
  }
  return entry.promise;
}

export function fetchElevationGrid(tx, ty, zoom = TERRAIN_ZOOM) {
  return cached('elev', `${zoom}/${tx}/${ty}`, async () => {
    await acquire();
    try {
      const blob = await fetchBlob(
        `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`
      );
      const img = await blobToImageData(blob);
      fetchStats.elev++;
      const out = new Float32Array(img.width * img.height);
      for (let i = 0, p = 0; i < out.length; i++, p += img.bpp) {
        out[i] = img.data[p] * 256 + img.data[p + 1] + img.data[p + 2] / 256 - 32768;
      }
      return out;
    } catch (err) {
      fetchStats.elevFail++;
      throw err;
    } finally {
      release();
    }
  });
}

export function fetchImageryCanvas(tx, ty, zoom = IMAGERY_ZOOM) {
  const p = cached('img', `${zoom}/${tx}/${ty}`, async () => {
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
              return await blobToImageBitmap(blob);
            } catch (err) {
              fetchStats.imgHttp++; // HTTP/network-level failure (rate limit?)
              throw err;
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
      bmp.close?.(); // HTMLImageElement fallback has no close
    });
    return canvas;
  });
  // any successful imagery fetch (fresh or cache hit) marks the feed alive —
  // the app.js outage banner clears when this goes quiet for 20s+
  p.then(() => { fetchStats.lastImgAt = Date.now(); }, () => {});
  return p;
}
