'use strict';

// Claim the app's real name before anything touches the keychain.
//
// safeStorage keys its keychain entry by app NAME. `electron .` reads that from
// package.json, but `electron scripts/whatever.js` does not — app.getName()
// silently returns "Electron", so encrypt/decrypt use a DIFFERENT key than the
// app itself and every stored API key fails to decrypt with a bare
// "Error while decrypting the ciphertext".
//
// Nothing warns about this, so it has to be claimed explicitly, and centrally:
// requiring it per-script means the next script written reintroduces the bug.
// Require this FIRST, before src/main/db or anything that reaches repo.reveal.
//
//   require('./_app-identity');
//
// Harmless when the name is already right (setName is idempotent).

const { app } = require('electron');
const { name } = require('../package.json');

if (app.getName() !== name) app.setName(name);

/**
 * The app's live database, wherever Electron puts userData on this platform.
 * Hardcoding ~/Library/Application Support/<name> is both macOS-only and a
 * second place for the app name to drift out of sync.
 */
function liveDbPath() {
  const path = require('node:path');
  return path.join(app.getPath('userData'), `${name}.db`);
}

module.exports = { appName: name, liveDbPath };
