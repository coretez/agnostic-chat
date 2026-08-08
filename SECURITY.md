# Security Policy

## Reporting a vulnerability

Email **chris@fluencysecurity.com**. Please do not open a public issue for a
security problem. Include what you found, how to reproduce it, and what an
attacker gets. You will get an acknowledgement, and credit in the fix notes
unless you prefer otherwise.

## What the threat model assumes

Shamrock runs locally and talks to model providers, MCP servers, and — in
coding mode — your filesystem and shell. The parts that matter most:

- **Secrets stay in the main process.** API keys and MCP tokens are encrypted
  with the OS keychain (`safeStorage`); only ciphertext is stored. Plaintext is
  recovered in the main process to make a provider call and is never handed to
  the renderer.
- **The renderer is sandboxed.** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, strict CSP. It can only call the typed channels the
  preload bridge exposes.
- **Coding-mode file actions are jailed** to the project's working directory
  and documents directory, with symlink chains resolved before the check.
- **Child processes get a scrubbed environment** — an allowlist, so the app's
  own keys never reach a shell command or dev server.
- **Model output is untrusted input.** Tool results and page content can carry
  injected instructions; mutating actions are gated, and a shell command always
  asks unless bypass is enabled for a git-backed project.

Findings in any of the above are in scope, as are sandbox escapes, jail
escapes, and secret disclosure. Attacks that require an already-compromised
machine or a user deliberately granting bypass on a non-git directory are
understood limitations rather than vulnerabilities.
