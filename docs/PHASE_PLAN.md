# Next Phase — "Efficiency, Measured"

## Where we are (done)

The context engine is built and glass-boxed:
- **Observability** — INTERNALS tab: CONTEXT (occupancy + assembled prompt), PROCESS (pipeline + threads), REVIEW (meta-evaluator).
- **Orchestration** — sub-agents: `delegate` (one, isolated) and `assign`+merge (parallel fan-out + synthesis); authored per-project agents.
- **Reduction** — skill selection (load only what a prompt needs), noise filter (RTK-inspired tool-result compression), opt-out skills.
- **Model management** — per-project preferred model, last-model memory, working directory.

## The gap this phase closes

We can *see* the pipeline, but we can't yet *hold it to a number*. Two reasons:
1. **All our token figures are estimates** (`chars / 4`), not ground truth.
2. **Nothing is tracked over time** — every metric is "this turn only."

So the phase theme is **measurement first, then optimize against it.**

---

## Measurable objectives (KPIs)

Each is per-turn, tracked over time, and reported *by the app itself*. Baselines
are from observed/estimated runs and must be re-established on real usage (that's
objective 0).

| # | Objective | Baseline | Target | Measured by |
|---|-----------|----------|--------|-------------|
| 0 | **Ground-truth metrics** — real provider `usage` captured per turn | none (estimates only) | 100% of turns log real prompt/completion/cache tokens | provider API `usage` |
| 1 | **Context occupancy** (window fill) | seen at 108% (overflow) | median ≤ 40%, p95 ≤ 75%, **0 turns > 100%** | real prompt_tokens ÷ window |
| 2 | **Fixed overhead** (system + skills) | 231k (all skills dumped) | ≤ 15k median | ledger skills+system |
| 3 | **Tool-result compression** (filter) | raw (0%) | ≥ 70% median reduction on results > 5k | filter saved ÷ raw |
| 4 | **Cache utilization** | 0% (prefix busted every turn) | ≥ 60% of input tokens cache-read on turn ≥ 2 | `cache_read_input_tokens` ÷ prompt_tokens |
| 5 | **Cost per turn** (multi-turn chats) | full price every turn | ≥ 50% reduction | usage × price |
| 6 | **Delegation isolation** (heavy-tool turns) | 0% (inline) | ≥ 80% of raw tool tokens kept OUT of main thread | sub-agent absorbed ÷ (absorbed+main) |
| 7 | **Evaluator health** | not tracked | high-severity findings trend → 0; median ≤ 1 | REVIEW history |
| 8 | **Correctness guardrail** | n/a | "missing skill/result" findings < 5% of turns | evaluator `usage` findings |

Objective 8 is the counterweight: reduction must not silently drop content the
model needed. We measure it, we don't assume it.

---

## Build order (each item maps to the KPIs it moves)

1. **Telemetry layer** *(obj 0 — foundation for all)* — capture `usage` from every
   provider response (prompt/completion/cache tokens), store in a `turn_metrics`
   table, reconcile against our `chars/4` estimate (validates the glass box).
2. **Prompt caching** *(obj 4, 5)* — reorder assembly into a stable prefix
   (system + tools + skill menu) with a cache breakpoint; volatile content
   (selected skill defs, summary, latest turn) after it.
3. **Cache-stable compaction** *(obj 4)* — stop rewriting history in place; keep
   the prefix stable so compaction doesn't bust the cache.
4. **Metrics history + trend view** *(obj 1–8)* — a per-project dashboard of the
   KPIs over time; auto-run the evaluator to feed objectives 7–8.
5. **Modes** *(obj 1, 2)* — group skills into working sets; mode-aware selection
   tightens fixed overhead further.
6. **Extractive filter layer** *(obj 3)* — query-aware keep-the-relevant-slices
   on top of today's deterministic filter.

Telemetry (1) and the trend view (4) are the backbone: they turn every objective
above from an aspiration into a number the app shows us — and that the evaluator
critiques. Everything else is optimizing against a measured baseline.

## The four measures we care about (map to KPIs)

The telemetry layer (obj 0) exists to capture these four, per turn, as real numbers:
- **Token Usage** → obj 1, 5 (real prompt/completion tokens, cost).
- **Token Reduction** → obj 2, 3, 6 (skill-selection saved, filter saved, compaction saved, delegation isolation — the sum of what we kept OUT of the window).
- **Skill Usage** → which skills were selected/loaded per turn, and frequency over time (informs modes + prary pruning).
- **Prompt-Cache impact** → obj 4 (cache-read tokens ÷ prompt tokens, and the $ it saves).

Each is a first-class column in `turn_metrics` and a series in the trend view.

---

## Planned capability: LLM Firewalls & Guardrails (the "prompt protection" vision)

Not built yet — planned as pipeline stages so they're observable and enforceable,
same glass-box treatment as everything else. This is the concrete form of the
project's original "prompt protection" goal.

- **Input guard (pre-send)** — runs before Assemble→Route on the outbound prompt:
  PII/secret redaction, prompt-injection detection (esp. on tool results and
  pasted/attached content — untrusted input is the real attack surface in an
  MCP-heavy app), and policy rules (block/redact/flag).
- **Output guard (post-receive)** — runs on the model's reply and on tool-call
  arguments before a tool executes: block disallowed actions, redact leaked
  secrets, enforce allow/deny policy per project.
- **Tool-call firewall** — gate MCP tool invocations against per-project policy
  (which tools/servers are permitted, argument constraints) before they run.
- **Observable + measured** — every guard action (redacted / blocked / flagged)
  is a pipeline event in PROCESS and a counter in metrics; the evaluator can
  critique guard efficacy and false positives.

Two new pipeline stages ("Input guard", "Output guard") slot into the existing
pipeline; enforcement is per-project policy. Design lives here; build is a later
phase once telemetry + caching land.

## Workstream: rules → gates (O26–O30)

`docs/AGENT_RULES.md` states the rules; this workstream makes the harness
enforce them. Theme: **verification stops being probabilistic.** Today every
quality mechanism is LLM judgment (O10 plan shape, O11 critic lenses); the lab
evidence (OpenAI harness engineering, Anthropic best practices, Kimi K2
verifiable rewards) says the floor must be deterministic and the rulebook must
be promoted into code when violated.

Build order (dependency-driven, each item lands observable per the glass box):

1. **O28 rule text** *(sliver — do first)* — the test-integrity line into
   CODING_RULES and the CODING MODE note. Prompt-only, zero risk; the
   guardrail half waits for O17.
2. **O29 map + rulebook injection** *(small)* — depth-2 repo map to Pass 2;
   working-dir rulebook injected under a banner, costed in the ledger. Makes
   AGENT_RULES actually reach the model.
3. **O26 framework check gate** *(the backbone)* — per-project check command:
   baseline at turn start, run after every mutating step, failures fed back
   under the root-cause rule, final result into synthesis and review. This is
   the phase's deterministic anchor and feeds KPI 8 (correctness guardrail).
4. **O27 debt ledger** — DEBT doc joins the O15 canonical set; unfixed O11
   findings and repeat evaluator findings append; repeat findings surface
   "promote to gate" (→ O26 check or O17 guard). Closes the loop the
   AGENT_RULES meta-rule requires.
5. **O30 drift pass** — user-invoked maintenance turn: golden-principles scan
   + doc-gardening; findings → O27; fixes as one bounded plan. Schedulable
   later; depends on 3 + 4.

Interleaving with the measurement phase: item 3 emits check results as
process events and task_metrics rows, so it lands *after* the telemetry layer
(build item 1 above) and rides the same rails. Items 1–2 are independent and
can ship any time. O17 remains the prerequisite for the enforcement half of
O28 and the guard-promotion half of O27 — this workstream does not block on
it, but those two halves do.

Done when: a coding turn on a project with a check command cannot complete a
mutating step against a failing check without escalation; the rulebook is
visible in the assembled prompt viewer; an unfixed review finding is readable
in the DEBT doc; and a repeat finding shows a promotion suggestion.

---

## Definition of done for the phase

- The app shows, per project, a trend of objectives 1–8 with real (not estimated)
  numbers.
- Caching is live and objective 4 is ≥ 60% on multi-turn chats.
- The evaluator runs automatically and objective 7's trend is visible.
