'use strict';

// O24 (first slice): deterministic TYPE conversion — html → pdf.
// The model composes ONCE (html); conversion is framework code, never a model
// call. Uses an offscreen, hardened BrowserWindow + printToPDF (in the
// runtime already — no new dependencies). Report HTML is self-contained by
// contract (O25: inline SVG, no external requests), so offline rendering is
// faithful; javascript stays disabled because a document is data, not an app.

const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Render an HTML file from the document library to a sibling .pdf.
 * @param {string} htmlPath absolute path to an existing .html document
 * @returns {Promise<{pdfPath: string, bytes: number}>}
 */
const LOAD_TIMEOUT_MS = 30000;

function validateHtmlPath(htmlPath) {
  const absolutePath = path.resolve(htmlPath);
  if (!fs.existsSync(absolutePath)) throw new Error(`no such file: ${htmlPath}`);
  if (path.extname(absolutePath).toLowerCase() !== '.html') throw new Error('htmlToPdf converts .html documents only');
  return absolutePath;
}

function createPdfWindow() {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      // Isolated, non-persisted session so the network deny below applies to
      // this render only and nothing is cached across documents.
      partition: 'render-pdf'
    }
  });
}

function blockRemoteResources(window) {
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file:|data:|chrome-extension:|devtools:)/i.test(details.url);
    callback({ cancel: !allowed });
  });
}

function loadWithTimeout(window, absolutePath) {
  const timeout = new Promise((_, reject) => setTimeout(
    () => reject(new Error(`render timed out after ${LOAD_TIMEOUT_MS / 1000}s`)), LOAD_TIMEOUT_MS
  ));
  return Promise.race([window.loadFile(absolutePath), timeout]);
}

async function renderPdfBuffer(window) {
  return window.webContents.printToPDF({
    printBackground: true, pageSize: 'Letter',
    margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
  });
}

async function htmlToPdf(htmlPath) {
  const absolutePath = validateHtmlPath(htmlPath);
  const window = createPdfWindow();
  try {
    // ENFORCE the self-contained contract (O25) instead of trusting it: only
    // file:// and data: subresources load. A document with a remote <img> —
    // an exfiltration beacon and a determinism hole — renders without it.
    blockRemoteResources(window);
    await loadWithTimeout(window, absolutePath);
    const buffer = await renderPdfBuffer(window);
    const pdfPath = absolutePath.slice(0, -'.html'.length) + '.pdf';
    fs.writeFileSync(pdfPath, buffer);
    return { pdfPath, bytes: buffer.length };
  } finally {
    window.destroy();
  }
}

module.exports = { htmlToPdf };
