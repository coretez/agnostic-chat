'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OFFICIAL_DOMAINS = ['sec.gov', 'apple.com', 'amazon.com', 'broadcom.com', 'abc.xyz', 'jpmorganchase.com', 'jpmorgan.com', 'meta.com', 'fb.com', 'microsoft.com', 'nvidia.com', 'exxonmobil.com'];
const DATE_RE = /\b(?:20\d{2}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2})\b/i;

function officialDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.find((domain) => host === domain || host.endsWith(`.${domain}`)) || null;
  } catch { return null; }
}

function sourceUrl(row) {
  for (const key of ['url', 'source_url', 'primary_source_url']) if (/^https:\/\//i.test(String(row && row[key] || ''))) return String(row[key]);
  return '';
}

function declaredPrimary(row) {
  return /primary/i.test([row && row.kind, row && row.type, row && row.source_type, row && row.content_type, row && row.name].filter(Boolean).join(' '));
}

function datedSource(row) {
  const text = ['publication_date', 'published_at', 'published_date', 'date', 'data_freshness'].map((key) => row && row[key]).filter(Boolean).join(' ');
  return DATE_RE.test(text);
}

function collectRows(value, rows = []) {
  if (!value || typeof value !== 'object') return rows;
  if (!Array.isArray(value) && declaredPrimary(value) && sourceUrl(value)) rows.push(value);
  for (const child of Object.values(value)) collectRows(child, rows);
  return rows;
}

function evidenceFiles(root) {
  if (!root) return [];
  try { return fs.readdirSync(root).filter((name) => /^evidence.*\.json$/i.test(name)).map((name) => path.join(root, name)); }
  catch { return []; }
}

function declaredSources(root) {
  const rows = [];
  for (const file of evidenceFiles(root)) {
    try { collectRows(JSON.parse(fs.readFileSync(file, 'utf8')), rows); } catch {}
  }
  return rows.map((row) => ({ url: sourceUrl(row), genuine: !!officialDomain(sourceUrl(row)), domain: officialDomain(sourceUrl(row)), dated: datedSource(row) }));
}

async function reachable(url, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    return response.status >= 200 && response.status < 400;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

async function verifyPrimarySources({ root, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const sources = declaredSources(root);
  const checked = await Promise.all(sources.map(async (source) => ({ ...source, reachable: source.genuine && source.dated ? await reachable(source.url, fetchImpl, timeoutMs) : false })));
  const valid = checked.filter((source) => source.genuine && source.dated && source.reachable);
  return { ok: valid.length > 0, checked, valid, detail: valid.length ? `${valid.length} reachable, dated official primary source(s) verified` : `${checked.length} declared primary source(s) checked; none were simultaneously official, dated, and reachable` };
}

module.exports = { OFFICIAL_DOMAINS, officialDomain, datedSource, declaredSources, verifyPrimarySources };
