/**
 * Live location status: reverse-geocodes the camera position via Nominatim
 * and shows "Place, Country" under the top nav bar while you travel.
 * Requests are distance-gated (>= 3 km) and rate-limited (>= 3 s apart)
 * to respect Nominatim's usage policy.
 */
import { worldToMerc, mercXToLon, mercYToLat } from './geo.js';

const MIN_QUERY_INTERVAL_MS = 3000; // hard rate limit between reverse-geocode calls
const MIN_MOVE_KM = 3;             // don't re-query unless we moved this far
const ZOOM = 10;                   // city-level detail

export function mountLocationStatus(camera) {
  const el = document.getElementById('locationText');
  const pill = document.getElementById('locationStatus');

  let lastQueryAt = 0;
  let lastQueried = null;  // {lat, lon}
  let seq = 0;
  let inflight = false;

  function update(t) {
    if (inflight) return;
    if (t - lastQueryAt < MIN_QUERY_INTERVAL_MS) return;
    const [mx, my] = worldToMerc(camera.position.x, camera.position.z);
    const lat = mercYToLat(my);
    const lon = mercXToLon(mx);
    if (lastQueried && distKm(lat, lon, lastQueried.lat, lastQueried.lon) < MIN_MOVE_KM) return;

    lastQueryAt = t;
    lastQueried = { lat, lon };
    const mySeq = ++seq;
    inflight = true;

    fetch(
      'https://nominatim.openstreetmap.org/reverse' +
      `?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}` +
      `&format=jsonv2&zoom=${ZOOM}&accept-language=en`
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((j) => {
        if (mySeq !== seq) return;
        el.textContent = placeLabel(j);
        pill.classList.add('visible');
      })
      .catch(() => { /* offline / rate-limited — keep the previous label */ })
      .finally(() => { inflight = false; });
  }

  return update;
}

/** "Vilnius, Lithuania" from a Nominatim reverse-geocode JSON. */
function placeLabel(j) {
  const a = j.address || {};
  const place =
    a.city || a.town || a.village || a.hamlet || a.municipality ||
    a.county || a.state_district || a.state;
  const country = a.country;
  if (place && country) return `${place}, ${country}`;
  if (place || country) return place || country;
  // fallback: first + last chunk of display_name ("Vilnius, ... ,Lithuania")
  const parts = String(j.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[parts.length - 1]}`;
  return parts[0] || '';
}

/** great-circle distance in km */
function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const d = Math.PI / 180;
  const dLat = (lat2 - lat1) * d;
  const dLon = (lon2 - lon1) * d;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
