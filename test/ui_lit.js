// Lit photo workflow, finishing strips, and pin-and-reflow editing.
// Run: node test/ui_lit.js  (needs a static server on :8765)
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs');
const SHOT = __dirname + '/shots/', truth = JSON.parse(fs.readFileSync(__dirname + '/fixtures/lit_rgb.json', 'utf8'));
(async () => {
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('dialog', d => d.accept());
  const box = async () => page.locator('#canvas').boundingBox();
  const at = async (x, y) => { const b = await box(), p = await page.evaluate(([x, y]) => LM.app.api.toScreen(x, y), [x, y]); return [b.x + p[0], b.y + p[1]]; };
  const click = async (x, y) => { const p = await at(x, y); await page.mouse.click(p[0], p[1]); await page.waitForTimeout(40); };
  const strips = () => page.evaluate(() => LM.app.S.project.strips.map(s => ({ name: s.name, done: !!s.done, n: s.leds.length, leds: s.leds.map(l => [l.x, l.y, l.dead ? 1 : 0, l.f ? 1 : 0, l.check ? 1 : 0]) })));

  /* 1. lit LEDs in a red, green, blue cycle */
  await page.goto('http://localhost:8765/index.html?fresh');
  await page.setInputFiles('#fileImages', __dirname + '/fixtures/lit_rgb.jpg'); await page.waitForFunction(() => LM.app.S.project.sheets.length === 1); await page.waitForTimeout(300);
  await page.click('text=Find lit LEDs'); await page.waitForTimeout(300);
  let st = await strips(); console.log('lit:', st.map(s => `${s.name} ${s.n}${s.done ? ' finished' : ''}`).join(', '), '| toast:', await page.locator('#toast').innerText());
  assert.strictEqual(st.length, 1, 'one strip'); assert.strictEqual(st[0].n, truth.leds.length, `all ${truth.leds.length} LEDs found`);
  let worst = 0; st[0].leds.forEach((l, i) => { worst = Math.max(worst, Math.hypot(l[0] - truth.leds[i][0], l[1] - truth.leds[i][1])); });
  console.log('worst position error in wire order:', worst.toFixed(2), 'px'); assert.ok(worst < 4, 'every LED is at its true place in wire order');
  assert.strictEqual(st[0].leds.filter(l => l[2]).length, (truth.rows - 1) * 2, 'the two LEDs in each turn are dead');
  assert.deepStrictEqual(await page.evaluate(() => LM.app.S.project.groups.map(g => g.leds.length)), new Array(truth.rows).fill(truth.perRow), 'one group per row');
  assert.strictEqual(st[0].leds.filter(l => l[4]).length, 0, 'nothing flagged on a clean photo'); assert.ok(st[0].done);
  await page.waitForTimeout(200); await page.screenshot({ path: SHOT + '20_lit_rgb.png' });
  const map = await page.evaluate(() => JSON.parse(LM.exporters.wled(LM.app.S.project).files[0].text).map); assert.strictEqual(map.length, truth.leds.length); assert.strictEqual(map.filter(v => v >= 0).length, truth.rows * truth.perRow);

  /* 2. finishing a strip, starting the next, continuing */
  await page.goto('http://localhost:8765/index.html?fresh');
  await page.setInputFiles('#fileImages', __dirname + '/fixtures/synthetic_strip.jpg'); await page.waitForFunction(() => LM.app.S.project.sheets.length === 1); await page.waitForTimeout(300);
  await click(200, 800); await click(260, 795);                         // spacing
  await click(200, 800); await click(1400, 700);                        // row A, 21 LEDs
  assert.ok(/Finish Strip 1/.test(await page.locator('#btnPathDone').innerText()), 'button names the strip it ends');
  await page.click('#btnPathDone'); st = await strips(); assert.ok(st[0].done && st[0].n === 21, 'Finish marks the strip finished');
  assert.ok(await page.locator('#btnPathContinue').isVisible(), 'Continue is offered');
  await click(1380, 500); st = await strips(); assert.strictEqual(st.length, 2, 'next click starts a new strip'); assert.strictEqual(st[0].n, 21); assert.strictEqual(st[1].n, 1);
  await click(220, 580); st = await strips(); assert.strictEqual(st[1].n, 20, 'second strip counts its own row');
  await page.keyboard.press('Escape'); st = await strips(); assert.ok(!st[1].done, 'Escape pauses without finishing');
  await page.click('#stripList .item >> nth=0 >> text=Continue'); await click(1436, 640); st = await strips(); assert.ok(st[0].n > 21 && st[1].n === 20, 'Continue adds to the finished strip');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Escape');

  /* 3. pin and reflow */
  await page.keyboard.press('v'); st = await strips(); const L = st[0].leds;
  assert.ok(L[10][3] === 1 && L[0][3] === 0 && L[20][3] === 0, 'clicked corners are pinned, LEDs between float');
  const a = await at(L[10][0], L[10][1]); await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(a[0] + 6, a[1] + 14, { steps: 3 }); await page.mouse.move(a[0], a[1] + 28, { steps: 4 }); await page.mouse.up();
  st = await strips(); const N = st[0].leds, dy = N[10][1] - L[10][1];
  assert.ok(dy > 20 && N[10][3] === 0, 'dragged LED moved and became pinned');
  assert.ok(Math.abs((N[5][1] - L[5][1]) - dy / 2) < 1.5 && Math.abs((N[15][1] - L[15][1]) - dy / 2) < 1.5, 'LEDs either side spread out to follow');
  assert.ok(Math.abs(N[0][1] - L[0][1]) < 0.01 && Math.abs(N[20][1] - L[20][1]) < 0.01, 'the corners stay put');
  await click(N[5][0], N[5][1]); await page.keyboard.press(']'); st = await strips(); assert.strictEqual(st[0].n, 22, '] adds one between the pins');
  assert.ok(Math.abs(st[0].leds[11][1] - N[10][1]) < 0.01, 'the pin did not move, it is now pixel 11');
  await page.keyboard.press('['); await page.keyboard.press('['); st = await strips(); assert.strictEqual(st[0].n, 20, '[ removes');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); st = await strips();
  assert.ok(Math.abs(st[0].leds[10][1] - L[10][1]) < 0.01 && st[0].leds[10][3] === 1, 'undo puts everything back');
  await page.screenshot({ path: SHOT + '21_pins.png' });
  assert.strictEqual(errors.length, 0, errors.join('; ')); console.log('lit: all checks passed'); await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
