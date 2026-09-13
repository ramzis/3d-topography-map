import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto('http://localhost:8081/', { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => setTimeout(r, 30000));

const res = await page.evaluate(() => {
  const d = window.__vilniusDebug;
  const slider = document.getElementById('exaggeration');
  const sample = [...d.places.places.values()].slice(0, 8).map((p) => ({ name: p.name, kind: p.kind }));
  return {
    counts: d.counts(),
    sliderDefault: slider.value,
    sliderLabel: document.getElementById('exagVal').textContent,
    flyDefault: d.fly.enabled,
    placeSample: sample,
  };
});
console.log(JSON.stringify(res, null, 2));
await browser.close();
