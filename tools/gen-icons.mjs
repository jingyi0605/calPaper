/*!
 * 算账稿纸 · PWA 图标生成器（零依赖，仅用 Node 内置 zlib）
 * ------------------------------------------------------------
 * 输入：icons/logo.png（512×512 圆角方形 + 白色 ¥）
 * 输出：
 *   icon-192.png / icon-512.png            purpose=any（保留原始圆角造型）
 *   icon-maskable-192.png / -512.png       purpose=maskable（满幅出血 + 安全区）
 *   apple-touch-icon.png (180)             iOS 主屏图标（不透明）
 *   favicon-32.png / favicon-16.png        浏览器标签页图标
 *
 * 用法：node tools/gen-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ============================ CRC32 ============================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ============================ PNG 解码 ============================ */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG 文件");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("仅支持 8 位 PNG，当前为 " + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error("不支持的色彩类型 " + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let i = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[i++];
    const line = new Uint8Array(raw.subarray(i, i + stride));
    i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (channels === 4) {
        out[o] = line[x * 4];
        out[o + 1] = line[x * 4 + 1];
        out[o + 2] = line[x * 4 + 2];
        out[o + 3] = line[x * 4 + 3];
      } else if (channels === 3) {
        out[o] = line[x * 3];
        out[o + 1] = line[x * 3 + 1];
        out[o + 2] = line[x * 3 + 2];
        out[o + 3] = 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = line[x];
        out[o + 3] = 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

/* ============================ PNG 编码 ============================ */

function encodePng(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const chunk = (type, payload) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, payload])));
    return Buffer.concat([len, t, payload, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ============================ 采样与缩放 ============================ */

/** 双线性采样；坐标以「像素中心 = 整数 + 0.5」为准，越界返回全透明 */
function sampleBilinear(src, u, v) {
  const { width: w, height: h, data } = src;
  if (u < 0 || v < 0 || u > w || v > h) return [0, 0, 0, 0];
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(u - 0.5)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(v - 0.5)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, u - 0.5 - x0));
  const fy = Math.min(1, Math.max(0, v - 0.5 - y0));

  const at = (x, y) => {
    const o = (y * w + x) * 4;
    return [data[o], data[o + 1], data[o + 2], data[o + 3]];
  };
  const p00 = at(x0, y0), p10 = at(x1, y0), p01 = at(x0, y1), p11 = at(x1, y1);

  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = p00[c] * (1 - fx) + p10[c] * fx;
    const bot = p01[c] * (1 - fx) + p11[c] * fx;
    out[c] = Math.round(top * (1 - fy) + bot * fy);
  }
  return out;
}

/** 面积平均缩放（预乘 alpha，避免透明边缘出现暗边） */
function resizeArea(src, dw, dh) {
  const { width: sw, height: sh, data } = src;
  const out = new Uint8Array(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = Math.floor((dy * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, aSum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * sw + sx) * 4;
          const al = data[o + 3] / 255;
          r += data[o] * al;
          g += data[o + 1] * al;
          b += data[o + 2] * al;
          aSum += al;
          n++;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (aSum > 0) {
        out[o] = Math.round(r / aSum);
        out[o + 1] = Math.round(g / aSum);
        out[o + 2] = Math.round(b / aSum);
        out[o + 3] = Math.round((aSum / n) * 255);
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/**
 * 满幅出血：把圆角之外的透明区域用底色（沿半径方向向内取样得到的渐变）填满，
 * 得到不带透明角的方形图标，供系统按自己的蒙版裁切。
 * 相比整体放大的做法，字形保持原始尺寸，不会溢出 maskable 安全区。
 */
function renderFullBleed(src, size) {
  const { width: w, height: h } = src;
  const cx = w / 2, cy = h / 2;
  const out = new Uint8Array(size * size * 4);

  // 半径方向的向内取样：透明处沿指向中心的方向找最近的实心像素
  function extendInward(u, v) {
    let t = 1;
    let last = [0, 0, 0, 0];
    for (let i = 0; i < 96; i++) {
      t -= 1 / 96;
      if (t <= 0) break;
      const p = sampleBilinear(src, cx + (u - cx) * t, cy + (v - cy) * t);
      last = p;
      if (p[3] === 255) return p;
    }
    return last;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * (w / size);
      const v = (y + 0.5) * (h / size);
      let p = sampleBilinear(src, u, v);
      if (p[3] < 255) p = extendInward(u, v);
      const o = (y * size + x) * 4;
      out[o] = p[0];
      out[o + 1] = p[1];
      out[o + 2] = p[2];
      out[o + 3] = 255;
    }
  }
  return { width: size, height: size, data: out };
}

/* ============================ 分析原图 ============================ */

/** 白色 ¥ 字形的外接矩形（源图坐标） */
function glyphBBox(src) {
  const { width: w, height: h, data } = src;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] > 200 && data[o] > 200 && data[o + 1] > 200 && data[o + 2] > 200) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/** 四个画布角是否已被底色填满（即圆角是否被推出画面） */
function cornersOpaque(img) {
  const { width: w, height: h, data } = img;
  const at = (x, y) => data[(y * w + x) * 4 + 3];
  const m = 1;
  return at(m, m) === 255 && at(w - 1 - m, m) === 255 &&
    at(m, h - 1 - m) === 255 && at(w - 1 - m, h - 1 - m) === 255;
}

/* ============================ 主流程 ============================ */

const logo = decodePng(readFileSync(join(ROOT, "icons", "logo.png")));
const bbox = glyphBBox(logo);

/** 字形四角是否落在 maskable 安全区（直径 80% 的居中圆）内 */
function glyphInSafeZone(size) {
  const half = size / 2;
  const R = size * 0.4;
  const sx = size / logo.width, sy = size / logo.height;
  return [[bbox.x0, bbox.y0], [bbox.x1, bbox.y0], [bbox.x0, bbox.y1], [bbox.x1, bbox.y1]]
    .every(([x, y]) => Math.hypot(x * sx - half, y * sy - half) <= R);
}

const maskable192 = renderFullBleed(logo, 192);
const maskable512 = renderFullBleed(logo, 512);

const outputs = [
  ["icon-192.png", resizeArea(logo, 192, 192)],
  ["icon-512.png", resizeArea(logo, 512, 512)],
  ["icon-maskable-192.png", maskable192],
  ["icon-maskable-512.png", maskable512],
  ["apple-touch-icon.png", renderFullBleed(logo, 180)],
  ["favicon-32.png", resizeArea(logo, 32, 32)],
  ["favicon-16.png", resizeArea(logo, 16, 16)]
];

for (const [name, img] of outputs) {
  writeFileSync(join(ROOT, "icons", name), encodePng(img));
}

// 自检：maskable 必须是不透明满幅；any 必须保留透明圆角
const checks = [
  ["maskable-512 四角不透明", cornersOpaque(maskable512)],
  ["maskable-512 无透明像素", (() => {
    for (let i = 3; i < maskable512.data.length; i += 4) if (maskable512.data[i] !== 255) return false;
    return true;
  })()],
  ["maskable-512 与 icon-512 不同", Buffer.compare(encodePng(maskable512), encodePng(outputs[1][1])) !== 0],
  ["字形在安全区内", glyphInSafeZone(512)],
  ["字形在 192 安全区内", glyphInSafeZone(192)]
];

console.log("源图尺寸:", logo.width + "×" + logo.height);
console.log("字形外接框:", JSON.stringify(bbox));
console.log("已生成:");
for (const [name, img] of outputs) console.log("  icons/" + name, img.width + "×" + img.height);
console.log("自检:");
for (const [label, ok] of checks) console.log("  " + (ok ? "✓" : "✗") + " " + label);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
