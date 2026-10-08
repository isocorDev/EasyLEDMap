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
    return { w, h, V, S };
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

  /**
   * Find lit LEDs: bright blobs. Returns [{ x, y, area }], brightest first.
   * threshold 0 picks one automatically from the brightness histogram.
   */
  function detectLit(prep, opts) {
    const o = Object.assign({ threshold: 0, minArea: 2, maxArea: 0 }, opts);
    const { w, h, V } = prep, n = w * h;
    let thr = o.threshold;
    if (!thr) {
      const hist = new Uint32Array(256); for (let i = 0; i < n; i++) hist[V[i]]++;
      // Otsu split, then keep to the bright side so glow around an LED is not counted.
      let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
      let wB = 0, sB = 0, best = 0, cut = 200;
      for (let t = 0; t < 256; t++) {
        wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
        sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
        if (v > best) { best = v; cut = t; }
      }
      thr = Math.max(150, Math.min(250, Math.round(cut + (255 - cut) * 0.5)));
    }
    const seen = new Uint8Array(n), out = [], stack = new Int32Array(n > 4e6 ? 4e6 : n);
    const maxArea = o.maxArea || Math.max(400, n / 400);
    for (let i = 0; i < n; i++) {
      if (seen[i] || V[i] < thr) continue;
      let sp = 0, area = 0, sx = 0, sy = 0, sw = 0; stack[sp++] = i; seen[i] = 1;
      while (sp) {
        const j = stack[--sp], x = j % w, y = (j / w) | 0, wt = V[j] - thr + 1;
        area++; sx += x * wt; sy += y * wt; sw += wt;
        if (x > 0 && !seen[j - 1] && V[j - 1] >= thr && sp < stack.length) { seen[j - 1] = 1; stack[sp++] = j - 1; }
        if (x < w - 1 && !seen[j + 1] && V[j + 1] >= thr && sp < stack.length) { seen[j + 1] = 1; stack[sp++] = j + 1; }
        if (y > 0 && !seen[j - w] && V[j - w] >= thr && sp < stack.length) { seen[j - w] = 1; stack[sp++] = j - w; }
        if (y < h - 1 && !seen[j + w] && V[j + w] >= thr && sp < stack.length) { seen[j + w] = 1; stack[sp++] = j + w; }
      }
      if (area >= o.minArea && area <= maxArea) out.push({ x: sx / sw, y: sy / sw, area });
    }
    // Drop specks far smaller than the typical blob.
    if (out.length > 8) {
      const areas = out.map(b => b.area).sort((a, b) => a - b), med = areas[areas.length >> 1];
      return { threshold: thr, blobs: out.filter(b => b.area >= med * 0.15 && b.area <= med * 8) };
    }
    return { threshold: thr, blobs: out };
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

  const api = { prepare, bilinear, profiles, countAlong, countPoly, polyLength, polyAt, boxSmooth, detectLit, orderNearest, orderSerpentine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LM = root.LM || {}; root.LM.detect = Object.assign(root.LM.detect || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
