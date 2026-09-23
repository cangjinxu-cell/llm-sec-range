'use strict';

/**
 * 生成应用图标（PNG + ICO），零依赖：
 * 手写 RGBA 光栅化与 PNG 编码，再按 ICO 容器格式打包多尺寸 PNG。
 * 图形：圆角方块渐变底 + 终端提示符 ">_"。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const BASE = 256;

/* ---------------- 几何 ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

/** 点到线段的距离，用于给笔画做抗锯齿。 */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / lengthSq);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 圆角矩形的有符号距离场（负值在内部）。 */
function roundedRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 用覆盖率做边缘平滑。 */
const coverage = (distance, feather = 1.1) => clamp01(0.5 - distance / feather);

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / BASE;
  const s = (v) => v * scale;

  // 渐变底色（左上深蓝 → 右下紫）
  const top = [77, 107, 254];
  const bottom = [139, 92, 246];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const offset = (y * size + x) * 4;

      // 圆角方块
      const plate = roundedRectDistance(px, py, size / 2, size / 2, s(112), s(112), s(58));
      const plateAlpha = coverage(plate, 1.4);
      if (plateAlpha <= 0) continue;

      const t = clamp01((px + py) / (2 * size));
      let r = mix(top[0], bottom[0], t);
      let g = mix(top[1], bottom[1], t);
      let b = mix(top[2], bottom[2], t);

      // 内层高光，让图标有一点体积感
      const inner = roundedRectDistance(px, py, size / 2, size / 2 * 0.92, s(96), s(96), s(48));
      const innerAlpha = coverage(inner, 1.6) * 0.16;
      r = mix(r, 255, innerAlpha);
      g = mix(g, 255, innerAlpha);
      b = mix(b, 255, innerAlpha);

      // ">" 提示符：两段粗线
      const stroke = s(15);
      const chevronTop = distanceToSegment(px, py, s(88), s(84), s(146), s(128)) - stroke;
      const chevronBottom = distanceToSegment(px, py, s(146), s(128), s(88), s(172)) - stroke;
      const chevron = Math.min(chevronTop, chevronBottom);
      const chevronAlpha = coverage(chevron, 1.6);

      // "_" 光标：一段横线
      const cursor =
        roundedRectDistance(px, py, s(176), s(178), s(30), s(9), s(6));
      const cursorAlpha = coverage(cursor, 1.6);

      const glyph = Math.max(chevronAlpha, cursorAlpha);
      r = mix(r, 255, glyph);
      g = mix(g, 255, glyph);
      b = mix(b, 255, glyph);

      pixels[offset] = Math.round(r);
      pixels[offset + 1] = Math.round(g);
      pixels[offset + 2] = Math.round(b);
      pixels[offset + 3] = Math.round(plateAlpha * 255);
    }
  }
  return pixels;
}

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 尺寸缩放与 ICO 打包 ---------------- */

/** 盒式滤波缩放（只支持整数/非整数比例的都均匀下采样）。 */
function resize(pixels, from, to) {
  const out = Buffer.alloc(to * to * 4);
  const ratio = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      const y0 = Math.floor(y * ratio);
      const y1 = Math.min(from, Math.ceil((y + 1) * ratio));
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(from, Math.ceil((x + 1) * ratio));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const offset = (sy * from + sx) * 4;
          const alpha = pixels[offset + 3] / 255;
          r += pixels[offset] * alpha;
          g += pixels[offset + 1] * alpha;
          b += pixels[offset + 2] * alpha;
          a += alpha;
          count++;
        }
      }
      const offset = (y * to + x) * 4;
      if (count === 0 || a === 0) continue;
      out[offset] = Math.round(r / a);
      out[offset + 1] = Math.round(g / a);
      out[offset + 2] = Math.round(b / a);
      out[offset + 3] = Math.round((a / count) * 255);
    }
  }
  return out;
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = [];
  for (const entry of entries) {
    const record = Buffer.alloc(16);
    record[0] = entry.size >= 256 ? 0 : entry.size;
    record[1] = entry.size >= 256 ? 0 : entry.size;
    record[2] = 0;
    record[3] = 0;
    record.writeUInt16LE(1, 4);
    record.writeUInt16LE(32, 6);
    record.writeUInt32LE(entry.png.length, 8);
    record.writeUInt32LE(offset, 12);
    directory.push(record);
    offset += entry.png.length;
  }

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)]);
}

/* ---------------- 主流程 ---------------- */

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const base = renderIcon(BASE);
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePng(base, BASE));

  const sizes = [256, 128, 64, 48, 32, 16];
  const entries = sizes.map((size) => ({
    size,
    png: size === BASE ? encodePng(base, BASE) : encodePng(resize(base, BASE, size), size),
  }));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeIco(entries));
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), encodePng(resize(base, BASE, 32), 32));

  for (const entry of entries) {
    console.log(`icon ${entry.size}x${entry.size}: ${entry.png.length} bytes`);
  }
  console.log('wrote assets/icon.png, assets/icon.ico, assets/tray.png');
}

if (require.main === module) main();

module.exports = { renderIcon, encodePng, encodeIco, resize };