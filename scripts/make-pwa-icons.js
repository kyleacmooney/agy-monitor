#!/usr/bin/env node
"use strict";
/*
 * make-pwa-icons.js — write the PWA / installed-app icons into public/.
 *
 * Reuses the same dependency-free renderer as the macOS app icon (make-icon.js)
 * so the browser tab, the "Install app" dialog, and the standalone-window dock
 * icon all match app.icns. Emits public/icon-192.png and public/icon-512.png,
 * the two sizes a web app manifest needs to be installable in Chrome.
 *
 * Usage: node scripts/make-pwa-icons.js   (run after changing the icon geometry)
 */
const fs = require("fs");
const path = require("path");
const { encodePng, renderIcon } = require("./make-icon");

const OUT = path.join(__dirname, "..", "public");
const SIZES = [192, 512];

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, size, renderIcon(size)));
  console.log(`✓ wrote ${path.relative(path.join(__dirname, ".."), file)}`);
}
