// Generates simple bus-icon PNGs with zero external dependencies (Node's
// built-in zlib only), so the app has real installable-PWA icons without
// needing an image library or native build tools.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.join(process.cwd(), 'public', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // no filter
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function setPixel(rgba, size, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function inRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : null;
  const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : null;
  if (cx === null || cy === null) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function drawBusIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [26, 115, 232, 255]; // brand blue
  const white = [255, 255, 255, 255];
  const dark = [20, 20, 30, 255];
  const glass = [173, 216, 255, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) setPixel(rgba, size, x, y, bg);
  }

  // bus body
  const bodyX0 = size * 0.14, bodyX1 = size * 0.86;
  const bodyY0 = size * 0.24, bodyY1 = size * 0.66;
  const radius = size * 0.08;
  for (let y = Math.floor(bodyY0); y <= bodyY1; y++) {
    for (let x = Math.floor(bodyX0); x <= bodyX1; x++) {
      if (inRoundedRect(x, y, bodyX0, bodyY0, bodyX1, bodyY1, radius)) setPixel(rgba, size, x, y, white);
    }
  }

  // windshield strip (glass band near top of body)
  const glassY0 = bodyY0 + size * 0.05, glassY1 = bodyY0 + size * 0.2;
  for (let y = Math.floor(glassY0); y <= glassY1; y++) {
    for (let x = Math.floor(bodyX0 + size * 0.05); x <= bodyX1 - size * 0.05; x++) {
      setPixel(rgba, size, x, y, glass);
    }
  }

  // wheels
  const wheelR = size * 0.085;
  const wheelY = bodyY1;
  for (const wheelX of [bodyX0 + size * 0.16, bodyX1 - size * 0.16]) {
    for (let y = -wheelR; y <= wheelR; y++) {
      for (let x = -wheelR; x <= wheelR; x++) {
        if (x * x + y * y <= wheelR * wheelR) {
          setPixel(rgba, size, Math.round(wheelX + x), Math.round(wheelY + y), dark);
        }
      }
    }
  }

  return rgba;
}

const sizes = [
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 180, name: 'apple-touch-icon.png' },
];

for (const { size, name } of sizes) {
  const rgba = drawBusIcon(size);
  const png = encodePng(size, size, rgba);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`wrote public/icons/${name} (${size}x${size}, ${png.length} bytes)`);
}
