/**
 * 生成扩展图标（纯 Node，无第三方依赖）。
 * 设计：深蓝渐变圆角方块 + 白色「桥」图形（两个节点由横梁相连）+ 右上角绿色在线点。
 * 用法：node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname ?? '.', '..', 'extension', 'icons');

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 圆角矩形覆盖率（0..1），用于超采样后仍保留一点解析度。 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

function drawRGBA(size) {
  const S = size * 4;
  const data = new Uint8Array(S * S * 4);
  const put = (i, r, g, b, a) => {
    const o = i * 4;
    const srcA = a / 255;
    const dstA = data[o + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    data[o] = Math.round((r * srcA + data[o] * dstA * (1 - srcA)) / outA);
    data[o + 1] = Math.round((g * srcA + data[o + 1] * dstA * (1 - srcA)) / outA);
    data[o + 2] = Math.round((b * srcA + data[o + 2] * dstA * (1 - srcA)) / outA);
    data[o + 3] = Math.round(outA * 255);
  };

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = px / S;
      const y = py / S;
      const i = py * S + px;
      // 背景：圆角方块 + 垂直渐变
      if (inRoundRect(x, y, 0.03, 0.03, 0.97, 0.97, 0.22)) {
        const t = y;
        const r = Math.round(11 + (30 - 11) * t);
        const g = Math.round(18 + (64 - 18) * t);
        const b = Math.round(32 + (175 - 32) * t);
        put(i, r, g, b, 255);
      }
      // 横梁
      if (inRoundRect(x, y, 0.30, 0.455, 0.70, 0.545, 0.045)) put(i, 255, 255, 255, 255);
      // 左节点
      if ((x - 0.305) ** 2 + (y - 0.5) ** 2 <= 0.105 ** 2) put(i, 255, 255, 255, 255);
      // 右节点（带一点蓝色内圈，暗示「另一端是 DSH」）
      const dr = (x - 0.695) ** 2 + (y - 0.5) ** 2;
      if (dr <= 0.105 ** 2) put(i, 255, 255, 255, 255);
      if (dr <= 0.048 ** 2) put(i, 59, 130, 246, 255);
      // 在线绿点
      const dg = (x - 0.795) ** 2 + (y - 0.205) ** 2;
      if (dg <= 0.058 ** 2) put(i, 34, 197, 94, 255);
    }
  }

  // 盒式降采样到目标尺寸
  const out = new Uint8Array(size * size * 4);
  const factor = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const o = ((y * factor + sy) * S + (x * factor + sx)) * 4;
          const alpha = data[o + 3] / 255;
          r += data[o] * alpha;
          g += data[o + 1] * alpha;
          b += data[o + 2] * alpha;
          a += alpha;
        }
      }
      const n = factor * factor;
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

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
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, drawRGBA(size));
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png);
  console.log(`icon-${size}.png ${png.length} bytes`);
}
