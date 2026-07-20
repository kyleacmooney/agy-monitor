#!/usr/bin/env node
"use strict";
/*
 * make-icon.js — dependency-free generator for the "Agy Monitor" app icon.
 *
 * Writes valid RGBA PNGs (hand-rolled encoder: zlib deflate + correct CRC32) of a dark
 * rounded square with a lighter geometric "pulse" motif — a center dot ringed by two
 * concentric circles — at every size iconutil wants, into an .iconset directory.
 * make-app.sh then runs `iconutil -c icns` on that directory to produce app.icns.
 *
 * Usage:
 *   node scripts/make-icon.js <out-iconset-dir>
 *
 * Emits (per Apple's .iconset naming): icon_16x16.png, icon_16x16@2x.png,
 *   icon_32x32.png, icon_32x32@2x.png, icon_128x128.png, icon_128x128@2x.png,
 *   icon_256x256.png, icon_256x256@2x.png, icon_512x512.png, icon_512x512@2x.png.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// --- PNG CRC32 (polynomial 0xEDB88320) ---
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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // per-scanline filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- Geometry, all in normalized [0,1] coordinates centered at 0.5 ---
const MARGIN = 0.055;          // padding around the rounded square
const CORNER = 0.205;          // corner radius (fraction of canvas)
const HALF = 0.5 - MARGIN;     // half-extent of the square per axis
const DARK = [22, 26, 37];     // rounded-square fill (#161a25)
const DOT = { r: 0.052, color: [128, 234, 216] };            // center dot
const RINGS = [
  { r: 0.165, t: 0.040, color: [104, 214, 220] },            // inner pulse ring
  { r: 0.280, t: 0.032, color: [82, 168, 206] },             // outer pulse ring
];

// Signed distance to the rounded square (<= 0 means inside).
function roundRectSdf(px, py) {
  const qx = Math.abs(px - 0.5) - (HALF - CORNER);
  const qy = Math.abs(py - 0.5) - (HALF - CORNER);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - CORNER;
}

// Accent color at a point, or null if this point is plain background.
function motifColor(px, py) {
  const d = Math.hypot(px - 0.5, py - 0.5);
  if (d <= DOT.r) return DOT.color;
  for (const ring of RINGS) {
    if (Math.abs(d - ring.r) <= ring.t / 2) return ring.color;
  }
  return null;
}

// Render one square RGBA buffer at `size` px, supersampled for anti-aliased edges.
function renderIcon(size) {
  const SS = 4; // 4x4 subsamples per pixel
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0; // premultiplied accumulators
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (roundRectSdf(px, py) > 0) continue; // outside the square → transparent
          const c = motifColor(px, py) || DARK;
          sr += c[0]; sg += c[1]; sb += c[2]; sa += 1;
        }
      }
      const total = SS * SS;
      const i = (y * size + x) * 4;
      if (sa === 0) { rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0; continue; }
      // Un-premultiply RGB (average over covered subsamples); alpha = coverage.
      rgba[i] = Math.round(sr / sa);
      rgba[i + 1] = Math.round(sg / sa);
      rgba[i + 2] = Math.round(sb / sa);
      rgba[i + 3] = Math.round((sa / total) * 255);
    }
  }
  return rgba;
}

// .iconset entries: [filename, pixel size]
const SPECS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/make-icon.js <out-iconset-dir>");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // Cache by pixel size — several specs share a size (e.g. 32, 256, 512).
  const cache = new Map();
  for (const [name, size] of SPECS) {
    if (!cache.has(size)) cache.set(size, encodePng(size, size, renderIcon(size)));
    fs.writeFileSync(path.join(outDir, name), cache.get(size));
  }
  console.log(`✓ wrote ${SPECS.length} PNGs to ${outDir}`);
}

main();
