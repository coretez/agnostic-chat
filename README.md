# Agnostic Chat

An LLM-agnostic, project-centric desktop chat app for coding and document work — think a Claude Code–style workflow where you can switch the model in the background (OpenAI, Anthropic, Qwen, Kimi, Gemini) and keep a project's chats, documents, skills, and keys together instead of stranding them inside a single conversation.

Built with Electron. Everything stays local on your Mac: API keys are encrypted at rest via the macOS Keychain (`safeStorage`) and only ever leave to call the provider you selected.

## Highlights

- **Project-centric** — projects own their chats, documents, per-project skills, working directory, and preferred model.
- **Multi-provider** — OpenAI-compatible (OpenAI, Qwen, Kimi, Gemini) and Anthropic connectors, with SSE **token streaming** and a provider-agnostic tool-calling loop.
- **MCP** — connect Model Context Protocol tool servers over stdio or streamable HTTP, including OAuth 2.1 (discovery → DCR → PKCE → refresh).
- **Skills** — per-project skill enablement, injected as guidance; import a library from a connected MCP server.
- **Artifacts** — HTML reports open in an embedded Chromium panel (split-pane, DevTools) so the agent can inspect and interact.
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
