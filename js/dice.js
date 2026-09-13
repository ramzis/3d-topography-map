import { fetchElevationGrid } from './geo.js';

/**
 * Random-place dice roll: picks a uniformly random point on Earth and
 * retries until it lands on solid ground (elevation tiles encode ocean as
 * negative bathymetry, so a simple elevation check rejects water).
 * The destination is reverse-geocoded for a friendly name.
 */

const MAX_TRIES = 30;
const MIN_LAND_ELEV = 2; // metres — avoids beaches and tidal flats

export async function rollRandomLandPlace() {
  for (let i = 0; i < MAX_TRIES; i++) {
    // uniform on the sphere: lat = asin(2u - 1)
    const lat = Math.asin(Math.random() * 2 - 1) * (180 / Math.PI);
    if (Math.abs(lat) > 78) continue; // keep inside usable mercator bounds
    const lon = Math.random() * 360 - 180;

    const elev = await sampleElevationAt(lat, lon);
    if (elev !== null && elev > MIN_LAND_ELEV) {
      const name = await reverseGeocodeName(lat, lon);
      return { lat, lon, name };
    }
  }
  // fallback if the dice refused to find land
  return { lat: 54.6858, lon: 25.2848, name: 'Vilnius' };
}

/** Elevation (m) at a lat/lon from the z8 terrarium tile, or null if unavailable. */
async function sampleElevationAt(lat, lon) {
  try {
    const zoom = 8;
    const n = 2 ** zoom;
    const latR = (lat * Math.PI) / 180;
    const tx = Math.floor(((lon + 180) / 360) * n);
    const ty = Math.floor(
      ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n
    );
    const grid = await fetchElevationGrid(tx, ty, zoom);
    const px = Math.floor((((lon + 180) / 360) * n - tx) * 255);
    const py = Math.floor(
      (((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n - ty) * 255
    );
    return grid[Math.min(255, Math.max(0, py)) * 256 + Math.min(255, Math.max(0, px))];
  } catch {
    return null; // tile gap or fetch failure — caller retries
  }
}

/** "Somewhere, Country" via OSM Nominatim reverse geocoding (best effort). */
async function reverseGeocodeName(lat, lon) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&format=jsonv2&zoom=10`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error();
    const json = await res.json();
    const parts = (json.display_name || '').split(',');
    const short = parts.slice(0, 2).join(',').trim();
    return short || 'uncharted land';
  } catch {
    return 'uncharted land';
  }
}
