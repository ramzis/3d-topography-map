import * as THREE from 'three';
import { worldToMerc, mercXToLon, mercYToLat } from './geo.js';

const RAD = Math.PI / 180;

// --- astronomy -------------------------------------------------------------------
function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function sunPosition(date, lat, lon) {
  const jd = julianDate(date);
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  return eclipticToHorizontal(lambda, eps, date, lat, lon);
}

function moonPosition(date, lat, lon) {
  const jd = julianDate(date);
  const synodic = 29.530588853;
  const knownNewMoon = 2451550.1; // 2000-01-06 18:14 UTC
  const phase = ((jd - knownNewMoon) / synodic) % 1; // 0 new … 0.5 full
  const elongation = phase * 360 * RAD;
  const illum = (1 - Math.cos(elongation)) / 2;

  // sun's ecliptic longitude (for the moon's approximate longitude)
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const sunLon = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;

  const eps = (23.439 - 0.0000004 * n) * RAD;
  const pos = eclipticToHorizontal(sunLon + elongation, eps, date, lat, lon);
  return { ...pos, illum, phase };
}

function eclipticToHorizontal(lambda, eps, date, lat, lon) {
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const delta = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const jd = julianDate(date);
  const n = jd - 2451545.0;
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * RAD;
  const H = lst - alpha;
  const latR = lat * RAD;
  const alt = Math.asin(
    Math.sin(latR) * Math.sin(delta) + Math.cos(latR) * Math.cos(delta) * Math.cos(H)
  );
  const az = Math.atan2(
    -Math.cos(delta) * Math.sin(H),
    Math.sin(delta) * Math.cos(latR) - Math.cos(delta) * Math.sin(latR) * Math.cos(H)
  );
  return { elevation: alt / RAD, azimuth: az / RAD };
}

function skyDirection(elevationDeg, azimuthDeg) {
  const e = elevationDeg * RAD;
  const a = azimuthDeg * RAD;
  return new THREE.Vector3(
    Math.sin(a) * Math.cos(e),
    Math.sin(e),
    -Math.cos(a) * Math.cos(e)
  );
}

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- the sky ---------------------------------------------------------------------
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uDay;        // 0 night … 1 day
  uniform float uSunElev;    // radians
  uniform float uMoonIllum;  // 0 … 1
  uniform float uNight;      // star/moon visibility

  void main() {
    vec3 dir = normalize(vDir);

    // base gradient
    vec3 dayTop = vec3(0.30, 0.50, 0.80);
    vec3 dayHor = vec3(0.75, 0.84, 0.93);
    vec3 nightTop = vec3(0.015, 0.02, 0.05);
    vec3 nightHor = vec3(0.05, 0.07, 0.13);
    vec3 top = mix(nightTop, dayTop, uDay);
    vec3 hor = mix(nightHor, dayHor, uDay);
    vec3 col = mix(hor, top, smoothstep(0.0, 0.45, dir.y));

    // warm band around the sun near the horizon (sunrise/sunset)
    float s = max(dot(dir, uSunDir), 0.0);
    float twilight = exp(-abs(uSunElev) * 10.0);
    vec3 warm = vec3(1.0, 0.45, 0.20) * pow(s, 3.0) * twilight * 0.55;
    col += warm;

    // sun glow + disc
    col += vec3(1.0, 0.85, 0.6) * pow(s, 180.0) * uDay * 0.8;
    col += vec3(1.0, 0.97, 0.9) * smoothstep(0.99965, 0.99993, s) * uDay;

    // moon with a simple phase: lit side faces the sun
    float m = dot(dir, uMoonDir);
    float disc = smoothstep(0.99988, 0.99997, m);
    if (disc > 0.0) {
      vec3 towardSun = normalize(uSunDir - uMoonDir * dot(uSunDir, uMoonDir));
      float along = dot(normalize(dir - uMoonDir * m), towardSun);
      float lit = smoothstep((2.0 * uMoonIllum - 1.0) - 0.05, (2.0 * uMoonIllum - 1.0) + 0.05, along);
      col += vec3(0.92, 0.94, 1.0) * disc * mix(0.15, 1.0, lit) * uNight;
    }
    // faint moon glow
    col += vec3(0.5, 0.55, 0.7) * pow(max(m, 0.0), 350.0) * 0.12 * uNight;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class DayNightSky {
  constructor(scene) {
    this.scene = scene;

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uDay: { value: 1 },
      uSunElev: { value: 0.5 },
      uMoonIllum: { value: 0.5 },
      uNight: { value: 0 },
    };

    // dome (follows the camera each frame)
    this.group = new THREE.Group();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(3500, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: this.uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    this.group.add(dome);

    // stars
    const starCount = 2200;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection();
      positions[i * 3] = v.x * 3300;
      positions[i * 3 + 1] = Math.abs(v.y) * 3300; // upper hemisphere only
      positions[i * 3 + 2] = v.z * 3300;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xdfe8ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.group.add(new THREE.Points(starGeo, this.starMat));
    scene.add(this.group);
    scene.background = null;

    // terrain lights (replace any previous lighting)
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.moonLight = new THREE.DirectionalLight(0x9db8e8, 0);
    this.hemi = new THREE.HemisphereLight(0xdfe8f5, 0x30281e, 1.0);
    scene.add(this.sunLight, this.moonLight, this.hemi);

    this.lastAstroAt = 0;
    this.lastPlace = null;
    this.moon = { elevation: 0, azimuth: 0, illum: 0.5 };
    this.sun = { elevation: 0, azimuth: 180 };
    this.alwaysNoon = false;
  }

  setAlwaysNoon(on) {
    this.alwaysNoon = on;
    this.lastAstroAt = 0; // force recompute on next update
    this.lastPlace = null;
  }

  _recompute(target) {
    const [mx, my] = worldToMerc(target.x, target.z);
    const lon = mercXToLon(mx);
    const lat = mercYToLat(my);
    const now = new Date();
    let when = now;
    if (this.alwaysNoon) {
      // local solar noon: 12:00 UTC shifted by longitude (15° per hour)
      const d = new Date();
      when = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) +
        (12 - lon / 15) * 3600 * 1000
      );
    }
    this.sun = sunPosition(when, lat, lon);
    this.moon = moonPosition(when, lat, lon);

    const sunDir = skyDirection(this.sun.elevation, this.sun.azimuth);
    this.uniforms.uSunDir.value.copy(sunDir);
    const moonDir = skyDirection(this.moon.elevation, this.moon.azimuth);
    this.uniforms.uMoonDir.value.copy(moonDir);

    const e = this.sun.elevation;
    const day = smoothstep(-8, 4, e);
    this.uniforms.uDay.value = day;
    this.uniforms.uNight.value = 1 - smoothstep(-14, -4, e);
    this.uniforms.uSunElev.value = e * RAD;
    this.uniforms.uMoonIllum.value = this.moon.illum;

    // terrain lighting follows the sky
    this.sunLight.position.copy(sunDir).multiplyScalar(1000);
    this.sunLight.intensity = 2.2 * smoothstep(-1, 12, e);
    const warm = new THREE.Color(0xff8a3c);
    const white = new THREE.Color(0xffffff);
    this.sunLight.color.copy(warm).lerp(white, smoothstep(2, 35, e));

    const moonUp = smoothstep(-2, 8, this.moon.elevation);
    this.moonLight.position.copy(moonDir).multiplyScalar(1000);
    this.moonLight.intensity = 0.4 * (1 - day) * moonUp * this.moon.illum;

    this.hemi.intensity = 0.18 + 0.9 * day;
    this.starMat.opacity = this.uniforms.uNight.value * 0.9;
  }

  update(camera, target) {
    this.group.position.copy(camera.position);
    const now = performance.now();
    const moved = !this.lastPlace || this.lastPlace.distanceTo(target) > 8;
    if (moved || now - this.lastAstroAt > 30000) {
      this.lastAstroAt = now;
      this.lastPlace = target.clone();
      this._recompute(target);
    }
  }

  get fogColor() {
    const day = this.uniforms.uDay.value;
    return new THREE.Color(0x0a0f1e).lerp(new THREE.Color(0xbfd0e0), day);
  }
}
