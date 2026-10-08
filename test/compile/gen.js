// Writes generated code for three export configurations into the folder given as argv[2].
const M = require('../../js/model.js'), X = require('../../js/exporters.js'), fs = require('fs');
const p = M.newProject(); p.name = 'Compile check'; const sh = M.newSheet('a', 1000, 1000, ''); p.sheets.push(sh);
for (let s = 0; s < 2; s++) { const st = M.newStrip(p); p.strips.push(st); for (let i = 0; i < 40; i++) st.leds.push(M.newLed(sh.id, 50 + i * 20, 100 + s * 200 + (i % 7) * 9, { dead: i % 11 === 10 })); p.groups.push(...M.groupsFromRuns(p, st, st.name)); }
for (const variant of ['a', 'b', 'c']) {
  if (variant === 'b') { Object.assign(p.exports.fastled, { coordType: 'float', lo: -1, hi: 1, grid: true }); Object.assign(p.exports.wled, { coordType: 'int16', order: 'groups' }); }
  if (variant === 'c') { p.groups = []; Object.assign(p.exports.fastled, { coordType: 'uint8', lo: 0, hi: 255 }); }
  fs.mkdirSync(`${process.argv[2]}/${variant}`, { recursive: true });
  for (const f of [...X.fastled(p).files, ...X.wled(p).files]) if (f.text) fs.writeFileSync(`${process.argv[2]}/${variant}/${f.name}`, f.text);
}
