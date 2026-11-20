/* 生成 App 图标 PNG（无第三方依赖，手写 PNG 编码） */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 绘图 ---------- */
const C1 = [74, 107, 253];
const C2 = [124, 58, 237];
const C3 = [56, 40, 180];
const DOT = [61, 86, 232];
const WHITE = [255, 255, 255];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, x - (x1 - r), 0);
  const dy = Math.max(y0 + r - y, y - (y1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** 单个采样点颜色（归一化坐标 0..1） */
function sample(x, y) {
  // 底色：对角渐变
  let t = clamp01(x * 0.72 + y * 0.55);
  t = t * t * (3 - 2 * t); // smoothstep
  let col = mix(C1, C2, t);

  // 右下压暗，增加体积感
  const vd = Math.hypot(x - 1.05, y - 1.05) / 1.2;
  col = mix(col, C3, clamp01(1 - vd) * 0.35);

  // 左上高光
  const hd = Math.hypot(x - 0.24, y - 0.14) / 0.62;
  if (hd < 1) {
    const k = Math.pow(1 - hd, 2.2) * 0.22;
    col = mix(col, WHITE, k);
  }

  // 对话气泡（白色圆角矩形 + 尾巴）
  const bubble = inRoundRect(x, y, 0.185, 0.245, 0.815, 0.635, 0.105);
  const tail = inTriangle(x, y, 0.285, 0.585, 0.285, 0.775, 0.475, 0.625);
  if (bubble || tail) {
    // 气泡内三个圆点
    const cy = 0.442;
    for (const cx of [0.345, 0.5, 0.655]) {
      if (Math.hypot(x - cx, y - cy) <= 0.027) return DOT;
    }
    // 气泡内轻微渐变，避免死白
    const g = clamp01((y - 0.245) / 0.45);
    return mix(WHITE, [232, 236, 255], g * 0.55);
  }

  return col;
}

function render(size, ss = 4) {
  const N = size * ss;
  const acc = new Float64Array(size * size * 3);
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5) / N;
      const y = (py + 0.5) / N;
      const c = sample(x, y);
      const di = ((py / ss) | 0) * size + ((px / ss) | 0);
      acc[di * 3] += c[0];
      acc[di * 3 + 1] += c[1];
      acc[di * 3 + 2] += c[2];
    }
  }
  const n = ss * ss;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = Math.round(acc[i * 3] / n);
    buf[i * 4 + 1] = Math.round(acc[i * 3 + 1] / n);
    buf[i * 4 + 2] = Math.round(acc[i * 3 + 2] / n);
    buf[i * 4 + 3] = 255;
  }
  return encodePNG(size, size, buf);
}

for (const size of [180, 512, 1024]) {
  const png = render(size, size >= 512 ? 3 : 4);
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`icon-${size}.png  ${(png.length / 1024).toFixed(1)} KB`);
}
