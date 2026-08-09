# Shamrock

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-1FA35F.svg)](LICENSE)

An LLM-agnostic, project-centric desktop harness for real work — coding, documents, and agentic operations — where you can switch the model in the background (OpenAI, Anthropic, Qwen, Kimi, Gemini, local) and keep a project's chats, documents, skills, and keys together instead of stranding them inside a single conversation.

Built with Electron. Everything stays local on your Mac: API keys are encrypted at rest via the macOS Keychain (`safeStorage`) and only ever leave to call the provider you selected.

## Highlights

- **Three work modes per chat** — **WORK** (general agentic work over your connected tools), **DOCUMENTS** (a deliverables factory), and **CODE** (a governed coding harness) — one titlebar switch.
- **Multi-provider** — OpenAI-compatible (OpenAI, Qwen, Kimi, Gemini) and Anthropic connectors, with SSE **token streaming** and a provider-agnostic tool-calling loop; switch models mid-project.
- **Plan-and-execute engine** — asks alignment questions before direction-setting work instead of racing ahead; runs independent collection steps **concurrently with declared merge contracts**; re-plans around stuck steps within bounds; every loop has a floor to land on.
- **Coding harness (CODE)** — file/shell tools jailed to the project directory (symlink-safe), approvals priced by irreversibility (reads free; writes auto-approved only where git provides rollback; shell asks), plan steps committed to git so **the plan is the history**, and an automatic quality + security review pass over every change.
- **Documents harness (DOCUMENTS)** — give a project a **format target** (a sample document with your branding) and every deliverable reproduces it; documents save into a versioned, organized library; the app renders **PDF** (offscreen, deterministic) and **Excel** exports (the model authors data, never markup).
- **The glass box** — a live plan rail with per-step and per-tool timing, a context-window ledger, token costs per tool result, and captured working memory you can inspect and edit. No invisible context engineering.
- **MCP that stays honest** — connect Model Context Protocol servers over stdio or streamable HTTP (OAuth 2.1: discovery → DCR → PKCE → refresh); **version-drift detection** badges stale imported skills and cached tool listings with one-click re-sync.
- **Skills** — per-project skill enablement with tool scoping; author in-app or import a library from a connected MCP server.
- **Documentation as source of truth** — each project keeps `docs/SPEC.md`, `DESIGN.md`, `PSEUDOCODE.md`, and `KNOWLEDGE.md`; the planner reads them instead of re-deriving intent from code, and the pipeline maintains them after every mutating turn.
- **Context compression** — summarizes older history as it approaches a model's context window, structurally protecting discovered values.
- **In-place updates** — a titlebar chip announces new commits; one click pulls, refreshes dependencies, and restarts (git installs today; signed release channel on the roadmap).

## Status & roadmap

Shamrock is a **public dev preview** — clone and run. It is built spec-first:
[`docs/HARNESS_OBJECTIVES.md`](docs/HARNESS_OBJECTIVES.md) is the objectives
ledger (each capability has an ID, acceptance criteria, and an honest
SHIPPED / PARTIAL / PLANNED status). Headline roadmap items: signed
installers with an auto-update channel, the LLM firewall + guardrails layer,
document verification with provenance manifests, the data-bound widget
library, and team policy via a shared proxy.

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
