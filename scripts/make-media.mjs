#!/usr/bin/env node
// Promotional media generator — saved in the repo for reuse.
//
//   node scripts/make-media.mjs          # banners + squares → media/
//
// Drives the app headlessly (dev server must be running on :8080):
// - banners (1920×1080): Rio, Cape Town, Santorini, Everest at 7 km altitude,
//   exaggeration 1, near-top-down slightly angled — 💎 (white outline) +
//   "3D Location Guesser" in Luckiest Guy, yellow with dark stroke
// - squares (1080×1080): the same views, 💎 with white outline only
//
// Cookie consent is pre-set and all app UI is hidden — clean terrain only.

import('puppeteer-core').then(async ({ default: p }) => {
  const b = await p.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--use-angle=swiftshader'],
  });

  const VIEWS = [
    { name: 'rio', lat: -22.95, lon: -43.2, alt: 70, yaw: 0.7, pitch: -1.15 },
    { name: 'cape-town', lat: -33.96, lon: 18.65, alt: 70, yaw: -0.6, pitch: -1.15 },
    { name: 'santorini', lat: 36.4026, lon: 25.396, alt: 70, yaw: -0.8, pitch: -1.2 },
    { name: 'everest', lat: 27.9881, lon: 86.925, alt: 70, yaw: -0.5, pitch: -1.15 },
  ];

  const gemOutline = [
    '10px 0 0 #fff', '-10px 0 0 #fff', '0 10px 0 #fff', '0 -10px 0 #fff',
    '8px 8px 0 #fff', '-8px -8px 0 #fff', '8px -8px 0 #fff', '-8px 8px 0 #fff',
  ].join(', ');

  async function shoot(loc, square) {
    const page = await b.newPage();
    await page.setCookie({ name: 'analytics_consent', value: 'granted', url: 'http://localhost:8080' });
    await page.setViewport(
      square ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 }
    );
    const q = `?lat=${loc.lat}&lon=${loc.lon}&alt=${loc.alt}&yaw=${loc.yaw}&pitch=${loc.pitch}&exag=1`;
    await page.goto('http://localhost:8080/' + q, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => {
      document.querySelectorAll('[id*="landing"]').forEach((el) => el.remove());
      const hide = ['#navBar', '#locBar', '#gemsBtn', '#playGuesserBtn', '#keyHelp',
        '#attrib', '#exagCol', '#altBox', '#ctrlModeBtn', '#compassBtn', '#netBanner',
        '.joystick', '[id*="cookie"]', '[class*="cookie"]'];
      const style = document.createElement('style');
      style.textContent = hide.join(',') + '{display:none !important}';
      document.head.appendChild(style);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Luckiest+Guy&display=swap';
      document.head.appendChild(link);
    });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 25000)); // let tiles stream in
    await page.evaluate((square, gemOutline) => {
      const div = document.createElement('div');
      div.style.cssText =
        'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;gap:20px;pointer-events:none;z-index:9999';
      const gem = document.createElement('div');
      gem.textContent = '💎';
      gem.style.cssText =
        'font-size:' + (square ? 340 : 230) + 'px;line-height:1.05;text-shadow:' + gemOutline;
      div.appendChild(gem);
      if (!square) {
        const title = document.createElement('div');
        title.innerHTML = '3D Location<br>Guesser';
        title.style.cssText =
          "font-family:'Luckiest Guy',system-ui,cursive;font-size:250px;line-height:0.92;" +
          'color:#FFD53E;-webkit-text-stroke:6px #141a26;paint-order:stroke fill;' +
          'text-shadow:0 12px 0 rgba(10,15,25,.55),0 0 50px rgba(0,0,0,.5);' +
          'letter-spacing:4px;text-align:center';
        div.appendChild(title);
      }
      document.body.appendChild(div);
    }, square, gemOutline);
    await new Promise((r) => setTimeout(r, 800));
    const file = `media/${square ? 'square' : 'banner'}-${loc.name}.png`;
    await page.screenshot({ path: file });
    await page.close();
    console.log('saved', file);
  }

  for (const loc of VIEWS) await shoot(loc, false); // banners
  for (const loc of VIEWS) await shoot(loc, true);  // squares
  await b.close();
  console.log('done — see media/');
});
