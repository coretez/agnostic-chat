'use strict';

const { PROVIDERS, registryList } = require('./registry');
const { openaiCompat } = require('./openai-compat');
const { anthropic } = require('./anthropic');

/**
 * Build a connector for a resolved connection.
 * @param {{type:string, base_url?:string, baseUrl?:string}} conn
 * @param {string} key  decrypted secret (main process only)
 */
function validateGuardCompatibility(guard, providerDefinition, providerType) {
  if (!guard?.enabled) return;
  // Guards are wire-protocol adapters, not vendor allowlists. Trylon speaks
  // two protocols — an OpenAI-compatible /v1 route and a distinct /anthropic
  // route — and forwards the request body verbatim to whatever upstream the
  // gateway operator configured. So the gate is the connection's STYLE, which
  // is what actually has to match; gating on `type` locked out Qwen, Kimi and
  // Gemini, which are all OpenAI-compatible and route fine.
  if (!['openai', 'anthropic'].includes(providerDefinition.style)) {
    throw new Error(`${guard.label || 'The enabled LLM guard'} cannot route ${providerDefinition.label || providerType}: no matching wire protocol. Disable the guard or select another connection.`);
  }
  if (guard.kind !== 'trylon' && providerDefinition.style !== 'openai') {
    throw new Error('The enabled LLM guard supports OpenAI-compatible connections only. Disable the guard or select an OpenAI-compatible model connection.');
  }
}

function routedBaseUrl(conn, providerDefinition, guard) {
  let baseUrl = conn.base_url || conn.baseUrl || providerDefinition.baseUrl;
  if (guard?.enabled) {
    baseUrl = guard.base_url;
    if (guard.kind === 'trylon' && providerDefinition.style === 'anthropic') {
      baseUrl = `${String(baseUrl).replace(/\/v1\/?$/i, '').replace(/\/+$/, '')}/anthropic`;
    }
  }
  return baseUrl;
}

function createProviderConnector(conn, key, guard, guardKey) {
  const providerDefinition = PROVIDERS[conn.type];
  if (!providerDefinition) throw new Error(`Unknown provider type: ${conn.type}`);
  validateGuardCompatibility(guard, providerDefinition, conn.type);
  const baseUrl = routedBaseUrl(conn, providerDefinition, guard);
  const effectiveKey = guard?.enabled && guard.kind !== 'trylon' && guard.auth_mode === 'bearer' ? guardKey : key;
  const connector = providerDefinition.style === 'anthropic'
    ? anthropic({ baseUrl, key: effectiveKey })
    : openaiCompat({ baseUrl, key: effectiveKey });
  return { connector, providerDefinition };
}

function blockedDirection(result, guard, providerDefinition) {
  const metadata = result?.guardMeta;
  const blocked = result?.finishReason === 'content_filter' || metadata?.blocked;
  if (!blocked) return { blocked: false, direction: null };
  if (metadata?.stage) return { blocked: true, direction: metadata.stage === 'input' ? 'outbound' : metadata.stage === 'output' ? 'inbound' : 'unknown' };
  const resultId = typeof result?.raw?.id === 'string' ? result.raw.id : '';
  const direction = guard.kind === 'trylon' && providerDefinition.style === 'openai'
    ? (resultId.startsWith('trylon-blocked-') ? 'outbound' : 'inbound') : 'unknown';
  return { blocked: true, direction };
}

function auditDetail(result, direction) {
  const metadata = result?.guardMeta;
  return [
    direction ? `direction=${direction}` : null,
    result?.finishReason ? `finish_reason=${result.finishReason}` : null,
    metadata?.safetyCode ? `safety_code=${metadata.safetyCode}` : null,
    metadata?.action ? `action=${metadata.action}` : null,
    metadata?.requestId ? `request_id=${metadata.requestId}` : null,
    metadata?.blocked && metadata?.message ? metadata.message : null
  ].filter(Boolean).join(' · ') || null;
}

function attachSecurityResult(result, guard, blocked, direction, auditId) {
  if (!blocked || !result) return;
  const metadata = result.guardMeta;
  result.security = {
    blocked: true, direction,
    stage: direction === 'outbound' ? 'llm_firewall' : direction === 'inbound' ? 'gate_guard' : 'guard',
    decision: 'blocked', message: metadata?.message || result.text || 'Model traffic was blocked by the configured guard.',
    safetyCode: metadata?.safetyCode ? String(metadata.safetyCode) : null,
    action: metadata?.action ? String(metadata.action) : null,
    requestId: metadata?.requestId ? String(metadata.requestId) : null,
    auditId: Number(auditId) || null, guardLabel: guard.label || 'LLM guard'
  };
}

function createAuditor(guard, providerDefinition, onAudit) {
  return async function auditProviderCall(operation, providerCall, model = null) {
    const started = Date.now();
    try {
      const result = await providerCall();
      const { blocked, direction } = blockedDirection(result, guard, providerDefinition);
      const auditId = onAudit({ operation, model, decision: blocked ? 'blocked' : 'allowed', durationMs: Date.now() - started, detail: auditDetail(result, direction) });
      attachSecurityResult(result, guard, blocked, direction, auditId);
      return result;
    } catch (error) {
      const detail = error?.status ? `HTTP ${error.status}` : (error?.code ? String(error.code) : 'guard call failed');
      onAudit({ operation, model, decision: 'error', durationMs: Date.now() - started, detail });
      throw error;
    }
  };
}

async function guardedChat(connector, guard, input) {
  if (guard.kind !== 'trylon' || typeof input?.onDelta !== 'function') return connector.chat(input);
  const onDelta = input.onDelta;
  const result = await connector.chat({ ...input, onDelta: undefined });
  if (result?.text && result.finishReason !== 'content_filter' && !result.guardMeta?.blocked) onDelta({ text: result.text });
  return result;
}

function getConnector(conn, key, { guard = null, guardKey = null, onAudit = null } = {}) {
  const { connector, providerDefinition } = createProviderConnector(conn, key, guard, guardKey);
  if (!guard?.enabled || typeof onAudit !== 'function') return connector;
  const audited = createAuditor(guard, providerDefinition, onAudit);

  return {
    listModels: () => audited('models', () => connector.listModels()),
    chat: (input) => audited('chat', () => guardedChat(connector, guard, input), input?.model)
  };
}

/**
 * Verify a connection works. Tries a live model list; if the provider doesn't
 * expose /models, falls back to a 1-token chat ping against `probeModel`.
 * @returns {Promise<{ok:boolean, models?:string[], error?:string}>}
 */
async function testConnection(conn, key, probeModel) {
  const connector = getConnector(conn, key);
  try {
    const models = await connector.listModels();
    if (models.length) return { ok: true, models };
  } catch (modelsErr) {
    const model = probeModel || conn.default_model || PROVIDERS[conn.type]?.fallbackModels?.[0];
    if (model) {
      try {
        await connector.chat({ model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 });
        return { ok: true, models: [] };
      } catch (chatErr) {
        return { ok: false, error: chatErr.message };
      }
    }
    return { ok: false, error: modelsErr.message };
  }
  return { ok: true, models: [] };
}

module.exports = { getConnector, testConnection, registryList, PROVIDERS };
