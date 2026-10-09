/* EasyLEDMap: image analysis. Plain JS, no dependencies. Runs in the browser and in Node. */
(function (root) {
  'use strict';

  /** Build brightness (V = max channel) and chroma (max - min) planes from RGBA. */
  function prepare(rgba, w, h) {
    const n = w * h, V = new Uint8Array(n), S = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      V[i] = mx; S[i] = mx - mn;
    }
    return { w, h, V, S, rgba };
  }

  function bilinear(P, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
    if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (P[i] * (1 - fx) + P[i + 1] * fx) * (1 - fy) + (P[i + w] * (1 - fx) + P[i + w + 1] * fx) * fy;
  }

  /* ---------- 1D helpers ---------- */
  function boxSmooth(a, r) {
    const n = a.length, out = new Float32Array(n);
    if (r < 1) { out.set(a); return out; }
    let s = 0, c = 0;
    for (let i = 0; i < Math.min(n, r + 1); i++) { s += a[i]; c++; }
    for (let i = 0; i < n; i++) {
      out[i] = s / c;
      const add = i + r + 1, rem = i - r;
      if (add < n) { s += a[add]; c++; }
      if (rem >= 0) { s -= a[rem]; c--; }
    }
    return out;
  }
  function normalise(a, win) {
    const n = a.length, trend = boxSmooth(a, win), out = new Float32Array(n);
    let ss = 0;
    for (let i = 0; i < n; i++) { out[i] = a[i] - trend[i]; ss += out[i] * out[i]; }
    const sd = Math.sqrt(ss / Math.max(1, n)) || 1;
    for (let i = 0; i < n; i++) out[i] /= sd;
    return out;
  }

  /**
   * Sample three feature profiles along a polyline: mean brightness, darkest pixel and mean
   * chroma across a band of half-width `half`. The polyline and `half` are in work space;
   * `map` (optional) converts work space to photo pixels, so a flattened photo is sampled
   * evenly in real distance. Sampling density is about one sample per photo pixel.
   */
  function profiles(prep, poly, half, map) {
    const { w, h, V, S } = prep;
    const img = map ? poly.map(p => map(p[0], p[1])) : poly;
    let L = 0, Lpx = 0; const segL = [];
    for (let i = 1; i < poly.length; i++) { const l = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]); segL.push(l); L += l; Lpx += Math.hypot(img[i][0] - img[i - 1][0], img[i][1] - img[i - 1][1]); }
    L = L || 1e-9;
    const n = Math.max(2, Math.round(Lpx) + 1), spu = (n - 1) / L;
    const mean = new Float32Array(n), dark = new Float32Array(n), chroma = new Float32Array(n);
    const hw = Math.max(1, Math.round(half * spu));
    let seg = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * L;
      while (seg < segL.length - 1 && t > acc + segL[seg]) { acc += segL[seg]; seg++; }
      const a = poly[seg], b = poly[seg + 1], sl = segL[seg] || 1e-9, f = Math.max(0, Math.min(1, (t - acc) / sl));
      const ux = (b[0] - a[0]) / sl, uy = (b[1] - a[1]) / sl, cx = a[0] + (b[0] - a[0]) * f, cy = a[1] + (b[1] - a[1]) * f;
      let sv = 0, mn = 255, sc = 0, c = 0;
      for (let k = -hw; k <= hw; k++) {
        let x = cx - uy * k / spu, y = cy + ux * k / spu;
        if (map) { const q = map(x, y); x = q[0]; y = q[1]; }
        const v = bilinear(V, w, h, x, y); sv += v; if (v < mn) mn = v;
        sc += bilinear(S, w, h, x, y); c++;
      }
      mean[i] = sv / c; dark[i] = mn; chroma[i] = sc / c;
    }
    return { L, n, spu, feats: [mean, dark, chroma] };
  }
  function polyLength(poly) { let L = 0; for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]); return L; }
  /** Point at distance t along a polyline. */
  function polyAt(poly, t) {
    for (let i = 1; i < poly.length; i++) {
      const l = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
      if (t <= l || i === poly.length - 1) { const f = l ? Math.max(0, Math.min(1, t / l)) : 0; return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * f, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * f]; }
      t -= l;
    }
    return poly[poly.length - 1].slice();
  }

  /**
   * Count the LED intervals along a polyline whose two ends sit on LED centres, by epoch
   * folding: for each candidate count M the brightness profile is folded at period L/M, and
   * the right M makes the folded shape sharpest.
   * Returns { intervals, period, confidence (0..1), weak, scores }.
   */
  function countPoly(prep, poly, ledSize, pitchGuess, tol, map) {
    const L = polyLength(poly);
    tol = tol || 0.3;
    const guess = Math.max(1, Math.round(L / pitchGuess));
    const lo = Math.max(1, Math.ceil(L / (pitchGuess * (1 + tol)))), hi = Math.max(lo, Math.floor(L / (pitchGuess * (1 - tol))));
    const frac = Math.abs(L / pitchGuess - guess);
    if (L < pitchGuess * 3.5 || hi === lo) return { intervals: guess, period: L / guess, confidence: frac < 0.2 ? 0.6 : 0.2, weak: frac >= 0.25 };
    const pr = profiles(prep, poly, ledSize * 0.5, map), spu = pr.spu;
    const feats = pr.feats.map(f => normalise(boxSmooth(f, Math.max(1, Math.round(ledSize * 0.08 * spu))), Math.max(2, Math.round(pitchGuess * 0.75 * spu))));
    const n = pr.n, scores = [];
    let best = -1, bestM = guess, second = -1;
    for (let M = lo; M <= hi; M++) {
      const period = (n - 1) / M, bins = Math.max(8, Math.min(48, Math.round(period)));
      let power = 0;
      for (const f of feats) {
        const sum = new Float32Array(bins), cnt = new Float32Array(bins);
        for (let i = 0; i < n; i++) {
          const ph = (i / period) % 1; let b = Math.floor(ph * bins); if (b >= bins) b = bins - 1;
          sum[b] += f[i]; cnt[b]++;
        }
        let v = 0, m = 0, k = 0;
        for (let b = 0; b < bins; b++) if (cnt[b]) { const t = sum[b] / cnt[b]; m += t; v += t * t; k++; }
        m /= k; power += v / k - m * m;
      }
      power /= feats.length;
      scores.push({ M, power });
      if (power > best) { second = best; best = power; bestM = M; } else if (power > second) second = power;
    }
    const confidence = best > 0 ? Math.max(0, Math.min(1, (best - Math.max(0, second)) / best * 1.6)) * Math.min(1, best / 0.2) : 0;
    // With only a few periods the fold is easily fooled, so fall back to length over spacing.
    if (confidence < 0.3 && L < pitchGuess * 6) return { intervals: guess, period: L / guess, confidence: 0.2, weak: true, scores };
    return { intervals: bestM, period: L / bestM, confidence, weak: false, scores };
  }
  function countAlong(prep, ax, ay, bx, by, ledSize, pitchGuess, tol, map) { return countPoly(prep, [[ax, ay], [bx, by]], ledSize, pitchGuess, tol, map); }

  /* ---------- lit LEDs ---------- */
  function otsu(hist, from) {
    let total = 0, sum = 0; for (let i = from; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
    let wB = 0, sB = 0, best = 0, cut = from;
    for (let t = from; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; cut = t; } }
    return cut;
  }
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  /** Connected blobs of pixels where keep[i] is set; pixels only join when label[i] matches. */
  function blobsOf(w, h, keep, label, weight) {
    const n = w * h, seen = new Uint8Array(n), stack = new Int32Array(Math.min(n, 4e6)), out = [];
    for (let i = 0; i < n; i++) {
      if (seen[i] || !keep[i]) continue;
      const L = label ? label[i] : 0; let sp = 0, area = 0, sx = 0, sy = 0, sw = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, peak = 0; stack[sp++] = i; seen[i] = 1;
      while (sp) {
        const j = stack[--sp], x = j % w, y = (j / w) | 0, wt = weight ? weight[j] + 1 : 1;
        area++; sx += x * wt; sy += y * wt; sw += wt; if (wt > peak) peak = wt; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0) { const k = j - 1; if (!seen[k] && keep[k] && (!label || label[k] === L) && sp < stack.length) { seen[k] = 1; stack[sp++] = k; } }
        if (x < w - 1) { const k = j + 1; if (!seen[k] && keep[k] && (!label || label[k] === L) && sp < stack.length) { seen[k] = 1; stack[sp++] = k; } }
        if (y > 0) { const k = j - w; if (!seen[k] && keep[k] && (!label || label[k] === L) && sp < stack.length) { seen[k] = 1; stack[sp++] = k; } }
        if (y < h - 1) { const k = j + w; if (!seen[k] && keep[k] && (!label || label[k] === L) && sp < stack.length) { seen[k] = 1; stack[sp++] = k; } }
      }
      out.push({ x: sx / sw, y: sy / sw, area, cls: label ? L : -1, box: [x0, y0, x1, y1], peak });
    }
    return out;
  }
  /** Split a blob that covers several LEDs into k parts along its long axis. */
  function splitBlob(b, k, w, keep, label) {
    const px = []; for (let y = b.box[1]; y <= b.box[3]; y++) for (let x = b.box[0]; x <= b.box[2]; x++) { const i = y * w + x; if (keep[i] && (!label || label[i] === b.cls)) px.push([x, y]); }
    let mx = 0, my = 0; for (const p of px) { mx += p[0]; my += p[1]; } mx /= px.length; my /= px.length;
    let sxx = 0, sxy = 0, syy = 0; for (const p of px) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(ang), s = Math.sin(ang);
    px.sort((p, q) => (p[0] * c + p[1] * s) - (q[0] * c + q[1] * s));
    const out = [], per = px.length / k;
    for (let j = 0; j < k; j++) { const part = px.slice(Math.round(j * per), Math.round((j + 1) * per)); if (!part.length) continue; let x = 0, y = 0; for (const p of part) { x += p[0]; y += p[1]; } out.push({ x: x / part.length, y: y / part.length, area: part.length, cls: b.cls, box: b.box, peak: b.peak, split: true }); }
    return out;
  }
  function tidyBlobs(blobs, w, keep, label, knownPitch, noSplit) {
    if (blobs.length < 3) return blobs;
    let A = median(blobs.filter(b => b.area >= 3).map(b => b.area)) || 1;
    // Typical distance to the nearest neighbour, among blobs big enough to be LEDs.
    const big = blobs.filter(b => b.area >= A * 0.3), nn = [];
    if (!knownPitch) for (let i = 0; i < big.length; i++) { let bd = Infinity; for (let j = 0; j < big.length; j++) if (i !== j) { const d = (big[i].x - big[j].x) ** 2 + (big[i].y - big[j].y) ** 2; if (d < bd) bd = d; } nn.push(Math.sqrt(bd)); }
    const pitch = knownPitch || median(nn) || 10;
    // Fragments of one LED (a ring around a blown-out centre) merge back together.
    const used = new Uint8Array(blobs.length), merged = [];
    for (let i = 0; i < blobs.length; i++) {
      if (used[i]) continue; let g = [blobs[i]]; used[i] = 1;
      for (let j = i + 1; j < blobs.length; j++) if (!used[j] && blobs[j].cls === blobs[i].cls && Math.hypot(blobs[j].x - blobs[i].x, blobs[j].y - blobs[i].y) < pitch * 0.42) { used[j] = 1; g.push(blobs[j]); }
      if (g.length === 1) { merged.push(g[0]); continue; }
      let a = 0, x = 0, y = 0, peak = 0; const box = [Infinity, Infinity, 0, 0];
      for (const b of g) { if (b.peak > peak) peak = b.peak; a += b.area; x += b.x * b.area; y += b.y * b.area; box[0] = Math.min(box[0], b.box[0]); box[1] = Math.min(box[1], b.box[1]); box[2] = Math.max(box[2], b.box[2]); box[3] = Math.max(box[3], b.box[3]); }
      merged.push({ x: x / a, y: y / a, area: a, cls: g[0].cls, box, peak });
    }
    A = median(merged.filter(b => b.area >= 3).map(b => b.area)) || 1;
    const out = [];
    for (const b of merged) {
      if (b.area < Math.max(2, A * 0.12)) continue;                       // speck
      const k = Math.round(b.area / A);
      // In a colour cycle no two LEDs of one colour are neighbours, so an oversized blob is not
      // two LEDs run together. It is something else: tape, a connector, a reflection.
      if (noSplit) { if (b.area <= A * 3.5) out.push(b); continue; }
      const bw = b.box[2] - b.box[0] + 1, bh = b.box[3] - b.box[1] + 1, long = Math.max(bw, bh) / Math.min(bw, bh) >= 1.6 || b.area / (bw * bh) < 0.5;
      if (b.area > A * 2.6 && k >= 2 && k <= 8 && long) out.push(...splitBlob(b, k, w, keep, label)); else if (b.area <= A * 12) out.push(b);
    }
    return out;
  }
  /**
   * Coloured LEDs. A phone camera does not show a lit LED as a flat red, green or blue dot:
   * red comes out orange, blue is a cyan centre inside a blue halo, and green is a pale mint.
   * The centres of green and blue LEDs are almost the same colour, so the halo decides:
   *   red   = warm-hued blobs, keeping the vivid ones (copper solder pads are warm but dull);
   *   blue  = cool-hued blobs with blue-hued pixels around them;
   *   green = cool-hued blobs without.
   */
  function litColour(prep, o) {
    const { w, h, V, S, rgba } = prep, n = w * h, score = new Uint8Array(n), kind = new Uint8Array(n);   // kind: 1 warm, 2 cool, 3 cool and blue-hued
    const Tw = o.warm || 60, Tc = o.cool || 35; let count = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const c = S[i]; if (c < 22) continue; const mx = V[i], sc = (c * mx) >> 8; if (sc < Tc) continue;
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      let hue; if (mx === r) hue = 60 * (g - b) / c; else if (mx === g) hue = 120 + 60 * (b - r) / c; else hue = 240 + 60 * (r - g) / c;
      if (hue >= -42 && hue <= 55) { if (sc >= Tw) { kind[i] = 1; score[i] = sc; count++; } }
      else if (hue >= 95 && hue <= 272 && mx >= 130) { kind[i] = hue >= 190 ? 3 : 2; score[i] = sc; count++; }
    }
    if (count < 12) return null;
    const p90 = a => { const t = a.slice().sort((x, y) => x - y); return t.length ? t[Math.floor(t.length * 0.9)] : 0; };
    // red
    const mWarm = new Uint8Array(n); for (let i = 0; i < n; i++) if (kind[i] === 1) mWarm[i] = 1;
    let red = blobsOf(w, h, mWarm, null, score).filter(b => b.area >= 2);
    const refW = p90(red.map(b => b.peak)); red = red.filter(b => b.peak >= refW * 0.66);
    const rr = Math.max(2, Math.round(1.2 * Math.sqrt((median(red.map(b => b.area)) || 40) / Math.PI)));
    // green or blue: share of blue-hued pixels in a window about one LED wide around each cool pixel
    const W1 = w + 1, sa = new Uint32Array(W1 * (h + 1)), sb = new Uint32Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) { let ra = 0, rb = 0; for (let x = 0; x < w; x++) { const k = kind[y * w + x]; if (k >= 2) ra++; if (k === 3) rb++; const o2 = (y + 1) * W1 + x + 1; sa[o2] = sa[o2 - W1] + ra; sb[o2] = sb[o2 - W1] + rb; } }
    const mCool = new Uint8Array(n), lab = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (kind[i] < 2) continue; mCool[i] = 1;
      const x0 = Math.max(0, x - rr), x1 = Math.min(w, x + rr + 1), y0 = Math.max(0, y - rr), y1 = Math.min(h, y + rr + 1);
      const A = sa[y1 * W1 + x1] - sa[y0 * W1 + x1] - sa[y1 * W1 + x0] + sa[y0 * W1 + x0], B = sb[y1 * W1 + x1] - sb[y0 * W1 + x1] - sb[y1 * W1 + x0] + sb[y0 * W1 + x0];
      lab[i] = B > A * 0.3 ? 2 : 1;
    }
    let cool = blobsOf(w, h, mCool, lab, score).filter(b => b.area >= 3 && b.peak >= 40);
    red.forEach(b => { b.cls = 0; });
    // LED spacing: a red LED's nearest green or blue LED is its neighbour on the wire.
    const cA = median(cool.map(b => b.area)) || 1, solid = cool.filter(b => b.area >= cA * 0.3);
    const pitch = median(red.map(a => { let bd = Infinity; for (const b of solid) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (d < bd) bd = d; } return bd; }).filter(isFinite)) || 0;
    const tidy = (bl, m, lb, c) => tidyBlobs(bl, w, m, lb, pitch || undefined, true).map(b => Object.assign(b, { cls: c }));
    let blobs = [...tidy(red, mWarm, null, 0), ...tidy(cool.filter(b => b.cls === 1), mCool, lab, 1), ...tidy(cool.filter(b => b.cls === 2), mCool, lab, 2)];
    // One LED can leave a second, smaller blob beside the main one. Keep the larger.
    if (pitch) blobs = blobs.filter((a, i) => !blobs.some((b, j) => i !== j && (b.area > a.area || (b.area === a.area && j < i)) && Math.hypot(a.x - b.x, a.y - b.y) < pitch * 0.45));
    const per = [0, 0, 0]; for (const b of blobs) per[b.cls]++;
    return { mode: 'colour', threshold: Tc, blobs, perColour: per, pitch };
  }
  function litBright(prep, o) {
    const { w, h, V } = prep, n = w * h, hist = new Uint32Array(256); for (let i = 0; i < n; i++) hist[V[i]]++;
    const cut = otsu(hist, 0), thr = o.threshold || Math.max(150, Math.min(250, Math.round(cut + (255 - cut) * 0.5)));
    const keep = new Uint8Array(n); for (let i = 0; i < n; i++) if (V[i] >= thr) keep[i] = 1;
    const blobs = tidyBlobs(blobsOf(w, h, keep, null, V).filter(b => b.area >= 2 && b.area <= Math.max(400, n / 400)), w, keep, null);
    return { mode: 'bright', threshold: thr, blobs, perColour: [0, 0, 0] };
  }
  /**
   * Find lit LEDs. Returns { mode, blobs: [{ x, y, area, cls }], perColour }.
   * cls is 0, 1 or 2 for red, green or blue LEDs, or -1 when found by brightness alone.
   * opts.mode: 'auto' (default), 'colour' or 'bright'.
   */
  function detectLit(prep, opts) {
    const o = Object.assign({ mode: 'auto', threshold: 0 }, opts);
    if (o.mode === 'bright' || !prep.rgba) return litBright(prep, o);
    const c = litColour(prep, o) || { mode: 'colour', threshold: 0, blobs: [], perColour: [0, 0, 0], pitch: 0 };
    if (o.mode === 'colour') return c;
    // A full red, green, blue cycle is unmistakable. Anything less is found by plain brightness.
    const n = c.blobs.length; if (n >= 6 && c.perColour.every(k => k >= n * 0.15)) return c;
    const br = litBright(prep, o); return br.blobs.length >= 2 ? br : c;
  }

  /**
   * Order LEDs that were lit in a repeating red, green, blue cycle along the wire.
   * Each LED's successor is a nearby LED of the next colour, so direction comes from the cycle
   * itself. Links are made shortest first across the whole photo, which keeps a row from
   * grabbing a neighbour in the row beside it. Then pieces are stitched: across one missed LED
   * (a placeholder is inserted) and across short wire jumps.
   * Returns { chains: [[blob index | { gap: [x, y], cls } | { join: true }...]], leftovers, pitch }.
   * opts.pitch: LED spacing if known. opts.minStrip: shorter pieces that join nothing are left out.
   */
  function chainByColour(blobs, opts) {
    const o = Object.assign({ pitch: 0, minStrip: 6 }, opts), n = blobs.length;
    let pitch = o.pitch;
    if (!pitch) { const nn = []; for (let i = 0; i < n; i++) { let bd = Infinity; for (let j = 0; j < n; j++) if (i !== j) { const d = (blobs[i].x - blobs[j].x) ** 2 + (blobs[i].y - blobs[j].y) ** 2; if (d < bd) bd = d; } nn.push(Math.sqrt(bd)); } pitch = median(nn) || 1; }
    const next = new Int32Array(n).fill(-1), prev = new Int32Array(n).fill(-1), gapAfter = new Map();
    const tailOf = i => { let g = 0; while (next[i] >= 0 && g++ <= n) i = next[i]; return i; };
    const link = (maxD, step) => {
      const edges = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i === j || blobs[j].cls !== (blobs[i].cls + step) % 3) continue; const d = Math.hypot(blobs[i].x - blobs[j].x, blobs[i].y - blobs[j].y); if (d <= maxD) edges.push([d, i, j]); }
      edges.sort((a, b) => a[0] - b[0]);
      for (const [, i, j] of edges) { if (next[i] >= 0 || prev[j] >= 0 || tailOf(j) === i) continue; next[i] = j; prev[j] = i; if (step === 2) gapAfter.set(i, { gap: [(blobs[i].x + blobs[j].x) / 2, (blobs[i].y + blobs[j].y) / 2], cls: (blobs[i].cls + 1) % 3 }); }
    };
    link(pitch * 1.75, 1);       // neighbours on the wire
    link(pitch * 2.9, 2);        // one LED missed between them
    let chains = [];
    for (let s = 0; s < n; s++) { if (prev[s] >= 0) continue; const c = []; for (let i = s, g = 0; i >= 0 && g <= n; i = next[i], g++) { c.push(i); if (gapAfter.has(i) && next[i] >= 0) c.push(gapAfter.get(i)); } chains.push(c); }
    const first = c => blobs[c.find(e => typeof e === 'number')], last = c => blobs[[...c].reverse().find(e => typeof e === 'number')];
    const real = c => c.filter(e => typeof e === 'number').length;
    // Stitch pieces tail to head where the colours carry on: wire jumps, and gaps of one LED the first pass did not close.
    for (;;) {
      let best = null;
      for (let a = 0; a < chains.length; a++) for (let b = 0; b < chains.length; b++) {
        if (a === b) continue; const t = last(chains[a]), hd = first(chains[b]), d = Math.hypot(t.x - hd.x, t.y - hd.y), step = (hd.cls - t.cls + 3) % 3;
        if (step === 0 || d > pitch * (step === 1 ? 6 : 3.4)) continue;
        if (real(chains[a]) < 2 && real(chains[b]) < 2) continue;
        const cost = d + (step === 2 ? pitch * 1.5 : 0); if (!best || cost < best.cost) best = { a, b, cost, step, t, hd, d };
      }
      if (!best) break;
      const mid = best.step === 2 ? [{ gap: [(best.t.x + best.hd.x) / 2, (best.t.y + best.hd.y) / 2], cls: (best.t.cls + 1) % 3 }] : [];
      const joined = chains[best.a].concat(mid, best.d > pitch * 1.75 && best.step === 1 ? [{ join: true }] : [], chains[best.b]);
      chains = chains.filter((_, i) => i !== best.a && i !== best.b); chains.push(joined);
    }
    const leftovers = []; chains = chains.filter(c => { if (real(c) >= o.minStrip) return true; for (const e of c) if (typeof e === 'number') leftovers.push(e); return false; });
    chains.sort((p, q) => q.length - p.length);
    return { chains, leftovers, pitch };
  }

  /**
   * Split an ordered run of LED positions into rows and turns.
   * Corners are found by simplifying the path. Long straight pieces are rows; a short piece is
   * a row only if it runs parallel to the nearest long row. Everything else is a turn.
   * Returns one entry per LED: { dead, brk } (brk marks the first LED of a row).
   */
  function rowsAndTurns(pts, pitch, minLen) {
    const n = pts.length, out = pts.map(() => ({ dead: false, brk: false })); if (n < 3) return out;
    minLen = Math.max(2, minLen || 5); const eps = pitch * 0.7, keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop(); if (i1 - i0 < 2) continue; const a = pts[i0], b = pts[i1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9; let md = 0, mi = -1;
      for (let i = i0 + 1; i < i1; i++) { const d = L < 1e-6 ? Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) : Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L; if (d > md) { md = d; mi = i; } }
      if (md > eps) { keep[mi] = 1; stack.push([i0, mi], [mi, i1]); }
    }
    const v = []; for (let i = 0; i < n; i++) if (keep[i]) v.push(i);
    const segs = []; for (let j = 0; j + 1 < v.length; j++) { const a = pts[v[j]], b = pts[v[j + 1]]; segs.push({ a: v[j], b: v[j + 1], count: v[j + 1] - v[j] + 1, ang: Math.atan2(b[1] - a[1], b[0] - a[0]), row: false }); }
    const angDiff = (p, q) => { let d = Math.abs(p - q) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; };
    if (!segs.some(s => s.count >= minLen)) return out;        // nothing that looks like a row: leave everything live
    // Rows in a serpentine all lie along one axis, which may swing slowly across a fanned panel.
    // Turns cut across it. The local axis is the direction most of the nearby LEDs run in,
    // with long pieces counting for far more than short ones.
    const axisAt = j => { let sx = 0, sy = 0; for (let k = Math.max(0, j - 5); k <= Math.min(segs.length - 1, j + 5); k++) { const wgt = (segs[k].count - 1) ** 2 / (1 + Math.abs(k - j) * 0.25); sx += wgt * Math.cos(2 * segs[k].ang); sy += wgt * Math.sin(2 * segs[k].ang); } return Math.atan2(sy, sx) / 2; };
    const axes = segs.map((_, j) => axisAt(j));
    segs.forEach((s, j) => { s.row = s.count >= 2 && angDiff(s.ang, axes[j]) < 0.5; });
    // A lone step of one LED spacing between two turn pieces is part of the turn.
    segs.forEach((s, j) => { if (s.row && s.count === 2 && !(segs[j - 1] && segs[j - 1].row) && !(segs[j + 1] && segs[j + 1].row) && segs[j - 1] && segs[j + 1]) s.row = false; });
    // The simplified corners are only approximate. Fit a line to each row and let the row end
    // exactly where the LEDs leave that line, so a row neither loses its last LED nor takes one from the turn.
    const rows = segs.filter(s => s.row).map(s => ({ a: s.a, b: s.b })), tol = pitch * 0.45;
    for (const r of rows) {
      const i0 = r.b - r.a >= 4 ? r.a + 1 : r.a, i1 = r.b - r.a >= 4 ? r.b - 1 : r.b; let mx = 0, my = 0, c = 0;
      for (let i = i0; i <= i1; i++) { mx += pts[i][0]; my += pts[i][1]; c++; } mx /= c; my /= c;
      let sxx = 0, sxy = 0, syy = 0; for (let i = i0; i <= i1; i++) { const dx = pts[i][0] - mx, dy = pts[i][1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
      const off = i => Math.abs(-(pts[i][0] - mx) * uy + (pts[i][1] - my) * ux), along = i => (pts[i][0] - mx) * ux + (pts[i][1] - my) * uy;
      while (r.b > r.a + 1 && off(r.b) > tol) r.b--; while (r.a < r.b - 1 && off(r.a) > tol) r.a++;
      const dir = Math.sign(along(r.b) - along(r.a)) || 1;
      while (r.b + 1 < n && off(r.b + 1) <= tol && (along(r.b + 1) - along(r.b)) * dir > pitch * 0.3) r.b++;
      while (r.a - 1 >= 0 && off(r.a - 1) <= tol && (along(r.a) - along(r.a - 1)) * dir > pitch * 0.3) r.a--;
    }
    const live = new Uint8Array(n), start = new Uint8Array(n); let lastEnd = -1;
    for (const r of rows) { const from = Math.max(r.a, lastEnd + 1); if (from > r.b) continue; for (let i = from; i <= r.b; i++) live[i] = 1; start[from] = 1; lastEnd = r.b; }
    for (let i = 0; i < n; i++) { out[i].dead = !live[i]; out[i].brk = !!start[i] && i > 0; }
    return out;
  }

  /** Order points by walking to the nearest unvisited neighbour, starting at index `start`. */
  function orderNearest(pts, start) {
    const n = pts.length, used = new Uint8Array(n), order = [];
    let cur = Math.max(0, Math.min(n - 1, start | 0));
    for (let k = 0; k < n; k++) {
      used[cur] = 1; order.push(cur);
      let best = -1, bd = Infinity;
      for (let j = 0; j < n; j++) if (!used[j]) { const d = (pts[j].x - pts[cur].x) ** 2 + (pts[j].y - pts[cur].y) ** 2; if (d < bd) { bd = d; best = j; } }
      if (best < 0) break; cur = best;
    }
    return order;
  }

  /**
   * Order points as serpentine rows. Rows are found along the layout's long axis,
   * the first row starts nearest to `start`, and direction flips on every row.
   */
  function orderSerpentine(pts, start) {
    const n = pts.length; if (n < 3) return pts.map((_, i) => i);
    let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    // Rows run along whichever axis the nearest neighbours line up with.
    let ang = 0; { let ax = 0, ay = 0;
      for (let i = 0; i < n; i++) { let bd = Infinity, bj = -1; for (let j = 0; j < n; j++) if (j !== i) { const d = (pts[j].x - pts[i].x) ** 2 + (pts[j].y - pts[i].y) ** 2; if (d < bd) { bd = d; bj = j; } }
        const a = 2 * Math.atan2(pts[bj].y - pts[i].y, pts[bj].x - pts[i].x); ax += Math.cos(a); ay += Math.sin(a); }
      ang = Math.atan2(ay, ax) / 2; }
    const c = Math.cos(-ang), s = Math.sin(-ang);
    const q = pts.map((p, i) => ({ i, u: (p.x - mx) * c - (p.y - my) * s, v: (p.x - mx) * s + (p.y - my) * c }));
    q.sort((a, b) => a.v - b.v);
    const gaps = []; for (let i = 1; i < n; i++) gaps.push(q[i].v - q[i - 1].v);
    const sorted = gaps.slice().sort((a, b) => a - b), big = sorted[sorted.length - 1];
    const cut = Math.max(sorted[Math.floor(sorted.length * 0.5)] * 4, big * 0.35, 1e-6);
    const rows = [[q[0]]]; for (let i = 1; i < n; i++) { if (q[i].v - q[i - 1].v > cut) rows.push([]); rows[rows.length - 1].push(q[i]); }
    for (const r of rows) r.sort((a, b) => a.u - b.u);
    const st = q.find(e => e.i === (start | 0)) || q[0];
    const first = rows[0].includes(st) || Math.abs(st.v - rows[0][0].v) < Math.abs(st.v - rows[rows.length - 1][0].v) ? 0 : rows.length - 1;
    if (first !== 0) rows.reverse();
    let flip = Math.abs(st.u - rows[0][0].u) > Math.abs(st.u - rows[0][rows[0].length - 1].u);
    const order = [];
    for (const r of rows) { if (flip) r.reverse(); for (const e of r) order.push(e.i); flip = !flip; }
    return order;
  }

  const api = { prepare, bilinear, profiles, countAlong, countPoly, polyLength, polyAt, boxSmooth, detectLit, chainByColour, rowsAndTurns, orderNearest, orderSerpentine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LM = root.LM || {}; root.LM.detect = Object.assign(root.LM.detect || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
