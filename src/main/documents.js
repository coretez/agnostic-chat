'use strict';

// Generated-document placement + on-disk write.
//
// The AI supplies semantic metadata (type, title, tenant, period, …) when it calls
// save_document; THIS module deterministically turns that metadata into a path via a
// user-configurable template, and writes the file — versioning any prior copy into a
// sibling .versions/ folder. Files live in a real, findable place (see resolveOutputDir),
// never an opaque app-data folder.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_TEMPLATE = 'documents/{type}/{tenant}/{title}-{period}.{ext}';

/** Default root for the whole app's documents (user-overridable via settings). */
function defaultBase() {
  // Product renamed to Shamrock. An existing library at the old path keeps
  // working — renaming the default would strand every document already
  // written there.
  const legacy = path.join(os.homedir(), 'Documents', 'Agnostic Chat');
  try { if (fs.existsSync(legacy)) return legacy; } catch {}
  return path.join(os.homedir(), 'Documents', 'Shamrock');
}

/** Where a project's documents live: explicit per-project output_dir, else <base>/<project>. */
function resolveOutputDir(project, base) {
  if (project && project.output_dir) return project.output_dir;
  const root = base || defaultBase();
  const name = (project && project.name) ? project.name : 'Project';
  return path.join(root, name.replace(/[/\\:]/g, '-').trim() || 'Project');
}

function slugSeg(s) {
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function extFor(format, mime) {
  const f = String(format || '').toLowerCase();
  if (/html?/.test(f)) return 'html';
  if (/^(md|markdown)$/.test(f)) return 'md';
  if (f === 'json') return 'json';
  if (f === 'txt' || f === 'text') return 'txt';
  if (/^[a-z0-9]{1,5}$/.test(f)) return f;
  const m = String(mime || '').toLowerCase();
  if (m.includes('html')) return 'html';
  if (m.includes('markdown')) return 'md';
  if (m.includes('json')) return 'json';
  return 'txt';
}
function mimeFor(ext) {
  return {
    html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown',
    json: 'application/json', txt: 'text/plain', csv: 'text/csv',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pdf: 'application/pdf', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'
  }[ext] || 'text/plain';
}

/**
 * The mime a file should be READ as.
 *
 * A stored mime is only trusted when it is actually a mime type. Uploads were
 * indexed with a hardcoded label — older rows say "text", newer ones say
 * "text/plain" — regardless of what was uploaded, so an HTML file opened as
 * source text instead of rendering. The extension is the more reliable signal
 * whenever the stored value is missing or malformed, and using it here repairs
 * the rows already on disk without a migration.
 */
function mimeForPath(filePath, storedMime = null) {
  const stored = String(storedMime || '').trim().toLowerCase();
  const ext = path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
  const derived = ext ? mimeFor(ext) : null;
  // "text" is not a mime type; neither is "". Anything without a slash is a
  // label somebody typed, not a declaration worth honouring over the extension.
  if (!stored.includes('/')) return derived || 'text/plain';
  // A generic stored mime loses to a specific extension: every upload claims
  // text/plain, and .html is a stronger statement than that.
  if ((stored === 'text/plain' || stored === 'application/octet-stream') && derived) return derived;
  return stored;
}

// Fill a template into a relative path. Placeholders: {type} {tenant} {period} {title} {ext}.
// Empty non-filename segments are dropped (a missing {tenant} must not leave a blank dir);
// leftover separators from empty placeholders (e.g. "{title}-{period}" with no period) are cleaned.
function placementPath(template, meta = {}) {
  const props = meta.properties || {};
  const ext = extFor(meta.format, meta.mime);
  const vals = {
    type: slugSeg(meta.type || 'document') || 'document',
    tenant: slugSeg(props.tenant || props.company || ''),
    period: slugSeg(props.period || props.date || ''),
    title: slugSeg(meta.title || 'untitled') || 'untitled',
    ext
  };
  const segs = String(template || DEFAULT_TEMPLATE).split('/');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const isFile = i === segs.length - 1;
    let seg = segs[i].replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? vals[k] : ''))
      .replace(/-{2,}/g, '-').replace(/-(\.)/g, '$1').replace(/^-+|-+$/g, '');
    if (isFile) {
      if (!seg || seg === '.' + ext || seg.startsWith('.')) seg = `${vals.title}.${ext}`;
      if (!path.extname(seg)) seg += '.' + ext;
      out.push(seg);
    } else if (seg) out.push(seg);
  }
  return out.join('/');
}

/**
 * Write content at an exact path, versioning any existing file into a sibling
 * .versions/ folder. The primitive under writeDocument, also used directly for
 * fixed-location canonical docs (project-docs.js).
 * @returns {{absPath, version}}
 */
function writeFileVersioned(absPath, content) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  let version = 1;
  if (fs.existsSync(absPath)) {
    const vdir = path.join(dir, '.versions');
    fs.mkdirSync(vdir, { recursive: true });
    const extname = path.extname(absPath);
    const base = path.basename(absPath, extname);
    let n = 1;
    while (fs.existsSync(path.join(vdir, `${base}.v${n}${extname}`))) n++;
    fs.renameSync(absPath, path.join(vdir, `${base}.v${n}${extname}`));
    version = n + 1;
  }
  fs.writeFileSync(absPath, String(content == null ? '' : content), 'utf8');
  return { absPath, version };
}

/**
 * Write content under outputDir per the template, versioning any existing file.
 * @returns {{absPath, relPath, version, mime, ext}}
 */
function writeDocument({ outputDir, template, meta = {}, content }) {
  const relPath = placementPath(template, meta);
  const absPath = path.join(outputDir, relPath);
  const ext = extFor(meta.format, meta.mime);
  const w = writeFileVersioned(absPath, content);
  return { absPath: w.absPath, relPath, version: w.version, mime: mimeFor(ext), ext };
}

module.exports = { DEFAULT_TEMPLATE, defaultBase, resolveOutputDir, placementPath, writeDocument, writeFileVersioned, slugSeg, extFor, mimeFor, mimeForPath };
