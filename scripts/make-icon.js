'use strict';

// Render build/icon.svg → build/icon.png (1024×1024, transparent) using Electron's
// own Chromium, then the shell wraps it into an .icns. Run with:
//   ./node_modules/.bin/electron scripts/make-icon.js
// No external SVG rasterizer needed.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const PAD = 0.08; // 8% breathing room around the emblem

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
  const inner = Math.round(SIZE * (1 - 2 * PAD));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
    .wrap{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}
    .wrap svg{width:${inner}px;height:${inner}px;display:block}
  </style></head><body><div class="wrap">${svg}</div></body></html>`;

  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: false }
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300)); // let the SVG paint

  let img = await win.webContents.capturePage();
  img = img.resize({ width: SIZE, height: SIZE, quality: 'best' }); // normalize off HiDPI
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.toPNG());

  const size = img.getSize();
  console.log(`[icon] wrote build/icon.png (${size.width}x${size.height})`);
  app.quit();
});
