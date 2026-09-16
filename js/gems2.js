const SUPABASE_URL = 'https://obhxpqdqoszeurgujvex.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4zhtDgF8IoMpnM_t8o0WrQ_p0XKNFdG';
const CODE_KEY = 'lg_code';

let purchasedCache = null;
export async function hasPurchasedGems() {
  if (document.getElementById('gemsPanel')?.classList.contains('unlocked')) return true;
  const code = localStorage.getItem(CODE_KEY);
  if (!code) return false;
  if (purchasedCache !== null) return purchasedCache;
  try {
    await rpc('get_location_gems', { p_code: code });
    purchasedCache = true;
  } catch {
    purchasedCache = false;
  }
  return purchasedCache;
}

export const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/9B6eV63wJ9m22yc7OE3sI00';

async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).message || msg;
    } catch { /* keep HTTP status */ }
    throw new Error(msg);
  }
  return res.json();
}

export function mountGems({ onSelect }) {
  const btn = document.getElementById('gemsBtn');
  const panel = document.getElementById('gemsPanel');
  const list = document.getElementById('gemsList');
  const codeInput = document.getElementById('gemCodeInput');
  const activateBtn = document.getElementById('gemActivateBtn');
  const statusEl = document.getElementById('gemsStatus');
  const codeStatusEl = document.getElementById('gemCodeStatus');
  let gems = null; // cached list once fetched

  btn.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    if (open) refresh();
  });

  // free samples shown in the locked view
  const SAMPLE_GEMS = [
    { name: 'Paris', lat: 48.8566, lon: 2.3522 },
    { name: 'Grand Canyon', lat: 36.1069, lon: -112.1129 },
    { name: 'Santorini Caldera', lat: 36.4026, lon: 25.396 },
  ];
  const samplesEl = document.getElementById('gemSamples');
  for (const g of SAMPLE_GEMS) {
    const el = document.createElement('button');
    el.className = 'gem-item';
    el.innerHTML = `<strong>${escapeHtml(g.name)}</strong>`;
    el.addEventListener('click', () => {
      panel.classList.remove('open');
      onSelect(g);
    });
    samplesEl.appendChild(el);
  }

  document.getElementById('gemBuyBtn').addEventListener('click', () => {
    if (STRIPE_PAYMENT_LINK) {
      window.open(STRIPE_PAYMENT_LINK, '_blank', 'noopener');
    } else {
      setStatus('Purchases are not set up yet — a Stripe payment link is needed in js/gems2.js', true);
    }
  });

  // extract a uuid from anywhere in a string (bare code or a full activation url)
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const extractUUID = (s) => (s.match(UUID_RE)?.[0] ?? '').toLowerCase();

  // paste button: pull the code straight from the clipboard
  document.getElementById('gemPasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const code = extractUUID(text);
      if (code) {
        codeInput.value = code;
        applyCode(code);
      } else {
        setCodeStatus('No activation code found in the clipboard', true);
      }
    } catch {
      setCodeStatus('Clipboard access denied — paste into the box instead', true);
    }
  });

  // auto-submit: a valid uuid in the box activates by itself, no button press
  let autoTimer = null;
  codeInput.addEventListener('input', () => {
    clearTimeout(autoTimer);
    const code = extractUUID(codeInput.value);
    if (code) {
      autoTimer = setTimeout(() => {
        codeInput.value = code;
        applyCode(code);
      }, 250);
    }
  });

  // apply a code: from the emailed link, the paste box, or Enter
  async function applyCode(raw) {
    const code = raw.trim().toLowerCase();
    if (!code) return;
    setCodeStatus('Checking code…');
    activateBtn.disabled = true;
    try {
      gems = await rpc('get_location_gems', { p_code: code });
      localStorage.setItem(CODE_KEY, code);
      codeInput.value = '';
      setCodeStatus('');
      render();
    } catch (err) {
      gems = null;
      render();
      setCodeStatus('Invalid activation code', true);
    } finally {
      activateBtn.disabled = false;
    }
  }

  activateBtn.addEventListener('click', () => applyCode(codeInput.value));
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCode(codeInput.value);
  });

  // emailed activation link: https://ramzis.github.io/3d-topography-map/#activate=<uuid>
  const hashCode = /^#activate=([0-9a-f-]{36})$/i.exec(location.hash)?.[1];
  if (hashCode) {
    history.replaceState(null, '', location.pathname);
    panel.classList.add('open');
    applyCode(hashCode);
  }

  function setStatus(msg, error = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', error);
  }

  function setCodeStatus(msg, error = false) {
    codeStatusEl.textContent = msg || '';
    codeStatusEl.classList.toggle('error', error);
  }

  async function refresh() {
    const code = localStorage.getItem(CODE_KEY);
    if (!code) return; // locked view is static
    if (gems) return render(); // cached
    list.innerHTML = '';
    setStatus('Loading gems…');
    try {
      gems = await rpc('get_location_gems', { p_code: code });
      setStatus('');
      render();
    } catch (err) {
      gems = null;
      render();
      setStatus('Invalid activation code', true);
    }
  }

  function render() {
    const has = !!localStorage.getItem(CODE_KEY) && gems;
    panel.classList.toggle('unlocked', has);
    if (!has) return;
    list.innerHTML = '';
    for (const g of gems ?? []) {
      const el = document.createElement('button');
      el.className = 'gem-item';
      el.innerHTML = `<strong>${escapeHtml(g.name)}</strong>`;
      el.addEventListener('click', () => {
        panel.classList.remove('open');
        onSelect({ lat: g.lat, lon: g.lon, name: g.name });
      });
      list.appendChild(el);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
