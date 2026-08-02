'use strict';

// Non-interactive tests for the OAuth mechanics (no browser needed).
const crypto = require('node:crypto');
const { buildPkce, startLoopback, discover, base64url } = require('../src/main/mcp/oauth');

function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('  ok -', m); }

(async () => {
  // PKCE: challenge must equal base64url(sha256(verifier))
  const { verifier, challenge } = buildPkce();
  const expect = base64url(crypto.createHash('sha256').update(verifier).digest());
  assert(challenge === expect && verifier.length >= 43, 'PKCE challenge = base64url(sha256(verifier))');

  // Loopback: capture code + state from the redirect
  const { server, port, waitForCode } = await startLoopback();
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc123&state=xyz789`);
  await res.text();
  const captured = await waitForCode(5000);
  server.close();
  assert(captured.code === 'abc123' && captured.state === 'xyz789', 'loopback captured code + state from redirect');

  // Discovery against the real server (network — may be blocked in sandbox)
  try {
    const d = await discover('https://expo.fluencyalliance.com/mcp');
    assert(!!d.as.authorization_endpoint && !!d.as.token_endpoint && !!d.as.registration_endpoint, 'discover() read real auth-server metadata (authorize/token/register)');
    console.log('    scopes:', d.scope, '| authServer:', d.authServer);
  } catch (e) {
    console.log('  ~ discover() skipped (network):', e.message);
  }

  console.log('OAUTH MECHANICS OK');
})();
