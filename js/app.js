/* LED Mapper: application. */
(function () {
  'use strict';
  const { model: M, detect: D, geom: G, zip: Z, exporters: X } = window.LM;
  const $ = id => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v; else if (k === 'checked') el.checked = !!v;
      else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
    return el;
  }

  /* ------------------------------------------------------------------ state */
  const S = {
    project: M.newProject(), images: new Map(), view: null, cams: {}, tool: 'select', activeStrip: null,
    sel: new Set(), lastSel: null, undo: [], redo: [], colorBy: 'strip', photoDim: 1, showLabels: true,
    path: null, calib: null, flatEdit: null, preview: null, layoutSel: null, exportTarget: 'wled', exportFile: 0,
    fileHandle: null, spaceDown: false, savedAt: 0
  };
  let index = new Map();
  window.LM.app = { S, get index() { return index; } };

  const curSheet = () => S.project.sheets.find(s => s.id === S.view) || null;
  const sheetById = id => S.project.sheets.find(s => s.id === id) || null;
  const stripById = id => S.project.strips.find(s => s.id === id) || null;
  function activeStrip(create) {
    let st = stripById(S.activeStrip);
    if (!st && S.project.strips.length) { st = S.project.strips[S.project.strips.length - 1]; S.activeStrip = st.id; }
    if (!st && create) { st = M.newStrip(S.project); S.project.strips.push(st); S.activeStrip = st.id; }
    return st;
  }
  function reindex() {
    index = new Map();
    S.project.strips.forEach(st => st.leds.forEach((l, k) => index.set(l.id, { strip: st, k, led: l })));
    for (const g of S.project.groups) g.leds = g.leds.filter(id => index.has(id));
    for (const id of [...S.sel]) if (!index.has(id)) S.sel.delete(id);
    if (S.lastSel && !index.has(S.lastSel)) S.lastSel = null;
  }
  function pushUndo() { S.undo.push(JSON.stringify(S.project)); if (S.undo.length > 120) S.undo.shift(); S.redo = []; }
  function changed() { reindex(); renderSide(); renderTabs(); draw(); autosaveSoon(); $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length; }
  function mutate(fn) { pushUndo(); fn(); changed(); }
  function restore(json) {
    S.project = M.validate(JSON.parse(json));
    if (S.view !== 'layout' && !sheetById(S.view)) S.view = S.project.sheets.length ? S.project.sheets[0].id : null;
    if (!stripById(S.activeStrip)) S.activeStrip = null;
    S.path = null; S.preview = null; S.calib = null; S.flatEdit = null;
    $('projectName').value = S.project.name; changed(); syncSetup();
  }
  function undo() {
    if (S.path && S.path.legs.length) return removeLeg();
    if (!S.undo.length) return; S.redo.push(JSON.stringify(S.project)); restore(S.undo.pop());
  }
  function redo() { if (!S.redo.length) return; S.undo.push(JSON.stringify(S.project)); restore(S.redo.pop()); }

  /* ----------------------------------------------------------- sheet spaces */
  // "Work space" is the flattened photo when a flatten is set, otherwise photo pixels.
  const flatCache = new Map();
  function flatH(sheet) {
    if (!sheet.flat) return null;
    const key = sheet.id + JSON.stringify(sheet.flat); let v = flatCache.get(key);
    if (!v) { const H = G.homography(sheet.flat.quad, [[0, 0], [sheet.flat.w, 0], [sheet.flat.w, sheet.flat.h], [0, sheet.flat.h]]); v = H ? { H, I: G.invertH(H) } : null; flatCache.set(key, v); }
    return v;
  }
  function toWork(sheet, x, y) { const f = flatH(sheet); return f ? G.applyH(f.H, x, y) : [x, y]; }
  function toImage(sheet, x, y) { const f = flatH(sheet); return f ? G.applyH(f.I, x, y) : [x, y]; }
  function pitchWork(sheet) {
    if (!sheet.calib) return 0;
    const a = toWork(sheet, sheet.calib.a[0], sheet.calib.a[1]), b = toWork(sheet, sheet.calib.b[0], sheet.calib.b[1]);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const pitchImage = sheet => sheet.calib ? Math.hypot(sheet.calib.b[0] - sheet.calib.a[0], sheet.calib.b[1] - sheet.calib.a[1]) : 0;
  const ledRatio = () => Math.max(0.18, Math.min(0.6, 5 * (+S.project.setup.ledsPerMeter || 60) / 1000));
  function prepFor(sheet) {
    const im = S.images.get(sheet.id); if (!im || !im.img) return null;
    if (!im.prep) {
      const c = document.createElement('canvas'); c.width = sheet.w; c.height = sheet.h;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im.img, 0, 0, sheet.w, sheet.h);
      im.prep = D.prepare(x.getImageData(0, 0, sheet.w, sheet.h).data, sheet.w, sheet.h);
    }
    return im.prep;
  }
  /** Count and place LEDs between two photo points that both sit on LEDs. */
  function legPoints(sheet, A, B, pitch, forceM) {
    const a = toWork(sheet, A[0], A[1]), b = toWork(sheet, B[0], B[1]), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let res = { intervals: Math.max(1, Math.round(L / pitch)), confidence: 0, period: pitch, weak: true };
    const prep = prepFor(sheet);
    if (prep && L > 1) {
      const f = flatH(sheet);
      res = D.countPoly(prep, [a, b], pitch * ledRatio(), pitch, 0.3, f ? (x, y) => G.applyH(f.I, x, y) : null);
    }
    const Mn = forceM || res.intervals, pts = [];
    for (let k = 1; k <= Mn; k++) pts.push(toImage(sheet, a[0] + (b[0] - a[0]) * k / Mn, a[1] + (b[1] - a[1]) * k / Mn));
    return { M: Mn, auto: res.intervals, pts, conf: res.confidence, weak: !!res.weak, period: L / Mn, length: L };
  }

  /**
   * Keep photos at one scale and laid out side by side in the Layout view.
   * Every photo shows the same kind of strip, so LED spacing is the common ruler: each photo is
   * scaled until its spacing matches the reference photo. Photos the user has scaled or moved
   * by hand are left alone.
   */
  function autoLayout() {
    const sheets = S.project.sheets; if (!sheets.length) return;
    const ref = sheets.find(x => x.flat && x.calib) || sheets.find(x => x.calib);
    if (ref) {
      const target = pitchWork(ref) * (ref.place.manual ? ref.place.scale : 1);
      for (const x of sheets) if (x.calib && !x.place.manual) { const pw = pitchWork(x); if (pw > 0) x.place.scale = target / pw; }
    }
    let cursor = null, gap = 0;
    for (const x of sheets) {
      const corners = () => { const Ms = G.sheetMatrix(x); return [[0, 0], [x.w, 0], [x.w, x.h], [0, x.h]].map(p => G.applyH(Ms, p[0], p[1])); };
      let c = corners(), minX = Math.min(...c.map(p => p[0])), maxX = Math.max(...c.map(p => p[0])), minY = Math.min(...c.map(p => p[1]));
      if (!x.place.moved) { if (cursor === null) cursor = minX; x.place.x += cursor - minX; x.place.y += 0 - minY; c = corners(); minX = Math.min(...c.map(p => p[0])); maxX = Math.max(...c.map(p => p[0])); }
      gap = Math.max(gap, (maxX - minX) * 0.06); cursor = Math.max(cursor === null ? maxX : cursor, maxX) + gap;
    }
    delete S.cams.layout;
  }

  /* ----------------------------------------------------------------- canvas */
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  let dpr = 1, cw = 0, ch = 0, drawQueued = false;
  function resize() {
    const r = canvas.getBoundingClientRect(), pw = cw, ph = ch; dpr = window.devicePixelRatio || 1; cw = r.width; ch = r.height;
    canvas.width = Math.max(1, Math.round(cw * dpr)); canvas.height = Math.max(1, Math.round(ch * dpr));
    // A big change in size (rotating a phone, docking a window) refits the view so nothing is stranded off screen.
    if (S.view && pw > 0 && (Math.abs(cw - pw) / pw > 0.3 || Math.abs(ch - ph) / Math.max(ph, 1) > 0.3)) fit(); else draw();
  }
  const cam = () => (S.cams[S.view] = S.cams[S.view] || { x: 0, y: 0, z: 1, fresh: true });
  const toScreen = (x, y) => { const c = cam(); return [(x - c.x) * c.z, (y - c.y) * c.z]; };
  const fromScreen = (sx, sy) => { const c = cam(); return [sx / c.z + c.x, sy / c.z + c.y]; };
  function viewBounds() {
    if (S.view === 'layout') {
      let b = null; const add = (x, y) => { b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y]; };
      for (const s of S.project.sheets) { const Ms = G.sheetMatrix(s); for (const [x, y] of [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]]) { const p = G.applyH(Ms, x, y); add(p[0], p[1]); } }
      return b || [0, 0, 100, 100];
    }
    const s = curSheet(); return s ? [0, 0, s.w, s.h] : [0, 0, 100, 100];
  }
  function fit() {
    const b = viewBounds(), c = cam(), w = Math.max(b[2] - b[0], 1e-6), hh = Math.max(b[3] - b[1], 1e-6), pad = 24;
    c.z = Math.max(1e-6, Math.min((cw - pad * 2) / w, (ch - pad * 2) / hh));
    c.x = b[0] - (cw / c.z - w) / 2; c.y = b[1] - (ch / c.z - hh) / 2; c.fresh = false; draw();
  }
  function zoomAt(sx, sy, f) { const c = cam(), [wx, wy] = fromScreen(sx, sy); c.z = Math.max(1e-4, Math.min(1e4, c.z * f)); c.x = wx - sx / c.z; c.y = wy - sy / c.z; draw(); }
  function draw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; paint(); }); }

  let groupOfLed = new Map();
  function ledColor(l, st) {
    if (S.colorBy === 'group') { const g = groupOfLed.get(l.id); return g ? g.color : '#9aa4a0'; }
    return st.color;
  }
  function paint() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
    if (!S.view) return;
    const c = cam(); if (c.fresh && cw > 0) { fit(); return; }
    groupOfLed = new Map(); for (const g of S.project.groups) for (const id of g.leds) if (!groupOfLed.has(id)) groupOfLed.set(id, g);
    const world = () => ctx.setTransform(c.z * dpr, 0, 0, c.z * dpr, -c.x * c.z * dpr, -c.y * c.z * dpr);
    const labels = [];
    if (S.view === 'layout') {
      for (const s of S.project.sheets) {
        const Ms = G.sheetMatrix(s), im = S.images.get(s.id);
        world();
        if (im && im.img && !s.flat && S.photoDim > 0) { ctx.save(); ctx.transform(Ms[0], Ms[3], Ms[1], Ms[4], Ms[2], Ms[5]); ctx.globalAlpha = S.photoDim * 0.85; ctx.drawImage(im.img, 0, 0, s.w, s.h); ctx.restore(); }
        const q = [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]].map(p => G.applyH(Ms, p[0], p[1]));
        ctx.beginPath(); q.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
        ctx.lineWidth = (s.id === S.layoutSel ? 2 : 1) / c.z; ctx.strokeStyle = s.id === S.layoutSel ? '#7fd6c4' : 'rgba(255,255,255,0.28)'; ctx.setLineDash(s.id === S.layoutSel ? [] : [6 / c.z, 5 / c.z]); ctx.stroke(); ctx.setLineDash([]);
        const tl = toScreen(q[0][0], q[0][1]); labels.push({ x: tl[0] + 4, y: tl[1] - 6, t: s.name, sheet: true });
      }
      const mats = {}; for (const s of S.project.sheets) mats[s.id] = { Ms: G.sheetMatrix(s), s };
      for (const st of S.project.strips) drawStrip(st, l => { const m = mats[l.s]; return m ? G.applyH(m.Ms, l.x, l.y) : null; }, l => { const m = mats[l.s]; if (!m) return 4; const p = G.applyH(m.Ms, l.x, l.y), q2 = G.applyH(m.Ms, l.x + 1, l.y); return (pitchImage(m.s) * 0.2 || Math.max(m.s.w, m.s.h) / 320) * Math.hypot(q2[0] - p[0], q2[1] - p[1]); }, labels, world);
    } else {
      const s = curSheet(), im = S.images.get(s.id);
      world();
      if (im && im.img) { ctx.globalAlpha = S.photoDim; ctx.imageSmoothingEnabled = c.z < 3; ctx.drawImage(im.img, 0, 0, s.w, s.h); ctx.globalAlpha = 1; }
      else { ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1 / c.z; ctx.strokeRect(0, 0, s.w, s.h); }
      const r0 = pitchImage(s) * 0.2 || Math.max(s.w, s.h) / 320;
      for (const st of S.project.strips) drawStrip(st, l => l.s === s.id ? [l.x, l.y] : null, () => r0, labels, world);
      if (S.flatEdit) drawFlat(s, world, c);
      if (s.flat && !S.flatEdit) { world(); ctx.beginPath(); s.flat.quad.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.strokeStyle = 'rgba(127,214,196,0.45)'; ctx.lineWidth = 1 / c.z; ctx.setLineDash([5 / c.z, 5 / c.z]); ctx.stroke(); ctx.setLineDash([]); }
      if (S.calib && S.calib.pts.length) { world(); for (const p of S.calib.pts) { ctx.beginPath(); ctx.arc(p[0], p[1], 7 / c.z, 0, 7); ctx.strokeStyle = '#ffd98a'; ctx.lineWidth = 2 / c.z; ctx.stroke(); } }
      if (S.preview) {
        world(); const pv = S.preview, col = pv.kind === 'turn' ? '#aab4af' : '#ffd98a';
        ctx.beginPath(); ctx.moveTo(pv.a[0], pv.a[1]); ctx.lineTo(pv.b[0], pv.b[1]); ctx.strokeStyle = col; ctx.lineWidth = 1.5 / c.z; ctx.setLineDash([4 / c.z, 4 / c.z]); ctx.stroke(); ctx.setLineDash([]);
        for (const p of pv.pts) { ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(r0, 3 / c.z), 0, 7); ctx.strokeStyle = col; ctx.lineWidth = 1.5 / c.z; ctx.stroke(); }
        const sp = toScreen(pv.b[0], pv.b[1]); labels.push({ x: sp[0] + 14, y: sp[1] - 12, t: (pv.kind === 'turn' ? Math.max(0, pv.M - 1) + ' dead in the turn' : pv.M + ' more') + (pv.weak ? ' ?' : ''), big: true });
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const taken = [];
    for (const lb of labels) {
      if (lb.x < -40 || lb.y < -20 || lb.x > cw + 40 || lb.y > ch + 20) continue;
      ctx.font = (lb.big ? '600 13px' : lb.sheet ? '600 12px' : '11px') + ' system-ui, sans-serif';
      const w = ctx.measureText(lb.t).width + 8, hh = lb.big ? 20 : 16, box = [lb.x, lb.y - hh / 2, lb.x + w, lb.y + hh / 2];
      if (!lb.force && !lb.big && taken.some(t => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      ctx.fillStyle = lb.big ? 'rgba(16,20,22,0.92)' : 'rgba(16,20,22,0.78)'; ctx.beginPath(); ctx.roundRect(box[0], box[1], w, hh, 4); ctx.fill();
      if (lb.c) { ctx.strokeStyle = lb.c; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = lb.big ? '#ffd98a' : '#f1f4f2'; ctx.fillText(lb.t, lb.x + 4, lb.y + 0.5);
    }
    if (S.marquee) { const m = S.marquee; ctx.strokeStyle = '#7fd6c4'; ctx.fillStyle = 'rgba(127,214,196,0.12)'; ctx.lineWidth = 1; const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1), w = Math.abs(m.x1 - m.x0), hh = Math.abs(m.y1 - m.y0); ctx.fillRect(x, y, w, hh); ctx.strokeRect(x + 0.5, y + 0.5, w, hh); }
  }
  function drawStrip(st, pos, rad, labels, world) {
    const c = cam(), pts = st.leds.map(pos); world();
    // wire
    ctx.beginPath(); let pen = false;
    for (let i = 0; i < pts.length; i++) { const p = pts[i]; if (!p) { pen = false; continue; } if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); pen = true; }
    ctx.strokeStyle = st.color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5 / c.z; ctx.stroke(); ctx.globalAlpha = 1;
    const minR = 3 / c.z, active = st.id === S.activeStrip;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; if (!p) continue; const l = st.leds[i], r = Math.max(rad(l), minR), selected = S.sel.has(l.id);
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.2832);
      if (l.dead) { ctx.fillStyle = 'rgba(20,24,26,0.7)'; ctx.fill(); ctx.strokeStyle = '#8b9590'; ctx.lineWidth = 1.2 / c.z; ctx.stroke(); ctx.beginPath(); ctx.moveTo(p[0] - r * 0.5, p[1] - r * 0.5); ctx.lineTo(p[0] + r * 0.5, p[1] + r * 0.5); ctx.moveTo(p[0] + r * 0.5, p[1] - r * 0.5); ctx.lineTo(p[0] - r * 0.5, p[1] + r * 0.5); ctx.stroke(); }
      else { ctx.fillStyle = ledColor(l, st); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1 / c.z; ctx.stroke(); }
      if (l.check && !selected) { ctx.beginPath(); ctx.arc(p[0], p[1], r + 2.5 / c.z, 0, 6.2832); ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 1.5 / c.z; ctx.setLineDash([3 / c.z, 2 / c.z]); ctx.stroke(); ctx.setLineDash([]); }
      if (selected) { ctx.beginPath(); ctx.arc(p[0], p[1], r + 2 / c.z, 0, 6.2832); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 / c.z; ctx.stroke(); }
      if (i === 0) { ctx.beginPath(); ctx.arc(p[0], p[1], r + 5 / c.z, 0, 6.2832); ctx.strokeStyle = st.color; ctx.lineWidth = 2 / c.z; ctx.stroke(); }
    }
    if (!S.showLabels) return;
    const step = c.z * (pts.length > 1 ? avgGap(pts) : 20);
    const every = step > 26 ? 1 : step > 13 ? 2 : step > 6 ? 5 : step > 2.6 ? 10 : step > 1 ? 25 : 50;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; if (!p) continue; const l = st.leds[i], prev = st.leds[i - 1], next = st.leds[i + 1];
      const edge = i === 0 || i === pts.length - 1 || (!l.dead && ((prev && prev.dead) || (next && next.dead) || l.brk || (next && next.brk)));
      if (!edge && i % every) continue;
      const sp = toScreen(p[0], p[1]), r = Math.max(rad(l), 3 / c.z) * c.z;
      labels.push({ x: sp[0] + r + 3, y: sp[1] - r - 3, t: i === 0 ? st.name + ', 0' : String(i), c: active ? st.color : null, force: i === 0 });
    }
  }
  function avgGap(pts) { let s = 0, n = 0; for (let i = 1; i < pts.length && n < 40; i++) if (pts[i] && pts[i - 1]) { s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); n++; } return n ? s / n : 20; }
  function drawFlat(s, world, c) {
    world(); const q = S.flatEdit.quad;
    ctx.beginPath(); q.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    ctx.fillStyle = 'rgba(127,214,196,0.10)'; ctx.fill(); ctx.strokeStyle = '#7fd6c4'; ctx.lineWidth = 2 / c.z; ctx.stroke();
    q.forEach((p, i) => { ctx.beginPath(); ctx.arc(p[0], p[1], 8 / c.z, 0, 7); ctx.fillStyle = '#101416'; ctx.fill(); ctx.strokeStyle = '#7fd6c4'; ctx.stroke(); ctx.fillStyle = '#7fd6c4'; ctx.font = `${11 / c.z}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), p[0], p[1]); ctx.textAlign = 'start'; });
  }

  /* ------------------------------------------------------------ hit testing */
  function ledAt(sx, sy) {
    const s = curSheet(); if (!s) return null; const c = cam();
    let best = null, bd = Math.max(9, (pitchImage(s) * 0.3 || 6) * c.z) ** 2;
    for (const st of S.project.strips) for (const l of st.leds) { if (l.s !== s.id) continue; const p = toScreen(l.x, l.y), d = (p[0] - sx) ** 2 + (p[1] - sy) ** 2; if (d < bd) { bd = d; best = l; } }
    return best;
  }
  function sheetAtLayout(wx, wy) {
    for (let i = S.project.sheets.length - 1; i >= 0; i--) {
      const s = S.project.sheets[i], I = G.invertH(G.sheetMatrix(s)); if (!I) continue; const p = G.applyH(I, wx, wy);
      if (p[0] >= 0 && p[1] >= 0 && p[0] <= s.w && p[1] <= s.h) return s;
    }
    return null;
  }

  /* -------------------------------------------------------------- path tool */
  function setTool(t) {
    if (S.path && t !== 'path') finishPath();
    S.tool = t; S.calib = null; S.preview = null;
    if (t === 'path' && S.view === 'layout') { S.tool = 'select'; toast('Open a photo tab to draw a path.'); }
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
    if (S.tool === 'path') { const s = curSheet(); if (s && !s.calib) S.calib = { pts: [] }; }
    updateHint(); draw(); renderPathBar();
  }
  function beginCalib() { S.calib = { pts: [] }; S.tool = 'path'; document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === 'path')); updateHint(); draw(); }
  function pathClick(x, y, single) {
    const s = curSheet(); if (!s) return;
    if (S.calib) {
      S.calib.pts.push([x, y]);
      if (S.calib.pts.length === 2) {
        const [a, b] = S.calib.pts;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) { S.calib.pts.pop(); toast('Those two clicks are on the same spot. Click the LED next to it.'); }
        else { mutate(() => { s.calib = { a, b }; autoLayout(); }); S.calib = null; }
      }
      updateHint(); draw(); return;
    }
    if (!S.path) {
      const st = activeStrip(true), last = st.leds[st.leds.length - 1];
      const prev = st.leds[st.leds.length - 2];
      // Continuing a strip: if it ends partway along a row, the next leg is the turn.
      S.path = { strip: st.id, sheet: s.id, legs: [], pitch: pitchWork(s), next: last && prev && !last.dead && !prev.dead && !last.brk ? 'turn' : 'row' };
      if (last && last.s === s.id) { addLeg(x, y); }
      else { mutate(() => { st.leds.push(M.newLed(s.id, x, y, st.leds.length ? { brk: true } : null)); }); }
      updateHint(); renderPathBar(); return;
    }
    if (single) addSingle(x, y); else addLeg(x, y);
  }
  /** Shift-click: place exactly one LED here, with no counting. Inside a turn it is a dead pixel. */
  function addSingle(x, y) {
    const s = curSheet(), st = stripById(S.path.strip), a = pathAnchor(); if (!a || !s) return;
    const inTurn = $('optRowsTurns').checked && S.path.next === 'turn';
    pushUndo();
    const led = M.newLed(s.id, x, y, { dead: inTurn });
    st.leds.push(led); S.path.legs.push({ kind: inTurn ? 'turn' : 'row', single: true, a: [a.x, a.y], b: [x, y], M: 1, auto: 1, ids: [led.id], prevPitch: S.path.pitch });
    S.preview = null; changed(); renderPathBar(); updateHint();
  }
  const pathAnchor = () => { const st = S.path && stripById(S.path.strip); return st ? st.leds[st.leds.length - 1] : null; };
  function makeLegLeds(sheet, leg, lp) {
    return lp.pts.map((p, k) => M.newLed(sheet.id, p[0], p[1], { dead: leg.kind === 'turn' && k < lp.M - 1, brk: leg.kind === 'turn' && k === lp.M - 1 ? true : undefined, check: (lp.weak || lp.conf < 0.3) && leg.kind === 'row' ? true : undefined }));
  }
  function addLeg(x, y, forceKind) {
    const s = curSheet(), st = stripById(S.path.strip), a = pathAnchor(); if (!a || !s) return;
    if (Math.hypot(x - a.x, y - a.y) < Math.max(2, pitchImage(s) * 0.35)) return;
    const kind = forceKind || ($('optRowsTurns').checked ? S.path.next : 'row');
    const lp = legPoints(s, [a.x, a.y], [x, y], S.path.pitch || pitchWork(s));
    const leg = { kind, a: [a.x, a.y], b: [x, y], M: lp.M, auto: lp.auto, conf: lp.conf, weak: lp.weak, prevPitch: S.path.pitch };
    pushUndo();
    const leds = makeLegLeds(s, leg, lp); leg.ids = leds.map(l => l.id); st.leds.push(...leds);
    if (kind === 'row' && !lp.weak && lp.conf >= 0.3 && lp.M >= 4) S.path.pitch = lp.period;
    S.path.legs.push(leg); S.path.next = kind === 'row' ? 'turn' : 'row'; S.preview = null;
    changed(); renderPathBar(); updateHint();
  }
  function regenLeg(newM, newKind) {
    const leg = S.path && S.path.legs[S.path.legs.length - 1]; if (!leg) return;
    if (leg.single) { toast('That LED was placed by hand. Use Remove leg to take it out.'); return; }
    const s = sheetById(S.path.sheet), st = stripById(S.path.strip);
    if (newKind) leg.kind = newKind;
    const m = Math.max(1, newM || leg.M), lp = legPoints(s, leg.a, leg.b, leg.prevPitch || pitchWork(s), m);
    lp.weak = false; lp.conf = 1;
    st.leds.splice(st.leds.length - leg.ids.length, leg.ids.length);
    const leds = makeLegLeds(s, leg, lp); leg.ids = leds.map(l => l.id); leg.M = m; st.leds.push(...leds);
    if (leg.kind === 'row' && m >= 4) S.path.pitch = lp.period;
    S.path.next = leg.kind === 'row' ? 'turn' : 'row';
    changed(); renderPathBar(); updateHint();
  }
  function removeLeg() {
    if (!S.path) return;
    if (!S.path.legs.length) { cancelPathStart(); return; }
    const leg = S.path.legs.pop(), keep = S.path;
    if (S.undo.length) { const json = S.undo.pop(); S.project = M.validate(JSON.parse(json)); }
    S.path = keep; S.path.pitch = leg.prevPitch; if (!leg.single) S.path.next = leg.kind; S.preview = null;
    changed(); renderPathBar(); updateHint();
  }
  function cancelPathStart() { S.path = null; S.preview = null; renderPathBar(); updateHint(); draw(); }
  function finishPath() {
    if (!S.path) return; const p = S.path; S.path = null; S.preview = null;
    const st = stripById(p.strip);
    if (st && p.legs.length && $('optGroupRows').checked && $('optRowsTurns').checked) { regroupStrip(st, false); }
    changed(); renderPathBar(); updateHint();
  }
  /** Rebuild the automatic groups of one strip from its runs of live pixels. */
  function regroupStrip(st, withUndo) {
    const run = () => {
      const mine = new Set(st.leds.map(l => l.id));
      S.project.groups = S.project.groups.filter(g => g.auto !== st.id);
      const taken = new Set(); for (const g of S.project.groups) for (const id of g.leds) if (mine.has(id)) taken.add(id);
      const fresh = M.groupsFromRuns(S.project, st, st.name).filter(g => !g.leds.every(id => taken.has(id)));
      fresh.forEach((g, i) => { g.auto = st.id; g.name = `${st.name} row ${i + 1}`; });
      S.project.groups.push(...fresh);
    };
    if (withUndo) mutate(run); else run();
  }
  function renderPathBar() {
    const on = S.tool === 'path' && S.view !== 'layout' && !!S.view; $('pathOpts').hidden = !on; if (!on) return;
    const leg = S.path && S.path.legs[S.path.legs.length - 1], has = !!leg;
    for (const id of ['btnLegMinus', 'btnLegPlus', 'btnLegType', 'btnLegJump', 'btnLegUndo']) $(id).disabled = !has;
    $('btnPathDone').disabled = !S.path;
    $('legInfo').textContent = has ? leg.single ? (leg.kind === 'turn' ? 'One dead LED placed' : 'One LED placed') : (leg.kind === 'turn' ? (leg.M === 1 ? 'Jump: no LEDs between' : `Turn: ${Math.max(0, leg.M - 1)} dead`) : `Row: ${leg.M} added`) + (leg.M !== leg.auto ? ` (tool counted ${leg.auto})` : '') : '';
  }

  /* ------------------------------------------------------------- selection */
  function selRuns() {
    // Returns [{ strip, from, to }] for the selection, per strip, as index ranges if contiguous.
    const by = new Map();
    for (const id of S.sel) { const e = index.get(id); if (!e) continue; if (!by.has(e.strip)) by.set(e.strip, []); by.get(e.strip).push(e.k); }
    const out = [];
    for (const [strip, ks] of by) { ks.sort((a, b) => a - b); out.push({ strip, ks, from: ks[0], to: ks[ks.length - 1], contiguous: ks[ks.length - 1] - ks[0] === ks.length - 1 }); }
    return out;
  }
  function selectRunAround(l) {
    const e = index.get(l.id); if (!e) return; const leds = e.strip.leds; let a = e.k, b = e.k;
    while (a > 0 && leds[a - 1].dead === l.dead && !leds[a].brk) a--;
    while (b < leds.length - 1 && leds[b + 1].dead === l.dead && !leds[b + 1].brk) b++;
    S.sel = new Set(leds.slice(a, b + 1).map(x => x.id)); S.lastSel = l.id; S.activeStrip = e.strip.id;
  }
  function setDead(v) { if (!S.sel.size) return; mutate(() => { for (const id of S.sel) { const e = index.get(id); if (e) { e.led.dead = v; delete e.led.check; } } }); }
  function toggleDead() { if (!S.sel.size) return; const anyLive = [...S.sel].some(id => { const e = index.get(id); return e && !e.led.dead; }); setDead(anyLive); }
  function deleteSel() { if (!S.sel.size) return; mutate(() => { for (const st of S.project.strips) st.leds = st.leds.filter(l => !S.sel.has(l.id)); S.sel.clear(); }); }
  function nudge(dx, dy) { if (!S.sel.size) return; mutate(() => { for (const id of S.sel) { const e = index.get(id); if (e) { e.led.x += dx; e.led.y += dy; } } }); }
  /** Replace the selected run with `count` evenly spaced LEDs between its two ends. */
  function respace(count) {
    const runs = selRuns(); if (runs.length !== 1 || !runs[0].contiguous || runs[0].ks.length < 2) { toast('Select one unbroken run of at least two LEDs first.'); return; }
    const { strip, from, to } = runs[0], old = strip.leds.slice(from, to + 1), n = Math.max(2, Math.round(count || old.length));
    const a = old[0], b = old[old.length - 1]; if (a.s !== b.s) { toast('That run crosses two photos.'); return; }
    const sh = sheetById(a.s), wa = toWork(sh, a.x, a.y), wb = toWork(sh, b.x, b.y);
    mutate(() => {
      const fresh = [];
      for (let j = 0; j < n; j++) {
        const src = old[Math.round(j * (old.length - 1) / (n - 1))], t = j / (n - 1), p = toImage(sh, wa[0] + (wb[0] - wa[0]) * t, wa[1] + (wb[1] - wa[1]) * t);
        const keepId = j === 0 ? a.id : j === n - 1 ? b.id : null;
        const led = M.newLed(sh.id, p[0], p[1], { dead: src.dead, brk: j === 0 ? a.brk : undefined }); if (keepId) led.id = keepId;
        if (!keepId) for (const g of S.project.groups) if (g.leds.includes(src.id)) g.leds.push(led.id);
        fresh.push(led);
      }
      strip.leds.splice(from, old.length, ...fresh); S.sel = new Set(fresh.map(l => l.id));
    });
  }
  function groupFromSel() {
    if (!S.sel.size) return;
    mutate(() => { const g = M.newGroup(S.project); const ids = [...S.sel].filter(id => index.has(id)).sort((x, y) => { const a = index.get(x), b = index.get(y); return S.project.strips.indexOf(a.strip) - S.project.strips.indexOf(b.strip) || a.k - b.k; }); g.leds = ids; S.project.groups.push(g); });
    S.colorBy = 'group'; $('colorBy').value = 'group'; draw();
  }
  function reorderFrom(led, mode) {
    const e = index.get(led.id); if (!e) return; const st = e.strip;
    if (new Set(st.leds.map(l => l.s)).size > 1) { toast('This strip spans more than one photo, so it cannot be reordered automatically.'); return; }
    mutate(() => { const sh = sheetById(led.s), pts = st.leds.map(l => { const w = toWork(sh, l.x, l.y); return { x: w[0], y: w[1] }; }); const order = (mode === 'serp' ? D.orderSerpentine : D.orderNearest)(pts, e.k); st.leds = order.map(i => st.leds[i]); });
  }

  /* --------------------------------------------------------------- pointers */
  const ptrs = new Map(); let drag = null, pinch = null;
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => {
    canvas.focus({ preventScroll: true }); const [sx, sy] = local(e); ptrs.set(e.pointerId, [sx, sy]);
    if (!S.view) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }; drag = null; S.marquee = null; return; }
    const c = cam(), [wx, wy] = fromScreen(sx, sy);
    if (e.button === 1 || e.button === 2 || S.spaceDown || S.tool === 'pan') { drag = { type: 'pan', sx, sy, cx: c.x, cy: c.y }; return; }
    if (S.view === 'layout') { const s = sheetAtLayout(wx, wy); S.layoutSel = s ? s.id : null; renderSide(); draw(); drag = s ? { type: 'sheet', s, sx, sy, px: s.place.x, py: s.place.y, moved: false } : { type: 'pan', sx, sy, cx: c.x, cy: c.y }; return; }
    if (S.flatEdit) { const qi = S.flatEdit.quad.findIndex(p => { const sp = toScreen(p[0], p[1]); return Math.hypot(sp[0] - sx, sp[1] - sy) < 16; }); if (qi >= 0) { drag = { type: 'flat', qi }; return; } }
    if (S.tool === 'path') { drag = { type: 'click', sx, sy, wx, wy, shift: e.shiftKey }; return; }
    if (S.tool === 'add') { addLedAt(wx, wy); return; }
    const l = ledAt(sx, sy);
    if (l) {
      const e2 = index.get(l.id);
      if (e.shiftKey && S.lastSel && index.get(S.lastSel) && index.get(S.lastSel).strip === e2.strip) { const k0 = index.get(S.lastSel).k, a = Math.min(k0, e2.k), b = Math.max(k0, e2.k); for (let k = a; k <= b; k++) S.sel.add(e2.strip.leds[k].id); }
      else if (e.ctrlKey || e.metaKey) { if (S.sel.has(l.id)) S.sel.delete(l.id); else S.sel.add(l.id); S.lastSel = l.id; }
      else { if (!S.sel.has(l.id)) S.sel = new Set([l.id]); S.lastSel = l.id; }
      S.activeStrip = e2.strip.id; drag = { type: 'move', sx, sy, wx, wy, moved: false, orig: null };
      renderSide(); draw();
    } else { if (!e.shiftKey) S.sel.clear(); drag = { type: 'marquee', add: e.shiftKey ? new Set(S.sel) : new Set() }; S.marquee = { x0: sx, y0: sy, x1: sx, y1: sy }; renderSide(); draw(); }
  });
  canvas.addEventListener('pointermove', e => {
    const [sx, sy] = local(e); if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [sx, sy]);
    if (!S.view) return; const c = cam();
    if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2; c.x -= (cx - pinch.cx) / c.z; c.y -= (cy - pinch.cy) / c.z; zoomAt(cx, cy, d / (pinch.d || d)); pinch = { d, cx, cy }; return; }
    const [wx, wy] = fromScreen(sx, sy);
    if (!drag) {
      if (S.tool === 'path' && S.path && !S.calib && S.view !== 'layout') { const a = pathAnchor(), s = curSheet(); if (a && a.s === s.id && Math.hypot(wx - a.x, wy - a.y) > pitchImage(s) * 0.5) { const kind = $('optRowsTurns').checked ? S.path.next : 'row', lp = legPoints(s, [a.x, a.y], [wx, wy], S.path.pitch || pitchWork(s)); S.preview = { a: [a.x, a.y], b: [wx, wy], pts: lp.pts, M: lp.M, kind, weak: lp.weak || lp.conf < 0.3 }; } else S.preview = null; draw(); }
      return;
    }
    if (drag.type === 'pan') { c.x = drag.cx - (sx - drag.sx) / c.z; c.y = drag.cy - (sy - drag.sy) / c.z; draw(); }
    else if (drag.type === 'click') { if (Math.hypot(sx - drag.sx, sy - drag.sy) > 6) { drag = { type: 'pan', sx: drag.sx, sy: drag.sy, cx: c.x, cy: c.y }; S.preview = null; } }
    else if (drag.type === 'sheet') { if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) > 3) { pushUndo(); drag.moved = true; drag.s.place.moved = true; } if (drag.moved) { drag.s.place.x = drag.px + (sx - drag.sx) / c.z; drag.s.place.y = drag.py + (sy - drag.sy) / c.z; draw(); } }
    else if (drag.type === 'flat') { S.flatEdit.quad[drag.qi] = [wx, wy]; draw(); }
    else if (drag.type === 'move') {
      if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) > 3) { pushUndo(); drag.moved = true; drag.orig = [...S.sel].map(id => { const en = index.get(id); return en ? [en.led, en.led.x, en.led.y] : null; }).filter(Boolean); }
      if (drag.moved) { const dx = wx - drag.wx, dy = wy - drag.wy; for (const [l, x, y] of drag.orig) { l.x = x + dx; l.y = y + dy; delete l.check; } draw(); }
    } else if (drag.type === 'marquee') {
      S.marquee.x1 = sx; S.marquee.y1 = sy; const s = curSheet(), m = S.marquee, x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      S.sel = new Set(drag.add); for (const st of S.project.strips) for (const l of st.leds) { if (l.s !== s.id) continue; const p = toScreen(l.x, l.y); if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) S.sel.add(l.id); }
      draw();
    }
  });
  function endPointer(e) {
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    const d = drag; drag = null; if (!d) return;
    if (d.type === 'click') pathClick(d.wx, d.wy, d.shift);
    else if (d.type === 'move' && d.moved) changed();
    else if (d.type === 'sheet' && d.moved) changed();
    else if (d.type === 'marquee') { S.marquee = null; renderSide(); draw(); }
  }
  canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('dblclick', e => {
    if (S.tool === 'path' && S.path) { finishPath(); return; }
    if (S.tool !== 'select' || S.view === 'layout') return; const [sx, sy] = local(e), l = ledAt(sx, sy); if (l) { selectRunAround(l); renderSide(); draw(); }
  });
  canvas.addEventListener('wheel', e => {
    if (!S.view) return; e.preventDefault(); const [sx, sy] = local(e), c = cam();
    const mouseWheel = !e.ctrlKey && e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
    if (e.ctrlKey || mouseWheel || e.deltaMode === 1) zoomAt(sx, sy, Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * (e.ctrlKey ? 0.01 : 0.0015)));
    else { c.x += e.deltaX / c.z; c.y += e.deltaY / c.z; draw(); }
  }, { passive: false });
  function addLedAt(x, y) {
    const s = curSheet(); if (!s) return;
    // Insert between two neighbours when the click lands on the wire between them.
    let best = null, bd = Infinity;
    for (const st of S.project.strips) for (let i = 1; i < st.leds.length; i++) {
      const a = st.leds[i - 1], b = st.leds[i]; if (a.s !== s.id || b.s !== s.id) continue;
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, t = ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (L * L);
      if (t <= 0.15 || t >= 0.85) continue; const d = Math.hypot(a.x + (b.x - a.x) * t - x, a.y + (b.y - a.y) * t - y);
      if (d < L * 0.35 && d < bd) { bd = d; best = { st, i, dead: a.dead && b.dead }; }
    }
    mutate(() => {
      if (best) { const led = M.newLed(s.id, x, y, { dead: best.dead }); best.st.leds.splice(best.i, 0, led); S.activeStrip = best.st.id; S.sel = new Set([led.id]); S.lastSel = led.id; for (const g of S.project.groups) { const a = g.leds.indexOf(best.st.leds[best.i - 1].id), b = g.leds.includes(best.st.leds[best.i + 1].id); if (a >= 0 && b) g.leds.splice(a + 1, 0, led.id); } }
      else { const st = activeStrip(true), led = M.newLed(s.id, x, y); st.leds.push(led); S.sel = new Set([led.id]); S.lastSel = led.id; }
    });
  }

  /* --------------------------------------------------------------- keyboard */
  const typing = e => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
  window.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key;
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (typing(e)) { if (k === 'Enter' || k === 'Escape') e.target.blur(); return; }
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); const st = activeStrip(false); if (st) { S.sel = new Set(st.leds.filter(l => S.view === 'layout' || l.s === S.view).map(l => l.id)); renderSide(); draw(); } return; }
    if (mod) return;
    if (k === ' ') { S.spaceDown = true; e.preventDefault(); canvas.style.cursor = 'grab'; return; }
    const kl = k.toLowerCase();
    if (S.path || S.calib) {
      if (k === 'Enter') { finishPath(); return; }
      if (k === 'Escape') { if (S.calib && curSheet() && curSheet().calib) { S.calib = null; updateHint(); draw(); } else if (S.path) finishPath(); else setTool('select'); return; }
      if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); if (S.calib && S.calib.pts.length) { S.calib.pts.pop(); draw(); updateHint(); } else removeLeg(); return; }
      if (k === '[') { const leg = S.path && S.path.legs[S.path.legs.length - 1]; if (leg) regenLeg(leg.M - 1); return; }
      if (k === ']') { const leg = S.path && S.path.legs[S.path.legs.length - 1]; if (leg) regenLeg(leg.M + 1); return; }
      if (kl === 'j') { if (S.path && S.path.legs.length) regenLeg(1, 'turn'); return; }
      if (kl === 't') { const leg = S.path && S.path.legs[S.path.legs.length - 1]; if (leg) regenLeg(leg.M, leg.kind === 'row' ? 'turn' : 'row'); return; }
    }
    if (kl === 'v') setTool('select'); else if (kl === 'p') setTool('path'); else if (kl === 'a') setTool('add'); else if (kl === 'h') setTool('pan');
    else if (kl === 'f') fit(); else if (k === '+' || k === '=') zoomAt(cw / 2, ch / 2, 1.3); else if (k === '-' || k === '_') zoomAt(cw / 2, ch / 2, 1 / 1.3);
    else if (k === 'Escape') { if (S.flatEdit) { S.flatEdit = null; renderSide(); } S.sel.clear(); renderSide(); draw(); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteSel(); }
    else if (kl === 'd') toggleDead(); else if (kl === 'g') groupFromSel();
    else if (k === '[' || k === ']') { const r = selRuns(); if (r.length === 1 && r[0].contiguous && r[0].ks.length >= 2) respace(r[0].ks.length + (k === ']' ? 1 : -1)); }
    else if (k.startsWith('Arrow') && S.sel.size && S.view !== 'layout') { e.preventDefault(); const st = (e.shiftKey ? 5 : 1) / cam().z * (e.altKey ? 0.25 : 1); nudge(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, k === 'ArrowUp' ? -st : k === 'ArrowDown' ? st : 0); }
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') { S.spaceDown = false; canvas.style.cursor = ''; } });

  /* ------------------------------------------------------------------ hints */
  function updateHint() {
    let t = '';
    const s = curSheet(), k = x => `<kbd>${x}</kbd>`;
    if (!S.view) t = '';
    else if (S.view === 'layout') t = 'Drag a photo to place it in the final assembly. Fine tune position, rotation and scale in the panel.';
    else if (S.flatEdit) t = 'Drag handles 1 to 4 onto the corners of a flat rectangle, clockwise from its top left. Then enter its size and apply.';
    else if (S.tool === 'path') {
      if (S.calib) t = S.calib.pts.length ? 'Now click the LED right next to it.' : 'First, click one LED so the tool can learn the spacing. Zoom in for accuracy.';
      else if (!S.path) { const st = activeStrip(false), last = st && st.leds[st.leds.length - 1]; t = last && last.s === s.id ? `Click the next corner to continue ${esc(st.name)} from pixel ${st.leds.length - 1}. To start a separate strip, add one in the Strips panel.` : 'Click the first LED of the strip, where the data enters.'; }
      else if (!S.path.legs.length) t = 'Click the last LED of this straight run. The tool counts the LEDs in between.';
      else if ($('optRowsTurns').checked) t = (S.path.next === 'turn' ? `Click the first LED of the next row. The tool estimates the dead LEDs in the turn: check the count. On a curved turn, ${k('Shift')}-click each LED in it.` : 'Click the last LED of this row.') + ` Wrong count? ${k('[')} ${k(']')}. ${k('Backspace')} steps back, ${k('Enter')} finishes.`;
      else t = `Click the next corner. ${k('Shift')}-click places one LED exactly. ${k('[')} ${k(']')} fix the count, ${k('Backspace')} steps back, ${k('Enter')} finishes.`;
    } else if (S.tool === 'add') t = 'Click to add an LED to the end of the active strip. Click on the wire between two LEDs to insert one there.';
    else if (S.tool === 'pan') t = 'Drag to pan. Scroll or pinch to zoom.';
    else if (!S.project.strips.some(st => st.leds.length)) t = `Choose ${k('Draw path')} and trace the strip from the first LED.`;
    else if (S.sel.size) t = `${k('D')} dead or live, ${k('G')} group, ${k('[')} ${k(']')} one fewer or one more in the run, ${k('Delete')} removes, arrows nudge.`;
    else t = 'Click an LED, drag a box, or double-click to select a whole run. Shift-click selects a range along the wire.';
    $('hint').innerHTML = t ? `<span>${t}</span>` : '';
  }
  const esc = s => String(s).replace(/[&<>"]/g, ch2 => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch2]));
  let toastTimer = 0;
  function toast(msg, action, fn) {
    const t = $('toast'); t.textContent = msg; if (action) t.append(h('button', { text: action, onclick: () => { t.classList.remove('show'); fn(); } }));
    t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), action ? 9000 : 4200);
  }

  /* ------------------------------------------------------------------- tabs */
  function renderTabs() {
    const el = $('tabs'); el.textContent = '';
    $('empty').hidden = S.project.sheets.length > 0; $('viewOpts').hidden = !S.project.sheets.length;
    for (const s of S.project.sheets) {
      const n = S.project.strips.reduce((a, st) => a + st.leds.filter(l => l.s === s.id).length, 0);
      const tab = h('button', { class: 'tab' + (S.view === s.id ? ' on' : ''), role: 'tab', title: 'Double-click to rename', onclick: () => setView(s.id), ondblclick: () => renameTab(tab, s) }, h('span', { text: s.name }), n ? h('span', { class: 'n', text: String(n) }) : null);
      el.append(tab);
    }
    el.append(h('button', { class: 'tab add', text: '+ Add photos', onclick: () => $('fileImages').click() }));
    if (S.project.sheets.length) el.append(h('button', { class: 'tab layout' + (S.view === 'layout' ? ' on' : ''), text: 'Layout', title: 'Arrange the photos into the final assembly', onclick: () => setView('layout') }));
  }
  function renameTab(tab, s) {
    const inp = h('input', { value: s.name, 'aria-label': 'Photo name' }); tab.textContent = ''; tab.append(inp); inp.focus(); inp.select();
    const done = () => { const v = inp.value.trim(); if (v && v !== s.name) mutate(() => { s.name = v; }); else renderTabs(); };
    inp.addEventListener('blur', done); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = s.name; inp.blur(); } e.stopPropagation(); });
  }
  function setView(v) { if (S.path) finishPath(); S.view = v; S.calib = null; S.preview = null; S.flatEdit = null; if (S.tool === 'path') { if (v === 'layout') setTool('select'); else { const s = curSheet(); if (s && !s.calib) S.calib = { pts: [] }; } } renderTabs(); renderSide(); renderPathBar(); updateHint(); draw(); }

  /* ---------------------------------------------------------------- sidebar */
  function syncSetup() {
    const s = S.project.setup; $('fChipset').value = s.chipset; $('fVoltage').value = s.voltage; $('fMa').value = s.maPerPixel; $('fOrder').value = s.colorOrder; $('fLpm').value = s.ledsPerMeter; $('fPsu').value = s.psuAmps || '';
    renderPower();
  }
  function renderPower() {
    const P = M.power(S.project), s = S.project.setup, box = $('powerBox'); box.textContent = '';
    if (!P.total) { box.append(h('span', { class: 'fine', text: 'Power estimates appear here once LEDs are mapped.' })); return; }
    box.append(h('span', null, h('b', { text: `${P.live} mapped` }), ` of ${P.total} LEDs` + (P.total - P.live ? ` (${P.total - P.live} dead)` : '')));
    box.append(h('span', null, 'Full white: ', h('b', { text: `${P.ampsLive.toFixed(1)} A` }), `, ${P.wattsLive.toFixed(0)} W at ${s.voltage} V`));
    if (+s.psuAmps > 0) { const ok = +s.psuAmps >= P.ampsLive; box.append(h('span', null, ok ? `Your ${s.psuAmps} A supply covers full white.` : `Your ${s.psuAmps} A supply is under full white draw. Limit WLED to ${P.wledLimitMa} mA.`)); }
    else box.append(h('span', null, `Supply for full white with 20% headroom: ${P.psuAmps.toFixed(1)} A`));
    if (P.longRuns.length) box.append(h('span', null, `${P.longRuns.map(r => r.name).join(', ')}: over ${P.injectEvery} LEDs on one run. Plan power injection at both ends.`));
    box.append(h('span', { class: 'fine', text: 'Estimates from the fields above, not measurements.' }));
  }
  function renderSide() {
    renderPower(); renderPhoto(); renderStrips(); renderSel(); renderGroups(); updateHint();
  }
  function num(label, value, on, attrs) { const i = h('input', Object.assign({ type: 'number', step: 'any', value: value }, attrs || {})); i.addEventListener('change', () => on(parseFloat(i.value))); return h('label', null, label, i); }
  function renderPhoto() {
    const box = $('photoForm'); box.textContent = ''; const sec = $('secPhoto');
    if (S.view === 'layout') {
      sec.querySelector('summary').firstChild.textContent = 'Layout';
      const s = sheetById(S.layoutSel);
      if (!s) { box.append(h('p', { class: 'note', text: 'Click a photo outline to select it, then drag it into place. Photos are scaled to match each other using their LED spacing.' })); return; }
      box.append(h('p', { class: 'note', text: s.name + (s.flat ? ' (flattened)' : '') }));
      const set = (k, v) => { if (!isFinite(v)) return; mutate(() => { s.place[k] = v; if (k === 'scale') s.place.manual = true; else s.place.moved = true; }); };
      box.append(h('div', { class: 'row2' }, num('X', +s.place.x.toFixed(2), v => set('x', v)), num('Y', +s.place.y.toFixed(2), v => set('y', v))));
      box.append(h('div', { class: 'row2' }, num('Rotation, degrees', +(s.place.rot * 180 / Math.PI).toFixed(2), v => set('rot', v * Math.PI / 180)), num('Scale', +s.place.scale.toFixed(4), v => { if (v > 0) set('scale', v); }, { min: 0 })));
      box.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn tiny', text: 'Rotate 90°', onclick: () => set('rot', s.place.rot + Math.PI / 2) }),
        (s.place.manual || s.place.moved) ? h('button', { class: 'btn tiny', text: 'Reset placement', title: 'Let the tool scale and place this photo again', onclick: () => mutate(() => { delete s.place.manual; delete s.place.moved; s.place.rot = 0; autoLayout(); }) }) : null));
      if (s.flat) box.append(h('p', { class: 'note', text: 'Flattened photos are drawn as LED positions only here. The photo itself is not warped yet.' }));
      return;
    }
    sec.querySelector('summary').firstChild.textContent = 'This photo';
    const s = curSheet(); if (!s) { box.append(h('p', { class: 'note', text: 'Add a photo to begin.' })); return; }
    if (S.flatEdit) {
      box.append(h('p', { class: 'note', text: 'Drag the four numbered handles onto a rectangle that lies flat with the LEDs: floor tiles, a sheet of paper, a table edge. Go clockwise from its top left. Then enter its real size. Any unit works if you use the same one on every photo.' }));
      const w = h('input', { type: 'number', step: 'any', min: 0, value: S.flatEdit.w }), hh = h('input', { type: 'number', step: 'any', min: 0, value: S.flatEdit.h });
      box.append(h('div', { class: 'row2' }, h('label', null, 'Rectangle width', w), h('label', null, 'Rectangle height', hh)));
      box.append(h('div', { class: 'btnrow' },
        h('button', { class: 'btn tiny primary', text: 'Apply', onclick: () => { const W = parseFloat(w.value), H = parseFloat(hh.value); if (!(W > 0 && H > 0)) { toast('Enter the width and height of the rectangle.'); return; } const q = S.flatEdit.quad.map(p => [p[0], p[1]]); if (!G.homography(q, [[0, 0], [W, 0], [W, H], [0, H]])) { toast('Those four corners do not make a usable rectangle.'); return; } mutate(() => { s.flat = { quad: q, w: W, h: H }; autoLayout(); }); S.flatEdit = null; renderSide(); draw(); toast('Photo flattened. Spacing and counts now use the corrected geometry.'); } }),
        h('button', { class: 'btn tiny', text: 'Cancel', onclick: () => { S.flatEdit = null; renderSide(); draw(); } }),
        s.flat ? h('button', { class: 'btn tiny danger', text: 'Remove flattening', onclick: () => { mutate(() => { s.flat = null; autoLayout(); }); S.flatEdit = null; renderSide(); draw(); } }) : null));
      return;
    }
    const pw = pitchWork(s);
    box.append(h('p', { class: 'note' }, s.calib ? `LED spacing: ${pitchImage(s).toFixed(1)} px in the photo.` : 'LED spacing not set yet. The Draw path tool asks for it the first time.'));
    box.append(h('div', { class: 'btnrow' },
      h('button', { class: 'btn tiny', text: s.calib ? 'Set spacing again' : 'Set spacing', onclick: beginCalib }),
      h('button', { class: 'btn tiny', text: s.flat ? 'Edit flattening' : 'Flatten photo', title: 'Correct for the camera angle using a rectangle of known size', onclick: () => { const m = Math.min(s.w, s.h) * 0.25, cx = s.w / 2, cy = s.h / 2; S.flatEdit = s.flat ? { quad: s.flat.quad.map(p => [p[0], p[1]]), w: s.flat.w, h: s.flat.h } : { quad: [[cx - m, cy - m], [cx + m, cy - m], [cx + m, cy + m], [cx - m, cy + m]], w: 12, h: 12 }; if (S.path) finishPath(); S.tool = 'select'; setTool('select'); renderSide(); draw(); } }),
      h('button', { class: 'btn tiny', text: 'Find lit LEDs', title: 'For photos taken with the LEDs switched on', onclick: () => findLit(s) })));
    if (!s.flat) box.append(h('p', { class: 'note', text: 'Shot at an angle? Flatten the photo first so spacing stays even across it.' }));
    box.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn tiny danger', text: 'Remove photo', onclick: () => removeSheet(s) })));
    void pw;
  }
  function removeSheet(s) {
    const n = S.project.strips.reduce((a, st) => a + st.leds.filter(l => l.s === s.id).length, 0);
    if (n && !confirm(`Remove "${s.name}" and the ${n} LEDs mapped on it?`)) return;
    mutate(() => { for (const st of S.project.strips) st.leds = st.leds.filter(l => l.s !== s.id); S.project.sheets = S.project.sheets.filter(x => x !== s); S.images.delete(s.id); autoLayout(); S.view = S.project.sheets.length ? S.project.sheets[0].id : null; });
    renderTabs(); updateHint();
  }
  function findLit(s) {
    const prep = prepFor(s); if (!prep) { toast('This photo has no image data.'); return; }
    const r = D.detectLit(prep);
    if (r.blobs.length < 2) { toast('No lit LEDs found. For unlit strips, use Draw path.'); return; }
    if (r.blobs.length > 6000) { toast(`Found ${r.blobs.length} bright spots, which is too many to be LEDs. Is this photo taken with the LEDs on?`); return; }
    mutate(() => {
      const st = activeStrip(true), start = r.blobs.reduce((bi, b, i) => (b.x + b.y < r.blobs[bi].x + r.blobs[bi].y ? i : bi), 0), order = D.orderNearest(r.blobs, start);
      const leds = order.map(i => M.newLed(s.id, r.blobs[i].x, r.blobs[i].y)); st.leds.push(...leds);
      if (!s.calib && leds.length > 1) { const d = []; for (let i = 1; i < leds.length; i++) d.push([Math.hypot(leds[i].x - leds[i - 1].x, leds[i].y - leds[i - 1].y), i]); d.sort((a, b) => a[0] - b[0]); const m = d[d.length >> 1][1]; s.calib = { a: [leds[m - 1].x, leds[m - 1].y], b: [leds[m].x, leds[m].y] }; }
      S.sel = new Set([leds[0].id]); S.lastSel = leds[0].id;
    });
    toast(`Found ${r.blobs.length} lit LEDs and ordered them by nearest neighbour. Select the true first pixel to reorder from there.`);
  }
  function renderStrips() {
    const list = $('stripList'); list.textContent = ''; const r = M.resolve(S.project);
    $('stripCount').textContent = S.project.strips.length ? `${S.project.strips.length}, ${r.total} LEDs` : '';
    if (!S.project.strips.length) list.append(h('p', { class: 'empty-note', text: 'One strip per data pin. A strip is created when you start drawing.' }));
    S.project.strips.forEach((st, i) => {
      const info = r.strips[i], on = st.id === S.activeStrip;
      const name = h('input', { class: 'name', value: st.name, 'aria-label': 'Strip name' }); name.addEventListener('change', () => { const v = name.value.trim(); if (v) mutate(() => { st.name = v; }); });
      const pin = h('input', { class: 'pin', type: 'number', min: 0, max: 48, value: st.pin, 'aria-label': 'Data pin (GPIO)', title: 'Data pin (GPIO)' }); pin.addEventListener('change', () => { const v = parseInt(pin.value, 10); if (v >= 0) mutate(() => { st.pin = v; }); });
      const col = h('input', { type: 'color', value: st.color, class: 'dot', title: 'Colour', style: 'background:' + st.color + ';-webkit-appearance:none;appearance:none;overflow:hidden' }); col.addEventListener('change', () => mutate(() => { st.color = col.value; }));
      const item = h('div', { class: 'item' + (on ? ' on' : ''), onclick: e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; S.activeStrip = st.id; renderSide(); draw(); } },
        col, name, h('span', { class: 'meta' }, 'GPIO', pin),
        h('div', { class: 'strip-more' }, h('span', { text: `${info.count} LEDs, ${info.count - info.live} dead, starts at ${info.start}` }), h('span', { style: 'flex:1' }),
          h('button', { class: 'icon', title: 'Move up', text: '↑', onclick: () => moveItem(S.project.strips, i, -1) }), h('button', { class: 'icon', title: 'Move down', text: '↓', onclick: () => moveItem(S.project.strips, i, 1) }),
          h('button', { class: 'icon', title: 'Reverse the data direction', text: '⇄', onclick: () => mutate(() => { st.leds.reverse(); }) }),
          h('button', { class: 'icon', title: 'Delete strip', text: '✕', onclick: () => { if (st.leds.length && !confirm(`Delete "${st.name}" and its ${st.leds.length} LEDs?`)) return; mutate(() => { S.project.strips.splice(i, 1); if (S.activeStrip === st.id) S.activeStrip = null; }); } })));
      list.append(item);
    });
  }
  function moveItem(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; mutate(() => { const [x] = arr.splice(i, 1); arr.splice(j, 0, x); }); }
  function renderSel() {
    const box = $('selBox'); box.textContent = ''; const runs = selRuns(), n = S.sel.size; $('selCount').textContent = n ? String(n) : '';
    if (!n) { box.append(h('p', { class: 'note', text: 'Nothing selected.' })); return; }
    const one = runs.length === 1 ? runs[0] : null;
    box.append(h('p', { class: 'note', text: one ? (n === 1 ? `Pixel ${one.from} on ${one.strip.name}` : one.contiguous ? `${n} LEDs, pixels ${one.from} to ${one.to} on ${one.strip.name}` : `${n} LEDs on ${one.strip.name}`) : `${n} LEDs on ${runs.length} strips` }));
    const flagged = [...S.sel].filter(id => { const e = index.get(id); return e && e.led.check; }).length;
    if (flagged) box.append(h('p', { class: 'note warn' }, `${flagged} of these have a dashed ring: the tool was unsure how many LEDs are in that run. Count them against the photo. `, h('button', { class: 'btn tiny', text: 'Count is right', onclick: () => mutate(() => { for (const id of S.sel) { const e = index.get(id); if (e) delete e.led.check; } }) })));
    box.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn tiny', text: 'Mark dead', onclick: () => setDead(true) }), h('button', { class: 'btn tiny', text: 'Mark live', onclick: () => setDead(false) }), h('button', { class: 'btn tiny danger', text: 'Delete', onclick: deleteSel })));
    if (one && one.contiguous && n >= 2) {
      const c = h('input', { type: 'number', min: 2, step: 1, value: n, 'aria-label': 'LEDs in this run' });
      box.append(h('label', null, 'LEDs in this run, ends stay put', h('div', { class: 'row3' }, c, h('button', { class: 'btn tiny', text: 'Respace', onclick: () => respace(parseInt(c.value, 10)) }), h('span', { class: 'btnrow' }, h('button', { class: 'btn tiny', text: '−1', onclick: () => respace(n - 1) }), h('button', { class: 'btn tiny', text: '+1', onclick: () => respace(n + 1) })))));
    }
    const gs = S.project.groups, sel = h('select', { 'aria-label': 'Add to group' }, h('option', { value: '', text: 'Add to group…' }), gs.map((g, i) => h('option', { value: String(i), text: g.name })));
    sel.addEventListener('change', () => { const g = gs[+sel.value]; if (!g) return; mutate(() => { for (const id of S.sel) if (!g.leds.includes(id)) g.leds.push(id); }); });
    box.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn tiny', text: 'New group', onclick: groupFromSel }), gs.length ? h('button', { class: 'btn tiny', text: 'Remove from groups', onclick: () => mutate(() => { for (const g of gs) g.leds = g.leds.filter(id => !S.sel.has(id)); }) }) : null));
    if (gs.length) box.append(sel);
    if (n === 1 && one) {
      const led = one.strip.leds[one.from];
      box.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!led.brk, onchange: e => mutate(() => { if (e.target.checked) led.brk = true; else delete led.brk; }) }), 'A new group starts at this pixel'));
      box.append(h('div', { class: 'btnrow' }, h('button', { class: 'btn tiny', text: 'Reorder from here: nearest', title: 'Make this the first pixel and order the rest by nearest neighbour', onclick: () => reorderFrom(led, 'near') }), h('button', { class: 'btn tiny', text: 'Reorder: serpentine rows', onclick: () => reorderFrom(led, 'serp') })));
    }
  }
  function renderGroups() {
    const list = $('groupList'); list.textContent = ''; const gs = S.project.groups; $('groupCount').textContent = gs.length ? String(gs.length) : '';
    if (!gs.length) list.append(h('p', { class: 'empty-note', text: 'A group is a named set of pixels that act together. Select LEDs and choose New group, or let Draw path group each row.' }));
    gs.forEach((g, i) => {
      const name = h('input', { class: 'name', value: g.name, 'aria-label': 'Group name' }); name.addEventListener('change', () => { const v = name.value.trim(); if (v) mutate(() => { g.name = v; delete g.auto; }); });
      list.append(h('div', { class: 'item', onclick: e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; S.sel = new Set(g.leds); const f = index.get(g.leds[0]); if (f && S.view !== 'layout' && f.led.s !== S.view) setView(f.led.s); renderSide(); draw(); } },
        h('span', { class: 'dot', style: 'background:' + g.color }), name,
        h('span', { class: 'meta' }, `#${i}, ${g.leds.length} px`, h('button', { class: 'icon', title: 'Move up', text: '↑', onclick: () => moveItem(gs, i, -1) }), h('button', { class: 'icon', title: 'Move down', text: '↓', onclick: () => moveItem(gs, i, 1) }), h('button', { class: 'icon', title: 'Delete group (keeps the LEDs)', text: '✕', onclick: () => mutate(() => { gs.splice(i, 1); }) }))));
    });
  }

  /* ----------------------------------------------------------------- photos */
  function loadImage(blob) { return new Promise((res, rej) => { const url = URL.createObjectURL(blob), img = new Image(); img.onload = () => res(img); img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That file could not be read as an image.')); }; img.src = url; }); }
  async function addPhotos(files) {
    let added = 0, first = null;
    for (const f of files) {
      if (!f.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)) continue;
      try {
        const img = await loadImage(f); let w = img.naturalWidth, hh = img.naturalHeight; const k = Math.min(1, 4096 / Math.max(w, hh)); w = Math.round(w * k); hh = Math.round(hh * k);
        // Re-encode once so the stored photo is upright and the same pixels on every reload.
        const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').drawImage(img, 0, 0, w, hh);
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95)), img2 = await loadImage(blob);
        if (!added) pushUndo();
        const s = M.newSheet(f.name.replace(/\.[^.]+$/, ''), w, hh, ''); s.file = `images/${s.id}.jpg`;
        S.project.sheets.push(s); S.images.set(s.id, { blob, img: img2, prep: null }); first = first || s; added++;
      } catch (err) { toast(`${f.name}: ${err.message}`); }
    }
    if (added) { autoLayout(); S.view = first.id; changed(); setView(first.id); if (!S.project.strips.some(st => st.leds.length)) setTool('path'); }
    else if (files.length) toast('None of those files are images this browser can read. JPEG and PNG always work.');
  }

  /* ------------------------------------------------------------ save / open */
  const downloadBlob = (name, blob) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); };
  async function projectBytes() {
    const clean = JSON.parse(JSON.stringify(S.project));
    const files = [{ name: 'project.json', data: JSON.stringify(clean, null, 1) }];
    for (const s of S.project.sheets) { const im = S.images.get(s.id); if (im && im.blob) files.push({ name: s.file, data: new Uint8Array(await im.blob.arrayBuffer()) }); }
    return Z.write(files);
  }
  async function saveProject() {
    try {
      const bytes = await projectBytes(), name = X.safe(S.project.name) + '.ledmap';
      if (window.showSaveFilePicker && window.isSecureContext) {
        try {
          if (!S.fileHandle) S.fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'LED Mapper project', accept: { 'application/zip': ['.ledmap'] } }] });
          const w = await S.fileHandle.createWritable(); await w.write(bytes); await w.close(); toast(`Saved ${S.fileHandle.name}`); markSaved(S.fileHandle.name); return;
        } catch (err) { if (err && err.name === 'AbortError') return; S.fileHandle = null; }
      }
      downloadBlob(name, new Blob([bytes], { type: 'application/zip' })); toast(`Saved ${name} to your downloads.`); markSaved(name);
    } catch (err) { toast('Could not save: ' + err.message); }
  }
  function markSaved(name) { S.savedAt = Date.now(); $('saveState').textContent = `Saved to ${name} at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`; }
  async function openProjectFile(file) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer()); let project, entries = [];
      if (buf[0] === 0x50 && buf[1] === 0x4b) { entries = await Z.read(buf); const pj = entries.find(e => e.name === 'project.json'); if (!pj) throw new Error('This zip has no project.json inside, so it is not an LED Mapper project.'); project = JSON.parse(new TextDecoder().decode(pj.data)); }
      else project = JSON.parse(new TextDecoder().decode(buf));
      await loadProject(M.validate(project), async s => { const e = entries.find(x => x.name === s.file); return e ? new Blob([e.data], { type: 'image/jpeg' }) : null; });
      S.fileHandle = null; toast(`Opened ${file.name}`); $('saveState').textContent = `Opened ${file.name}`;
    } catch (err) { toast('Could not open that file. ' + (err instanceof SyntaxError ? 'It is not a valid project file.' : err.message)); }
  }
  async function loadProject(project, getBlob) {
    const images = new Map(); let missing = 0;
    for (const s of project.sheets) { const blob = await getBlob(s); if (blob) { try { images.set(s.id, { blob, img: await loadImage(blob), prep: null }); } catch (_) { missing++; } } else missing++; }
    S.project = project; S.images = images; S.undo = []; S.redo = []; S.sel.clear(); S.cams = {}; S.path = null; S.calib = null; S.flatEdit = null; S.preview = null;
    S.view = project.sheets.length ? project.sheets[0].id : null; S.activeStrip = project.strips.length ? project.strips[0].id : null;
    $('projectName').value = project.name; syncSetup(); changed(); setTool('select'); renderTabs();
    if (missing) toast(`${missing} photo(s) are missing from this file. The map is intact and you can keep editing.`);
  }
  function newProject() {
    if (S.project.sheets.length && !confirm('Start a new project? Save first if you want to keep this one.')) return;
    loadProject(M.newProject(), async () => null); S.fileHandle = null; $('saveState').textContent = '';
  }

  /* --------------------------------------------------------------- autosave */
  let saveTimer = 0, db = null;
  function idb() { return new Promise((res, rej) => { if (db) return res(db); const r = indexedDB.open('led-mapper', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { db = r.result; res(db); }; r.onerror = () => rej(r.error); }); }
  function autosaveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(autosave, 1200); }
  async function autosave() {
    try {
      const d = await idb(), clean = JSON.stringify(S.project), imgs = [...S.images].map(([id, im]) => ({ id, blob: im.blob }));
      await new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ json: clean, imgs, at: Date.now() }, 'autosave'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      if (!S.savedAt || Date.now() - S.savedAt > 4000) { const st = $('saveState'); if (S.project.sheets.length && !/^Saved to/.test(st.textContent)) st.textContent = 'Kept in this browser. Save project to make a file.'; else if (S.project.sheets.length) st.textContent = st.textContent.replace(/^Saved to/, 'Changed since saving to').replace(/ at .*/, ''); }
    } catch (_) { /* private mode or blocked storage: the Save button still works */ }
  }
  async function restoreAutosave() {
    try {
      const d = await idb(), rec = await new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get('autosave'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (!rec || !rec.json) return false; const project = M.validate(JSON.parse(rec.json)); if (!project.sheets.length) return false;
      await loadProject(project, async s => { const e = (rec.imgs || []).find(x => x.id === s.id); return e ? e.blob : null; });
      toast('Picked up where you left off.', 'Start new', newProject); return true;
    } catch (_) { return false; }
  }

  /* ----------------------------------------------------------------- export */
  let exportResult = null;
  function renderLayoutPng() {
    const r = M.resolve(S.project), n = M.normalise(r.leds, { origin: 'corner', yUp: false, keepAspect: true, lo: 0, hi: 1 });
    const size = 1400, pad = 40, W = size, H = Math.max(120, Math.round((size - pad * 2) / Math.max(n.aspect, 0.05)) + pad * 2), c = document.createElement('canvas'); c.width = W; c.height = Math.min(H, 4000);
    const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    const sc = Math.min((W - pad * 2), (c.height - pad * 2) * Math.max(n.aspect, 1e-6)) , k = n.aspect >= 1 ? (W - pad * 2) : (c.height - pad * 2);
    const rad = Math.max(2, Math.min(9, k / Math.sqrt(Math.max(1, r.total)) * 0.22)); void sc;
    r.leds.forEach(l => { const px = pad + n.u[l.index] * k, py = pad + n.v[l.index] * k; x.beginPath(); x.arc(px, py, rad, 0, 7); if (l.dead) { x.strokeStyle = '#555'; x.lineWidth = 1; x.stroke(); } else { const g = l.groups.length ? S.project.groups[l.groups[0]] : null; x.fillStyle = g ? g.color : S.project.strips[l.strip].color; x.fill(); } });
    return new Promise(res => c.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), 'image/png'));
  }
  function optRow(o, key, label, type, extra) {
    if (type === 'check') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!o[key], onchange: e => { o[key] = e.target.checked; exportChanged(); } }), label);
    if (type === 'select') { const s = h('select', null, extra.map(([v, t]) => h('option', { value: v, text: t }))); s.value = String(o[key]); s.addEventListener('change', () => { let v = s.value; if (v === 'true' || v === 'false') v = v === 'true'; o[key] = v; if (extra.onset) extra.onset(v); exportChanged(); }); return h('label', null, label, s); }
    const i = h('input', { type: 'number', step: 'any', value: o[key] }); i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) { o[key] = v; exportChanged(); } }); return h('label', null, label, i);
  }
  function exportChanged() { autosaveSoon(); renderExport(); }
  async function renderExport() {
    const t = S.exportTarget, o = S.project.exports[t], f = $('exportForm'); f.textContent = '';
    document.querySelectorAll('#exportTarget button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    const coords = [optRow(o, 'origin', 'Origin', 'select', [['corner', o.yUp ? 'Bottom left corner' : 'Top left corner'], ['center', 'Centre of the layout']]), optRow(o, 'yUp', 'Y axis points', 'select', [['false', 'Down, like an image'], ['true', 'Up, like a graph']]), optRow(o, 'keepAspect', 'Keep proportions (longest side fills the range)', 'check'), optRow(o, 'includeDeadInBounds', 'Count dead pixels when fitting the range', 'check')];
    if (t === 'wled') {
      f.append(optRow(o, 'order', 'Pixel order effects will see', 'select', [['wiring', 'Wiring order, dead pixels skipped'], ['groups', 'Packed by group, in group list order']]));
      f.append(optRow(o, 'coordType', 'Position numbers in the header', 'select', [['uint8', 'uint8_t, 0 to 255'], ['uint16', 'uint16_t, 0 to 65535'], ['int16', 'int16_t, -32768 to 32767']]), ...coords);
      f.append(optRow(o, 'grid', 'Also write a 2D matrix map (snaps LEDs to a grid)', 'check')); if (o.grid) f.append(optRow(o, 'gridWidth', 'Grid width in cells, 0 picks one from the LED spacing', 'number'));
    } else if (t === 'fastled') {
      const ct = [['uint8', 'uint8_t'], ['uint16', 'uint16_t'], ['int16', 'int16_t'], ['int8', 'int8_t'], ['float', 'float']]; ct.onset = v => { const T = M.INT_TYPES[v]; o.lo = T.lo; o.hi = T.hi; };
      f.append(optRow(o, 'coordType', 'Number type', 'select', ct), h('div', { class: 'row2' }, optRow(o, 'lo', 'Range from', 'number'), optRow(o, 'hi', 'to', 'number')), ...coords);
      f.append(optRow(o, 'grid', 'Add an XY(x, y) grid lookup', 'check')); if (o.grid) f.append(optRow(o, 'gridWidth', 'Grid width in cells, 0 picks one from the LED spacing', 'number'));
    } else {
      f.append(h('div', { class: 'row2' }, optRow(o, 'lo', 'Range from', 'number'), optRow(o, 'hi', 'to', 'number')), ...coords);
      f.append(h('div', { class: 'row2' }, optRow(o, 'universeSize', 'Pixels per universe', 'number'), optRow(o, 'firstUniverse', 'First universe', 'number')), optRow(o, 'stripsStartUniverse', 'Each strip starts on a new universe', 'check'));
    }
    let res; try { res = X[t === 'td' ? 'touchdesigner' : t](S.project); } catch (err) { res = { files: [], warnings: ['Export failed: ' + err.message], summary: { total: 0, live: 0, groups: 0 } }; }
    for (const file of res.files) if (file.render === 'layout') { file.bytes = await renderLayoutPng(); }
    exportResult = res;
    const warn = $('exportWarn'); warn.textContent = '';
    if (!res.summary.total) warn.append(h('p', { class: 'note warn', text: 'There are no LEDs mapped yet, so these files are empty.' }));
    const checks = S.project.strips.reduce((a, st) => a + st.leds.filter(l => l.check).length, 0); if (checks) warn.append(h('p', { class: 'note warn', text: `${checks} LED(s) are still flagged with a dashed ring because the tool was unsure of the count there. Check those runs before you trust the indexes.` }));
    for (const w of res.warnings) warn.append(h('p', { class: 'note warn', text: w }));
    $('exportSummary').textContent = `${res.summary.total} LEDs on the wire, ${res.summary.live} mapped, ${res.summary.groups} groups.`;
    const tabs = $('fileTabs'); tabs.textContent = ''; if (S.exportFile >= res.files.length) S.exportFile = 0;
    res.files.forEach((file, i) => tabs.append(h('button', { class: i === S.exportFile ? 'on' : '', text: file.name, onclick: () => { S.exportFile = i; showFile(); tabs.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === i)); } })));
    showFile();
  }
  function showFile() {
    const pre = $('filePreview'), file = exportResult && exportResult.files[S.exportFile]; pre.textContent = ''; if (!file) return;
    if (file.bytes) { const img = h('img', { alt: file.name, src: URL.createObjectURL(new Blob([file.bytes], { type: 'image/png' })) }); if (file.name.includes('uv')) img.style.cssText = 'width:100%;height:28px;image-rendering:pixelated'; pre.append(img); $('btnCopyFile').disabled = true; }
    else { pre.textContent = file.text.length > 60000 ? file.text.slice(0, 60000) + '\n… preview cut here. The download has the whole file.' : file.text; $('btnCopyFile').disabled = false; }
  }
  const fileBlob = file => file.bytes ? new Blob([file.bytes], { type: 'image/png' }) : new Blob([file.text], { type: 'text/plain' });

  /* ------------------------------------------------------------------ wiring */
  function init() {
    const cs = $('fChipset'); for (const k in M.CHIPSETS) cs.append(h('option', { value: k, text: M.CHIPSETS[k].label }));
    cs.addEventListener('change', () => mutate(() => { const c = M.CHIPSETS[cs.value], s = S.project.setup; s.chipset = cs.value; s.voltage = c.voltage; s.maPerPixel = c.ma; s.colorOrder = c.order; syncSetup(); }));
    const bind = (id, key, parse) => $(id).addEventListener('change', () => { const v = parse($(id).value); mutate(() => { S.project.setup[key] = v; }); syncSetup(); });
    const pos = d => v => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : d; };
    bind('fVoltage', 'voltage', pos(5)); bind('fMa', 'maPerPixel', pos(0)); bind('fOrder', 'colorOrder', v => v); bind('fLpm', 'ledsPerMeter', v => Math.max(1, pos(60)(v))); bind('fPsu', 'psuAmps', pos(0));
    $('projectName').addEventListener('change', () => { const v = $('projectName').value.trim() || 'Untitled map'; mutate(() => { S.project.name = v; }); $('projectName').value = v; });
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('btnFit').onclick = fit; $('btnZoomIn').onclick = () => zoomAt(cw / 2, ch / 2, 1.4); $('btnZoomOut').onclick = () => zoomAt(cw / 2, ch / 2, 1 / 1.4);
    $('btnUndo').onclick = undo; $('btnRedo').onclick = redo; $('btnSave').onclick = saveProject; $('btnNew').onclick = newProject;
    $('btnOpen').onclick = $('btnOpen2').onclick = () => $('fileProject').click(); $('btnAddFirst').onclick = () => $('fileImages').click();
    $('fileImages').addEventListener('change', e => { addPhotos([...e.target.files]); e.target.value = ''; });
    $('fileProject').addEventListener('change', e => { if (e.target.files[0]) openProjectFile(e.target.files[0]); e.target.value = ''; });
    $('btnAddStrip').onclick = () => { if (S.path) finishPath(); mutate(() => { const st = M.newStrip(S.project); S.project.strips.push(st); S.activeStrip = st.id; }); if (S.view && S.view !== 'layout') setTool('path'); };
    $('btnGroupRuns').onclick = () => { const st = activeStrip(false); if (!st || !st.leds.length) { toast('Select a strip with LEDs first.'); return; } regroupStrip(st, true); S.colorBy = 'group'; $('colorBy').value = 'group'; draw(); toast(`Grouped each run of live pixels on ${st.name}.`); };
    $('btnClearGroups').onclick = () => { if (S.project.groups.length && confirm(`Remove all ${S.project.groups.length} groups? The LEDs stay.`)) mutate(() => { S.project.groups = []; }); };
    $('photoDim').addEventListener('input', e => { S.photoDim = e.target.value / 100; draw(); });
    $('colorBy').addEventListener('change', e => { S.colorBy = e.target.value; draw(); }); $('showLabels').addEventListener('change', e => { S.showLabels = e.target.checked; draw(); });
    $('optRowsTurns').addEventListener('change', updateHint);
    $('btnLegMinus').onclick = () => { const l = S.path && S.path.legs[S.path.legs.length - 1]; if (l) regenLeg(l.M - 1); }; $('btnLegPlus').onclick = () => { const l = S.path && S.path.legs[S.path.legs.length - 1]; if (l) regenLeg(l.M + 1); };
    $('btnLegJump').onclick = () => { const l = S.path && S.path.legs[S.path.legs.length - 1]; if (l) regenLeg(1, 'turn'); };
    $('btnLegType').onclick = () => { const l = S.path && S.path.legs[S.path.legs.length - 1]; if (l) regenLeg(l.M, l.kind === 'row' ? 'turn' : 'row'); }; $('btnLegUndo').onclick = removeLeg; $('btnPathDone').onclick = finishPath;
    $('btnExport').onclick = () => { if (S.path) finishPath(); $('dlgExport').showModal(); renderExport(); };
    document.querySelectorAll('#exportTarget button').forEach(b => b.addEventListener('click', () => { S.exportTarget = b.dataset.t; S.exportFile = 0; renderExport(); }));
    $('btnCopyFile').onclick = async () => { const f = exportResult && exportResult.files[S.exportFile]; if (f && f.text) { try { await navigator.clipboard.writeText(f.text); toast(`Copied ${f.name}`); } catch (_) { toast('Copy was blocked by the browser. Use Download instead.'); } } };
    $('btnDownloadFile').onclick = () => { const f = exportResult && exportResult.files[S.exportFile]; if (f) downloadBlob(f.name, fileBlob(f)); };
    $('btnDownloadAll').onclick = async () => { if (!exportResult) return; const files = []; for (const f of exportResult.files) files.push({ name: f.name, data: f.bytes || f.text }); const name = `${X.safe(S.project.name)}_${S.exportTarget === 'td' ? 'touchdesigner' : S.exportTarget}.zip`; downloadBlob(name, new Blob([Z.write(files)], { type: 'application/zip' })); toast(`Downloaded ${name}`); };
    // drag and drop
    const wrap = document.body, emp = $('empty');
    wrap.addEventListener('dragover', e => { e.preventDefault(); emp.classList.add('drag'); }); wrap.addEventListener('dragleave', () => emp.classList.remove('drag'));
    wrap.addEventListener('drop', e => { e.preventDefault(); emp.classList.remove('drag'); const files = [...e.dataTransfer.files]; const proj = files.find(f => /\.(ledmap|zip|json)$/i.test(f.name)); if (proj) openProjectFile(proj); else addPhotos(files); });
    new ResizeObserver(resize).observe($('canvasWrap'));
    window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); autosave(); });
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => { /* offline install is optional */ });
    syncSetup(); changed(); setTool('select'); resize();
    if (!/[?&]fresh\b/.test(location.search)) restoreAutosave();
  }
  window.LM.app.api = { addPhotos, openProjectFile, saveProject, projectBytes, setTool, setView, fit, toScreen, fromScreen, legPoints, finishPath, loadProject, renderExport, getExport: () => exportResult };
  init();
})();
