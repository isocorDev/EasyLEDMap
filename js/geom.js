/* LED Mapper: geometry helpers (homography, similarity). */
(function (root) {
  'use strict';
  /** Solve A x = b for small dense systems (Gaussian elimination with pivoting). */
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  /** Homography mapping 4 source points to 4 destination points. Returns 9 numbers (row major). */
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return h ? h.concat([1]) : null;
  }
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  function invertH(H) {
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-14) return null;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
  }
  const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** Sheet transform: photo pixels -> world. flat (optional) rectifies, place moves/rotates/scales. */
  function sheetMatrix(sheet) {
    let H = IDENT;
    if (sheet.flat && sheet.flat.quad) {
      const { quad, w, h } = sheet.flat;
      H = homography(quad, [[0, 0], [w, 0], [w, h], [0, h]]) || IDENT;
    }
    const p = sheet.place || { x: 0, y: 0, rot: 0, scale: 1 };
    const s = p.scale || 1, cs = Math.cos(p.rot || 0) * s, sn = Math.sin(p.rot || 0) * s;
    const P = [cs, -sn, p.x || 0, sn, cs, p.y || 0, 0, 0, 1];
    return mul(P, H);
  }
  function mul(A, B) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return o;
  }
  const api = { solve, homography, applyH, invertH, sheetMatrix, mul, IDENT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LM = root.LM || {}; root.LM.geom = api;
})(typeof self !== 'undefined' ? self : globalThis);
