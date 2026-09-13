import * as THREE from 'three';
import { lonToMercX, latToMercY, mercToWorld, worldToMerc, mercXToLon, mercYToLat } from './geo.js';

/**
 * Shareable view state: camera position + orientation + exaggeration,
 * serialized to URL query params (share links) and localStorage (refresh).
 *
 * Priority on load: URL params → localStorage → default view over Vilnius.
 */

const STORAGE_KEY = 'topoMapView';
const SAVE_INTERVAL_MS = 3000;

export function encodeState(camera, exaggeration) {
  const [mx, my] = worldToMerc(camera.position.x, camera.position.z);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  return {
    lat: +mercYToLat(my).toFixed(5),
    lon: +mercXToLon(mx).toFixed(5),
    alt: +camera.position.y.toFixed(1),
    yaw: +e.y.toFixed(3),
    pitch: +e.x.toFixed(3),
    exag: Number(exaggeration),
  };
}

export function applyState(s, camera, controls, applyExaggeration) {
  const [wx, wz] = mercToWorld(lonToMercX(s.lon), latToMercY(s.lat));
  camera.position.set(wx, s.alt, wz);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(s.pitch ?? 0, s.yaw ?? 0, 0);
  if (applyExaggeration) applyExaggeration(s.exag);

  // give the streaming manager and orbit controls a sensible focus point
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  controls.target.copy(camera.position).addScaledVector(fwd, 40);
}

export function stateFromUrl() {
  const p = new URLSearchParams(location.search);
  const lat = parseFloat(p.get('lat'));
  const lon = parseFloat(p.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    alt: parseFloat(p.get('alt')) || 40,
    yaw: parseFloat(p.get('yaw')) || 0,
    pitch: parseFloat(p.get('pitch')) || 0,
    exag: clampExag(parseFloat(p.get('exag')) || 6),
  };
}

export function stateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null;
    return { ...s, exag: clampExag(s.exag) };
  } catch {
    return null;
  }
}

export function writeUrl(state) {
  const q = new URLSearchParams({
    lat: state.lat,
    lon: state.lon,
    alt: state.alt,
    yaw: state.yaw,
    pitch: state.pitch,
    exag: state.exag,
  });
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

export function saveToStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage unavailable — URL sharing still works */ }
}

/**
 * Auto-persist: call each frame; writes URL + localStorage at most every
 * SAVE_INTERVAL_MS, only when the camera actually moved/turned.
 */
export function createStateSaver(camera, getExaggeration) {
  let last = null;
  let lastSaveAt = 0;
  return (t) => {
    if (t - lastSaveAt < SAVE_INTERVAL_MS) return;
    const s = encodeState(camera, getExaggeration());
    const moved =
      !last ||
      Math.abs(last.lat - s.lat) > 1e-5 ||
      Math.abs(last.lon - s.lon) > 1e-5 ||
      Math.abs(last.alt - s.alt) > 0.2 ||
      Math.abs(last.yaw - s.yaw) > 0.01 ||
      Math.abs(last.pitch - s.pitch) > 0.01 ||
      last.exag !== s.exag;
    if (!moved) return;
    last = s;
    lastSaveAt = t;
    writeUrl(s);
    saveToStorage(s);
  };
}

function clampExag(v) {
  return Math.max(1, Math.min(60, Number.isFinite(v) ? v : 6));
}
