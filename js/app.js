import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ChunkManager } from './chunks.js';
import { cacheStats } from './geo.js';
import { WardOverlay } from './wards.js';
import { FlyRig } from './fly.js';
import { mountExaggeration } from './exag.js';
import { VirtualStick } from './joystick.js';
import { PlacesLayer } from './places.js';
import { initAnalytics } from './analytics.js';
import { mountSearch } from './search.js';
import { mountGems } from './gems.js';
import { mountLanding } from './landing.js';
import { mountLocationStatus } from './location.js';
import { fetchStats } from './geo.js';
import { FillerLayer } from './filler.js';
import { GestureMap } from './gestures.js';
import { teleportTo } from './teleport.js';
import { DayNightSky } from './sky.js';
import { rollRandomLandPlace } from './dice.js';
import {
  stateFromUrl, stateFromStorage, applyState, createStateSaver, encodeState, writeUrl,
} from './state.js';

const DEFAULT_EXAGGERATION = 6;
const ALWAYS_NOON_DEFAULT = true; // sun toggle starts on — always daytime

// --- renderer / scene -----------------------------------------------------------
// touch detection must precede the renderer: mobile gets a cheaper pipeline
const isTouch = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ antialias: !isTouch });
// 1.5 on touch: a 3x phone screen at full ratio costs ~4x the fill rate for
// little visible gain on moving terrain — this is the single biggest
// mobile render-cost saving
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
// the classic mobile "silent" death: the GPU driver drops the WebGL
// context (no JS error) and the page freezes — report it so we know
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  window.Sentry?.captureMessage('WebGL context lost', 'fatal');
  e.preventDefault();
});
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
const filler = new FillerLayer(scene, manager);

const exag = mountExaggeration({
  value: DEFAULT_EXAGGERATION,
  onChange: (f) => {
    manager.setExaggeration(f);
    wards.updateExaggeration(f);
  },
});

// --- restore shared/saved view state (URL → localStorage → default) ----------------
const savedState = stateFromUrl() || stateFromStorage();
if (savedState) {
  applyState(savedState, camera, controls, (f) => {
    exag.set(f);
    manager.setExaggeration(exag.get());
    wards.updateExaggeration(exag.get());
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
const saveState = createStateSaver(camera, () => exag.get());
const updateLocationStatus = mountLocationStatus(camera);

// --- imagery outage notice -------------------------------------------------------
// When satellite tiles stop arriving (blocked network, offline, throttling)
// chunks fall back to flat-colored terrain — say so instead of looking
// broken, and clear the notice automatically when imagery recovers.
const netBanner = document.createElement('div');
netBanner.textContent = '🛰 Satellite imagery unavailable — terrain-only mode, retrying…';
netBanner.className =
  'glass fixed top-3 left-1/2 -translate-x-1/2 z-30 rounded-full px-4 py-2 text-sm ' +
  'pointer-events-none hidden whitespace-nowrap';
document.body.appendChild(netBanner);
let lastBannerCheck = 0;

manager.update(camera, controls.target);

wards
  .load()
  .then(() => {
    wards.decorateLoaded();
  })
  .catch((err) => console.warn('wards failed:', err.message));

// --- UI -------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// touch devices keep the OrbitControls gestures:
// one finger — orbit, pinch — zoom, two fingers — pan

const fly = new FlyRig(camera, renderer.domElement, {
  getGroundY: (wx, wz) => manager.groundWorldY(wx, wz),
});

// mobile control state: gesture map (default) vs legacy virtual joystick
let mobileControlMode = 'gesture';
let gesture = null;
let viewAnim = null; // compass reset: yaw/pitch interpolation

// --- always-day toggle: pin the sun to local noon ------------------------------------
// on by default — daytime, until the user turns it off
sky.setAlwaysNoon(ALWAYS_NOON_DEFAULT);
$('sunBtn').classList.toggle('on', ALWAYS_NOON_DEFAULT);

$('sunBtn').addEventListener('click', () => {
  const on = !sky.alwaysNoon;
  sky.setAlwaysNoon(on);
  $('sunBtn').classList.toggle('on', on);
});

if (!isTouch) {
  // desktop: spectator fly camera (click the view to capture the mouse)
  controls.enabled = false;
  fly.enable();
} else {
  // touch: standard dual-stick scheme — left stick moves (forward/strafe),
  // right stick looks (turn + up/down), hold buttons climb/descend,
  // single tap glides to the tapped spot
  controls.enabled = false;
  fly.noPointerLock = true;
  fly.enable();

  const leftStick = new VirtualStick({ className: 'left-4 bottom-[calc(64px+env(safe-area-inset-bottom))]' });
  const rightStick = new VirtualStick({ className: 'right-4 bottom-[calc(64px+env(safe-area-inset-bottom))]' });
  leftStick.onChange = (x, y) => { fly.axes.strafe = x; fly.axes.fwd = -y; };
  rightStick.onChange = (x, y) => { fly.axes.yaw = x; fly.axes.pitch = -y; };

  // throttle buttons (drone-style climb / descend), centered between the sticks
  const altBox = document.createElement('div');
  altBox.id = 'altBox';
  altBox.className =
    'fixed left-1/2 -translate-x-1/2 z-30 flex flex-col gap-2 ' +
    'bottom-[calc(64px+env(safe-area-inset-bottom))]';
  const chevron = (up) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${up ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'}"/></svg>`;
  for (const dir of [1, -1]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-box';
    btn.setAttribute('aria-label', dir > 0 ? 'climb' : 'descend');
    btn.innerHTML = chevron(dir > 0);
    const stop = () => { fly.axes.lift = 0; };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); fly.axes.lift = dir; });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu
    altBox.appendChild(btn);
  }
  document.body.appendChild(altBox);

  // anchor the exaggeration thermometer to the top-left, clear of the
  // left button stack (gems / mode toggle / compass) and the sticks
  exag.el.style.top = '10rem';

  // the location line doubles as the search bar: move the search input +
  // dropdown into the pill (before mountSearch binds them — listeners are
  // attached to the elements, which survive the move), and toggle between
  // label mode and typing mode
  const loc = document.getElementById('locationStatus');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const locSearchBtn = document.getElementById('locSearchBtn');
  searchInput.className =
    'grow min-w-0 bg-transparent outline-none text-base text-ink placeholder:text-muted';
  loc.insertBefore(searchInput, locSearchBtn);
  loc.appendChild(searchResults);
  const startSearch = () => {
    loc.classList.add('searching');
    searchInput.focus();
  };
  const endSearch = () => {
    // collapse after a short delay: tapping a result first blurs the input
    // (focusout) and only then fires the result's click — clearing the
    // dropdown instantly would remove the button before that click lands,
    // which is why tap-to-select did nothing on mobile
    setTimeout(() => {
      if (document.activeElement === searchInput) return; // refocused — typing continues
      loc.classList.remove('searching');
      searchResults.innerHTML = '';
    }, 250);
  };
  locSearchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startSearch();
  });
  loc.addEventListener('click', () => {
    if (!loc.classList.contains('searching')) startSearch();
  });
  searchInput.addEventListener('focusout', endSearch);

  // --- control modes: Google Earth-style gestures (default) vs the legacy
  // dual-stick scheme. The toggle button on the left stack shows the mode
  // it switches TO; the compass (gesture mode only) resets north-up top-down.
  gesture = new GestureMap(camera, renderer.domElement, {
    getGroundY: (wx, wz) => manager.groundWorldY(wx, wz),
    onTouchStart: () => { glide = null; viewAnim = null; }, // a touch interrupts animations
  });

  const ICONS = {
    // what the toggle switches TO, shown as the button's face
    sticks:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="11" r="1" fill="currentColor"/><circle cx="17.5" cy="13.5" r="1" fill="currentColor"/><path d="M17.2 5H6.8a4 4 0 0 0-3.9 3.1L1.5 15a3 3 0 0 0 5.3 2.2L9 15h6l2.2 2.2A3 3 0 0 0 22.5 15l-1.4-6.9A4 4 0 0 0 17.2 5Z"/></svg>',
    gestures:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v4"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
  };

  const ctrlModeBtn = document.createElement('button');
  ctrlModeBtn.id = 'ctrlModeBtn';
  ctrlModeBtn.type = 'button';
  ctrlModeBtn.className = 'icon-box labelled';
  ctrlModeBtn.addEventListener('click', () => {
    mobileControlMode = mobileControlMode === 'gesture' ? 'joystick' : 'gesture';
    applyControlMode();
  });
  document.body.appendChild(ctrlModeBtn);

  const compassBtn = document.createElement('button');
  compassBtn.id = 'compassBtn';
  compassBtn.type = 'button';
  compassBtn.className = 'icon-box labelled';
  compassBtn.setAttribute('aria-label', 'reset view north-up');
  compassBtn.title = 'North-up top-down';
  compassBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 5.4-5.4 2.1 2.1-5.4Z"/></svg>' +
    '<span class="btn-label">North</span>';
  compassBtn.addEventListener('click', () => {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    const dyaw = ((0 - e.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI; // shortest path
    viewAnim = {
      t0: performance.now(), dur: 500,
      yaw0: e.y, dyaw,
      pitch0: e.x, dpitch: (-Math.PI / 2 + 0.02) - e.x, // top-down
    };
  });
  document.body.appendChild(compassBtn);

  function applyControlMode() {
    const gestures = mobileControlMode === 'gesture';
    if (gestures) gesture.enable(); else gesture.disable();
    leftStick.el.classList.toggle('hidden', gestures);
    rightStick.el.classList.toggle('hidden', gestures);
    altBox.classList.toggle('hidden', gestures);
    compassBtn.classList.toggle('hidden', !gestures);
    // zero the legacy axes so no stick input leaks across the switch
    fly.axes.fwd = fly.axes.strafe = fly.axes.lift = fly.axes.yaw = fly.axes.pitch = 0;
    // the button's face is the mode it switches TO
    ctrlModeBtn.innerHTML = (gestures ? ICONS.sticks : ICONS.gestures) +
      `<span class="btn-label">${gestures ? 'Sticks' : 'Gestures'}</span>`;
    ctrlModeBtn.setAttribute('aria-label', gestures ? 'switch to joystick controls' : 'switch to gesture controls');
    ctrlModeBtn.title = gestures ? 'Joystick controls' : 'Gesture controls';
  }
  applyControlMode(); // default: GESTURE_MAP
  exag.el.style.transform = 'none';
}

// --- double-tap / double-click: raycast the tapped spot and glide there -----------
const tapRay = new THREE.Raycaster();
let glide = null; // { t0, dur, fromPos, fromTarget, toPos, toTarget }

function glideToScreen(cx, cy) {
  tapRay.setFromCamera(
    new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1),
    camera
  );
  const meshes = [];
  for (const c of manager.chunks.values()) if (c.terrain && c.group.visible) meshes.push(c.terrain);
  const hit = tapRay.intersectObjects(meshes, false)[0];
  if (!hit) return;
  const gy = manager.groundWorldY(hit.point.x, hit.point.z);
  if (gy === null) return;
  const toTarget = new THREE.Vector3(hit.point.x, gy, hit.point.z);
  // keep the current view offset (height + direction) relative to the target
  const offset = camera.position.clone().sub(controls.target);
  glide = {
    t0: performance.now(),
    dur: 700,
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toTarget,
    toPos: toTarget.clone().add(offset),
  };
  if (fly.enabled) fly.velocity.set(0, 0, 0);
}

// single tap on the map flies to the tapped spot
let tapId = null, tapX = 0, tapY = 0, tapMoved = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || tapId !== null) return;
  tapId = e.pointerId; tapX = e.clientX; tapY = e.clientY; tapMoved = 0;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerId !== tapId) return;
  tapMoved += Math.hypot(e.clientX - tapX, e.clientY - tapY);
  tapX = e.clientX; tapY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.pointerId !== tapId) return;
  tapId = null;
  if (tapMoved < 12 && !glide) glideToScreen(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('pointercancel', (e) => {
  if (e.pointerId === tapId) tapId = null;
});
if (!isTouch) renderer.domElement.addEventListener('dblclick', (e) => glideToScreen(e.clientX, e.clientY));

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

// landing showcase: card taps teleport there, Explore just closes it
// (the app has been booting behind the overlay the whole time)
mountLanding({
  onTeleport: (place) => teleportTo(place, { camera, controls, fly, manager }),
});

// --- location gems: paid teleport list -----------------------------------------
mountGems({
  onSelect: (gem) => teleportTo(gem, { camera, controls, fly, manager }),
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
  writeUrl(encodeState(camera, exag.get()));
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
let lastMemT = 0;
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
  if (glide) {
    // ease camera + orbit target to the double-tapped spot
    const k = Math.min(1, (performance.now() - glide.t0) / glide.dur);
    const s = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2; // ease-in-out quad
    camera.position.lerpVectors(glide.fromPos, glide.toPos, s);
    controls.target.lerpVectors(glide.fromTarget, glide.toTarget, s);
    if (k >= 1) glide = null;
  }
  if (viewAnim) {
    // compass reset: interpolate yaw (shortest path to north) and pitch to
    // top-down — position and altitude are left untouched
    const k = Math.min(1, (performance.now() - viewAnim.t0) / viewAnim.dur);
    const s = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2; // ease-in-out quad
    camera.rotation.order = 'YXZ';
    camera.rotation.set(viewAnim.pitch0 + viewAnim.dpitch * s, viewAnim.yaw0 + viewAnim.dyaw * s, 0);
    if (k >= 1) viewAnim = null;
  }
  if (gesture) gesture.update(dt);
  if (t - lastChunkUpdate > 400) {
    lastChunkUpdate = t;
    manager.update(camera, controls.target);
    places.update(camera, controls.target, t);
    filler.update(camera, controls.target);
  }
  sky.update(camera, controls.target);
  scene.fog.color.copy(sky.fogColor);
  // fog ends where the satellite fill ends (so the fill is never fog-hidden,
  // and there is never unfilled visible ground beyond it) — filler.fogFar is
  // the camera-to-far-edge distance of the actual fill cone
  const fogFar = Math.max(2600, filler.fogFar ?? filler.currentRadius ?? 2600);
  scene.fog.near = fogFar * 0.35;
  scene.fog.far = fogFar;
  // grow the far clip plane if the stretched view needs it (never shrinks)
  const neededFar = fogFar + 600;
  if (camera.far < neededFar) {
    camera.far = neededFar;
    camera.updateProjectionMatrix();
  }
  saveState(t);
  updateLocationStatus(t);

  // memory breadcrumb every 10s: a tab that gets OOM-killed by the browser
  // sends nothing at all (renderer dies, JS never runs again) — but the
  // growth trajectory left in breadcrumbs/replays tells the story after the
  // next successful event
  if (t - lastMemT > 10000) {
    lastMemT = t;
    const cs = cacheStats();
    const mem = performance.memory
      ? ` · jsHeap ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB`
      : '';
    window.Sentry?.addBreadcrumb({
      category: 'memory',
      level: 'info',
      message: `tiles ${cs.size}/${cs.max} · places ${places.places.size} · chunks ${manager.chunks.size}${mem}`,
    });
  }

  // imagery outage notice: untextured ready chunks piling up + no tile
  // success for 20s ⇒ tell the user (auto-clears on recovery)
  if (t - lastBannerCheck > 2000) {
    lastBannerCheck = t;
    let flat = 0;
    for (const c of manager.chunks.values()) {
      if (c.state === 'ready' && !c.imageryTex) flat++;
    }
    const outage = flat >= 5 && Date.now() - fetchStats.lastImgAt > 20000;
    netBanner.classList.toggle('hidden', !outage);
  }

  places.updatePositions((wx, wz) => manager.groundWorldY(wx, wz));
  updateLabelFade();
  renderer.render(scene, camera);
});
