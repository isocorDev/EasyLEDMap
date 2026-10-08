// Full UI check. Run: node test/ui_full.js  (needs a static server on :8765)
const { chromium } = require('playwright'); const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const SHOT = __dirname + '/shots/';
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; } catch (_) {} });   // headless has no file picker; use the download path
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:8765/index.html?fresh');
  const st = () => page.evaluate(() => { const p = LM.app.S.project; return { strips: p.strips.map(s => s.leds.map(l => l.dead ? 'x' : (l.brk ? '|o' : 'o')).join('')), groups: p.groups.map(g => g.leds.length), sel: LM.app.S.sel.size, sheets: p.sheets.length, undo: LM.app.S.undo.length }; });
  const box = async () => page.locator('#canvas').boundingBox();
  const at = async (x, y) => { const b = await box(), p = await page.evaluate(([x, y]) => LM.app.api.toScreen(x, y), [x, y]); return [b.x + p[0], b.y + p[1]]; };
  const click = async (x, y, o) => { const p = await at(x, y); const mods = (o && o.modifiers) || []; for (const m of mods) await page.keyboard.down(m); await page.mouse.click(p[0], p[1]); for (const m of mods) await page.keyboard.up(m); await page.waitForTimeout(40); };

  /* 1. draw a path on the synthetic strip: row of 21, a turn with 2 dead, row of 20 */
  await page.setInputFiles('#fileImages', __dirname + '/fixtures/synthetic_strip.jpg');
  await page.waitForFunction(() => LM.app.S.project.sheets.length === 1); await page.waitForTimeout(300);
  await click(200, 800); await click(260, 795);                       // spacing: two neighbours
  await click(200, 800); await click(1400, 700);                      // row A
  let s = await st(); assert.strictEqual(s.strips[0], 'o'.repeat(21), 'row A has 21 LEDs');
  await click(1380, 500);                                             // turn to row B
  s = await st(); console.log('after turn', s.strips[0]); assert.ok(/^o{21}x+\|o$/.test(s.strips[0]), 'turn adds dead pixels then a marked row start');
  const deadAuto = s.strips[0].split('x').length - 1;
  if (deadAuto !== 2) { for (let i = deadAuto; i < 2; i++) await page.keyboard.press(']'); for (let i = deadAuto; i > 2; i--) await page.keyboard.press('['); }
  s = await st(); assert.strictEqual(s.strips[0], 'o'.repeat(21) + 'xx|o', '[ and ] set the turn to 2 dead');
  await click(220, 580);                                              // row B
  s = await st(); assert.strictEqual(s.strips[0], 'o'.repeat(21) + 'xx|o' + 'o'.repeat(19), 'row B has 20 LEDs');
  await page.keyboard.press(']'); s = await st(); assert.strictEqual(s.strips[0].split('|o')[1].length, 20, '] adds one');
  await page.keyboard.press('['); await page.keyboard.press('Backspace'); s = await st(); assert.ok(s.strips[0].endsWith('|o'), 'Backspace removes the last leg');
  await page.keyboard.press('Backspace'); s = await st(); assert.strictEqual(s.strips[0], 'o'.repeat(21), 'Backspace again removes the turn');
  for (const pt of [[1436, 640], [1420, 570]]) await click(pt[0], pt[1], { modifiers: ['Shift'] });   // place the turn LEDs by hand
  await click(1380, 500); await click(220, 580); await page.keyboard.press('Enter');
  s = await st(); assert.strictEqual(s.strips[0], 'o'.repeat(21) + 'xx|o' + 'o'.repeat(19), 'hand-placed turn gives the same result');
  assert.deepStrictEqual(s.groups, [21, 20], 'one group per row');
  await page.screenshot({ path: SHOT + '10_path.png' });

  /* 2. select tool */
  await page.keyboard.press('v');
  const led = async (k) => page.evaluate(k => { const l = LM.app.S.project.strips[0].leds[k]; return [l.x, l.y]; }, k);
  let p = await led(3); await click(p[0], p[1]); s = await st(); assert.strictEqual(s.sel, 1);
  p = await led(7); await click(p[0], p[1], { modifiers: ['Shift'] }); s = await st(); assert.strictEqual(s.sel, 5, 'shift-click selects the range');
  await page.keyboard.press('d'); s = await st(); assert.strictEqual(s.strips[0].slice(3, 8), 'xxxxx', 'D marks dead');
  await page.keyboard.press('Control+z'); s = await st(); assert.strictEqual(s.strips[0].slice(0, 11), 'ooooooooooo', 'undo restores');
  await page.keyboard.press('Control+Shift+z'); s = await st(); assert.strictEqual(s.strips[0].slice(3, 8), 'xxxxx', 'redo');
  await page.keyboard.press('Control+z');
  p = await led(3); const pd = await at(p[0], p[1]); await page.mouse.dblclick(pd[0], pd[1]); s = await st(); assert.strictEqual(s.sel, 21, 'double-click selects the run');
  const n0 = (await st()).strips[0].length; await page.keyboard.press(']'); s = await st(); assert.strictEqual(s.strips[0].length, n0 + 1, '] respaces with one more'); assert.strictEqual(s.groups[0], 22, 'new LED joined the group');
  await page.keyboard.press('['); s = await st(); assert.strictEqual(s.strips[0].length, n0);
  // drag one LED
  await page.keyboard.press('Escape'); p = await led(5); const a = await at(p[0], p[1]); await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(a[0] + 20, a[1] + 10, { steps: 4 }); await page.mouse.up();
  const p2 = await led(5); assert.ok(Math.hypot(p2[0] - p[0], p2[1] - p[1]) > 3, 'drag moved the LED'); await page.keyboard.press('Control+z');
  // marquee + delete + undo
  const b = await box(); await page.mouse.move(b.x + 5, b.y + 60); await page.mouse.down(); await page.mouse.move(b.x + b.width - 5, b.y + b.height - 60, { steps: 5 }); await page.mouse.up();
  s = await st(); assert.strictEqual(s.sel, s.strips[0].replace(/\|/g, '').length, 'marquee selects everything'); await page.keyboard.press('Delete'); s = await st(); assert.strictEqual(s.strips[0].length, 0); await page.keyboard.press('Control+z');
  // add tool inserts on the wire
  await page.keyboard.press('a'); const l1 = await led(1), l2 = await led(2); await click((l1[0] + l2[0]) / 2, (l1[1] + l2[1]) / 2); s = await st(); assert.strictEqual(s.strips[0].length, n0 + 1, 'add tool inserted'); await page.keyboard.press('Control+z'); await page.keyboard.press('v');

  /* 3. second photo, lit LEDs, layout */
  await page.setInputFiles('#fileImages', __dirname + '/fixtures/lit_grid.png'); await page.waitForFunction(() => LM.app.S.project.sheets.length === 2); await page.waitForTimeout(200);
  await page.click('#btnAddStrip'); await page.keyboard.press('v');
  await page.click('text=Find lit LEDs'); s = await st(); assert.strictEqual(s.strips[1].length, 40, 'found 40 lit LEDs'); await page.screenshot({ path: SHOT + '11_lit.png' });
  await page.click('text=Reorder: serpentine rows'); const xs = await page.evaluate(() => LM.app.S.project.strips[1].leds.slice(0, 12).map(l => Math.round(l.x) + ',' + Math.round(l.y))); console.log('serpentine', xs.join(' '));
  await page.click('text=Layout'); await page.waitForTimeout(200); await page.screenshot({ path: SHOT + '12_layout.png' });
  // flatten the lit photo using its known LED grid (630 x 330 px rectangle -> 9 x 3 units)
  await page.click('.tab >> text=lit_grid'); await page.click('text=Flatten photo');
  await page.evaluate(() => { LM.app.S.flatEdit.quad = [[80, 80], [710, 80], [710, 410], [80, 410]]; });
  await page.fill('#photoForm input >> nth=0', '9'); await page.fill('#photoForm input >> nth=1', '3'); await page.click('#photoForm >> text=Apply');
  const world = await page.evaluate(() => LM.model.resolve(LM.app.S.project).leds.filter(l => l.strip === 1).map(l => [l.x, l.y]));
  const wx = world.map(w => w[0]), wy = world.map(w => w[1]); console.log('flattened span', (Math.max(...wx) - Math.min(...wx)).toFixed(2), (Math.max(...wy) - Math.min(...wy)).toFixed(2));
  assert.ok(Math.abs(Math.max(...wx) - Math.min(...wx) - 9) < 0.1 && Math.abs(Math.max(...wy) - Math.min(...wy) - 3) < 0.1, 'flatten maps the grid to 9 x 3 units');

  /* 4. export all three */
  await page.click('#btnExport'); await page.waitForTimeout(200);
  for (const t of ['wled', 'fastled', 'td']) {
    await page.click(`#exportTarget button[data-t=${t}]`); await page.waitForTimeout(250);
    const info = await page.evaluate(() => ({ files: LM.app.api.getExport().files.map(f => f.name), warn: LM.app.api.getExport().warnings, sum: LM.app.api.getExport().summary })); console.log(t, JSON.stringify(info));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownloadAll')]); const f = path.join(os.tmpdir(), 'lm_' + dl.suggestedFilename()); await dl.saveAs(f);
    const names = require('child_process').execSync(`python3 -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(' '.join(z.namelist()))" "${f}"`).toString().trim(); assert.strictEqual(names.split(' ').length, info.files.length, 'zip holds every file');
    if (t === 'td') await page.screenshot({ path: SHOT + '13_export_td.png' });
  }
  const map = await page.evaluate(() => { LM.app.S.exportTarget = 'wled'; return JSON.parse(LM.exporters.wled(LM.app.S.project).files[0].text).map; });
  const total = (await st()).strips.reduce((n, x) => n + x.replace(/\|/g, '').length, 0); assert.strictEqual(map.length, total, 'ledmap length equals LEDs on the wire');
  await page.click('#dlgExport button[value=close]');

  /* 5. save, reopen, compare */
  const before = await page.evaluate(() => JSON.stringify(LM.app.S.project));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]); const pf = path.join(os.tmpdir(), 'lm_test.ledmap'); await dl.saveAs(pf); console.log('project file', dl.suggestedFilename(), fs.statSync(pf).size, 'bytes');
  await page.goto('http://localhost:8765/index.html?fresh'); await page.setInputFiles('#fileProject', pf); await page.waitForFunction(() => LM.app.S.project.sheets.length === 2); await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify(LM.app.S.project)); assert.strictEqual(after, before, 'project survives save and reopen');
  assert.strictEqual(await page.evaluate(() => [...LM.app.S.images.values()].filter(i => i.img).length), 2, 'photos reloaded'); await page.screenshot({ path: SHOT + '14_reopened.png' });
  // edit after export, then export again
  await page.keyboard.press('v'); p = await led(0); await click(p[0], p[1]); await page.keyboard.press('d'); await page.click('#btnExport'); await page.waitForTimeout(200);
  const map2 = await page.evaluate(() => JSON.parse(LM.app.api.getExport().files[0].text).map); assert.ok(!map2.includes(0) && map2.length === total, 'second export reflects the edit'); await page.click('#dlgExport button[value=close]');
  /* 6. autosave restore */
  await page.waitForTimeout(1600); await page.goto('http://localhost:8765/index.html'); await page.waitForFunction(() => LM.app.S.project.sheets.length === 2, null, { timeout: 5000 }); console.log('autosave restored');
  /* 7. phone layout does not break */
  await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(300); await page.screenshot({ path: SHOT + '15_phone.png' });
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); assert.ok(!over, 'no sideways scroll on a phone');
  console.log('errors:', errors.length ? errors : 'none'); assert.strictEqual(errors.length, 0);
  console.log('ui: all checks passed'); await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
