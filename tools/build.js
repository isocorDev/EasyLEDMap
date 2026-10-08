// Builds dist/led-mapper.html: the whole app in one file that runs by double-clicking it.
// Run: node tools/build.js
const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>\n${fs.readFileSync(path.join(root, f), 'utf8')}</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) => `<script>\n${fs.readFileSync(path.join(root, f), 'utf8').replace(/<\/script/g, '<\\/script')}</script>`);
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
const icon = Buffer.from(fs.readFileSync(path.join(root, 'icon.svg'))).toString('base64');
html = html.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="data:image/svg+xml;base64,${icon}">`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'led-mapper.html'), html);
console.log(`dist/led-mapper.html  ${(html.length / 1024).toFixed(0)} KB`);
