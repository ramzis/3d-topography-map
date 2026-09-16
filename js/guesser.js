import { rollRandomLandPlace } from './dice.js';
import { STRIPE_PAYMENT_LINK, hasPurchasedGems } from './gems.js';

const ROUNDS = 10;
const QUAD_RETRIES = 8;
const SCORE_MAX = 5000;
const SCORE_DECAY_KM = 1500;
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
const TILE_PX = 256;
const MEDIA = [
  'media/banner-rio.jpg',
  'media/banner-cape-town.jpg',
  'media/banner-santorini.jpg',
  'media/banner-everest.jpg',
  'media/square-rio.jpg',
  'media/square-cape-town.jpg',
  'media/square-santorini.jpg',
  'media/square-everest.jpg',
];

const D2R = Math.PI / 180;
const R_EARTH = 6371;

export function mountGuesser({ onTeleport }) {
  const playBtn = document.getElementById('playGuesserBtn');
  const playLabel = playBtn.querySelector('.btn-label');
  const panel = document.getElementById('gemsPanel');
  const locBar = document.getElementById('locBar');
  const pill = document.getElementById('locationStatus');
  const shareBtn = document.getElementById('shareBtn');

  let game = null;
  let bar = null;

  function setPlayLabel(short, full) {
    playLabel.textContent = short;
    playBtn.title = full;
    playBtn.setAttribute('aria-label', full.toLowerCase());
  }

  let checking = false;
  async function requestStart() {
    if (game) { confirmQuit(); return; }
    if (checking) return;
    checking = true;
    try {
      if (!(await hasPurchasedGems())) { showLockedPrompt(); return; }
      startGame();
    } finally {
      checking = false;
    }
  }

  playBtn.addEventListener('click', requestStart);

  function quadrantOf(lat, lon) {
    const band = Math.min(3, Math.max(0, Math.floor((lat + 90) / 45)));
    const shift = (band % 2) * 22.5 + game.gridOffset;
    const col = Math.floor((((lon + shift + 180) % 360) + 360) % 360 / 45) % 8;
    return band * 8 + col;
  }

  async function startGame() {
    game = { round: 0, total: 0, target: null, visited: new Set(), gridOffset: Math.random() * 45 };
    enterGameUI();
    await nextRound();
  }

  async function nextRound() {
    game.round++;
    game.pin = null;
    markBarSelected();
    setCounter('Traveling…');
    const veil = showVeil('Traveling to next location');
    let target;
    try {
      for (let i = 0; i < QUAD_RETRIES; i++) {
        target = await rollRandomLandPlace();
        const q = quadrantOf(target.lat, target.lon);
        if (!game.visited.has(q)) break;
      }
      game.visited.add(quadrantOf(target.lat, target.lon));
    } finally {
      veil.remove();
    }
    game.target = target;
    await onTeleport(
      { lat: target.lat, lon: target.lon, name: 'next location' },
      'Traveling to next location'
    );
    setCounter();
  }

  function endGame() {
    if (!game) return;
    game = null;
    exitGameUI();
  }

  function enterGameUI() {
    panel.classList.remove('open');
    history.replaceState(null, '', location.pathname);
    pill.classList.add('hidden');
    shareBtn.classList.add('hidden');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'guesserBar';
      bar.innerHTML =
        '<span id="guesserCount">Round 1/' + ROUNDS + '</span>' +
        '<button id="guesserGuessBtn" class="guesser-pill" aria-label="guess location" title="Open the map and guess">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>' +
        '<span>Guess location</span>' +
        '</button>';
      locBar.insertBefore(bar, shareBtn);
      bar.querySelector('#guesserGuessBtn').addEventListener('click', openGuessModal);
    }
    bar.classList.remove('hidden');
    setPlayLabel('Quit', 'Quit game');

    document.getElementById('diceBtn').classList.add('hidden');
    document.getElementById('searchBar')?.classList.add('hidden');
  }

  function exitGameUI() {
    if (bar) bar.classList.add('hidden');
    pill.classList.remove('hidden');
    shareBtn.classList.remove('hidden');
    setPlayLabel('Play', 'Play Location Guesser');
    document.getElementById('diceBtn').classList.remove('hidden');
    document.getElementById('searchBar')?.classList.remove('hidden');
  }

  function setCounter(prefix) {
    const el = document.getElementById('guesserCount');
    if (el) el.textContent = (prefix ? prefix + ' · ' : '') + 'Round ' + game.round + '/' + ROUNDS;
  }

  function baseModal(closable = true) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const card = document.createElement('div');
    card.className = 'modal-card';
    overlay.appendChild(card);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      overlay.remove();
      removeEventListener('keydown', onKey);
    };
    if (closable) {
      addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      const x = document.createElement('button');
      x.className = 'modal-x';
      x.setAttribute('aria-label', 'close');
      x.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      x.addEventListener('click', close);
      card.appendChild(x);
    }
    document.body.appendChild(overlay);
    return { overlay, card, close };
  }

  function showLockedPrompt() {
    const { card, close } = baseModal();
    const img = document.createElement('img');
    img.className = 'modal-media';
    img.alt = 'Location Guesser';
    img.src = MEDIA[Math.floor(Math.random() * MEDIA.length)];
    card.appendChild(img);
    card.insertAdjacentHTML('beforeend',
      '<div class="modal-title">💎 Location Guesser</div>' +
      '<p class="modal-text">Location Guesser comes with <strong>Location Gems</strong> — ' +
      'unlock 100 hand-picked wonders of the world and the guessing game in one purchase.</p>');
    const row = document.createElement('div');
    row.className = 'modal-row';
    const later = document.createElement('button');
    later.className = 'modal-btn modal-btn-danger';
    later.textContent = 'Explore the map';
    later.addEventListener('click', close);
    const buy = document.createElement('button');
    buy.className = 'modal-btn modal-btn-rainbow';
    buy.textContent = '💎 Buy Location Gems · €1';
    buy.addEventListener('click', () => {
      if (STRIPE_PAYMENT_LINK) window.open(STRIPE_PAYMENT_LINK, '_blank', 'noopener');
    });
    row.append(later, buy);
    card.appendChild(row);
  }

  function confirmQuit() {
    const { card, close } = baseModal();
    card.insertAdjacentHTML('beforeend',
      '<div class="modal-title">Quit game?</div>' +
      '<p class="modal-text">Your current run and score will be lost.</p>');
    const row = document.createElement('div');
    row.className = 'modal-row';
    const stay = document.createElement('button');
    stay.className = 'modal-btn';
    stay.textContent = 'Keep playing';
    stay.addEventListener('click', close);
    const quit = document.createElement('button');
    quit.className = 'modal-btn primary';
    quit.textContent = 'Quit game';
    quit.addEventListener('click', () => { close(); endGame(); });
    row.append(stay, quit);
    card.appendChild(row);
  }

  function showVeil(text) {
    const veil = document.createElement('div');
    veil.className = 'teleport-overlay';
    veil.innerHTML = '<div class="teleport-card"><div class="teleport-spinner"></div><div>' + text + '</div></div>';
    document.body.appendChild(veil);
    return veil;
  }

  function openGuessModal() {
    const { overlay, card, close } = baseModal(true);
    card.classList.add('tall');

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Where are we?';
    card.appendChild(title);

    const mapEl = document.createElement('div');
    mapEl.className = 'slippy-map';
    card.appendChild(mapEl);

    const zoom = document.createElement('div');
    zoom.className = 'slippy-zoom';
    mapEl.appendChild(zoom);

    const footer = document.createElement('div');
    footer.className = 'modal-row';
    card.appendChild(footer);

    const hint = document.createElement('span');
    hint.className = 'modal-text grow';
    const guess = document.createElement('button');
    guess.className = 'modal-btn primary';
    guess.textContent = 'Guess';
    footer.append(hint, guess);

    const map = new SlippyMap(mapEl, zoom);
    let submitted = false;

    const setPinned = () => {
      hint.textContent = '📍 Pin placed — Guess when ready';
      guess.disabled = false;
      markBarSelected();
    };
    if (game.pin) {
      map.setPin(game.pin);
      map.z = 4;
      map.center = game.pin;
      setPinned();
    } else {
      hint.textContent = 'Tap the map to place your pin';
      guess.disabled = true;
    }
    map.onPick = () => {
      game.pin = map.getPinLL();
      setPinned();
    };

    guess.addEventListener('click', () => {
      const pin = map.getPinLL();
      if (!pin) return;
      game.pin = pin;
      const km = distKm(pin, game.target);
      const pts = scoreFor(km);
      game.total += pts;
      showGuessResult(close, map, footer, km, pts);
      submitted = true;
      const obs = new MutationObserver(() => {
        if (!document.body.contains(overlay)) {
          obs.disconnect();
          if (submitted && game) {
            submitted = false;
            if (game.round >= ROUNDS) showEndModal();
            else nextRound();
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  function markBarSelected() {
    document.getElementById('guesserGuessBtn')?.classList.toggle('selected', !!game?.pin);
  }

  function showGuessResult(close, map, footer, km, pts) {
    map.lock();
    map.addMarker(game.target.lat, game.target.lon, '🎯');
    map.fit(game.target, map.getPinLL());
    footer.innerHTML = '';
    footer.insertAdjacentHTML('beforeend',
      '<span class="modal-text grow">' +
      '<strong>' + Math.round(km).toLocaleString('en') + ' km away</strong> · +' + pts.toLocaleString('en') + ' pts' +
      '<br><span class="text-muted">It was ' + escapeHtml(game.target.name) + '</span></span>');
    const next = document.createElement('button');
    next.className = 'modal-btn primary';
    next.textContent = game.round >= ROUNDS ? 'See results' : 'Next location';
    next.addEventListener('click', close);
    footer.appendChild(next);
  }

  function showEndModal() {
    const { overlay, card } = baseModal();
    card.insertAdjacentHTML('beforeend',
      '<div class="modal-title">🏁 Game over</div>' +
      '<p class="modal-text big">I scored <strong>' + game.total.toLocaleString('en') +
      '</strong> on World Explorer - 3D Location Guessing Game</p>');
    const row = document.createElement('div');
    row.className = 'modal-row';
    const again = document.createElement('button');
    again.className = 'modal-btn';
    again.textContent = 'Play again';
    again.addEventListener('click', () => {
      obs.disconnect();
      overlay.remove();
      startGame();
    });
    const share = document.createElement('button');
    share.className = 'modal-btn primary';
    share.textContent = 'Share score';
    share.addEventListener('click', async () => {
      const text = 'I scored ' + game.total + ' on World Explorer - 3D Location Guessing Game — https://explorer.tadget.net/';
      try {
        await navigator.clipboard.writeText(text);
        share.textContent = '✓ Copied';
      } catch {
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        el.remove();
        share.textContent = '✓ Copied';
      }
      setTimeout(() => { share.textContent = 'Share score'; }, 2000);
    });
    row.append(again, share);
    card.appendChild(row);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(overlay)) { obs.disconnect(); endGame(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  return { startGame, endGame, requestStart, isPlaying: () => !!game };
}

function scoreFor(km) {
  return Math.round(SCORE_MAX * Math.exp(-km / SCORE_DECAY_KM));
}

function distKm(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

class SlippyMap {
  constructor(el, zoomEl) {
    this.el = el;
    this.z = 2;
    this.center = { lat: 20, lon: 0 };
    this.pin = null;
    this.markers = [];
    this.tiles = new Map();
    this.locked = false;
    this.onPick = null;

    for (const [label, dz] of [['+', 1], ['−', -1]]) {
      const b = document.createElement('button');
      b.className = 'icon-box';
      b.textContent = label;
      b.addEventListener('click', () => this.zoomBy(dz));
      zoomEl.appendChild(b);
    }
    zoomEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    zoomEl.addEventListener('pointerup', (e) => e.stopPropagation());
    zoomEl.addEventListener('pointercancel', (e) => e.stopPropagation());
    this._wheelAcc = 0;
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._wheelAcc += e.deltaY;
      if (Math.abs(this._wheelAcc) < 150) return;
      const dz = this._wheelAcc > 0 ? -1 : 1;
      this._wheelAcc = 0;
      const r = this.el.getBoundingClientRect();
      this.zoomAt(this.eventLL(e), e.clientX - r.left, e.clientY - r.top, dz);
    }, { passive: false });

    this._ptrs = new Map();
    this._drag = null;
    this._pinch = null;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    const up = (e) => this._up(e);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(el);
    this.render();
  }

  lock() { this.locked = true; }

  eventLL(e) {
    const r = this.el.getBoundingClientRect();
    return this.pxToLL(
      this.llToPx(this.center).x + (e.clientX - r.left - r.width / 2),
      this.llToPx(this.center).y + (e.clientY - r.top - r.height / 2),
      this.z
    );
  }

  zoomAt(ll, sx, sy, dz) {
    const nz = Math.max(0, Math.min(6, this.z + dz));
    if (nz === this.z) return;
    this.z = nz;
    const p = this.llToPx(ll, nz);
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
    this.center = this.pxToLL(p.x - (sx - w / 2), p.y - (sy - h / 2), nz);
    this.render();
  }

  getPinLL() { return this.pin; }

  addMarker(lat, lon, emoji) {
    const el = document.createElement('div');
    el.className = 'slippy-marker';
    el.textContent = emoji;
    this.el.appendChild(el);
    this.markers.push({ lat, lon, el });
    this.render();
  }

  fit(a, b) {
    for (let z = 6; z >= 0; z--) {
      const pa = this.llToPx(a, z), pb = this.llToPx(b, z);
      const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
      if (Math.abs(pa.x - pb.x) < w * 0.7 && Math.abs(pa.y - pb.y) < h * 0.7) {
        this.z = z;
        this.center = this.pxToLL((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, z);
        this.render();
        return;
      }
    }
    const pa = this.llToPx(a, 0), pb = this.llToPx(b, 0);
    this.z = 0;
    this.center = this.pxToLL((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 0);
    this.render();
  }

  zoomBy(dz) {
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
    this.zoomAt(this.center, w / 2, h / 2, dz);
  }

  _down(e) {
    this.el.setPointerCapture(e.pointerId);
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._pinch = { dist: Math.hypot(b.x - a.x, b.y - a.y) };
      this._drag = null;
    } else if (this._ptrs.size === 1) {
      this._drag = { moved: 0 };
    }
  }

  _move(e) {
    const p = this._ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this._ptrs.size === 2 && this._pinch) {
      const [a, b] = [...this._ptrs.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const ratio = dist / (this._pinch.dist || 1);
      if (ratio > 1.3 || ratio < 0.75) {
        const dz = ratio > 1.3 ? 1 : -1;
        this._pinch.dist = dist;
        const r = this.el.getBoundingClientRect();
        this.zoomAt(
          this.eventLL({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }),
          (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, dz
        );
      }
      return;
    }
    if (this._drag) {
      this._drag.moved += Math.hypot(dx, dy);
      this.panBy(dx, dy);
    }
  }

  _up(e) {
    const p = this._ptrs.get(e.pointerId);
    this._ptrs.delete(e.pointerId);
    if (this._ptrs.size < 2) this._pinch = null;
    if (this._ptrs.size === 0 && this._drag && p) {
      if (this._drag.moved < 6 && !this.locked) {
        const r = this.el.getBoundingClientRect();
        const ll = this.pxToLL(
          this.llToPx(this.center).x + (p.x - r.left - r.width / 2),
          this.llToPx(this.center).y + (p.y - r.top - r.height / 2),
          this.z
        );
        this.setPin(ll);
      }
      this._drag = null;
    }
  }

  setPin(ll) {
    this.pin = ll;
    if (!this._pinEl) {
      this._pinEl = document.createElement('div');
      this._pinEl.className = 'slippy-marker';
      this._pinEl.textContent = '📍';
      this.el.appendChild(this._pinEl);
    }
    this.render();
    this.onPick?.();
  }

  panBy(dx, dy) {
    const c = this.llToPx(this.center, this.z);
    const ll = this.pxToLL(c.x - dx, c.y - dy, this.z);
    this.center = ll;
    this.render();
  }

  _clamp() {
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
    const n = TILE_PX * 2 ** this.z;
    const c = this.llToPx(this.center, this.z);
    const cx = w >= n ? n / 2 : Math.min(Math.max(c.x, w / 2), n - w / 2);
    const cy = h >= n ? n / 2 : Math.min(Math.max(c.y, h / 2), n - h / 2);
    if (cx !== c.x || cy !== c.y) this.center = this.pxToLL(cx, cy, this.z);
  }

  render() {
    this._clamp();
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
    const c = this.llToPx(this.center, this.z);
    const n = 2 ** this.z;
    const x0 = Math.floor((c.x - w / 2) / TILE_PX), x1 = Math.floor((c.x + w / 2) / TILE_PX);
    const y0 = Math.floor((c.y - h / 2) / TILE_PX), y1 = Math.floor((c.y + h / 2) / TILE_PX);
    const seen = new Set();
    for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(n - 1, x1); tx++) {
        const key = this.z + '/' + tx + '/' + ty;
        seen.add(key);
        let img = this.tiles.get(key);
        if (!img) {
          img = new Image();
          img.draggable = false;
          img.src = TILE_URL + '/' + this.z + '/' + ty + '/' + tx;
          this.el.appendChild(img);
          this.tiles.set(key, img);
        }
        img.style.left = Math.round(tx * TILE_PX - c.x + w / 2) + 'px';
        img.style.top = Math.round(ty * TILE_PX - c.y + h / 2) + 'px';
      }
    }
    for (const [key, img] of this.tiles) {
      if (!seen.has(key)) { img.remove(); this.tiles.delete(key); }
    }
    const place = (el, ll) => {
      const p = this.llToPx(ll, this.z);
      el.style.left = Math.round(p.x - c.x + w / 2) + 'px';
      el.style.top = Math.round(p.y - c.y + h / 2) + 'px';
    };
    if (this._pinEl && this.pin) place(this._pinEl, this.pin);
    for (const m of this.markers) place(m.el, m);
  }

  llToPx(ll, z = this.z) {
    const n = TILE_PX * 2 ** z;
    const s = Math.sin(Math.max(-85, Math.min(85, ll.lat)) * D2R);
    return {
      x: ((ll.lon + 180) / 360) * n,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
    };
  }

  pxToLL(x, y, z = this.z) {
    const n = TILE_PX * 2 ** z;
    let lon = (x / n) * 360 - 180;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / D2R;
    return { lat, lon };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
