// Run: node test/exporters.test.js
const assert = require('assert'); const zlib = require('zlib');
const M = require('../js/model.js'), X = require('../js/exporters.js');
function sample() {
  const p = M.newProject(); p.name = 'Test "panel"';
  const sh = M.newSheet('a', 1000, 1000, 'images/a.jpg'); p.sheets.push(sh);
  // Strip 1: 5 live, 2 dead, 4 live. Strip 2: 3 live.
  const s1 = M.newStrip(p); p.strips.push(s1);
  for (let i = 0; i < 11; i++) s1.leds.push(M.newLed(sh.id, 100 + i * 10, i < 5 ? 100 : (i < 7 ? 150 : 200), { dead: i === 5 || i === 6 }));
  const s2 = M.newStrip(p); p.strips.push(s2);
  for (let i = 0; i < 3; i++) s2.leds.push(M.newLed(sh.id, 300 + i * 10, 300));
  p.groups.push(...M.groupsFromRuns(p, s1, 'A')); p.groups.push(...M.groupsFromRuns(p, s2, 'B'));
  return p;
}
const p = sample(), r = M.resolve(p);
assert.strictEqual(r.total, 14); assert.strictEqual(r.live, 12);
assert.deepStrictEqual(p.groups.map(g => g.leds.length), [5, 4, 3]);

// WLED
let w = X.wled(p), map = JSON.parse(w.files.find(f => f.name === 'ledmap.json').text);
assert.strictEqual(map.map.length, 14, 'map padded to physical length');
assert.deepStrictEqual(map.map, [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, -1, -1]);
assert.ok(!map.map.includes(5) && !map.map.includes(6), 'dead pixels unmapped');
const hdr = w.files.find(f => f.name === 'led_map_wled.h').text;
const arr = (text, name) => { const m = new RegExp('const \\w+ ' + name + '\\[[^\\]]*\\][^=]*= \\{([^}]*)\\}').exec(text); assert.ok(m, 'array ' + name + ' present'); return m[1].split(',').map(s => parseFloat(s)); };
assert.deepStrictEqual(arr(hdr, 'LM_GROUP_START'), [0, 5, 9]); assert.deepStrictEqual(arr(hdr, 'LM_GROUP_LEN'), [5, 4, 3]);
assert.deepStrictEqual(arr(hdr, 'LM_GROUP_OF'), [0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
assert.strictEqual(arr(hdr, 'LM_X').length, 12);
assert.ok(w.files.find(f => f.name === 'wled_setup.md').text.includes('"stop":9'), 'segment for strip 1 covers its 9 live pixels');
assert.ok(!/\u2014/.test(w.files.map(f => f.text || '').join('')), 'no em dashes in WLED output');
// Packed by group, with groups reordered
const p2 = sample(); p2.groups.reverse(); p2.exports.wled.order = 'groups';
map = JSON.parse(X.wled(p2).files[0].text).map;
assert.deepStrictEqual(map, [11, 12, 13, 7, 8, 9, 10, 0, 1, 2, 3, 4, -1, -1]);
// Non contiguous group warns
const p3 = sample(); p3.groups[0].leds.push(p3.strips[1].leds[2].id);
assert.ok(X.wled(p3).warnings.some(x => /not one unbroken run/.test(x)));

// FastLED
const f = X.fastled(p), fh = f.files[0].text;
assert.strictEqual(arr(fh, 'LM_X').length, 14); assert.deepStrictEqual(arr(fh, 'LM_STRIP_START'), [0, 11]);
assert.deepStrictEqual(arr(fh, 'LM_GROUP'), [0, 0, 0, 0, 0, 255, 255, 1, 1, 1, 1, 2, 2, 2]);
const xs = arr(fh, 'LM_X'), ys = arr(fh, 'LM_Y');
assert.strictEqual(Math.min(...xs), 0); assert.strictEqual(Math.max(...xs), 65535, 'longest side fills range');
assert.ok(Math.max(...ys) < 65535 && Math.min(...ys) === 0, 'aspect kept, anchored at corner');
assert.ok(fh.includes('0x60'), 'dead bits 5 and 6 set'); // 0b01100000
p.exports.fastled.grid = true; assert.ok(X.fastled(p).files[0].text.includes('uint16_t XY('));

// TouchDesigner
const t = X.touchdesigner(p), rows = t.files[0].text.trim().split('\n').map(l => l.split(','));
assert.strictEqual(rows.length, 15);
const col = n => rows.slice(1).map(rw => +rw[rows[0].indexOf(n)]);
assert.ok(Math.min(...col('x')) === -1 && Math.max(...col('x')) === 1, 'x spans -1..1');
assert.ok(col('y')[0] > col('y')[13], 'Y up: first row (top of photo) is higher than the last');
assert.deepStrictEqual(col('universe').slice(10, 12), [0, 1], 'strip 2 starts a new universe');
assert.strictEqual(col('channel')[1], 4);
const png = t.files.find(x => x.name === 'led_uv_16bit.png').bytes;
assert.deepStrictEqual([...png.slice(0, 4)], [137, 80, 78, 71]);
// decode IDAT to prove the PNG is valid
const idatAt = Buffer.from(png).indexOf('IDAT'), len = Buffer.from(png).readUInt32BE(idatAt - 4);
const raw = zlib.inflateSync(Buffer.from(png).subarray(idatAt + 4, idatAt + 4 + len));
assert.strictEqual(raw.length, 1 + 14 * 6); assert.strictEqual(raw.readUInt16BE(1 + 5 * 6 + 4), 0, 'dead pixel blue = 0');
assert.strictEqual(X.crc32(Buffer.from('123456789')), 0xCBF43926);
console.log('exporters: all checks passed');
