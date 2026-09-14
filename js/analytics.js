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
  banner.id = 'cookieBanner';
  banner.innerHTML =
    '<div class="cookie-text">' +
    '<span class="cookie-icon">🍪</span>' +
    '<span>This map uses Google Analytics to see how it\'s used. OK with you?</span>' +
    '</div>' +
    '<div class="cookie-row">' +
    '<button id="cookieOk" class="cookie-btn">OK</button>' +
    '<button id="cookieNo" class="cookie-btn">Not OK</button>' +
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
