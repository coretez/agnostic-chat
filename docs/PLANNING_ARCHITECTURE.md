# Planning Architecture — Plan-and-Execute with a Variable Store

Status: **BUILT (P0–P5)** · Branch: `feature/planning` · Supersedes the single-loop turn model in `chat-loop.js` for complex turns (which remains the simple-turn / fallback path).

Implementation map: `variables.js` (P0) · `execute.js` (P1/P5) · `plan-derive.js` (P2) · `compress.js#protect` (P3) · schema v14/v15 + PROCESS-lens plan display (P4) · `ipc.js chat:send` planning branch (P5). All smoke-verified; live validation pending.

This document is the coding plan for the plan-and-execute rework. It captures the
mental model, the flowchart, the pseudocode, the reuse/new/modify map against the
existing code, the constraints we must not break, the open decisions, and a phased
build order with measurable objectives. Read this before writing any code on this
branch.

---

## 1. Why we are changing the turn model

Today a turn is **one flat agentic loop** (`runChatLoop`): call the model, run any
tools it asks for, feed results back, repeat until it stops or hits an iteration
cap. That works, but it has three structural weaknesses this rework targets:

1. **No explicit plan.** The model improvises the whole task inside one loop. There
   is nothing to inspect, approve, or measure at the *step* level, and nothing that
   tells the model "you are on step 3 of 5" — so it drifts, repeats work, or stops
   early (the "didn't finish" class of bugs we already patched around with forced
   wrap-up).
2. **No working memory of discovered parameters.** Tool parameters we discover mid-
   turn (a tenant id, a case id, a file path, an account GUID) live only in the raw
   message history. When compaction fires, those values can be summarized away — and
   then a later tool call can't be formed. The user called this out directly:
   *"when we call tools, we have parameters ... often we've discovered [them] in
   previous parts of the conversation ... we need to maintain a history of those
   parameters."*
3. **Instruction layers are implicit.** The MCP cheat-sheet and the project brief
   are stuffed into the system prompt ad hoc. There is no defined precedence or
   lifecycle for them.

The fix is a **plan-and-execute** turn: layer the instructions, plan explicitly in
two passes, execute step-by-step against a **persistent variable store**, and
compact in a way that *never* drops the variable store.

---

## 2. Relationship to the existing `planner.js`

We already have a `planner.js` — but it is a **different strategy** and it stays.

| | `planner.js` (exists) | plan-and-execute (this doc) |
|---|---|---|
| Shape | Parallel **decompose → merge** | Sequential **plan → execute → synthesize** |
| Steps run as | Isolated sub-agents, no shared state | One agent, **shared variable store** across steps |
| Best for | Independent sub-tasks fanned out (research N things, merge) | Dependent tasks where step N needs values discovered in step N-1 |
| Merge | AI-merge of isolated conclusions | Synthesis over accumulated variables + step results |

They are **siblings**, selected by the plan itself: a derived step may be marked
`parallel` and delegated to `planner.js`/`runSubagent`, while dependent steps run
inline through the new executor. We are not replacing decompose-and-merge; we are
adding the sequential, stateful path it lacks.

---

## 3. Instruction layers (precedence, highest wins on conflict)

Every turn is assembled from these layers, in this order:

1. **Harness rules** — provider-agnostic system framing, safety, output contract.
   Fixed, ships with the app.
2. **MCP cheat-sheet** — the connected server's routing/usage guidance
   (`routing_cheatsheet`-style). Tells the model how *this* toolset is meant to be
   used. Loaded once per turn, cache-friendly (stable prefix).
3. **Project brief** (`project.cheat_sheet`) — the user's per-project standing
   instructions and domain context.
4. **Loaded skills** — full instructions for the skills `selectContext` chose this
   turn (opt-out: on by default, minus per-project disables).
5. **Variable store digest** — the current working memory (see §5), rendered as a
   compact, always-present block so discovered parameters survive compaction.
6. **Conversation history** — recent turns verbatim; older turns compacted.
7. **The user's message.**

Layers 1–3 form a **stable prefix** (good for prompt caching); 4–7 vary per turn.

---

## 4. Flowchart

```mermaid
flowchart TD
    A[User sends a message] --> B[Load instruction layers + memory<br/>harness · MCP cheat-sheet · project brief]
    B --> C[Plan · Pass 1<br/>selectContext: pick skills + tools]
    C --> D[Plan · Pass 2<br/>derive steps  ·  skill iteration]
    D -->|refine loop:<br/>plan.needsMore| D
    D --> E{The plan<br/>goal + ordered steps}
    E --> F[Execute next step<br/>inner model↔tools loop<br/>capture vars from args + results]
    F <--> V[(Variable store<br/>discovered params)]
    F --> S{Step outcome?}
    S -->|done| H{More steps?}
    S -->|stuck: budget exhausted| R{Re-plans < 3?}
    R -->|yes| RP[Re-plan remaining steps<br/>with results-so-far + why stuck]
    RP --> F
    R -->|no| UA{Ask user: keep trying?<br/>explain what's stuck}
    UA -->|yes → reset budget| RP
    UA -->|no| I
    H -->|yes, next step| F
    H -->|context nearing window| K[Compact<br/>keep: instructions, variables,<br/>discovered, recent turns]
    K --> H
    H -->|no| I[Synthesize final answer<br/>over variables + step results]
    I --> J[Save + measure<br/>turn_metrics · task_metrics · documents]
    J --> Z[Reply to user]
```

The shapes that did not exist in the old flat-loop picture: **Pass 2 step
derivation** (D), the **Variable store** (V, read/written by every step),
**step-scoped execution** (F replacing one monolithic loop), and the **stuck →
re-plan → escalate** control (S/R/RP/UA) — the system adapts its own plan around a
stuck step and only interrupts the user when it genuinely can't progress.

---

## 5. The Variable Store

Working memory of **discovered tool parameters and derived values**, carried across
steps within a turn and (optionally) persisted across turns of a chat. It is the
piece that makes step N able to use what step N-1 found, and the piece compaction
must protect.

**Shape (per entry):**

```
{
  key:        'tenant_id',            // stable, model- and tool-addressable
  value:      'acme-prod',            // the discovered value
  type:       'string',              // string | number | id | path | json
  source:     'list_tenants#call_3',  // provenance: which tool call / step produced it
  step:        2,                     // step index that captured it
  confidence: 'observed',            // observed (from a tool result) | derived (model-computed) | user
  ts:          <turn-relative seq>    // ordering; NOT wall-clock (see constraints)
}
```

**Capture** happens two ways (see open decision #3):

- **Auto-extract** — after each tool call, harvest `call.args` (the parameters the
  model *used* are, by definition, resolved values worth remembering) and run a
  light extraction pass over the tool *result* for obvious id/path/key fields.
- **Explicit** — a synthetic `set_variable(key, value, type?)` tool the model can
  call to record a value it derived or chose deliberately.

**Rendering** — the store is serialized into layer 5 as a compact table so it is
always in front of the model:

```
KNOWN VALUES (use these exact values when a tool needs them):
- tenant_id = "acme-prod"   (from list_tenants, step 2)
- case_id   = "C-10432"     (from list_cases, step 3)
```

**Persistence** — in-memory for a turn; a `variables` table (or a `variables_json`
column on the chat) lets it survive across turns and app restarts. Scope: per chat.

---

## 6. Pseudocode

Injected dependencies (`chat`, `callTool`, `selectContext`, `summarize`, store)
keep every function unit-testable without a live model — same discipline as the
current `runChatLoop`/`makePlan`.

### The plan contract

Pass 2 returns a **structured series of JSON step objects plus merge
instructions** (forced-tool output of `submit_plan`):

```json
{
  "simple": false,
  "goal": "one line: what done looks like",
  "steps": [
    { "task": "complete, self-contained instruction",
      "produces": "case_id, tenant_id",        // named values/artifact later steps need → drives set_variable capture
      "delegate": true,                          // run as an ISOLATED sub-agent (bulk stays out of the main thread)
      "agent": "report-reader",                 // named agent for a delegated step, or "auto"
      "parallel": true }                         // may run concurrently with adjacent parallel steps
  ],
  "merge": "how to combine step results into the final answer (structure/format); empty = last step's output IS the answer"
}
```

Delegation and merging are therefore **planner decisions, in the plan itself** —
not left to the model's whim mid-loop: `delegate`/`parallel` route a step to
`runSubagent`, `produces` is echoed into the step directive ("THIS STEP MUST
PRODUCE: … record with set_variable"), and `merge` is honored verbatim by
`synthesize` ("HOW TO COMBINE THE RESULTS: …"). If a loaded skill prescribes an
output format, the planner is instructed to write `merge` to follow it.

```js
async function handleTurn({ chat, callTool, model, chat_id, userText, deps }) {
  // 1. Instruction layers + memory (§3)
  const layers = loadInstructionLayers({ chat_id, deps });   // harness, mcp cheat, project brief
  const store  = await loadVariableStore(chat_id);            // §5, may be empty

  // 2. Plan · Pass 1 — pick skills + tools (REUSE context-select.js)
  const { skillNames, toolNames } = await selectContext({
    connector: deps.connector, model: deps.fastModel,
    skills: deps.projectSkills, tools: deps.connectedTools, userText,
  });
  const loadedSkills = deps.projectSkills.filter(s => skillNames.includes(s.name));
  const { tools }    = applyToolCeiling({ loadedSkills, toolNames, allTools: deps.connectedTools });

  // 3. Plan · Pass 2 — derive steps (skill iteration, NEW)
  let plan = await derivePlan({ chat: deps.fastChat, layers, loadedSkills, tools, store, userText });
  while (plan.needsMore) {                                    // refine loop (open decision #2)
    plan = await refinePlan({ chat: deps.fastChat, plan, layers, store });
  }

  // 4. Execute the plan, re-planning around stuck steps (decision #1).
  const REPLAN_BUDGET = 3;
  const stepResults = [];
  let history = seedHistory(layers, store, userText);
  let steps = [...plan.steps];
  let replans = 0, idx = 0;
  while (idx < steps.length) {
    const step = steps[idx];
    if (step.parallel) {                                       // hand off to decompose-and-merge sibling
      stepResults.push(await runSubagentStep(step, { callTool, ...deps })); idx++; continue;
    }
    const r = await executeStep({ chat, callTool, model, step, tools, history, store, deps });
    history = await maybeCompactKeepingStore({ history: r.history, store, model, summarize: deps.summarize });

    if (r.stuck) {
      if (replans < REPLAN_BUDGET) {                           // auto re-plan the REMAINING tail
        replans++;
        const revised = await refinePlan({ chat: deps.fastChat, plan, store,
                                           done: stepResults, stuckStep: step,
                                           reason: r.reason, partial: r.partial });  // what it half-found rides along
        steps = [...steps.slice(0, idx), ...revised.steps];    // keep done; replace remaining; retry idx
        continue;
      }
      const decision = await deps.onStuck({                    // budget spent → escalate with an explanation
        goal: plan.goal, done: stepResults, stuckStep: step, values: store.render(), replans });
      if (decision.continue) { replans = 0; continue; }        // user granted a fresh budget
      stepResults.push({ step: step.id, conclusion: r.partial, incomplete: true });
      break;                                                   // user declined → synthesize what we have
    }
    stepResults.push(r.result); idx++;
  }

  // 5. Synthesize over accumulated variables + step results, honoring the
  //    plan's own merge contract (plan.merge → "HOW TO COMBINE THE RESULTS").
  const answer = await synthesize({ chat, model, plan, stepResults, store });

  // 6. Persist + measure
  await saveVariableStore(chat_id, store);
  await recordTurnMetrics({ chat_id, plan, stepResults, usage: aggregateUsage(stepResults) });
  return { answer, plan, store, stepResults };
}

// One step = a scoped inner model↔tools loop that CAPTURES variables as it goes.
async function executeStep({ chat, callTool, model, step, tools, history, store, deps }) {
  const budget = step.budget || DEFAULT_STEP_BUDGET;
  history = [...history, { role: 'user', content: renderStepDirective(step, store) }];
  for (let i = 0; i < budget; i++) {
    const res = await chat({ model, messages: history, tools });
    const calls = res.toolCalls || [];
    if (calls.length === 0) {
      return { result: { step: step.id, conclusion: res.text, usage: res.usage }, history };
    }
    history.push({ role: 'assistant', content: res.text, toolCalls: calls });
    for (const call of calls) {
      if (call.name === 'set_variable') { store.set(call.args, { step: step.id, confidence: 'derived' }); }
      captureFromArgs(store, call.args, step.id);              // auto-extract: used params are resolved values
      const out = await callTool(call.name, call.args);
      const filtered = filterToolResult(call.name, out.text, { cap: 24000 });  // REUSE filter.js
      captureFromResult(store, call.name, out.text, step.id);  // auto-extract obvious ids/paths/keys
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: filtered.text });
    }
  }
  // Step exhausted its budget without a natural stop → mark it STUCK so the
  // orchestrator can re-plan the remaining tail (decision #1). Still force a
  // tool-less partial conclusion so nothing gathered is lost.
  const partial = await forceStepConclusion({ chat, model, history, step });
  return { result: partial, partial: partial.conclusion, history, stuck: true,
           reason: 'iteration-budget-exhausted' };
}

// Compaction that STRUCTURALLY protects the variable store (extends compress.js).
async function maybeCompactKeepingStore({ history, store, model, summarize }) {
  // keep = [ instruction layers, VARIABLE STORE DIGEST, discovered artifacts, recent turns ]
  // Only the middle of the raw tool trace is summarized; §5 store is re-injected verbatim.
  return maybeCompress({ messages: history, contextWindow: contextWindowFor(model),
                         summarize, keepRecent: 6, protect: renderStore(store) });
}
```

---

## 7. Reuse / New / Modify map

| Concern | Module | Action |
|---|---|---|
| Pass 1: skill + tool selection | `context-select.js` `selectContext` / `applyToolCeiling` | **Reuse as-is** |
| Noise filter on tool results | `filter.js` `filterToolResult` | **Reuse as-is** |
| History compaction | `compress.js` `maybeCompress` | **Modify** — add a `protect` block so the store + instruction layers are never summarized |
| Structured-output contract | `evaluator.js` `extractJson` / forced-tool pattern | **Reuse** for `derivePlan`/`set_variable` schemas |
| Decompose-and-merge (parallel steps) | `planner.js` / `subagent.js` | **Reuse** as the `step.parallel` branch |
| Flat turn loop | `chat-loop.js` `runChatLoop` | **Keep** for simple turns; the new executor is `executeStep`, factored from it |
| Pass 2: step derivation | — | **New** `plan-derive.js` (`derivePlan`, `refinePlan`) |
| Variable store | — | **New** `variables.js` (in-memory store + capture helpers + render) |
| Step executor + turn orchestrator | — | **New** `execute.js` (`executeStep`, `handleTurn`) or fold into an evolved `planner.js` |
| Persistence | `db/schema.sql` + `db/repo.js` | **Modify** — `variables` storage + step-level metrics |

Net new files: `plan-derive.js`, `variables.js`, `execute.js`. Everything else is
reuse or a bounded extension.

---

## 8. Constraints (must not break)

- **Provider-agnostic.** All new model calls go through the connector abstraction
  (`connector.chat`), never a provider SDK directly. Normalized usage
  `{inputTokens, outputTokens, cachedTokens, cacheCreationTokens}` must keep flowing.
- **Security model.** Secrets stay in the main process (safeStorage/Keychain).
  Renderer talks only via the preload bridge. The variable store may hold discovered
  *parameters* — treat it as potentially sensitive; it lives main-side and is never
  logged in plaintext to the renderer beyond the glass-box views the user opted into.
- **`node:sqlite` + `PRAGMA user_version` migrations.** Any schema change is a new
  numbered migration (next is **v14**), column-existence-guarded, additive.
- **Forced tool-calling for structured output**, with the offered-tool retry
  fallback — some thinking models reject a forced `tool_choice` (HTTP 400). Reuse the
  exact pattern already in `selectContext`.
- **Thinking-model budgets.** The fast/utility model may be a thinking model
  (`kimi-k2.6`): planning and extraction calls need generous `maxTokens` and a
  `reasoning_content` fallback. Recommend a non-thinking `fast_model` in docs.
- **No `Date.now()`/`Math.random()` assumptions in ordering.** Variable-store
  ordering uses a turn-relative sequence, not wall-clock, so it is deterministic and
  test-reproducible.
- **Glass box.** Every new stage emits events for the INTERNALS tab
  (CONTEXT/PROCESS/REVIEW): plan derivation, each step start/end, every variable
  capture, each compaction. Exposing the internals is the product thesis — nothing
  in this pipeline is a black box.
- **Opt-out skills.** Skills remain on by default minus per-project disables.
- **Determinism for tests.** Injected `chat`/`callTool`/`summarize` so `smoke.js`
  can drive the whole turn with no live model.

---

## 9. Design considerations & decisions

All three planning decisions are now **DECIDED** (below). The rest of the section
logs considerations for the build.

1. **Stuck-step handling — DECIDED: re-plan first, escalate to the user after a cap.**
   When a step exhausts its iteration budget ("stuck") we do NOT immediately prompt
   the user. Instead:
   1. **Auto re-plan** — feed the results-so-far (completed steps + the variable
      store + *why* the step stuck) back into Pass 2 (`refinePlan`) to re-derive the
      *remaining* steps. Completed steps and the variable store are preserved; only
      the not-yet-done tail is replaced.
   2. **Bounded** — at most `REPLAN_BUDGET = 3` re-plans per turn (configurable).
   3. **Escalate** — once the budget is spent and a step is still stuck, surface
      *what is stuck* to the user (the goal, what's done, the blocking step, the
      values gathered so far) and ask approval to keep trying. A "yes" grants a fresh
      re-plan budget; a "no" synthesizes an answer from what was gathered.
   Rationale: the system adapts on its own first and only interrupts the user when it
   genuinely can't make progress — with a real explanation, not a bare "+10?".

2. **Skill iteration: loop or single pass — DECIDED (coupled to #1): single-pass
   up front, re-plan reactively.** Pass 2 derives the plan in one cheap proactive
   pass. The `refinePlan` loop still exists but is driven *reactively* by stuck steps
   (decision #1), sharing the same `REPLAN_BUDGET = 3` cap. No proactive
   `while plan.needsMore` spinning; re-planning happens on demand, bounded.

3. **Variable capture mechanism — DECIDED: both.** Auto-extract from every
   `call.args` (used params are resolved values) plus an explicit `set_variable` for
   derived/chosen values. Auto gives recall for free; explicit gives the model a
   deliberate handle. Implemented in P0.

Other considerations logged for the build:
- **When to plan at all.** Trivial turns (a greeting, a one-line question) shouldn't
  pay for two planning passes. Gate: if Pass 1 selects no skills and ≤1 tool, skip
  Pass 2 and run the simple `runChatLoop`. Measure the gate's hit rate.
- **Plan approval UX.** Optional user approval of the derived plan before execution
  (planner.js already assumes approval). Default: auto-run, show the plan in the
  glass box; make approval a per-project toggle later.
- **Store key collisions.** Same logical key rediscovered with a new value → keep
  latest, retain prior in provenance; never silently overwrite a `user`-confidence
  value with an `observed` one without noting it.

---

## 10. Data model changes (migration v14)

Additive only, column-existence-guarded, matching the existing migration style:

- `chats.variables_json TEXT` — the per-chat variable store snapshot (or a
  normalized `variables` table if we want history/provenance queries; start with the
  JSON column, promote to a table only if queried).
- `turn_metrics`: add `plan_steps INTEGER`, `plan_refines INTEGER`,
  `vars_captured INTEGER` so the glass box can measure the planner itself.
- `task_metrics` already carries per-task duration+tokens — reuse for per-step.

---

## 11. Phased build order with measurable objectives

Each phase is independently commit-able, smoke-tested, and observable in the glass
box before the next begins.

**Phase P0 — Variable store (foundation).** `variables.js`: in-memory store,
`captureFromArgs`, `captureFromResult`, `set_variable` tool schema, `renderStore`.
Migration v14 (`chats.variables_json`) + repo load/save.
- *Objective:* a step can write a value and a later step reads the exact value back;
  round-trips across a save/load; survives a forced compaction. Smoke-verified.

**Phase P1 — Step executor.** `execute.js` `executeStep` factored from `runChatLoop`,
with variable capture wired (P0), per-step budget, `set_variable` interception, and
**stuck detection** — a budget-exhausted step returns `{stuck, partial, reason}` plus
a forced partial conclusion (decision #1). The `onStuck` escalation callback is
stubbed here (mock-injectable); its live IPC wiring and the auto-`refinePlan` land in
P2. The orchestration loop (re-plan tail / escalate) is exercised with a mock
`refinePlan`.
- *Objective:* (a) a two-step turn where step 2's tool call is formed **only** from a
  value step 1 discovered; (b) a step that exhausts its budget is reported `stuck`
  and its partial conclusion retained. Both driven entirely by injected mocks.
  Smoke-verified.

**Phase P2 — Plan derivation (Pass 2) + re-plan.** `plan-derive.js` `derivePlan` and
`refinePlan` (the reactive, `REPLAN_BUDGET`-capped re-plan of a stuck step's remaining
tail, decisions #1/#2), using the forced-tool structured-output pattern. Wire Pass 1
(`selectContext`) → Pass 2 → executor in `handleTurn`, plus the live `onStuck`
user-escalation over IPC (reusing the continue-at-limit channel, now carrying the
what's-stuck explanation).
- *Objective:* derived plans are well-formed (goal + ordered steps) ≥95% of runs on a
  fixture set; a stuck step triggers ≤3 automatic re-plans of the remaining tail and
  only then escalates. The trivial-turn gate skips planning for greetings. Measured:
  `plan_steps`, `plan_refines` (= re-plans).

**Phase P3 — Compaction that protects the store.** Extend `maybeCompress` with a
`protect` block; re-inject the store digest + instruction layers verbatim.
- *Objective:* after compaction fires mid-turn, every variable captured before it is
  still usable in a subsequent step. Smoke-verified with a forced-overflow fixture.

**Phase P4 — Glass-box + telemetry.** Emit plan/step/capture/compaction events;
surface a PLAN lens (or extend PROCESS) in INTERNALS; record v14 metrics.
- *Objective:* a real turn shows its plan, per-step timing, and variable captures in
  the UI; `turn_metrics` reads back `plan_steps`/`vars_captured`.

**Phase P5 — Integration + parallel-step handoff.** `step.parallel` routes to
`planner.js`/`runSubagent`; synthesize over the mixed results; end-to-end live run.
- *Objective:* one turn that mixes a sequential step (uses the store) and a parallel
  step (fanned out + merged) produces a coherent synthesized answer. Live-validated.

Global success metric for the rework: on a scripted multi-step task, **zero**
"formed a tool call from a value that was compacted away" failures, and a plan that
is inspectable at every step in the glass box.

---

## 12. Live validation (2026-08-04) — results & the capability gap

Four live runs of **"Investigate case for taylor.brooks@acneinc.com"** on
`kimi-k2.6` against the Fluency Expo MCP (205 tools, 30 skills), same chat, on
the completed P0–P5 build. Every designed mechanism fired in production: plan
derivation from skill instructions, per-step delegation with isolation, one
reactive re-plan, honest clarification on a typo'd identity (`acneinc` vs
`acmeinc` — the planner refused to guess), variable capture + cross-turn
persistence, and stop-safe telemetry.

**Turn economics across the lineage** (same investigation, successive turns):

| Turn | Input tokens | Cache | Duration | Plan | Notes |
|---|---|---|---|---|---|
| A | 787k | 86% | 13.5 min | 6 steps | full investigation, report saved + verdict recorded |
| B | 233k | 94% | 8.8 min | 7 steps, 1 re-plan | stopped honestly at the identity mismatch |
| C | ~230k | — | 13.4 min | 6 steps, 3 delegates | 12.4k-char report; main thread at 10% occupancy |
| D | 142k | 66% | 12.2 min | 4 steps, 2 delegates | **planner reused prior work: "without re-expanding"** |

787k → 142k input (5.5×) for the same investigation lineage — the variable
store carrying `case_id` / `expansion_status=expanded` across turns let the
planner skip discovery AND expansion. Kimi's thinking dominates wall clock;
the token story is where the wins show. Delegation isolation confirmed: a
delegate absorbed 24k and returned 212 tok ("kept 23k out of main").

### The gap the last run exposed: the plan outruns the runtime's capabilities

Turn D's steps 1 and 4 prescribe things no offered tool can do: *"read
`references/output-contract.md`"* and *"run `python3
…/validate_case_report.py`"*. The skill's workflow legitimately calls for
them — but the toolset has no file-read and no script execution, so those
sub-steps get improvised around: the step-1 delegate could only call
`get_instruction_group` twice, and step 4's "validation" is the model
ASSERTING the report is valid, not the script running. The plan faithfully
follows the skill; the runtime silently can't honor it.

## 13. Proposed fix: capability-grounded planning + `read_skill_file`

Two halves — one closes the file gap for real, one makes the remaining gap
honest instead of pantomimed.

### 13a. `read_skill_file` — serve the skill's bundled files we already store

The healed skill envelope in the DB **already contains all bundled files**
(the Fluency delivery for `fluency-case-investigation` carries 10 files:
`SKILL.md`, `references/output-contract.md`, the HTML report template, the
validation scripts). Today we extract only SKILL.md; the rest sits unread in
`skills.definition`. Plan:

- **skill-content.js**: add `listSkillFiles(definition)` → `[{path, bytes}]`
  and `readSkillFile(definition, path)` → content, both reading the stored
  envelope (non-envelope skills expose just their own markdown). No
  filesystem, no MCP round-trip — main-process lookup of data we already have.
- **Synthetic tool** `READ_SKILL_FILE_TOOL { skill, path }`, intercepted in
  `callTool` beside `set_variable`/`save_document`, resolved against the
  turn's LOADED skills only (a skill that wasn't selected isn't readable —
  same scoping discipline as everything else).
- **Advertise the files**: the skill-injection block and `planContext` list
  each loaded skill's bundled files ("bundled files: references/…, assets/…"),
  so the planner derives *"read references/output-contract.md via
  read_skill_file"* as a real, executable step — and the report gets built
  from the actual output contract instead of the model's memory of it.
- **Smoke**: envelope → list/read round-trip; unloaded-skill path refused;
  planner prompt carries the file list.

### 13b. Capability-grounded planning (honest degradation)

Add one hard rule to `DERIVE_PROMPT` / `REFINE_PROMPT`: *"Derive steps ONLY
for actions the listed tools can perform. If the skill prescribes an action
with no matching tool (running a script, rendering a PDF), do not emit a step
that pretends — either adapt it to available tools or state in the step what
must be skipped and why."* The planner already receives the exact scoped tool
menu; this makes the boundary explicit, so a validation step degrades to
*"validation script unavailable in this runtime — flagging unvalidated"*
instead of asserting success.

### 13c. Script execution — RESOLVED by the coding harness (feature/code)

Originally deferred as a sandboxing decision. Resolved differently than the
`run_skill_script` sketch below: a per-chat **coding harness toggle**
(`chats.coding_mode`, v16) provides six file/shell tools (`coding-tools.js`)
under a three-level permission hierarchy:

1. **Scope (never bypassable)** — file actions must resolve inside
   `working_dir` ∪ the project documents dir. The check runs on REAL paths
   (symlink chains resolved via `realResolve`), before any prompt.
2. **Action gating** — reads are free; `write_file`/`edit_file`/`run_command`
   each require user approval (ALLOW/DENY prompt, 180s → deny) over the
   one-shot prompt queue in `ipc.js`.
3. **Bypass** — the per-project `coding_bypass` setting skips prompts, honored
   only when `working_dir` is a git repo (rollback exists); enforced in main,
   revocable from the composer BYPASS chip.

`run_command` executes in `working_dir` with a scrubbed env allowlist (the app
process env — API keys, tokens — never crosses into the shell). Coverage lives
in `scripts/smoke.js` (jail incl. symlink escapes, gating, deny, env scrub,
`hasGit`). Skills' bundled scripts can now run through `run_command`; a
dedicated `read_skill_file` (13a) remains open. Full pipeline description:
`docs/PIPELINE_PSEUDOCODE.md`.

> Historical sketch (superseded): a `run_skill_script` tool gated by
> per-project approval, executing in the project's `working_dir` with no
> network.

## 14. Risks

- **Two planning passes add latency and fast-model cost.** Mitigation: the trivial-
  turn gate, single-pass Pass 2 to start, and Pass 1 is already paid for today.
- **Thinking fast-model burns budget before emitting the plan.** Mitigation: generous
  `maxTokens`, `reasoning_content` fallback, and the standing recommendation to set a
  non-thinking `fast_model`.
- **Over-capture pollutes the store.** Mitigation: cap store size, prefer id/path/key
  shapes in `captureFromResult`, decay/evict least-recently-used within a turn.
- **Scope creep vs. the existing flat loop.** Mitigation: keep `runChatLoop` for
  simple turns; plan-and-execute only earns its keep on multi-step work.
