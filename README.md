# Shamrock

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-1FA35F.svg)](LICENSE)

An LLM-agnostic, project-centric desktop chat app for coding and document work — think a Claude Code–style workflow where you can switch the model in the background (OpenAI, Anthropic, Qwen, Kimi, Gemini) and keep a project's chats, documents, skills, and keys together instead of stranding them inside a single conversation.

Built with Electron. Everything stays local on your Mac: API keys are encrypted at rest via the macOS Keychain (`safeStorage`) and only ever leave to call the provider you selected.

## Highlights

- **Project-centric** — projects own their chats, documents, per-project skills, working directory, and preferred model.
- **Multi-provider** — OpenAI-compatible (OpenAI, Qwen, Kimi, Gemini) and Anthropic connectors, with SSE **token streaming** and a provider-agnostic tool-calling loop.
- **MCP** — connect Model Context Protocol tool servers over stdio or streamable HTTP, including OAuth 2.1 (discovery → DCR → PKCE → refresh).
- **Skills** — per-project skill enablement, injected as guidance; import a library from a connected MCP server.
- **Artifacts** — HTML reports open in an embedded Chromium panel (split-pane, DevTools) so the agent can inspect and interact.
- **Coding harness** — a per-chat CODE mode with file/shell tools jailed to the project directory, permissions priced by irreversibility, plan steps committed to git, and a quality + security review pass over every change.
- **Documentation as source of truth** — each project keeps `docs/SPEC.md`, `DESIGN.md`, `PSEUDOCODE.md`, and `KNOWLEDGE.md`; the planner reads them instead of re-deriving intent from code, and the pipeline maintains them.
- **Context compression** — summarizes older history as it approaches a model's context window.

## Security model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP.
- The renderer never touches Node or secrets directly — it can only call the small, typed surface exposed by the preload bridge (`window.api`).
- Secrets are encrypted with `safeStorage`; only ciphertext is stored, decrypted in the main process when a provider is called. Plaintext keys are never written to the DB or handed to the renderer.

## Stack

- **Electron** (bundles Node) — main / preload / renderer split.
- **`node:sqlite`** (`DatabaseSync`) — zero native deps; WAL; `PRAGMA user_version` migrations.
- Direction B "terminal / developer" UI (light + dark themes).

## Development

```bash
npm install
npm start
```

The SQLite database and encrypted secrets live in the app's `userData` directory (outside this repo), so cloning the repo never carries any keys.

```bash
node scripts/smoke.js   # smoke checks (DB, providers, MCP, compression, chat loop, skills)
```

## Layout

```
src/main/       Electron main process — DB, IPC, provider connectors, MCP, chat loop
src/preload/    Context-bridge — the only surface the renderer can reach
src/renderer/   UI (Direction B)
docs/           Design spec and notes
scripts/        Smoke test + tooling
```

## License

Shamrock is source-available under the
[Functional Source License 1.1 (ALv2 future)](LICENSE) — free to use, modify,
and redistribute for any purpose except offering Shamrock itself as a competing
commercial product or service. **Every release becomes Apache 2.0 two years
after it ships.**

See [LICENSING.md](LICENSING.md) for what that means in practice and how to get
a commercial license. Contributions are welcome under the DCO — see
[CONTRIBUTING.md](CONTRIBUTING.md).

Copyright © 2026 Christopher Jordan. **Shamrock™** and the clover mark are
trademarks of Christopher Jordan and are **not** licensed under the FSL — see
[TRADEMARK.md](TRADEMARK.md). Security reports: [SECURITY.md](SECURITY.md).
