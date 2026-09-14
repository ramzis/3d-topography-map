const DEBOUNCE_MS = 800; // Nominatim usage policy: max ~1 request/second
const MIN_QUERY = 2;

export function mountSearch({ onSelect }) {
  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  let timer = null;
  let seq = 0;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    results.innerHTML = '';
    if (q.length < MIN_QUERY) return;
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      results.innerHTML = '';
      input.blur();
    }
  });

  async function run(q) {
    const mySeq = ++seq;
    results.innerHTML = '<div class="search-status">searching…</div>';
    try {
      const res = await fetch(
        'https://nominatim.openstreetmap.org/search' +
          `?q=${encodeURIComponent(q)}&format=jsonv2&limit=6`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      if (mySeq !== seq) return; // a newer query superseded this one
      results.innerHTML = '';
      if (!list.length) {
        results.innerHTML = '<div class="search-status">nothing found</div>';
        return;
      }
      for (const item of list) {
        const short = item.display_name.split(',')[0];
        const rest = item.display_name.split(',').slice(1, 3).join(',').trim();
        const el = document.createElement('button');
        el.className = 'search-result';
        el.innerHTML = `<strong>${escapeHtml(short)}</strong>` +
          (rest ? `<span class="search-sub">${escapeHtml(rest)}</span>` : '');
        el.addEventListener('click', () => {
          results.innerHTML = '';
          input.value = short;
          input.blur();
          onSelect({ lat: Number(item.lat), lon: Number(item.lon), name: short });
        });
        results.appendChild(el);
      }
    } catch {
      if (mySeq === seq) results.innerHTML = '<div class="search-status">search failed — try again</div>';
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
