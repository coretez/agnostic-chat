'use strict';

// O31 — the Librarian: the organization layer that keeps a growing project
// findable. Documents pile up and sessions pile up; a flat list stops working
// around twenty items. One fast-model call files each artifact — normalizing
// its metadata against the project's EXISTING vocabulary and assigning faceted
// tags — and deterministic validation decides what actually lands.
//
// Two invariants, both structural:
//   1. The LLM chooses meaning, never location. Disk placement stays the
//      deterministic template (documents.js) fed by the normalized metadata;
//      organization beyond that is virtual (tags), so nothing ever moves on
//      disk and .versions/ chains never break.
//   2. Filing can never break a save or a turn. Any failure — model error,
//      junk output, no fast model — degrades to "saved unfiled" ({}).
//
// Vocabulary preference is enforced HERE, not just requested in the prompt:
// a proposed tag whose slug matches an existing tag reuses it, so
// "Monthly Report" / "monthly_report" / "monthly-reports" can't fork the
// vocabulary even when the model ignores instructions.

const FACETS = ['topic', 'kind', 'entity', 'period', 'status'];
const MAX_TAGS = 5;

function slug(s) {
  return String(s == null ? '' : s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const FILE_DOCUMENT_TOOL = {
  name: 'file_document',
  description: 'File this document: normalized metadata plus faceted tags. Prefer the existing vocabulary EXACTLY as listed; invent a new value only when nothing listed fits.',
  inputSchema: {
    type: 'object',
    properties: {
      doc_type: { type: 'string', description: 'Normalized document type (kind), e.g. "monthly-report", "investigation". Reuse an existing type when one fits.' },
      entity: { type: 'string', description: 'The tenant/customer/company/system this is about, if any. Reuse existing spelling.' },
      period: { type: 'string', description: 'Reporting period or date if the document has one, e.g. "2026-08".' },
      tags: {
        type: 'array',
        description: `Up to ${MAX_TAGS} faceted tags. Facets: ${FACETS.join(' | ')}.`,
        items: {
          type: 'object',
          properties: {
            facet: { type: 'string', description: FACETS.join(' | ') },
            name: { type: 'string', description: 'Short tag name. Reuse existing vocabulary exactly when it fits.' }
          },
          required: ['facet', 'name']
        }
      }
    },
    required: ['tags']
  }
};

const FILE_SESSION_TOOL = {
  name: 'file_session',
  description: 'File this chat session: a title (if it needs one), a one-line summary, and faceted tags. Prefer the existing vocabulary EXACTLY as listed.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short session title (≤60 chars) — only if the current one is missing or generic.' },
      summary: { type: 'string', description: 'ONE sentence: what this session is about / produced.' },
      tags: FILE_DOCUMENT_TOOL.inputSchema.properties.tags
    },
    required: ['summary', 'tags']
  }
};

/** Render the project's tag vocabulary + known doc types for the prompt. */
function renderVocabulary({ tags = [], docTypes = [], entities = [] }) {
  const byFacet = {};
  for (const t of tags) (byFacet[t.facet] = byFacet[t.facet] || []).push(t.name);
  const parts = [];
  for (const f of FACETS) if (byFacet[f] && byFacet[f].length) parts.push(`${f}: ${[...new Set(byFacet[f])].slice(0, 30).join(', ')}`);
  if (docTypes.length) parts.push(`document types in use: ${[...new Set(docTypes)].slice(0, 20).join(', ')}`);
  if (entities.length) parts.push(`entities in use: ${[...new Set(entities)].slice(0, 20).join(', ')}`);
  return parts.length ? `EXISTING VOCABULARY (reuse these exact values whenever they fit — a near-duplicate spelling rots the library):\n${parts.join('\n')}` : '(no vocabulary yet — this is the first filing; choose plain, reusable names)';
}

/** Deterministic validation: known facets, slugged non-empty names, capped,
 *  deduped by (facet, slug), existing-vocabulary spellings win. */
function validateTags(raw, existing = []) {
  const bySlug = new Map(existing.map((t) => [`${t.facet}:${t.slug}`, t.name]));
  const out = [];
  const seen = new Set();
  for (const t of (Array.isArray(raw) ? raw : [])) {
    if (out.length >= MAX_TAGS) break;
    const facet = FACETS.includes(t && t.facet) ? t.facet : null;
    const s = slug(t && t.name);
    if (!facet || !s) continue;
    const key = `${facet}:${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ facet, name: bySlug.get(key) || String(t.name).trim().slice(0, 80) });
  }
  return out;
}

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

async function callForced(connector, model, content, tool) {
  let r;
  try {
    r = await connector.chat({ model, messages: [{ role: 'user', content }], tools: [tool], forceTool: true, maxTokens: 600 });
  } catch {
    r = await connector.chat({ model, messages: [{ role: 'user', content }], tools: [tool], maxTokens: 600 });
  }
  const call = (r.toolCalls || [])[0];
  return call && call.args && typeof call.args === 'object' ? call.args : null;
}

/**
 * Normalize a document's metadata + tags before placement.
 * @returns {Promise<{docType?, entity?, period?, tags: Array<{facet,name}>}>}
 *   {} -shaped no-op on any failure — filing never breaks a save.
 */
async function fileDocument({ connector, model, meta = {}, contentHead = '', vocabulary = {} }) {
  try {
    const prompt =
      `You are the librarian of a project's document library. File the document below so the library stays organized: normalize its metadata and assign faceted tags.\n\n`
      + renderVocabulary(vocabulary) + '\n\n'
      + `DOCUMENT\ntitle: ${clip(meta.title, 200)}\ndeclared type: ${clip(meta.type, 80) || '(none)'}\n`
      + `declared properties: ${clip(JSON.stringify(meta.properties || {}), 300)}\n`
      + `content head:\n${clip(contentHead, 1500)}\n\nCall file_document now.`;
    const args = await callForced(connector, model, prompt, FILE_DOCUMENT_TOOL);
    if (!args) return { tags: [] };
    const existing = vocabulary.tags || [];
    const out = { tags: validateTags(args.tags, existing) };
    // Normalized metadata only when it slugs to something real; existing
    // doc-type spellings win over fresh coinage (same rule as tags).
    if (args.doc_type && slug(args.doc_type)) {
      const s = slug(args.doc_type);
      const known = (vocabulary.docTypes || []).find((d) => slug(d) === s);
      out.docType = known || s;
    }
    if (args.entity && String(args.entity).trim()) {
      const s = slug(args.entity);
      const known = (vocabulary.entities || []).find((e) => slug(e) === s);
      out.entity = known || String(args.entity).trim().slice(0, 80);
    }
    if (args.period && String(args.period).trim()) out.period = String(args.period).trim().slice(0, 40);
    return out;
  } catch (e) {
    console.error('[librarian:document]', e && e.message);
    return { tags: [] };
  }
}

/**
 * File a chat session: title (when missing/generic), one-line summary, tags.
 * @returns {Promise<{title?, summary?, tags: Array<{facet,name}>}>}
 */
async function fileSession({ connector, model, messages = [], currentTitle = '', vocabulary = {} }) {
  try {
    const digest = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => `${m.role.toUpperCase()}: ${clip(m.content, 400)}`)
      .join('\n');
    if (!digest) return { tags: [] };
    const prompt =
      `You are the librarian of a project's chat sessions. File the session below so the session list stays organized and findable.\n\n`
      + renderVocabulary(vocabulary) + '\n\n'
      + `CURRENT TITLE: ${clip(currentTitle, 100) || '(untitled)'}\n\nSESSION (recent turns):\n${digest}\n\nCall file_session now.`;
    const args = await callForced(connector, model, prompt, FILE_SESSION_TOOL);
    if (!args) return { tags: [] };
    const out = { tags: validateTags(args.tags, vocabulary.tags || []) };
    if (args.summary && String(args.summary).trim()) out.summary = clip(String(args.summary).replace(/\s+/g, ' '), 200);
    if (args.title && String(args.title).trim() && String(args.title).trim().length >= 3) out.title = clip(String(args.title).replace(/\s+/g, ' '), 60);
    return out;
  } catch (e) {
    console.error('[librarian:session]', e && e.message);
    return { tags: [] };
  }
}

module.exports = { fileDocument, fileSession, validateTags, renderVocabulary, FILE_DOCUMENT_TOOL, FILE_SESSION_TOOL, FACETS, MAX_TAGS, slug };
