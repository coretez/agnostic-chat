# Context Engineering Strategy — the Glass Box

## Thesis / positioning

Claude, ChatGPT and Kimi all do sophisticated context engineering (compaction,
tool-result clearing, memory, sub-agents) — and they all **hide it**. You get a
black box that silently rewrites your prompt and occasionally forgets things,
with no way to see why or to intervene.

**Shamrock's differentiator: the context engine is a glass box.** Every
transformation applied to the prompt before it reaches the model is a *visible,
inspectable, and (eventually) overridable* event. This is the concrete,
shippable form of the "prompt protection" idea the project started with.

Two consequences drive every decision below:
1. **Observability is a first-class feature, not debug tooling.** We build the
   inspector *first*, over the behavior we already have, before we make the
   engine smarter.
2. **Nothing touches the prompt invisibly.** If a stage drops a tool result,
   summarizes history, or spawns a sub-agent, the user can see exactly what
   happened and what the model actually received.

---

## 1. Model the engine as a pipeline of discrete, observable stages

Today compression is a single function buried in `ipc.js`. We reframe the whole
path from "user hits send" to "model responds" as an explicit pipeline. Each
stage takes a context, transforms it, and **emits a structured event** to a
per-chat **Context Ledger**.

| # | Stage | What it does | Emits |
|---|-------|--------------|-------|
| 1 | **Assemble** | Build the message list: system prompt + enabled skills + retrieved project docs + working-dir context + history + current turn | per-contributor token cost |
| 2 | **Trim tool results** | Clear/collapse tool outputs older than N recent rounds (new — Claude `clear_tool_uses`, Kimi "Hide-Tool-Result") | which results kept/dropped, tokens reclaimed |
| 3 | **Compact history** | Summarize older turns when over budget (existing, improved: incremental + cache-stable) | before/after tokens, the summary text |
| 4 | **Route** | Pick provider/model (existing: preferred/last-model) | model, context window |
| 5 | **Tool loop** | `runChatLoop`; may **spawn sub-agents** with isolated context that return only a conclusion (new) | tool calls, sub-agent tree |
| 6 | **Persist** | Save summary/memory, last-model, per-chat state | what was written |

The pipeline is the product. Each stage is independently toggleable and
instrumented, so we can *see* and *fix* each one in isolation — which is the
whole point.

---

## 2. The transparency layer — the INTERNALS tab

A new surface that renders the Context Ledger for the current chat. Built in
phases from read-only → interactive.

**Panels:**
- **Window occupancy** — a live gauge showing how full the context is, broken
  down by contributor: system / skills / documents / history / tool-results /
  headroom. Answers "why am I near the limit?" at a glance.
- **Event timeline** — every pipeline event in order: "trimmed 3 tool results
  (−12k tok)", "compacted 18 turns → summary (−41k tok)", "spawned sub-agent
  `report-writer`". Click an event to see details.
- **Assembled prompt viewer** — the *exact* message list sent to the model this
  turn. The ultimate transparency: no hidden system text, no silent injection.
- **Sub-agent tree** — (once Phase 3 lands) spawned sub-agents, their task,
  their own token usage, and the conclusion they returned to the parent.

**Progressive interactivity** (Phase 4):
- Edit/regenerate the compaction summary before it's used.
- Pin/unpin individual tool results so trimming leaves them alone.
- Tune ratios (compaction trigger, keep-recent, tool-result rounds) per project.
- Inspect or kill a running sub-agent.

---

## 3. Engine improvements — each shipped *observable*

In priority order (highest value / lowest risk first):

1. **Tool-result trimming (Stage 2).** All three vendors converge here; it's the
   biggest win for an MCP-heavy app like ours where tool outputs dominate token
   growth. Keep the last N rounds verbatim, collapse older ones to a stub
   ("[result cleared — 8.2k tokens]"). Cheap, near-lossless, cache-friendly.
   *Guardrail (per the "GC without write barriers" critique): never drop pinned
   results; always keep the most recent round.*
2. **Cache-stable, incremental compaction (Stage 3).** Stop regenerating one
   giant summary from scratch (which nukes the prompt cache every time). Keep a
   stable prefix and fold only newly-aged turns into a running summary.
3. **Sub-agents (Stage 5).** We already have the ingredients: `runChatLoop` +
   per-provider compression. A sub-agent = a fresh message list with its own
   context budget that runs a scoped task and returns only its conclusion to the
   parent. Natural fit for the roadmap's "modes" (planning, doc-management) and
   report generation. Start with sequential single delegation; parallel fan-out
   later.

---

## 4. Rollout phases

- **Phase 0 — Glass box over today's behavior.** Introduce the Context Ledger +
  event vocabulary; refactor the existing assemble/compact path to emit events;
  build the CONTEXT tab (occupancy + timeline + assembled-prompt viewer),
  read-only. *Delivers the differentiator immediately, before any new algorithm.*
- **Phase 1 — Tool-result trimming**, visible in the timeline from day one.
- **Phase 2 — Incremental, cache-stable compaction**; make the summary viewable
  then editable.
- **Phase 3 — Sub-agents** with the sub-agent tree view.
- **Phase 4 — Controls/overrides** (pin results, edit summary, tune per-project
  policy, inspect/kill sub-agents).

Each phase leaves the app shippable and every new mechanism lands already
observable — never a black box we bolt visibility onto later.

---

## 5. Placement (design cohesion) — DECIDED

- **Primary:** a new top-level tab **INTERNALS** (alongside CHAT / OVERVIEW /
  DOCUMENTS / SKILLS) — it needs room for the timeline, occupancy breakdown, and
  prompt viewer that the narrow right rail can't give.
- **Always-visible hook:** a small **context meter** in the composer meta row
  (e.g. `62% ctx`) that links into the tab — so you notice pressure without
  leaving chat.
- Reuse Direction B language: `.ovcard`-style panels, mono labels, brand accent,
  the existing `chat:progress` event stream (extended vocabulary) feeding the
  timeline much like the PLAN rail does today.

---

## Decisions (2026-08-02)

1. **Placement:** top-level **INTERNALS** tab (+ composer context meter).
2. **First milestone:** **Phase 0** — visibility over today's behavior, read-only.
3. **Tab name:** **INTERNALS**.
