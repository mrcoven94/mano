// Draws the Mano app icons: an ink tile with a highlighter-yellow M.
// Pure node, no dependencies: rasterizes rects and a triangle into RGBA
// buffers and writes PNGs with zlib. Run: pnpm --filter @mano/app assets

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const INK = [18, 18, 18, 255];
const YELLOW = [255, 225, 74, 255];
const WHITE = [255, 255, 255, 255];

function makeCanvas(size) {
  return { size, buf: Buffer.alloc(size * size * 4, 0) };
}

function paint(c, x, y, color) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const o = (y * c.size + x) * 4;
  c.buf[o] = color[0];
  c.buf[o + 1] = color[1];
  c.buf[o + 2] = color[2];
  c.buf[o + 3] = color[3];
}

function rect(c, x0, y0, x1, y1, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) paint(c, x, y, color);
  }
}

function roundedTile(c, color) {
  const s = c.size;
  const r = s * 0.22;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = Math.min(x, s - 1 - x);
      const dy = Math.min(y, s - 1 - y);
      let inside = true;
      if (dx < r && dy < r) {
        const cx = r - dx;
        const cy = r - dy;
        inside = cx * cx + cy * cy <= r * r;
      }
      if (inside) paint(c, x, y, color);
    }
  }
}

function triangle(c, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const d1 = sign(x, y, ax, ay, bx, by);
      const d2 = sign(x, y, bx, by, cx, cy);
      const d3 = sign(x, y, cx, cy, ax, ay);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) paint(c, x, y, color);
    }
  }
}

// Blocky M: two bars plus a triangle from the top corners to center.
function drawM(c, color) {
  const s = c.size;
  const X = (v) => v * s;
  const Y = (v) => v * s;
  rect(c, X(0.21), Y(0.28), X(0.35), Y(0.72), color);
  rect(c, X(0.65), Y(0.28), X(0.79), Y(0.72), color);
  triangle(c, X(0.21), Y(0.28), X(0.79), Y(0.28), X(0.5), Y(0.6), color);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(path, c) {
  const s = c.size;
  const rows = [];
  for (let y = 0; y < s; y++) {
    rows.push(Buffer.concat([Buffer.from([0]), c.buf.subarray(y * s * 4, (y + 1) * s * 4)]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}

const icon = makeCanvas(1024);
roundedTile(icon, INK);
drawM(icon, YELLOW);
writePng(join(root, "icon.png"), icon);

const adaptive = makeCanvas(1024);
drawM(adaptive, YELLOW);
writePng(join(root, "adaptive-icon.png"), adaptive);

const splash = makeCanvas(512);
roundedTile(splash, INK);
drawM(splash, YELLOW);
writePng(join(root, "splash-icon.png"), splash);

const favicon = makeCanvas(48);
roundedTile(favicon, INK);
drawM(favicon, YELLOW);
writePng(join(root, "favicon.png"), favicon);

const notification = makeCanvas(96);
drawM(notification, WHITE);
writePng(join(root, "notification-icon.png"), notification);
