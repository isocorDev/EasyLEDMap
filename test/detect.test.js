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

// ---- lit LEDs in a red, green, blue cycle ----
// Serpentine: `rows` rows of `perRow` LEDs, two squeezed LEDs in each turn. Returns truth positions in wire order.
function serpentine(rows, perRow, x0, y0, pitch, rowGap) {
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < perRow; c++) pts.push([x0 + (r % 2 ? perRow - 1 - c : c) * pitch, y0 + r * rowGap]);
    if (r < rows - 1) { const ex = pts[pts.length - 1][0] + (r % 2 ? -14 : 14); pts.push([ex, y0 + r * rowGap + rowGap * 0.36], [ex, y0 + r * rowGap + rowGap * 0.66]); }
  }
  return pts;
}
function litScene(w, h, strips, opts) {
  const o = Object.assign({ lightsOn: true, skip: new Set(), offset: [] }, opts), rgba = new Uint8Array(w * h * 4);
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const set = (x, y, r, g, b) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; };
  const base = o.lightsOn ? 185 : 14;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = base + (rnd() - 0.5) * 10; set(x, y, v, v, v); }
  const COL = [[255, 35, 30], [40, 255, 60], [45, 70, 255]];
  strips.forEach((pts, si) => {
    if (o.lightsOn) {                    // white strip under the LEDs and copper pads beside some of them
      for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let t = 0; t <= L; t += 0.5) for (let k = -6; k <= 6; k++) { const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; set(a[0] + (b[0] - a[0]) * t / L + nx * k, a[1] + (b[1] - a[1]) * t / L + ny * k, 244, 244, 242); } }
      for (let i = 2; i < pts.length; i += 3) { const a = pts[i - 1], b = pts[i]; for (let dy = -4; dy <= 4; dy++) for (let dx = -2; dx <= 2; dx++) set((a[0] + b[0]) / 2 + dx, (a[1] + b[1]) / 2 + dy, 232, 150, 98); }
    }
    pts.forEach((p, i) => {
      if (o.skip.has(si + ':' + i)) return; const c = COL[(i + (o.offset[si] || 0)) % 3];
      for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
        const d = Math.hypot(dx, dy); if (d > 9) continue;
        if (d <= 2) set(p[0] + dx, p[1] + dy, 255, 255, 255);                                  // blown-out centre
        else if (d <= 5.5) set(p[0] + dx, p[1] + dy, c[0], c[1], c[2]);
        else { const k = 0.28 * (1 - (d - 5.5) / 3.5), bg = o.lightsOn ? 244 : 14; set(p[0] + dx, p[1] + dy, bg + (c[0] - bg) * k, bg + (c[1] - bg) * k, bg + (c[2] - bg) * k); }   // faint glow
      }
    });
  });
  return D.prepare(rgba, w, h);
}
const near = (b, p, tol) => Math.hypot(b.x - p[0], b.y - p[1]) <= (tol || 3);
for (const lightsOn of [true, false]) {
  const truth = serpentine(5, 12, 60, 50, 30, 100), prep = litScene(460, 520, [truth], { lightsOn });
  const res = D.detectLit(prep); assert.strictEqual(res.mode, 'colour'); assert.strictEqual(res.blobs.length, truth.length, `lights ${lightsOn ? 'on' : 'off'}: found ${res.blobs.length} of ${truth.length}`);
  const ch = D.chainByColour(res.blobs, { pitch: res.pitch }); assert.strictEqual(ch.chains.length, 1); assert.strictEqual(ch.chains[0].length, truth.length);
  ch.chains[0].forEach((e, i) => assert.ok(near(res.blobs[e], truth[i]), `LED ${i} is in wire order`));
}
{ // one LED did not light: the walk bridges it and leaves a placeholder at the right index
  const truth = serpentine(4, 10, 60, 50, 30, 100), prep = litScene(420, 420, [truth], { skip: new Set(['0:17']) }), res = D.detectLit(prep), ch = D.chainByColour(res.blobs, { pitch: res.pitch });
  assert.strictEqual(res.blobs.length, truth.length - 1); assert.strictEqual(ch.chains[0].length, truth.length); assert.ok(ch.chains[0][17].gap, 'gap marked at index 17');
  assert.ok(Math.hypot(ch.chains[0][17].gap[0] - truth[17][0], ch.chains[0][17].gap[1] - truth[17][1]) < 6); assert.ok(near(res.blobs[ch.chains[0][18]], truth[18]));
}
{ // two strips in one photo, the second starting mid-cycle: each is found on its own, in its own wire order
  const a = serpentine(3, 10, 50, 50, 30, 100), b = serpentine(3, 8, 480, 60, 30, 100), prep = litScene(780, 330, [a, b], { offset: [0, a.length % 3] }), res = D.detectLit(prep);
  assert.strictEqual(res.blobs.length, a.length + b.length);
  const two = D.chainByColour(res.blobs, { pitch: res.pitch }); assert.deepStrictEqual(two.chains.map(c => c.length), [a.length, b.length]); assert.ok(near(res.blobs[two.chains[1][0]], b[0]), 'second strip starts at its own first LED');
}
{ // a short piece reached by a wire jump joins the end of the strip, and the join is marked
  const a = serpentine(2, 10, 60, 50, 30, 100), tail = [[200, 250], [170, 250], [140, 250]], all = a.concat(tail), prep = litScene(420, 320, [all]), res = D.detectLit(prep), ch = D.chainByColour(res.blobs, { pitch: res.pitch });
  assert.strictEqual(ch.chains.length, 1); const c = ch.chains[0]; assert.strictEqual(c.filter(e => typeof e === 'number').length, all.length); assert.ok(c[a.length].join, 'join marked where the wire jumps');
  assert.ok(near(res.blobs[c[c.length - 1]], tail[2]));
}
{ // plain white LEDs still work, by brightness
  const w = 300, h = 120, rgba = new Uint8Array(w * h * 4).fill(18); for (let c = 0; c < 9; c++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const i = ((60 + dy) * w + 30 + c * 30 + dx) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 250; }
  const res = D.detectLit(D.prepare(rgba, w, h)); assert.strictEqual(res.mode, 'bright'); assert.strictEqual(res.blobs.length, 9);
}
{ // rows and turns: rows stay live, LEDs inside a turn go dead, every row after the first is marked as a new group
  const truth = serpentine(5, 12, 60, 50, 30, 100), rt = D.rowsAndTurns(truth, 30, 5);
  assert.strictEqual(rt.filter(r => r.dead).length, 8, 'two dead per turn'); assert.strictEqual(rt.filter(r => r.brk).length, 4);
  assert.ok(rt[12].dead && rt[13].dead && !rt[11].dead && !rt[14].dead && rt[14].brk);
  // a short last row parallel to the others is still a row
  const short = serpentine(3, 12, 60, 50, 30, 100).concat([[60 - 14, 286], [60 - 14, 316], [60, 350], [90, 350], [120, 350]]), rs = D.rowsAndTurns(short, 30, 5);
  assert.ok(!rs[short.length - 1].dead && !rs[short.length - 3].dead && rs[short.length - 4].dead, 'short parallel run counts as a row');
}
// homography round trip
{ const H = G.homography([[10, 20], [200, 30], [220, 180], [5, 160]], [[0, 0], [24, 0], [24, 12], [0, 12]]), I = G.invertH(H), p = G.applyH(H, 120, 90), q = G.applyH(I, p[0], p[1]); assert.ok(Math.hypot(q[0] - 120, q[1] - 90) < 1e-6); assert.ok(Math.hypot(...G.applyH(H, 220, 180).map((v, i) => v - [24, 12][i])) < 1e-9); }
console.log('detect: all checks passed');
