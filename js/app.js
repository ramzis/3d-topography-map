import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ChunkManager } from './chunks.js';
import { WardOverlay } from './wards.js';
import { FlyRig } from './fly.js';
import { PlacesLayer } from './places.js';
import { initAnalytics } from './analytics.js';
import { mountSearch } from './search.js';
import { mountLocationStatus } from './location.js';
import { teleportTo } from './teleport.js';
import { DayNightSky } from './sky.js';
import { rollRandomLandPlace } from './dice.js';
import {
  stateFromUrl, stateFromStorage, applyState, createStateSaver, encodeState, writeUrl,
} from './state.js';

const DEFAULT_EXAGGERATION = 6;

// --- renderer / scene -----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141a);
scene.fog = new THREE.Fog(0x10141a, 900, 2600);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 6000);
// start low over Vilnius city center, looking across the city
camera.position.set(0, 40, 30);
camera.lookAt(0, 18, -60);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 12, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.minDistance = 10;
controls.maxDistance = 1500;

// --- day/night sky (owns the terrain lights) ----------------------------------------
const sky = new DayNightSky(scene);
scene.fog.color = sky.fogColor;

// --- streaming world ----------------------------------------------------------------
const manager = new ChunkManager(scene);
manager.setExaggeration(DEFAULT_EXAGGERATION);
const wards = new WardOverlay(manager, scene);
const places = new PlacesLayer(scene);

// --- restore shared/saved view state (URL → localStorage → default) ----------------
const savedState = stateFromUrl() || stateFromStorage();
if (savedState) {
  applyState(savedState, camera, controls, (f) => {
    const slider = document.getElementById('exaggeration');
    slider.value = f;
    document.getElementById('exagVal').textContent = `${f}×`;
    manager.setExaggeration(f);
    wards.updateExaggeration(f);
  });
} else {
  // default: low over Vilnius city center, looking across the city
  applyState(
    { lat: 54.6858, lon: 25.2848, alt: 40, yaw: 0, pitch: -0.25, exag: DEFAULT_EXAGGERATION },
    camera,
    controls,
    null
  );
}
const saveState = createStateSaver(camera, () =>
  Number(document.getElementById('exaggeration').value)
);
const updateLocationStatus = mountLocationStatus(camera);

manager.update(camera, controls.target);

wards
  .load()
  .then((n) => {
    console.log(`wards loaded: ${n}`);
    wards.decorateLoaded();
  })
  .catch((err) => console.warn('wards failed:', err.message));

// --- UI -------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

$('exaggeration').addEventListener('input', (e) => {
  const f = Number(e.target.value);
  $('exagVal').textContent = `${f}×`;
  manager.setExaggeration(f);
  wards.updateExaggeration(f);
});

// --- camera: fly mode on desktop, touch-orbit on mobile --------------------------------
const isTouch = matchMedia('(pointer: coarse)').matches;
// touch devices keep the OrbitControls gestures:
// one finger — orbit, pinch — zoom, two fingers — pan

// --- camera: fly mode on desktop, touch-orbit on mobile --------------------------------
const fly = new FlyRig(camera, renderer.domElement, {
  getGroundY: (wx, wz) => manager.groundWorldY(wx, wz),
});
fly.onSpeed = (s) => {
  document.title = `fly speed ${s.toFixed(0)} · 3D Topography Map`;
};

// --- always-day toggle: pin the sun to local noon ------------------------------------
$('sunBtn').addEventListener('click', () => {
  const on = !sky.alwaysNoon;
  sky.setAlwaysNoon(on);
  $('sunBtn').classList.toggle('on', on);
});

if (!isTouch) {
  // desktop: spectator fly camera (click the view to capture the mouse)
  controls.enabled = false;
  fly.enable();
}
// touch devices keep the OrbitControls gestures:
// one finger — orbit, pinch — zoom, two fingers — pan

// --- label fade: hide names once they shrink below readable size ------------------
function updateLabelFade() {
  const pxPerRad = innerHeight / (2 * Math.tan((camera.fov / 2) * (Math.PI / 180)));
  const fadeOne = (sprite) => {
    const h = sprite.userData.labelParams?.heightUnits ?? 7;
    const dist = camera.position.distanceTo(sprite.position);
    const pxHeight = h * (pxPerRad / dist);
    const fade = Math.max(0, Math.min(1, (pxHeight - 14) / 10));
    sprite.material.opacity = fade;
    const onGround = sprite.userData.place ? sprite.position.y > 0 : true;
    sprite.visible = onGround && fade > 0.02;
  };
  for (const sprite of wards.labelSprites.values()) fadeOne(sprite);
  for (const p of places.places.values()) fadeOne(p.sprite);
}

// --- debug hook -------------------------------------------------------------------------
window.__vilniusDebug = {
  manager,
  camera,
  controls,
  fly,
  wards,
  places,
  counts: () => ({
    ...wards.counts,
    chunks: manager.readyCount,
    loading: manager.pending.size,
    placeNames: places.places.size,
  }),
};

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

initAnalytics();

// --- search + teleport ------------------------------------------------------------
mountSearch({
  onSelect: (place) => teleportTo(place, { camera, controls, fly, manager }),
});

// --- dice roll: teleport to a random land spot ----------------------------------
$('diceBtn').addEventListener('click', async () => {
  const btn = $('diceBtn');
  if (btn.classList.contains('rolling')) return;
  btn.classList.add('rolling');
  try {
    const place = await rollRandomLandPlace();
    await teleportTo(place, { camera, controls, fly, manager });
  } finally {
    btn.classList.remove('rolling');
  }
});

// --- share: copy a link that embeds the current view ------------------------------
$('shareBtn').addEventListener('click', async () => {
  writeUrl(encodeState(camera, Number($('exaggeration').value)));
  const url = location.href;
  const btn = $('shareBtn');
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '✓';
    btn.title = 'Link copied!';
  } catch {
    // clipboard unavailable (e.g. non-secure context) — select the old way
    const el = document.createElement('textarea');
    el.value = url;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    el.remove();
    btn.textContent = '✓';
    btn.title = 'Link copied!';
  }
  setTimeout(() => {
    btn.textContent = '🔗';
    btn.title = 'Share this view';
  }, 2000);
});

let lastChunkUpdate = 0;
let lastFrameT = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.1, (t - lastFrameT) / 1000 || 0.016);
  lastFrameT = t;

  if (fly.enabled) {
    fly.update(dt);
    // keep chunk streaming centered on where we're flying
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    controls.target.copy(camera.position).addScaledVector(fwd, 40);
  } else {
    controls.update();
    // keep the orbit camera and target from sinking under the terrain
    for (const p of [camera.position, controls.target]) {
      const gy = manager.groundWorldY(p.x, p.z);
      if (gy !== null && p.y < gy + 2) p.y = gy + 2;
    }
  }
  if (t - lastChunkUpdate > 400) {
    lastChunkUpdate = t;
    manager.update(camera, controls.target);
    places.update(camera, controls.target, t);
  }
  sky.update(camera, controls.target);
  scene.fog.color.copy(sky.fogColor);
  saveState(t);
  updateLocationStatus(t);
  places.updatePositions((wx, wz) => manager.groundWorldY(wx, wz));
  updateLabelFade();
  renderer.render(scene, camera);
});
