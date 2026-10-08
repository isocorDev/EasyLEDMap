/* EasyLEDMap: project model. Pure functions, no DOM. */
(function (root) {
  'use strict';
  const G = (typeof require !== 'undefined' && typeof module !== 'undefined') ? require('./geom.js') : root.LM.geom;

  /* mA is full-white draw per pixel. Editable in Setup; these only pre-fill the field. */
  const CHIPSETS = {
    WS2812B: { label: 'WS2812B', voltage: 5, ma: 55, order: 'GRB', fastled: 'WS2812B', wled: 'WS281x', white: false },
    WS2813: { label: 'WS2813', voltage: 5, ma: 55, order: 'GRB', fastled: 'WS2813', wled: 'WS281x', white: false },
    WS2815: { label: 'WS2815', voltage: 12, ma: 12, order: 'GRB', fastled: 'WS2815', wled: 'WS281x', white: false },
    WS2811: { label: 'WS2811 (12 V, 3 LEDs per pixel)', voltage: 12, ma: 30, order: 'RGB', fastled: 'WS2811', wled: 'WS281x', white: false },
    SK6812: { label: 'SK6812 RGB', voltage: 5, ma: 55, order: 'GRB', fastled: 'SK6812', wled: 'WS281x', white: false },
    SK6812W: { label: 'SK6812 RGBW', voltage: 5, ma: 80, order: 'GRB', fastled: 'SK6812', wled: 'SK6812 RGBW', white: true },
    OTHER: { label: 'Other', voltage: 5, ma: 60, order: 'GRB', fastled: 'WS2812B', wled: 'WS281x', white: false }
  };
  const STRIP_COLORS = ['#ff4fa3', '#19c3e6', '#ffb000', '#8ddc3c', '#b78cff', '#ff7847', '#34d6a8', '#f2e24b'];
  const GROUP_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#ffe119', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075'];
  const DEFAULT_PINS = [16, 4, 2, 12, 13, 14, 15, 17, 18, 19];

  let _id = 0;
  function uid(prefix) { _id++; return (prefix || 'i') + Date.now().toString(36).slice(-5) + _id.toString(36); }

  function newProject() {
    return {
      format: 'easyledmap', version: 1, name: 'Untitled map',
      setup: { chipset: 'WS2815', voltage: 12, maPerPixel: 12, colorOrder: 'GRB', ledsPerMeter: 60, psuAmps: 0 },
      sheets: [], strips: [], groups: [],
      exports: {
        wled: { order: 'wiring', coordType: 'uint8', origin: 'corner', yUp: false, keepAspect: true, grid: false, gridWidth: 0, includeDeadInBounds: false },
        fastled: { coordType: 'uint16', origin: 'corner', yUp: false, keepAspect: true, lo: 0, hi: 65535, grid: false, gridWidth: 0, includeDeadInBounds: false },
        td: { origin: 'center', yUp: true, keepAspect: true, lo: -1, hi: 1, universeSize: 170, stripsStartUniverse: true, firstUniverse: 0, includeDeadInBounds: false }
      }
    };
  }
  function newSheet(name, w, h, file) {
    return { id: uid('s'), name, file, w, h, pitch: 0, ledSize: 0, flat: null, place: { x: 0, y: 0, rot: 0, scale: 1 }, anchors: [] };
  }
  function newStrip(project) {
    const n = project.strips.length;
    return { id: uid('t'), name: 'Strip ' + (n + 1), pin: DEFAULT_PINS[n % DEFAULT_PINS.length], color: STRIP_COLORS[n % STRIP_COLORS.length], leds: [] };
  }
  function newLed(sheet, x, y, extra) { return Object.assign({ id: uid('l'), s: sheet, x, y, dead: false }, extra || {}); }
  function newGroup(project, name) {
    const n = project.groups.length;
    return { id: uid('g'), name: name || 'Group ' + (n + 1), color: GROUP_COLORS[n % GROUP_COLORS.length], leds: [] };
  }

  /** Flatten the project into wiring order with world coordinates and group membership. */
  function resolve(project) {
    const mats = {};
    for (const s of project.sheets) mats[s.id] = G.sheetMatrix(s);
    const groupOf = new Map();
    project.groups.forEach((g, gi) => { for (const id of g.leds) { if (!groupOf.has(id)) groupOf.set(id, []); groupOf.get(id).push(gi); } });
    const leds = [], strips = [];
    let index = 0;
    project.strips.forEach((st, si) => {
      const start = index; let live = 0;
      st.leds.forEach((l, k) => {
        const M = mats[l.s] || G.IDENT, p = G.applyH(M, l.x, l.y);
        if (!l.dead) live++;
        leds.push({ id: l.id, strip: si, stripIndex: k, index: index++, sheet: l.s, x: p[0], y: p[1], dead: !!l.dead, groups: groupOf.get(l.id) || [] });
      });
      strips.push({ id: st.id, name: st.name, pin: st.pin, color: st.color, start, count: st.leds.length, live });
    });
    return { leds, strips, total: index, live: leds.filter(l => !l.dead).length };
  }

  /**
   * Scale world coordinates into an output range.
   * opts: origin 'corner' | 'center', yUp, keepAspect, lo, hi, includeDeadInBounds.
   * Returns { u, v } (0..1, v already flipped for yUp) and { x, y } in [lo, hi], plus bounds.
   */
  function normalise(leds, opts) {
    const o = Object.assign({ origin: 'corner', yUp: false, keepAspect: true, lo: 0, hi: 1, includeDeadInBounds: false }, opts);
    let src = leds.filter(l => o.includeDeadInBounds || !l.dead);
    if (!src.length) src = leds;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of src) { if (l.x < minX) minX = l.x; if (l.x > maxX) maxX = l.x; if (l.y < minY) minY = l.y; if (l.y > maxY) maxY = l.y; }
    if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
    const W = Math.max(maxX - minX, 1e-9), H = Math.max(maxY - minY, 1e-9);
    const sx = o.keepAspect ? 1 / Math.max(W, H) : 1 / W, sy = o.keepAspect ? 1 / Math.max(W, H) : 1 / H;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const n = leds.length, u = new Float64Array(n), v = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const l = leds[i]; let a, b;
      if (o.origin === 'center') { a = 0.5 + (l.x - cx) * sx; b = 0.5 + (o.yUp ? -(l.y - cy) : (l.y - cy)) * sy; }
      else { a = (l.x - minX) * sx; b = (o.yUp ? (maxY - l.y) : (l.y - minY)) * sy; }
      u[i] = a; v[i] = b; x[i] = o.lo + a * (o.hi - o.lo); y[i] = o.lo + b * (o.hi - o.lo);
    }
    return { u, v, x, y, bounds: { minX, minY, maxX, maxY, W, H }, aspect: W / H };
  }

  const INT_TYPES = {
    uint8: { c: 'uint8_t', lo: 0, hi: 255 }, int8: { c: 'int8_t', lo: -128, hi: 127 },
    uint16: { c: 'uint16_t', lo: 0, hi: 65535 }, int16: { c: 'int16_t', lo: -32768, hi: 32767 },
    float: { c: 'float', lo: -1, hi: 1 }
  };
  function castValue(v, type) {
    if (type === 'float') return Math.round(v * 1e5) / 1e5;
    const t = INT_TYPES[type]; return Math.max(t.lo, Math.min(t.hi, Math.round(v)));
  }

  /** Power estimate. Worst case is every pixel at full white. */
  function power(project) {
    const r = resolve(project), s = project.setup, ma = +s.maPerPixel || 0, v = +s.voltage || 0;
    const per = r.strips.map(st => ({ name: st.name, pin: st.pin, count: st.count, live: st.live, ampsAll: st.count * ma / 1000, ampsLive: st.live * ma / 1000 }));
    const ampsAll = r.total * ma / 1000, ampsLive = r.live * ma / 1000;
    const injectEvery = v >= 12 ? 300 : (v >= 9 ? 200 : 100);
    return {
      total: r.total, live: r.live, ampsAll, ampsLive, wattsAll: ampsAll * v, wattsLive: ampsLive * v,
      psuAmps: ampsLive / 0.8, psuWatts: ampsLive * v / 0.8, wledLimitMa: Math.round((+s.psuAmps > 0 ? +s.psuAmps * 0.9 : ampsLive) * 1000),
      per, injectEvery, longRuns: per.filter(p => p.count > injectEvery)
    };
  }

  /** Each unbroken run of live LEDs in a strip becomes one group. Returns the new groups. */
  function groupsFromRuns(project, strip, prefix) {
    const out = []; let cur = null;
    for (const l of strip.leds) {
      if (l.dead) { cur = null; continue; }
      if (l.brk) cur = null;   // a marked pixel always starts a new group
      if (!cur) { cur = newGroup({ groups: project.groups.concat(out) }, (prefix || strip.name) + ' ' + (out.length + 1)); out.push(cur); }
      cur.leds.push(l.id);
    }
    return out;
  }

  function validate(p) {
    // 'led-mapper' was the format name before the tool was renamed. Those files still open.
    if (!p || (p.format !== 'easyledmap' && p.format !== 'led-mapper')) throw new Error('This file is not an EasyLEDMap project.');
    p.format = 'easyledmap';
    if (p.version > 1) throw new Error('This project was saved by a newer version of EasyLEDMap.');
    const d = newProject();
    p.setup = Object.assign(d.setup, p.setup || {});
    p.sheets = p.sheets || []; p.strips = p.strips || []; p.groups = p.groups || [];
    p.exports = p.exports || {};
    for (const k of Object.keys(d.exports)) p.exports[k] = Object.assign(d.exports[k], p.exports[k] || {});
    for (const s of p.sheets) { s.place = Object.assign({ x: 0, y: 0, rot: 0, scale: 1 }, s.place || {}); s.anchors = s.anchors || []; }
    return p;
  }

  const api = { CHIPSETS, STRIP_COLORS, GROUP_COLORS, INT_TYPES, uid, newProject, newSheet, newStrip, newLed, newGroup, resolve, normalise, castValue, power, groupsFromRuns, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LM = root.LM || {}; root.LM.model = api;
})(typeof self !== 'undefined' ? self : globalThis);
