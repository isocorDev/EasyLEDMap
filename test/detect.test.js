// Run: node test/detect.test.js
const assert = require('assert'); const D = require('../js/detect.js'), G = require('../js/geom.js');
// Synthetic strip: grey panel, white strip, an LED (grey disc with dark dots) every `pitch` px along a slanted line.
function scene(w, h, ax, ay, bx, by, count, noise) {
  const rgba = new Uint8Array(w * h * 4), put = (x, y, v) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255; };
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 170 + (rnd() - 0.5) * noise);
  const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L, pitch = L / (count - 1);
  for (let t = -20; t <= L + 20; t += 0.5) for (let k = -8; k <= 8; k += 0.5) put(ax + ux * t - uy * k, ay + uy * t + ux * k, 245);
  for (let i = 0; i < count; i++) { const cx = ax + ux * pitch * i, cy = ay + uy * pitch * i; for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dy * dy <= 25) put(cx + dx, cy + dy, 150); put(cx - 6, cy - 6, 40); put(cx + 6, cy + 6, 40); }
  return { prep: D.prepare(rgba, w, h), pitch };
}
for (const count of [6, 11, 17, 24]) {
  const { prep, pitch } = scene(900, 500, 60, 80, 840, 420, count, 14);
  for (const wrong of [0.8, 1, 1.22]) {
    const r = D.countAlong(prep, 60, 80, 840, 420, 13, pitch * wrong);
    assert.strictEqual(r.intervals, count - 1, `count ${count} with spacing guess x${wrong}: got ${r.intervals + 1}`);
    assert.ok(r.confidence > 0.3, 'confident on a clean strip');
  }
}
// endpoints a few pixels off the LED centres still count correctly
{ const { prep, pitch } = scene(900, 500, 60, 80, 840, 420, 15, 14); assert.strictEqual(D.countAlong(prep, 64, 77, 836, 424, 13, pitch).intervals, 14); }
// a short leg falls back to length over spacing and says it is unsure when between two counts
{ const { prep } = scene(400, 200, 40, 100, 360, 100, 9, 10); const r = D.countAlong(prep, 40, 100, 140, 100, 13, 40); assert.strictEqual(r.intervals, 3); assert.ok(r.weak, 'flags an in-between length'); }
// polyline helpers
assert.strictEqual(D.polyLength([[0, 0], [3, 4], [3, 10]]), 11); assert.deepStrictEqual(D.polyAt([[0, 0], [10, 0], [10, 10]], 15), [10, 5]);
// lit detection and ordering
{ const w = 300, h = 200, rgba = new Uint8Array(w * h * 4).fill(20); const pts = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) { const x = 30 + c * 32, y = 40 + r * 55; pts.push([x, y]); for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const i = ((y + dy) * w + x + dx) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 255; } }
  const res = D.detectLit(D.prepare(rgba, w, h)); assert.strictEqual(res.blobs.length, 24);
  const start = res.blobs.findIndex(b => Math.abs(b.x - 30) < 1 && Math.abs(b.y - 40) < 1), o = D.orderSerpentine(res.blobs, start).map(i => res.blobs[i]);
  assert.deepStrictEqual(o.slice(6, 10).map(b => [Math.round(b.x), Math.round(b.y)]), [[222, 40], [254, 40], [254, 95], [222, 95]], 'serpentine turns at the row end'); }
// homography round trip
{ const H = G.homography([[10, 20], [200, 30], [220, 180], [5, 160]], [[0, 0], [24, 0], [24, 12], [0, 12]]), I = G.invertH(H), p = G.applyH(H, 120, 90), q = G.applyH(I, p[0], p[1]); assert.ok(Math.hypot(q[0] - 120, q[1] - 90) < 1e-6); assert.ok(Math.hypot(...G.applyH(H, 220, 180).map((v, i) => v - [24, 12][i])) < 1e-9); }
console.log('detect: all checks passed');
