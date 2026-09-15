import * as THREE from 'three';

const ACCEL = 10;       // how quickly velocity approaches target (1/s)
const DAMPING = 6;      // velocity decay when no input (1/s)
const SPRINT = 4;
const UP = new THREE.Vector3(0, 1, 0);
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const clampS = (v) => Math.max(-SPRINT, Math.min(SPRINT, v));

const isTypingTarget = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

export class FlyRig {
  constructor(camera, dom, { getGroundY } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.getGroundY = getGroundY || (() => null); // (wx, wz) -> scene units | null
    this.enabled = false;
    this.baseSpeed = 15; // scene units / s (1 unit = 100 m)
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this.axes = { fwd: 0, strafe: 0, lift: 0, yaw: 0, pitch: 0 }; // virtual sticks (touch)
    this.noPointerLock = false; // touch mode: no pointer lock, sticks drive axes
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();

    this._onMouseMove = (e) => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return;
      this._euler.setFromQuaternion(this.camera.quaternion);
      this._euler.y -= e.movementX * 0.0022;
      this._euler.x -= e.movementY * 0.0022;
      this._euler.x = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this._euler.x));
      this.camera.quaternion.setFromEuler(this._euler);
    };
    this._onKeyDown = (e) => {
      if (!this.enabled || isTypingTarget(e)) return;
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      if (isTypingTarget(e)) return;
      this.keys.delete(e.code);
    };
    this._onWheel = (e) => {
      if (!this.enabled) return;
      this.baseSpeed = Math.max(1, Math.min(150, this.baseSpeed * (e.deltaY > 0 ? 0.85 : 1.18)));
      this.onSpeed?.(this.baseSpeed);
    };
    this._onClick = () => {
      if (this.noPointerLock) return;
      if (this.enabled && document.pointerLockElement !== this.dom) this.dom.requestPointerLock();
    };
    this._onLockChange = () => {
      this.onLock?.(document.pointerLockElement === this.dom);
    };
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.keys.clear();
    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    addEventListener('mousemove', this._onMouseMove);
    addEventListener('wheel', this._onWheel, { passive: true });
    this.dom.addEventListener('click', this._onClick);
    document.addEventListener('pointerlockchange', this._onLockChange);
    if (!this.noPointerLock) {
      try {
        const p = this.dom.requestPointerLock?.();
        p?.catch?.(() => {}); // may fail without a user gesture — fine, click re-locks
      } catch { /* pointer lock unavailable */ }
    }
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    removeEventListener('mousemove', this._onMouseMove);
    removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('click', this._onClick);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
    this.velocity.set(0, 0, 0);
  }

  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    // altitude-scaled speed: near the ground you move precisely, up high you
    // traverse — a 56 km view at ground-level pace would take minutes to cross
    const altScale = Math.min(10, 1 + this.camera.position.y / 100);
    const speed = this.baseSpeed * altScale;

    this.camera.getWorldDirection(this._forward);
    const right = new THREE.Vector3().crossVectors(this._forward, this.camera.up).normalize();

    // virtual-stick axes merge with the keys. A fully deflected stick is
    // the W + Shift sprint speed; a modest push already matches plain W.
    if (this.axes.yaw) this.camera.rotateOnWorldAxis(UP, -this.axes.yaw * dt * 1.6);
    if (this.axes.pitch) {
      this._euler.setFromQuaternion(this.camera.quaternion);
      this._euler.x += this.axes.pitch * dt * 1.2;
      this._euler.x = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this._euler.x));
      this.camera.quaternion.setFromEuler(this._euler);
    }
    const sprintKey = k.has('ShiftLeft') || k.has('ShiftRight');
    const fwdIn = clampS(clamp1((k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0)) * (sprintKey ? SPRINT : 1) + this.axes.fwd * SPRINT);
    const strafeIn = clampS(clamp1((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)) * (sprintKey ? SPRINT : 1) + this.axes.strafe * SPRINT);
    const liftIn = clampS(clamp1((k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0)) + this.axes.lift * SPRINT);

    const target = new THREE.Vector3();
    if (fwdIn) target.addScaledVector(this._forward, fwdIn * speed);
    if (strafeIn) target.addScaledVector(right, strafeIn * speed);
    target.y += liftIn * speed;

    if (target.lengthSq() > 0) {
      this.velocity.lerp(target, Math.min(1, ACCEL * dt));
    } else {
      this.velocity.multiplyScalar(Math.exp(-DAMPING * dt));
      if (this.velocity.lengthSq() < 1e-6) this.velocity.set(0, 0, 0);
    }
    this.camera.position.addScaledVector(this.velocity, dt);

    // ground collision: never sink below the terrain surface
    const gy = this.getGroundY(this.camera.position.x, this.camera.position.z);
    if (gy !== null && this.camera.position.y < gy + 3) {
      this.camera.position.y = gy + 3;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
  }
}
