/* EasyLEDMap: minimal zip reader and writer. Writes stored (uncompressed) entries, which is fine
   because the bulk of a project is JPEG data. Reads stored and deflated entries. */
(function (root) {
  'use strict';
  let table = null;
  function crc32(buf) {
    if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const enc = new TextEncoder(), dec = new TextDecoder();
  /** files: [{ name, data: Uint8Array | string }] -> Uint8Array */
  function write(files) {
    const entries = files.map(f => { const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data; return { name: enc.encode(f.name), data, crc: crc32(data) }; });
    let size = 22; for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
    const out = new Uint8Array(size), dv = new DataView(out.buffer); let p = 0; const offsets = [];
    for (const e of entries) {
      offsets.push(p);
      dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true);
      dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, 0x21, true); dv.setUint32(p + 14, e.crc, true);
      dv.setUint32(p + 18, e.data.length, true); dv.setUint32(p + 22, e.data.length, true); dv.setUint16(p + 26, e.name.length, true); dv.setUint16(p + 28, 0, true);
      out.set(e.name, p + 30); out.set(e.data, p + 30 + e.name.length); p += 30 + e.name.length + e.data.length;
    }
    const cdStart = p;
    entries.forEach((e, i) => {
      dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true); dv.setUint16(p + 10, 0, true);
      dv.setUint16(p + 12, 0, true); dv.setUint16(p + 14, 0x21, true); dv.setUint32(p + 16, e.crc, true); dv.setUint32(p + 20, e.data.length, true); dv.setUint32(p + 24, e.data.length, true);
      dv.setUint16(p + 28, e.name.length, true); dv.setUint32(p + 42, offsets[i], true);
      out.set(e.name, p + 46); p += 46 + e.name.length;
    });
    dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, entries.length, true); dv.setUint16(p + 10, entries.length, true);
    dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true);
    return out;
  }
  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed project files. Use a current version of Chrome, Edge, Firefox or Safari.');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  /** Uint8Array -> Promise<[{ name, data: Uint8Array }]> */
  async function read(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let e = buf.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('This is not a zip file.');
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      const ln = dv.getUint16(off + 26, true), lx = dv.getUint16(off + 28, true), start = off + 30 + ln + lx;
      const raw = buf.subarray(start, start + csize);
      if (!name.endsWith('/')) out.push({ name, data: method === 0 ? raw.slice() : await inflateRaw(raw) });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }
  const api = { write, read, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LM = root.LM || {}; root.LM.zip = api;
})(typeof self !== 'undefined' ? self : globalThis);
