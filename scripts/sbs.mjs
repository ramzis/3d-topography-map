import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--window-size=1400,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

// v1: default view (its own camera defaults)
await page.goto('http://localhost:8080/', { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => setTimeout(r, 8000));
await page.screenshot({ path: '/tmp/sbs_v1.png' });

// v2: default view
await page.goto('http://localhost:8081/', { waitUntil: 'load', timeout: 30000 });
await new Promise((r) => setTimeout(r, 20000));
await page.screenshot({ path: '/tmp/sbs_v2.png' });
await browser.close();
console.log('done');
