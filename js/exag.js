// Vertical exaggeration control, styled like a thermometer: a right-side
// column of tick marks with number indicators (1–6, top = most relief),
// a big mountain icon on top, a small one and the label at the bottom.

const MIN = 1, MAX = 6;

export function mountExaggeration({ value = 6, onChange } = {}) {
  let current = Math.max(MIN, Math.min(MAX, Math.round(value)));

  const el = document.createElement('div');
  el.id = 'exagCol';
  el.className =
    'glass fixed z-[19] select-none touch-none ' +
    'flex flex-col items-center rounded-2xl px-1.5 py-3 cursor-pointer';
  // explicit placement, no utility ambiguity: same 12px left inset as the
  // gems button, vertically centered in the viewport
  el.style.left = '12px';
  el.style.top = '50%';
  el.style.transform = 'translateY(-50%)';

  const mountain = (cls) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}"><path d="m8 3 4 8 5-5 5 15H2L8 3"/></svg>`;

  el.innerHTML =
    `<span class="text-ink">${mountain('w-6 h-6')}</span>` +
    '<div id="exagTrack" class="relative my-2 flex flex-col-reverse gap-2.5 py-1"></div>' +
    `<span class="text-muted">${mountain('w-3.5 h-3.5')}</span>` +
    '<span class="mt-1 text-[9px] uppercase tracking-wider text-muted">exag</span>';

  const track = el.querySelector('#exagTrack');
  const rows = [];
  // flex-col-reverse: index 0 renders at the bottom — so 1× is at the
  // bottom next to the small mountain, 6× at the top under the big one
  for (let v = MIN; v <= MAX; v++) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-end gap-1 pr-0.5';
    row.dataset.v = v;
    row.innerHTML =
      `<span class="exag-num w-3 text-right text-[10px] tabular-nums">${v}</span>` +
      '<span class="exag-tick block h-px w-3.5"></span>';
    track.appendChild(row);
    rows.push(row);
  }

  const paint = () => {
    for (const row of rows) {
      const active = Number(row.dataset.v) === current;
      row.querySelector('.exag-num').className =
        `exag-num w-3 text-right text-[10px] tabular-nums ${active ? 'font-bold text-ink' : 'text-muted'}`;
      row.querySelector('.exag-tick').className =
        `exag-tick block h-px w-3.5 ${active ? 'bg-ink' : 'bg-white/25'}`;
    }
  };

  const apply = (v) => {
    const next = Math.max(MIN, Math.min(MAX, Math.round(v)));
    if (next === current) return;
    current = next;
    paint();
    onChange?.(current);
  };

  // drag anywhere on the column to set; ticks are ~16px apart, generous targets
  const pick = (clientY) => {
    const r = track.getBoundingClientRect();
    const t = (r.bottom - clientY) / r.height; // 0 at bottom (1×) … 1 at top (6×)
    apply(MIN + t * (MAX - MIN));
  };

  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    pick(e.clientY);
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) pick(e.clientY);
  });
  const stop = () => { dragging = false; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  paint();
  document.body.appendChild(el);
  return {
    el,
    get: () => current,
    set: (v) => {
      current = Math.max(MIN, Math.min(MAX, Math.round(v)));
      paint();
    },
  };
}
