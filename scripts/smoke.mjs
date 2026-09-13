import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto('http://localhost:8081/', { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => setTimeout(r, 15000));

const toggle = async (id) => {
  await page.evaluate((id) => {
    const cb = document.getElementById(id);
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  }, id);
  await new Promise((r) => setTimeout(r, 300));
};

// exercise every toggle
for (const id of ['satelliteMode', 'terrainVisible', 'wireframe', 'flatShading', 'flatten', 'gridVisible', 'boundariesVisible', 'labelsVisible']) {
  await toggle(id);
  await toggle(id); // back to original
}
await page.evaluate(() => document.getElementById('copyState').click());
await new Promise((r) => setTimeout(r, 500));
const state = await page.evaluate(() => window.__vilniusDebug.state());
const hud = await page.evaluate(() => document.getElementById('hud').textContent);
console.log('HUD:', hud);
console.log('state keys OK:', !!state.camera && state.chunks >= 0);
console.log('no page errors above = PASS');
await browser.close();
