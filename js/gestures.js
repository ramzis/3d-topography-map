// Google Earth-style multi-touch camera for mobile: one-finger pan,
// pinch-to-zoom (altitude), two-finger vertical swipe (pitch), two-finger
// twist (yaw) — with a 4° twist deadzone, altitude-aware speed scaling and
// exponential-decay inertia on release.
//
// Smoothness: fingers never move the camera directly. Each gesture sets an
// absolute TARGET derived from the finger configuration measured from the
// gesture's start (no incremental error accumulation, no per-event jitter),
// and update(dt) chases it every frame through a first-order low-pass with
// per-frame rate clamps. Pitch is clamped between just-shy-of top-down and a
// near-horizon floor so the camera can never flip or look under terrain.

import * as THREE from 'three';

const PITCH_MIN = -Math.PI / 2 + 0.02;    // top-down
const PITCH_MAX = -10 * Math.PI / 180;   // near-horizon
const TWIST_DEADZONE = 10 * Math.PI / 180; // rotational deadzone — high so zooming never clips into rotation
const CLASSIFY_MOVE = 10;  // px per finger before the two-finger mode is decided

// --- feel tuning ------------------------------------------------------------
const SENS_PAN = 0.5;      // one full screen of drag ≈ half the visible ground
const PITCH_SENS = 0.0018; // rad per px of two-finger centroid travel
const TAU = 0.07;          // smoothing time constant (s): ~4 frames at 60fps
const ZOOM_RATE = 0.12;   // max altitude change per frame (fraction of alt)
const PITCH_RATE = 0.035;  // max pitch change per frame (rad)
const YAW_RATE = 0.05;     // max yaw change per frame (rad)
const PAN_RATE = 0.35;     // max pan per frame (fraction of the gesture target)

const FRICTION = 3.5;      // inertia: v(t) = v0 * e^(-k*t)
const VEL_EPS = 1e-3;      // below this, momentum is "imperceptible"
const HISTORY_MS = 90;     // exit-velocity averaging window (~3-5 frames)
const MAX_ALT = 2400;      // scene units (240 km)
const MIN_ALT = 2;         // floor when no ground data is loaded yet
const MAX_FLING = { pan: 250, alt: 120, pitch: 0.8, yaw: 1.6 }; // velocity caps
const MAX_ORBIT = 600;    // cap on the orbit radius (60 km) — near-horizon views orbit a capped distance, not half the planet

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrapPi = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

export class GestureMap {
  constructor(camera, dom, { getGroundY = () => null, onTouchStart = null } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.getGroundY = getGroundY;
    this.onTouchStart = onTouchStart;

    this.pointers = new Map(); // pointerId -> { x, y } (raw finger positions)
    this.g = null;            // active gesture baseline (targets are absolute from it)
    this.samples = [];        // recent APPLIED per-frame deltas, for exit velocity
    this.vel = { x: 0, z: 0, alt: 0, pitch: 0, yaw: 0 };
    this.orbitPivot = null;   // inertia: the point yaw momentum keeps circling
    this.enabled = false;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    this._down = (e) => this._onDown(e);
    this._move = (e) => this._onMove(e);
    this._up = (e) => this._onUp(e);
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.dom.addEventListener('pointerdown', this._down);
    this.dom.addEventListener('pointermove', this._move);
    this.dom.addEventListener('pointerup', this._up);
    this.dom.addEventListener('pointercancel', this._up);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.dom.removeEventListener('pointerdown', this._down);
    this.dom.removeEventListener('pointermove', this._move);
    this.dom.removeEventListener('pointerup', this._up);
    this.dom.removeEventListener('pointercancel', this._up);
    this.pointers.clear();
    this._endGesture();
  }

  // --- raw input: only finger bookkeeping, never camera application ------

  _onDown(e) {
    this.onTouchStart?.();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._beginGesture();
  }

  _onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 2 && this._classifyTwo() === 'zoom') this._trackTwist();
  }

  _onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) {
      this._beginGesture(); // re-baseline on the surviving finger(s)
    } else {
      this._release();
    }
  }

  /** (re)establish the gesture baseline — every target is measured from here,
   *  so a baseline change never jumps the camera: applied motion is kept. */
  _beginGesture() {
    const cam = this.camera;
    this._euler.setFromQuaternion(cam.quaternion);
    if (this.pointers.size === 1) {
      const [p] = [...this.pointers.values()];
      const fovRad = (cam.fov * Math.PI) / 180;
      // world units per screen pixel at the gesture's starting altitude —
      // held fixed for the gesture so speed doesn't wobble mid-drag
      const k = Math.max(cam.position.y, MIN_ALT) *
        ((2 * Math.tan(fovRad / 2)) / Math.max(1, innerHeight)) * SENS_PAN;
      const yaw = this._euler.y;
      this.g = {
        mode: 'pan',
        k,
        sx: p.x, sy: p.y,             // finger start
        fx: -Math.sin(yaw), fz: -Math.cos(yaw), // yaw-projected ground forward
        rx: Math.cos(yaw), rz: -Math.sin(yaw),  // and right (yaw 0 faces north = -Z)
        cx0: cam.position.x, cz0: cam.position.z,
        appliedX: 0, appliedZ: 0,     // smoothed pan applied so far (world units)
      };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.g = {
        mode: 'two',
        phase: 'undecided',    // classified on first real movement: 'pitch' | 'zoom'
        start1: { x: a.x, y: a.y }, start2: { x: b.x, y: b.y }, // per-finger starts for classification
        dist0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)),
        alt0: cam.position.y,
        angle0: Math.atan2(b.y - a.y, b.x - a.x),
        centroidY0: (a.y + b.y) / 2,
        yaw0: this._euler.y,
        pitch0: this._euler.x,
        twistTotal: 0,
        twistUnlocked: false,
        targetYaw: this._euler.y,     // absolute yaw target (deadzone-gated)
        appliedAlt: 0, appliedYaw: 0, appliedPitch: 0, // smoothed amounts so far
      };
    } else {
      this.g = null;
    }
  }

  /** decide the two-finger mode from how the gesture BEGINS, then lock it
   *  until release: both fingers moving vertically together = pitch mode
   *  (pinch/rotate disabled); anything else = zoom mode (pinch + twist,
   *  pitch disabled). Mutual exclusion kills the gesture clashes. */
  _classifyTwo() {
    const g = this.g;
    if (!g || g.mode !== 'two' || g.phase !== 'undecided') return g ? g.phase : null;
    const [a, b] = [...this.pointers.values()];
    const d1x = a.x - g.start1.x, d1y = a.y - g.start1.y;
    const d2x = b.x - g.start2.x, d2y = b.y - g.start2.y;
    if (Math.hypot(d1x, d1y) < CLASSIFY_MOVE || Math.hypot(d2x, d2y) < CLASSIFY_MOVE) {
      return 'undecided'; // both fingers must have moved before the verdict means anything
    }
    const vertical =
      Math.abs(d1y) > Math.abs(d1x) && Math.abs(d2y) > Math.abs(d2x) && d1y * d2y > 0;
    g.phase = vertical ? 'pitch' : 'zoom';
    if (g.phase === 'zoom') {
      // re-baseline the pinch/twist measurements at the decision point — the
      // deciding movement was vertical, so no distance/angle jump occurs
      g.dist0 = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
      g.angle0 = Math.atan2(b.y - a.y, b.x - a.x);
      this._euler.setFromQuaternion(this.camera.quaternion);
      g.yaw0 = this._euler.y;
      g.twistTotal = 0;
      g.targetYaw = g.yaw0;
    }
    return g.phase;
  }

  /** accumulate twist since gesture start; unlock past the deadzone */
  _trackTwist() {
    const g = this.g;
    if (!g || g.mode !== 'two' || g.phase !== 'zoom') return;
    const [a, b] = [...this.pointers.values()];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (!g.twistUnlocked) {
      g.twistTotal += wrapPi(angle - g.angle0 - g.twistTotal);
      if (Math.abs(g.twistTotal) >= TWIST_DEADZONE) g.twistUnlocked = true;
    }
    // absolute target: where the camera yaw should be, from the start yaw and
    // the total finger rotation — incremental jitter never accumulates
    const total = g.twistUnlocked ? wrapPi(angle - g.angle0) : 0;
    g.targetYaw = g.yaw0 + total; // map follows the fingers: CW twist = CW view
  }

  // --- per-frame application (called from the render loop) -----------------

  update(dt) {
    if (!this.enabled) return;
    if (this.g) {
      this._updateActive(dt);
    } else {
      this._updateInertia(dt);
    }
    this._clampGround();
  }

  _updateActive(dt) {
    const g = this.g;
    const cam = this.camera;
    // first-order low-pass: fraction of the remaining distance to cover this
    // frame — frame-rate independent, smooths away finger jitter
    const s = 1 - Math.exp(-dt / TAU);

    if (g.mode === 'pan') {
      const [p] = [...this.pointers.values()];
      // absolute pan target from the finger's offset since the gesture start —
      // "grab the map": the map follows the finger, so the camera moves
      // opposite (drag up pulls the map up = camera retreats south)
      const tx = (g.fx * (p.y - g.sy) - g.rx * (p.x - g.sx)) * g.k;
      const tz = (g.fz * (p.y - g.sy) - g.rz * (p.x - g.sx)) * g.k;
      let stepX = clamp((tx - g.appliedX) * s, -g.k * 800 * PAN_RATE, g.k * 800 * PAN_RATE);
      let stepZ = clamp((tz - g.appliedZ) * s, -g.k * 800 * PAN_RATE, g.k * 800 * PAN_RATE);
      cam.position.x += stepX;
      cam.position.z += stepZ;
      g.appliedX += stepX;
      g.appliedZ += stepZ;
      this._sample(stepX, stepZ, 0, 0, 0);
    } else if (g.mode === 'two' && this.pointers.size === 2) {
      if (g.phase === 'undecided') return; // wait for the gesture to declare itself
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y));
      const cy = (a.y + b.y) / 2;

      if (g.phase === 'pitch') {
        // PITCH MODE (locked at gesture start by the vertical finger
        // vectors): only the tilt changes; pinch and rotate are ignored
        // until release. Dragging down tilts toward top-down.
        const targetPitch = clamp(g.pitch0 - (cy - g.centroidY0) * PITCH_SENS, PITCH_MIN, PITCH_MAX);
        let stepPitch = clamp((targetPitch - g.pitch0 - g.appliedPitch) * s, -PITCH_RATE, PITCH_RATE);
        if (stepPitch) this._rotate(stepPitch, 0);
        g.appliedPitch += stepPitch;
        this._sample(0, 0, 0, stepPitch, 0);
        return;
      }

      // ZOOM MODE (locked at gesture start): pinch + twist only, no pitch.

      // unified pivot: the height-scaled point ahead — twist sets our ANGLE
      // around it, pinch sets our DISTANCE to it. One shared pivot means the
      // two motions compose (rotate the radius vector, then scale its
      // length) instead of fighting over the camera position.
      if (!g.pivot) {
        g.pivot = this._orbitPoint();
        g.startR = Math.hypot(cam.position.x - g.pivot.x, cam.position.y - g.pivot.y, cam.position.z - g.pivot.z);
      }
      const pv = g.pivot;
      const px0 = cam.position.x, py0 = cam.position.y, pz0 = cam.position.z;

      // --- twist: orbit step (rotate around the pivot, keeps its distance) ---
      let dyaw = wrapPi(g.targetYaw - (g.yaw0 + g.appliedYaw));
      let stepYaw = clamp(dyaw * s, -YAW_RATE, YAW_RATE);
      if (stepYaw) {
        const cos = Math.cos(stepYaw), sin = Math.sin(stepYaw);
        const dx = cam.position.x - pv.x, dz = cam.position.z - pv.z;
        cam.position.x = pv.x + dx * cos + dz * sin;
        cam.position.z = pv.z - dx * sin + dz * cos;
        this.orbitPivot = pv; // inertia keeps orbiting the same point
      }

      // --- pinch: radius step toward/away from the pivot (zoom = approach,
      //     top-down reduces to a plain altitude change) ---
      const f = clamp(dist / g.dist0, 0.15, 6);
      let ux = cam.position.x - pv.x, uy = cam.position.y - pv.y, uz = cam.position.z - pv.z;
      const curR = Math.hypot(ux, uy, uz) || 1e-6;
      const targetR = clamp(g.startR / f, 3, 700);
      const newR = curR + clamp((targetR - curR) * s, -ZOOM_RATE * curR, ZOOM_RATE * curR);
      const k = newR / curR;
      cam.position.set(pv.x + ux * k, pv.y + uy * k, pv.z + uz * k);

      // ground / ceiling clamps
      const minAlt = this._minAltitude();
      if (cam.position.y < minAlt) cam.position.y = minAlt;
      if (cam.position.y > MAX_ALT) cam.position.y = MAX_ALT;

      // --- parallel vertical drift is ignored in zoom mode (pitch is a
      //     separate gesture, locked at gesture start) ---
      if (stepYaw) this._rotate(0, stepYaw);
      g.appliedYaw += stepYaw;

      // momentum: what the camera actually did this frame (orbit + dolly)
      this._sample(cam.position.x - px0, cam.position.z - pz0, cam.position.y - py0, 0, stepYaw);
    }
  }

  _updateInertia(dt) {
    const v = this.vel;
    const decay = Math.exp(-FRICTION * dt);

    if (Math.abs(v.x) > VEL_EPS || Math.abs(v.z) > VEL_EPS) {
      this.camera.position.x += v.x * dt;
      this.camera.position.z += v.z * dt;
      v.x *= decay; v.z *= decay;
    } else { v.x = 0; v.z = 0; }

    if (Math.abs(v.alt) > VEL_EPS) {
      this.camera.position.y = clamp(this.camera.position.y + v.alt * dt, this._minAltitude(), MAX_ALT);
      v.alt *= decay;
    } else { v.alt = 0; }

    if (Math.abs(v.pitch) > VEL_EPS || Math.abs(v.yaw) > VEL_EPS) {
      if (Math.abs(v.yaw) > VEL_EPS && this.orbitPivot) {
        this._orbitYaw(v.yaw * dt, this.orbitPivot); // keep circling the same point
        this._rotate(v.pitch * dt, 0);
      } else {
        this._rotate(v.pitch * dt, v.yaw * dt);
      }
      v.pitch *= decay; v.yaw *= decay;
    } else { v.pitch = 0; v.yaw = 0; this.orbitPivot = null; }
  }

  // --- helpers -----------------------------------------------------------

  /** world units per screen pixel, for inertia ground-clamping context */
  _worldPerPixel() {
    const fovRad = (this.camera.fov * Math.PI) / 180;
    return Math.max(this.camera.position.y, MIN_ALT) * ((2 * Math.tan(fovRad / 2)) / Math.max(1, innerHeight));
  }

  _minAltitude() {
    const gy = this.getGroundY(this.camera.position.x, this.camera.position.z);
    return (gy ?? 0) + 3;
  }

  _clampGround() {
    const min = this._minAltitude();
    if (this.camera.position.y < min) {
      this.camera.position.y = min;
      if (this.vel.alt < 0) this.vel.alt = 0;
    }
  }

  _rotate(dPitch, dYaw) {
    this._euler.setFromQuaternion(this.camera.quaternion);
    this._euler.x = clamp(this._euler.x + dPitch, PITCH_MIN, PITCH_MAX);
    this._euler.y += dYaw;
    this.camera.quaternion.setFromEuler(this._euler);
  }

  /** the pivot both gestures share: the ground point under the CENTER of
   *  the view — where the view ray meets the terrain. Twist orbits around it
   *  and pinch zooms toward it, so rotation visibly pivots the map around
   *  the middle of the screen. The circle radius is set by the view itself:
   *  tight when looking down, wide when tilted (capped near horizon). */
  _orbitPoint() {
    const cam = this.camera;
    const dir = this._dir || (this._dir = new THREE.Vector3());
    cam.getWorldDirection(dir);
    const groundHere = this.getGroundY(cam.position.x, cam.position.z) ?? 0;
    let h = Math.max(cam.position.y - groundHere, 2);
    const fl = Math.hypot(dir.x, dir.z);
    // horizontal distance where the center ray meets flat ground: h/tan(pitch)
    const horiz = fl > 1e-4 ? Math.min(h * fl / Math.max(-dir.y, 0.02), MAX_ORBIT) : 0;
    let x = cam.position.x + (fl > 1e-4 ? (dir.x / fl) * horiz : 0);
    let z = cam.position.z + (fl > 1e-4 ? (dir.z / fl) * horiz : 0);
    // one refinement against the terrain height at the landing spot
    const gy = this.getGroundY(x, z);
    if (gy !== null) {
      h = Math.max(cam.position.y - gy, 2);
      const h2 = fl > 1e-4 ? Math.min(h * fl / Math.max(-dir.y, 0.02), MAX_ORBIT) : 0;
      x = cam.position.x + (fl > 1e-4 ? (dir.x / fl) * h2 : 0);
      z = cam.position.z + (fl > 1e-4 ? (dir.z / fl) * h2 : 0);
    }
    return { x, z, y: this.getGroundY(x, z) ?? gy ?? groundHere };
  }

  /** rotate the camera dYaw around a pivot point on the ground — the camera
   *  moves in a circle around what we're looking at while turning to keep
   *  it centered, so the map appears to rotate under the gaze */
  _orbitYaw(dYaw, pivot) {
    if (pivot) {
      const cam = this.camera;
      const cos = Math.cos(dYaw), sin = Math.sin(dYaw);
      const dx = cam.position.x - pivot.x;
      const dz = cam.position.z - pivot.z;
      cam.position.x = pivot.x + dx * cos + dz * sin;
      cam.position.z = pivot.z - dx * sin + dz * cos;
    }
    this._rotate(0, dYaw);
  }

  // --- momentum -----------------------------------------------------------

  _sample(mx, mz, dAlt, dPitch, dYaw) {
    const t = performance.now();
    this.samples.push({ t, mx, mz, dAlt, dPitch, dYaw });
    while (this.samples.length && t - this.samples[0].t > HISTORY_MS) this.samples.shift();
  }

  _endGesture() {
    this.g = null;
    this.samples = [];
    this.vel = { x: 0, z: 0, alt: 0, pitch: 0, yaw: 0 };
  }

  /** fingers left the screen: average the recent APPLIED frames into exit
   *  velocities — smoothed deltas, so no micro-stutter spikes get flung */
  _release() {
    const now = performance.now();
    const recent = this.samples.filter((s) => now - s.t <= HISTORY_MS);
    if (recent.length >= 2) {
      const span = Math.max(1e-3, (now - recent[0].t) / 1000);
      const sum = { x: 0, z: 0, alt: 0, pitch: 0, yaw: 0 };
      for (const s of recent) {
        sum.x += s.mx; sum.z += s.mz; sum.alt += s.dAlt; sum.pitch += s.dPitch; sum.yaw += s.dYaw;
      }
      this.vel = {
        x: clamp(sum.x / span, -MAX_FLING.pan, MAX_FLING.pan),
        z: clamp(sum.z / span, -MAX_FLING.pan, MAX_FLING.pan),
        alt: clamp(sum.alt / span, -MAX_FLING.alt, MAX_FLING.alt),
        pitch: clamp(sum.pitch / span, -MAX_FLING.pitch, MAX_FLING.pitch),
        yaw: clamp(sum.yaw / span, -MAX_FLING.yaw, MAX_FLING.yaw),
      };
    } else {
      this.vel = { x: 0, z: 0, alt: 0, pitch: 0, yaw: 0 };
    }
    this.g = null;
    this.samples = [];
  }
}
