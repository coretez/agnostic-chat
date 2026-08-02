'use strict';

const { PROVIDERS, registryList } = require('./registry');
const { openaiCompat } = require('./openai-compat');
const { anthropic } = require('./anthropic');

/**
 * Build a connector for a resolved connection.
 * @param {{type:string, base_url?:string, baseUrl?:string}} conn
 * @param {string} key  decrypted secret (main process only)
 */
function getConnector(conn, key) {
  const type = conn.type;
  const def = PROVIDERS[type];
  if (!def) throw new Error(`Unknown provider type: ${type}`);
  const baseUrl = conn.base_url || conn.baseUrl || def.baseUrl;
  if (def.style === 'anthropic') return anthropic({ baseUrl, key });
  return openaiCompat({ baseUrl, key });
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
