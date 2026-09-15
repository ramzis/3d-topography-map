const GA_MEASUREMENT_ID = 'G-4TW82S9NV1';
const CONSENT_COOKIE = 'analytics_consent';
const CONSENT_MAX_AGE = 30 * 24 * 60 * 60; // 1 month, seconds

export function getConsent() {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + CONSENT_COOKIE + '=([^;]*)'));
  return m ? m[1] : null; // 'granted' | 'denied' | null
}

export function setConsent(granted) {
  document.cookie =
    `${CONSENT_COOKIE}=${granted ? 'granted' : 'denied'}` +
    `;max-age=${CONSENT_MAX_AGE};path=/;samesite=lax`;
}

function loadGoogleAnalytics() {
  if (GA_MEASUREMENT_ID === 'G-XXXXXXXXXX' || !/^G-[A-Z0-9]+$/.test(GA_MEASUREMENT_ID)) {
    console.info('Analytics: set GA_MEASUREMENT_ID in js/analytics.js to enable tracking.');
    return;
  }
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
}

export function initAnalytics() {
  const stored = getConsent();
  if (stored === 'granted') {
    loadGoogleAnalytics();
    return;
  }
  if (stored === 'denied') return;

  const banner = document.createElement('div');
  banner.className =
    'glass fixed bottom-[70px] left-1/2 -translate-x-1/2 z-40 ' +
    'flex flex-col gap-2.5 w-[min(92vw,420px)] p-3.5 rounded-3xl ' +
    'text-sm leading-relaxed';
  const btn =
    'rounded-full border border-white/25 px-3.5 py-2 text-sm cursor-pointer ' +
    'text-ink transition-all duration-100 ' +
    'hover:bg-white/15 hover:-translate-y-0.5 active:scale-90';
  banner.innerHTML =
    '<div class="flex items-center justify-center gap-2.5 text-center">' +
    '<span class="text-[22px]">🍪</span>' +
    '<span>This map uses Google Analytics to see how it\'s used. OK with you?</span>' +
    '</div>' +
    '<div class="grid grid-cols-2 gap-2">' +
    `<button id="cookieOk" class="${btn}">OK</button>` +
    `<button id="cookieNo" class="${btn}">Not OK</button>` +
    '</div>';
  document.body.appendChild(banner);

  const close = (granted) => {
    setConsent(granted);
    banner.remove();
    if (granted) loadGoogleAnalytics();
  };
  document.getElementById('cookieOk').addEventListener('click', () => close(true));
  document.getElementById('cookieNo').addEventListener('click', () => close(false));
}
