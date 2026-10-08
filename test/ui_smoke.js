// Path tool on the real dot photo: first row, a curved turn placed by Shift-click, second row.
// Run: node test/ui_smoke.js  (needs a static server on :8765 and the photo at the path below)
const { chromium } = require('playwright'); const assert = require('assert');
const PHOTO = process.env.LM_DOT_PHOTO || '/mnt/user-data/uploads/IMG_6348.jpeg', SHOT = __dirname + '/shots/';
(async () => {
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:8765/index.html?fresh'); await page.screenshot({ path: SHOT + '01_empty.png' });
  if (!require('fs').existsSync(PHOTO)) { console.log('smoke: skipped, no photo at ' + PHOTO); await browser.close(); return; }
  await page.setInputFiles('#fileImages', PHOTO); await page.waitForFunction(() => LM.app.S.project.sheets.length === 1); await page.waitForTimeout(400);
  const box = await page.locator('#canvas').boundingBox();
  const click = async (x, y, shift) => { const p = await page.evaluate(([x, y]) => LM.app.api.toScreen(x, y), [x, y]); if (shift) await page.keyboard.down('Shift'); await page.mouse.click(box.x + p[0], box.y + p[1]); if (shift) await page.keyboard.up('Shift'); await page.waitForTimeout(50); };
  await click(1526.9, 1533.1); await click(1445.6, 1530);                 // spacing
  await click(1526.9, 1533.1); await click(1042.5, 1523.8);                // row 1: pixels 0 to 6
  for (const p of [[968.8, 1500], [905, 1456.3], [842.5, 1410], [805, 1343.8], [818.8, 1289.4]]) await click(p[0], p[1], true);   // curved turn, one LED at a time
  await click(883.1, 1276.9);                                              // first LED of row 2
  await click(1839.1, 1265.7);                                             // last LED of row 2
  await page.keyboard.press('Enter');
  const leds = await page.evaluate(() => LM.app.S.project.strips[0].leds.map(l => l.dead ? 'x' : (l.brk ? '|o' : 'o')).join(''));
  console.log(leds); assert.strictEqual(leds, 'ooooooo' + 'xxxxx' + '|o' + 'o'.repeat(12));
  assert.deepStrictEqual(await page.evaluate(() => LM.app.S.project.groups.map(g => g.leds.length)), [7, 13]);
  await page.screenshot({ path: SHOT + '05_done.png' });
  await page.click('#btnExport'); await page.waitForTimeout(300); await page.screenshot({ path: SHOT + '06_export.png' });
  const map = await page.evaluate(() => JSON.parse(LM.app.api.getExport().files[0].text).map);
  assert.deepStrictEqual(map, [0, 1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, -1, -1, -1, -1, -1]);
  assert.strictEqual(errors.length, 0, errors.join('; ')); console.log('smoke: all checks passed'); await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
