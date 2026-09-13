/**
 * CS-spectator-style fly camera: pointer-lock mouse look + WASD gliding.
 *  - W/S: forward/back along the view direction (pitch included)
 *  - A/D: strafe left/right
 *  - Space: up, C: down
 *  - Shift: 4x sprint
 *  - Mouse wheel: adjust base speed
 */
import * as THREE from 'three';

const ACCEL = 10;       // how quickly velocity approaches target (1/s)
const DAMPING = 6;      // velocity decay when no input (1/s)
const SPRINT = 4;

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
    try {
      const p = this.dom.requestPointerLock?.();
      p?.catch?.(() => {}); // may fail without a user gesture — fine, click re-locks
    } catch { /* pointer lock unavailable */ }
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

  /** Integrate one frame. dt in seconds. */
  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    const speed = this.baseSpeed * (k.has('ShiftLeft') || k.has('ShiftRight') ? SPRINT : 1);

    this.camera.getWorldDirection(this._forward);
    const right = new THREE.Vector3().crossVectors(this._forward, this.camera.up).normalize();

    const target = new THREE.Vector3();
    if (k.has('KeyW')) target.addScaledVector(this._forward, speed);
    if (k.has('KeyS')) target.addScaledVector(this._forward, -speed);
    if (k.has('KeyD')) target.addScaledVector(right, speed);
    if (k.has('KeyA')) target.addScaledVector(right, -speed);
    if (k.has('Space')) target.y += speed;
    if (k.has('KeyC')) target.y -= speed;

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
