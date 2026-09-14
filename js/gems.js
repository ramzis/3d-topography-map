const SUPABASE_URL = 'https://obhxpqdqoszeurgujvex.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_4zhtDgF8IoMpnM_t8o0WrQ_p0XKNFdG';
const CODE_KEY = 'lg_code';

const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/test_aFa3cxdoK1JbaVPae91kA00';

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
  let gems = null; // cached list once fetched

  btn.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    if (open) refresh();
  });

  document.getElementById('gemBuyBtn').addEventListener('click', () => {
    if (STRIPE_PAYMENT_LINK) {
      window.open(STRIPE_PAYMENT_LINK, '_blank', 'noopener');
    } else {
      setStatus('purchases are not set up yet — a Stripe payment link is needed in js/gems.js', true);
    }
  });

  // apply a code: from the emailed link, the paste box, or Enter
  async function applyCode(raw) {
    const code = raw.trim().toLowerCase();
    if (!code) return;
    setStatus('checking code…');
    activateBtn.disabled = true;
    try {
      gems = await rpc('get_location_gems', { p_code: code });
      localStorage.setItem(CODE_KEY, code);
      codeInput.value = '';
      setStatus('');
      render();
    } catch (err) {
      gems = null;
      render();
      setStatus('invalid activation code', true);
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

  async function refresh() {
    const code = localStorage.getItem(CODE_KEY);
    if (!code) return; // locked view is static
    if (gems) return render(); // cached
    list.innerHTML = '';
    setStatus('loading gems…');
    try {
      gems = await rpc('get_location_gems', { p_code: code });
      setStatus('');
      render();
    } catch (err) {
      gems = null;
      render();
      setStatus('invalid activation code', true);
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
      el.innerHTML = `<strong>${escapeHtml(g.name)}</strong>` +
        `<span class="gem-sub">${g.lat.toFixed(4)}, ${g.lon.toFixed(4)}</span>`;
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
