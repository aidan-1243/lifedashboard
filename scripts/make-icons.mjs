// Draws the app icon (Coastal colors) as PNGs: navy square, sand ring, coral sun.
// Run from the project folder: node scripts/make-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
const NAVY = [20, 36, 59], SAND = [246, 243, 236], CORAL = [232, 87, 61];
function draw(size) {
  const ss = 4; // supersampling for smooth edges
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / size - 0.5, v = (y + (sy + 0.5) / ss) / size - 0.5;
      const r = Math.hypot(u, v);
      const c = r < 0.085 ? CORAL : Math.abs(r - 0.255) < 0.045 ? SAND : NAVY;
      acc = acc.map((a, i) => a + c[i]);
    }
    acc.forEach((a, i) => { px[(y * size + x) * 3 + i] = Math.round(a / (ss * ss)); });
  }
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [180, 192, 512]) fs.writeFileSync(`public/icon-${s}.png`, draw(s));
fs.writeFileSync('public/icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#14243B"/><circle cx="256" cy="256" r="130.5" fill="none" stroke="#F6F3EC" stroke-width="46"/><circle cx="256" cy="256" r="43.5" fill="#E8573D"/></svg>\n`);
console.log('icons written');
