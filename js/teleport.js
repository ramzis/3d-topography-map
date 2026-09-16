import { lonToMercX, latToMercY, mercToWorld, worldToChunk } from './geo.js';

export function teleportTo({ lat, lon, name }, { camera, controls, fly, manager }, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'teleport-overlay';
    const message = opts.label ?? `Flying to ${escapeHtml(name)}…`;
    overlay.innerHTML =
      '<div class="teleport-card">' +
      '<div class="teleport-plane-track"><span class="teleport-plane">✈️</span></div>' +
      '<div class="teleport-spinner"></div>' +
      `<div>${message}</div>` +
      '</div>';
    document.body.appendChild(overlay);

    const [wx, wz] = mercToWorld(lonToMercX(lon), latToMercY(lat));

    // jump high above the destination; the streaming manager follows
    // controls.target, so chunks start loading there on the next update
    camera.position.set(wx, 140, wz + 80);
    camera.lookAt(wx, 10, wz);
    if (fly.enabled) fly.velocity.set(0, 0, 0);
    controls.target.set(wx, 10, wz);

    const [tx, ty] = worldToChunk(wx, wz);
    const startedAt = Date.now();

    const poll = setInterval(() => {
      let dest = null;
      for (const c of manager.chunks.values()) {
        if (c.tx === tx && c.ty === ty) dest = c;
      }
      const ready = dest && dest.state === 'ready' && dest.group.visible;
      if (ready || Date.now() - startedAt > 30000) {
        clearInterval(poll);
        // settle to a comfortable height above the actual terrain
        const gy = manager.groundWorldY(wx, wz);
        if (gy !== null) {
          camera.position.set(wx, gy + 60, wz + 40);
          camera.lookAt(wx, gy + 5, wz);
        }
        // a beat to enjoy the arrival, then fade the overlay out
        setTimeout(() => {
          overlay.classList.add('fade-out');
          setTimeout(() => overlay.remove(), 450);
        }, 400);
        resolve();
      }
    }, 250);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
