'use strict';

// Built-in internet access for the model — no API key required:
//
//   web_search  DuckDuckGo's HTML endpoint, parsed to {title, url, snippet}
//   fetch_url   GET a page, strip it to readable text
//
// Synthetic tools like save_document/set_variable: routed in ipc.js before
// MCP, results flow through the same filter/trace/capture path. Network is
// outbound-read-only; responses are size- and time-capped so a slow or huge
// page can never wedge a turn.

const TIMEOUT_MS = 20000;
const MAX_BODY = 1500000;   // bytes read off the wire
const MAX_TEXT = 20000;     // chars returned (filter caps again at 24k)
const MAX_RESULTS = 8;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const WEB_TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the web (DuckDuckGo). Returns up to 8 results as title, url, and snippet. '
      + 'Use for current information, library documentation, error messages, and anything '
      + 'outside your training data. Follow up with fetch_url to read a promising result.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a web page and return its readable text (HTML stripped, scripts removed, '
      + 'capped at ~20k chars). Use after web_search, or directly when you know the URL — '
      + 'docs pages, changelogs, README files.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL to fetch.' } },
      required: ['url']
    }
  }
];

const names = new Set(WEB_TOOLS.map((t) => t.name));

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** DDG result links are redirects (//duckduckgo.com/l/?uddg=<enc>) — unwrap. */
function unwrapDdg(href) {
  const m = String(href).match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch {} }
  return href.startsWith('//') ? 'https:' + href : href;
}

/** Parse DuckDuckGo's html endpoint into structured results. Exported for tests. */
function parseDdg(html) {
  const results = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/g;
  const strip = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const snippets = [];
  let m;
  while ((m = snipRe.exec(html))) snippets.push(strip(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html)) && results.length < MAX_RESULTS) {
    const url = unwrapDdg(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: strip(m[2]), url, snippet: snippets[i] || '' });
    i++;
  }
  return results;
}

/** Strip a page to readable text. Exported for tests. */
function htmlToText(html) {
  let t = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t)
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n… [truncated]' : t;
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// fetch_url is model-directed: a hostile page can steer the model at localhost
// or the intranet (including this app's own transient OAuth loopback server
// and dev servers). Every hop — original URL and each redirect — must resolve
// to a public address before it is fetched. DNS-rebinding TOCTOU remains
// (lookup and fetch are separate resolutions) — accepted for a desktop tool.
const dnsp = require('node:dns').promises;
const net = require('node:net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || a === 0
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (/^(fc|fd)/.test(s)) return true;                       // ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return true;                      // link-local fe80::/10
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)); // v4-mapped
  return false;
}

async function assertPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(`invalid URL: ${u}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s) URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost$|.+\.(local|localhost|internal|home\.arpa)$)/i.test(host)) throw new Error(`refusing to fetch ${host} — local network`);
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`refusing to fetch ${host} — private/loopback address`);
    return url;
  }
  let addrs;
  try { addrs = await dnsp.lookup(host, { all: true, verbatim: true }); } catch { throw new Error(`cannot resolve ${host}`); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error(`refusing to fetch ${host} — resolves to a private/loopback address`);
  }
  return url;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function fetchCapped(url, { maxRedirects = 5 } = {}) {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);           // every hop re-checked
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(current, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, redirect: 'manual', signal: ctrl.signal });
      if (REDIRECT_STATUS.has(res.status)) {
        const loc = res.headers.get('location');
        if (!loc || hop >= maxRedirects) return { status: res.status, body: '' };
        current = new URL(loc, current).toString();
        continue;
      }
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) return { status: res.status, body: await res.text() };
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
        if (size >= MAX_BODY) { try { ctrl.abort(); } catch {} break; }
      }
      return { status: res.status, body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
    } finally { clearTimeout(to); }
  }
}

async function call(name, args = {}) {
  try {
    if (name === 'web_search') {
      const q = String(args.query || '').trim();
      if (!q) return { text: 'web_search: no query given.', isError: true };
      const { status, body } = await fetchCapped('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
      if (status !== 200) return { text: `web_search: search endpoint returned HTTP ${status}.`, isError: true };
      const results = parseDdg(body);
      if (!results.length) return { text: `No results for "${q}".` };
      return { text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n') };
    }
    if (name === 'fetch_url') {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { text: 'fetch_url: an absolute http(s) URL is required.', isError: true };
      const { status, body } = await fetchCapped(url);
      const text = htmlToText(body);
      if (status >= 400) return { text: `HTTP ${status} from ${url}\n${text.slice(0, 2000)}`, isError: true };
      return { text: text || '(page had no readable text)' };
    }
    return { text: `unknown web tool: ${name}`, isError: true };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s or exceeded the size cap` : (e && e.message) || 'failed';
    return { text: `${name} failed: ${msg}`, isError: true };
  }
}

module.exports = { WEB_TOOLS, names, call, parseDdg, htmlToText, unwrapDdg, isPrivateIp, assertPublicUrl };
