// Landing page overlay: a first-visit showcase of ten places. Tapping a
// card teleports there and closes the overlay; after any dismissal the
// overlay stays hidden until tomorrow (local midnight).

const DISMISS_KEY = 'landing_dismissed_until';

const PLACES = [
  { slug: 'vilnius', name: 'Vilnius', tagline: 'Where it all begins', home: true,
    lat: 54.6858, lon: 25.2848, desc: 'Green hills and river bends of the baroque capital.' },
  { slug: 'grand-canyon', name: 'Grand Canyon', tagline: 'A mile-deep story in stone',
    lat: 36.0544, lon: -112.1401, desc: 'Layered rock carved by the Colorado river.' },
  { slug: 'everest', name: 'Mount Everest', tagline: 'The roof of the world',
    lat: 27.9881, lon: 86.9250, desc: 'The highest point on Earth, exaggerated in full relief.' },
  { slug: 'matterhorn', name: 'Matterhorn', tagline: 'The pyramid of the Alps',
    lat: 45.9763, lon: 7.6586, desc: 'Switzerland\u2019s iconic rock spire above Zermatt.' },
  { slug: 'santorini', name: 'Santorini', tagline: 'A drowned volcano',
    lat: 36.3932, lon: 25.4615, desc: 'White towns on the rim of a flooded caldera.' },
  { slug: 'venice', name: 'Venice', tagline: 'A city floating on water',
    lat: 45.4408, lon: 12.3155, desc: 'Canals, islands and lagoons of the Serenissima.' },
  { slug: 'dubai', name: 'Dubai', tagline: 'An island drawn in sand',
    lat: 25.1124, lon: 55.1390, desc: 'The Palm Jumeirah and the desert metropolis.' },
  { slug: 'ha-long-bay', name: 'Ha Long Bay', tagline: 'A thousand limestone towers',
    lat: 20.9101, lon: 107.1839, desc: 'Jungle-capped karst pillars rising from the sea.' },
  { slug: 'bryce-canyon', name: 'Bryce Canyon', tagline: 'An amphitheatre of spires',
    lat: 37.5930, lon: -112.1871, desc: 'Hoodoos glowing red in the Utah dawn.' },
  { slug: 'iceland', name: 'Iceland', tagline: 'Fire, ice and water',
    lat: 64.0784, lon: -16.2306, desc: 'Glacier lagoons on the edge of Europe\u2019s wilderness.' },
];

function dismissed() {
  try {
    return Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now();
  } catch {
    return false; // storage unavailable (private mode) — just show it
  }
}

function dismiss() {
  // don't show again until tomorrow, local midnight
  const until = new Date();
  until.setHours(24, 0, 0, 0);
  try { localStorage.setItem(DISMISS_KEY, String(until.getTime())); } catch { /* private mode */ }
}

/**
 * Shows the landing overlay unless it was dismissed today.
 * onTeleport(place) is called with { name, lat, lon } when a card is tapped.
 */
export function mountLanding({ onTeleport, onExplore } = {}) {
  const root = document.getElementById('landing');
  if (!root || dismissed()) {
    root?.remove();
    return;
  }

  const grid = document.getElementById('landingGrid');
  for (const p of PLACES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.title = `${p.name} — ${p.desc}`;
    card.className =
      'group flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-white/5 ' +
      'text-left cursor-pointer transition-all duration-100 ' +
      'hover:border-white/40 hover:-translate-y-0.5 active:scale-95';
    card.innerHTML =
      `<img src="images/places/${p.slug}.jpg" alt="${p.name}" loading="lazy" decoding="async"
             class="aspect-square w-full object-cover transition group-hover:scale-105" />` +
      '<div class="flex flex-col gap-0.5 px-3 py-2">' +
      `<span class="text-sm font-semibold text-ink">${p.name}${p.home ? ' <span class="text-[#ffd166]">★</span>' : ''}</span>` +
      `<span class="text-xs text-muted">${p.tagline}</span>` +
      '</div>';
    card.addEventListener('click', () => {
      close();
      onTeleport?.({ name: p.name, lat: p.lat, lon: p.lon });
    });
    grid.appendChild(card);
  }

  const close = () => {
    dismiss();
    root.remove();
  };

  document.getElementById('landingExplore').addEventListener('click', () => {
    close();
    onExplore?.();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('landing')) close();
  }, { once: true });

  root.classList.remove('hidden');
}
