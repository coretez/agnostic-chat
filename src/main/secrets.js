'use strict';

const { safeStorage } = require('electron');

/**
 * Encrypt/decrypt secrets (API keys, tokens) using the OS keychain via
 * Electron's safeStorage. Plaintext secrets never touch the database or disk.
 *
 * On macOS this is backed by the Keychain; on Windows by DPAPI; on Linux by
 * the configured keyring (falls back to a basic scheme if none is available).
 */

function assertAvailable() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS secure storage is not available; refusing to store secrets in plaintext.'
    );
  }
}

/**
 * @param {string} plaintext
 * @returns {Buffer} ciphertext to store as a BLOB
 */
function encrypt(plaintext) {
  assertAvailable();
  return safeStorage.encryptString(plaintext);
}

/**
 * @param {Buffer|Uint8Array} ciphertext
 * @returns {string} the recovered plaintext
 */
function decrypt(ciphertext) {
  assertAvailable();
  return safeStorage.decryptString(Buffer.from(ciphertext));
}

module.exports = { encrypt, decrypt, isAvailable: () => safeStorage.isEncryptionAvailable() };
