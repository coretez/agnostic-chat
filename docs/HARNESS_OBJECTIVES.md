# Coding Harness — Objectives (SPEC)

What the Shamrock coding harness must do, derived from studying how the
current generation of harnesses is designed — Claude Code, Kimi Code CLI,
OpenCode, Aider — and from delivery-pipeline platforms (Harness.io) whose
gates/rollback/audit discipline predates all of them. Each objective has an
ID; design elements and commits cite these IDs. Status reflects feature/code.

The one-line thesis: **supply the hands (tools), the conscience (permissions),
and the method (lifecycle) — while keeping the glass box** that the other
harnesses lack.

---

## A. Capability — the hands

**O1. Jailed local capability.** The model can read, search, write, edit, and
run commands — but every file action resolves inside the project's working
directory ∪ documents directory, symlink chains included. A shell is
inherently unjailed, so it is never a "read".
*Source: every coding harness ships fs/shell/edit as the primary surface;
the jail is ours.*
Accept: escape attempts (relative, absolute, symlinked file, symlinked
parent) are refused before any prompt. **Status: SHIPPED** (coding-tools.js;
smoke coverage).

**O2. One result contract.** Coding tools return `{text, isError}` exactly
like MCP calls so filtering, tracing, variable capture, and the glass box
apply unchanged.
Accept: no special-casing downstream of `callTool`. **Status: SHIPPED.**

**O3. Live-service grounding.** Unlike any pure coding harness, the agent can
interrogate connected MCP services (e.g. a SIEM) *while building*, capturing
real data contracts into working memory — but code it writes can never call
MCP; that boundary must be stated to the model.
Accept: CODING MODE note names the boundary. **Status: PARTIAL** (tools
compose today; the boundary is stated in the planner's CODING_RULES, so
planned turns are told — but the runtime CODING MODE note still lacks the
sentence, so flat-loop turns are not. Sliver: add it to the note in ipc.js).

## B. Consent — the conscience

**O4. Hierarchical permissions, priced by irreversibility.** Three levels:
(1) scope jail, never bypassable; (2) action approval for what git cannot
undo — reads free, file writes/edits auto-approved WHEN the working dir is a
git repo (rollback exists; per-file prompts don't scale to real projects),
shell always asks; (3) bypass (extends to shell) only where rollback exists
(git), enforced in main, revocable and visible.
*Source: Claude Code permission modes; Harness.io approval stages; usage
feedback — per-file approval was unusable at project scale.*
Accept: deny mutates nothing and tells the model not to retry; writes flow
without prompts in a git repo and ask without one; shell prompts unless
bypassed; bypass ignored without `.git`; standing bypass shows a chip.
**Status: SHIPPED.**

**O5. Reviewable approvals.** An approval must show what will actually
happen — a diff for edits, size/overwrite facts for writes, the verbatim
command for shell — not a description to rubber-stamp.
*Source: Aider/Claude Code diff-first UX.*
Accept: edit_file prompts contain −/+ lines. **Status: SHIPPED**
(coding-tools.js call() summaries).

**O6. No secret leakage into child processes.** Commands get an allowlisted
env; the app's keys and tokens never cross into the shell.
Accept: canary env var does not appear in `run_command` output.
**Status: SHIPPED.**

## C. Method — the lifecycle

**O7. Objectives → design → code, never a race.** When a request sets a
development direction (platform, stack, structure, distribution) that isn't
already fixed by KNOWN VALUES, the project brief, or the request itself, the
planner must return *decisions to make* — options, tradeoffs,
recommendation — and the turn ends awaiting the user. It must never silently
pick a direction.
*Source: the phone-app trace; OpenCode plan mode generalized from "don't
write yet" to "don't decide yet".*
Accept: an underdetermined build request yields an alignment reply with zero
tool calls. **Status: SHIPPED** (`align` outcome + interactive decision
form with write-in; live-verified).

**O8. Decisions are durable.** Ratified user decisions persist as
`user`-confidence variables — overwrite-protected against model guesses,
re-injected into every future step and plan.
Accept: a decision stated by the user reaches the store via the plan's
`record` field. **Status: SHIPPED** (record → store at `user` confidence +
SPEC decision records).

**O9. The plan is the git history.** Each completed step that mutated the
working tree commits with its `produces` as the message — the typed plan
contract becomes traceable increments. Framework bookkeeping, not a
model-approved action.
*Source: no harness does this; Harness.io's audit trail says it must exist.*
Accept: a 3-step mutating plan leaves ≥1 commit per mutating step.
**Status: SHIPPED** (commitStep + onStepComplete; flat-loop turns get one
`turn:` commit so a wandering turn is never unrecorded).

**O10. Plans that write code must verify.** The plan-shape contract: steps
that create/modify code end with a verification step (tests/build via
run_command, fix failures); steps may only prescribe what the listed tools
can do (no pantomime, no MCP-in-app).
*Source: compiler/tests as ground truth — the harnesses' core advantage;
Harness.io Continuous Verification.*
Accept: DERIVE_PROMPT carries the rules; a code-writing plan's last step
runs verification. **Status: SHIPPED** (CODING_RULES in DERIVE_PROMPT).

**O11. Refinement is bounded and structural.** Verify means three layers:
(1) it works — the plan's own verification step runs tests/build; (2) it is
well-made — DRY, modular, no brute force; (3) it is secure. Layers 2–3 run
as a deterministic post-execution review (review.js): quality + security
critic lenses over the actual changed files, in parallel, findings validated
(known files only, high/med only, deduped, worst-first) — then ONE bounded
fix step, committed as `review: …`. Clean is a first-class outcome.
*Source: Chris's methodology; the multi-lens review pattern.*
Accept: junk findings filtered; findings sorted worst-first; fix cycle runs
once and cannot spiral; review failure never breaks a turn.
**Status: SHIPPED (v1)** — deterministic-tool anchors (lint/audit) and
authored-agent lenses are the v2 extensions.

## D. Recovery + measurement — the safety net

**O12. Every loop bounded, every failure lands somewhere safer.** Planner
failure → flat loop; budget exhaustion → forced wrap-up; stuck → refine ≤3 →
escalate; STOP → save work; no git → ask. **Status: SHIPPED** (pre-dates the
harness; preserved by it).

**O13. Rollback is executable, not aspirational.** Auto-checkpoint before a
bypassed turn's first mutation; one-click revert-turn. O9's step-commits are
the foundation. **Status: PLANNED.**

**O14. Everything measured, glass box kept.** Approvals, commits, plan
shape, refinement cycles land in metrics/process events like everything
else. No invisible context engineering — the differentiator over every
harness studied. **Status: PARTIAL** (process events shipped; approval rows
in task_metrics planned).

**O15. Documentation is the source of truth, maintained by the pipeline.**
The project documents library holds a canonical doc set — SPEC (objectives,
requirements, decision records), DESIGN (architecture + ADRs), KNOWLEDGE
(how it works, findings, gotchas). Planning READS these to determine
objective and purpose — never inferring intent by re-reading code, the
Claude/Codex failure mode. Every change WRITES back: ratified align
decisions append to the SPEC automatically (framework bookkeeping, like
step-commits); after any turn that mutated files, a dedicated
technical-writer pass (doc-writer.js) updates DESIGN/PSEUDOCODE/KNOWLEDGE
from the actual changed file contents — the planner is explicitly told NOT
to plan documentation steps (planned doc steps produced untouched skeletons
and narrative sludge). Docs are real versioned files in the project output
dir (in-repo when a working dir exists), indexed in the library.
*Source: docs-as-code; Architecture Decision Records (Nygard); Diátaxis;
requirements traceability.*
Accept: an align `record` bumps the SPEC doc with the decision appended;
`planContext` carries the docs under a source-of-truth banner;
DERIVE_PROMPT carries the documentation rule; both execution paths run the
doc-writer when the turn mutated. **Status: SHIPPED** (project-docs.js +
doc-writer.js; both paths wired in ipc.js).

## E. Orchestration + guards — the next ring

**O16. The plan establishes the orchestrator; division owes merging.** The
planner that divides work into steps must also author how results recombine:
`submit_plan` declares an orchestrator block (merge strategy, conflict
policy) and step-level fan-out groups; steps sharing a group and marked
parallel run CONCURRENTLY (today `parallel` buys isolation only — sub-agents
awaited in order), and each group's results are merged by its own contract
into one step-result that later steps consume via working memory. Bounds:
≤4 concurrent sub-agents per group, one bounded merge call, merge failure
degrades to concatenation.
*Source: LangGraph fan-in reducers; the assign tool's Promise.all + merge
(already shipped, but model-invoked); §3 of the internal design record.*
Accept: a plan with a marked group runs its members concurrently; the merged
product appears as one step-result and its values are captured; a failed
member surfaces in the merge rather than aborting the group.
**Status: SHIPPED (v1)** — submit_plan carries `group` + `orchestrator`
{merge, on_conflict}; execute.js runs consecutive same-group steps with a
4-worker pool, merges via one bounded fast-model call (concatenation
fallback), captures the merged product into working memory, and books the
group as one step; group events land in the plan rail. Smoke-covered
(concurrency, single-result, contract pass-through, merge-failure
degradation, group-implies-parallel normalization). Deferred to v2:
`consumes` dependency edges and non-consecutive group scheduling.

**O17. Guard chain — the LLM firewall and guardrails at named points.**
Two module families at two trust boundaries. The **LLM firewall** is the
model's perimeter: inbound it protects the LLM from prompt injection (IN-1
user prompt, IN-2 tool results, IN-3 sub-agent conclusions); outbound it
protects the user's data — DLP scrubbing at the provider hop (EG-2), since
content entering the LLM IS data leaving the machine. **Guardrails** are
the user's last checkpoint: output guardrails on replies and saved docs
(EG-3 — malicious URLs, abusive language, unsafe content) and action
guardrails on tool calls (EG-1 — path policy, command lint, secrets in
written content). One module contract for both families:
`{name, point, inspect() → allow|block|rewrite|flag + reason}`.
Deterministic-first; classifier guards are bounded and fail to `flag`; block
reuses the O4 denial contract; rewrites are visible process events; the
human approval gate is the LAST action guardrail; the scope jail is never a
module. Guards add restriction, never permission. A point with no modules
is a PASSTHROUGH — undefined firewall/guardrails is a valid, zero-cost
state; the chain's existence is the contract, not any particular module.
*Source: OpenAI Agents SDK guardrails/tripwires; NeMo Guardrails rail
taxonomy; LLM gateway egress scrubbing; Harness.io gates.*
Accept: filter.js, the approval gate, and the env scrub are re-expressed as
registry guards with zero behavior change; an IN-2 injection scanner and an
EG-2 secret scrub ship as the first new modules; every verdict lands in
process events.
**Status: PLANNED** (design: the internal design record §4).

**O18. The guard chain is a deployable boundary — group proxy with access
control and audit.** The firewall→LLM→guardrail pattern is location-
transparent: verdicts are serializable, so the same chain contract runs
(1) in-process — today's internal default, passthrough allowed; (2) as a
local sidecar; (3) as a shared **group proxy** deployed separately and
fronting a team — one policy, one audit trail, many clients. At the proxy
the whole pattern collapses onto the wire hop it already owns: the request
carries the full context (firewall inspects, DLP scrubs), the response
carries the completion (output guardrails inspect; tool calls in the
completion get policy verdicts attached) — while tool EXECUTION and the
human approval gate always remain client-side. The proxy authenticates
callers (per-user/app credentials), authorizes per group policy (allowed
models, guard profiles, tool policy, quotas), and holds the provider keys —
clients never do. Audit is append-only per event: {caller, point, guard,
verdict, reason, content refs}; policy chooses hash-only vs full capture;
client process events carry the proxy audit id so the glass box (O14) spans
the wire. Fail posture is group policy: fail-closed default for managed
groups, fail-open permitted for solo/dev.
*Source: LLM gateway pattern (LiteLLM, Kong AI, Cloudflare AI Gateway) —
adopted for key custody and the wire hop; rejected as a whole because
gateways can't see IN-2/IN-3 or run the client-side human gate. Zero-trust
policy-enforcement-point placement.*
Accept: the in-process chain and the proxy accept the same guard module
unchanged; a client configured with a proxy URL routes EG-2 through it and
records audit ids in process events; an unauthenticated caller is refused;
a proxy outage honors the group's fail posture.
**Status: PLANNED** (design: the internal design record §4c).

**O19. Controls are shared, inherited, and versioned — the proxy is the
control plane.** Agentic development means many actors — developer
sessions, headless CI/cron agents, and the sub-agents any of them spawn —
and it is only governable if the LLM controls are defined ONCE and shared
through the deployment, not configured per machine. The proxy therefore
serves a **policy bundle** per authenticated identity: guard profiles per
point, model allowlist, tool policy, approval policy, fail posture, and a
`policy_version`. Rules: (1) clients bootstrap by fetching their bundle at
session start and apply it to the local registry; (2) local configuration
can only TIGHTEN a shared bundle, never loosen it — "guards add
restriction, never permission" at deployment scale; (3) sub-agents and
delegated steps inherit the resolved bundle of whatever spawned them —
delegation can never escape policy; (4) headless runs resolve the same way
via app credentials — no unmanaged path; (5) every turn's process events
and every proxy audit row carry the `policy_version` that governed it, so
an audit answers "which rules were in force" as well as "what happened".
*Source: policy-as-code distribution (OPA); zero-trust control-plane/data-
plane split; Claude Code managed-settings precedent — admin-distributed
policy that user settings cannot override.*
Accept: two clients with the same identity resolve identical bundles; a
local attempt to loosen a shared control is ignored and logged; a spawned
sub-agent's effective policy equals its parent's; audit rows join process
events on `policy_version`.
**Status: PLANNED** (design: the internal design record §4d).

## F. The documents harness — collect, analyze, create, manage

The DOCUMENTS mode triad: hands = collect and manage, conscience =
provenance, method = the document lifecycle. Ratified terminology
(2026-08-08): **format** = the document we are trying to PRODUCE (a named
structural template); **type** = what we CONVERT to (markdown | html |
pdf); **placement** = where it is stored (a managed taxonomy, e.g.
customer → category).

**O20. Document hands.** A library-jailed tool pack: read, list, and
search the project document library, plus `revise_document` for targeted
edits to an existing deliverable. Reuses the coding-tools jail machinery
with the library as the only root — no shell, no raw writes (publication
goes through the pipeline). Closes the shipped gap where the model is
shown library paths only CODE mode can open.
Accept: the model can read anything the DOCUMENTS tab lists; a revision
produces a new version of the same document, never a duplicate.
**Status: PARTIAL** — the library-jailed read pack shipped
(`buildLibraryTools` in coding-tools.js: read_file/list_dir/grep_files,
single library root, same jail, routed in DOCUMENTS mode, smoke-covered);
`revise_document` and management verbs still planned
(design: the internal design record §5).

**O21. Provenance is the conscience.** Collection auto-captures sources
(URL, MCP tool + params, library file) alongside values — the same
capture discipline the variable store applies to ids — and every
published document carries its source manifest in properties. A claim
without a source is a review finding, not a style preference.
Accept: a published report's properties name the sources each section
drew from; the verify pass flags unsourced claims.
**Status: PLANNED** (design: the internal design record §5).

**O22. Document lifecycle.** The plan shape for documents mode: align
(audience, format, type — the O7 gate extended to documents) → collect in
parallel (the first customer of O16 fan-out/merge) → analyze into working
memory → draft by composing the format → verify with document lenses
(claims-vs-sources, completeness against the request, internal
consistency, format contract) → ONE bounded fix cycle → publish
versioned. Maintain on later turns: revise, never recreate.
Accept: an underdetermined document request yields an align reply; a
publishing turn runs the verify pass; fix runs once and cannot spiral.
**Status: PARTIAL** — the plan-shape contract shipped (DOCUMENTS_RULES in
plan-derive.js: plan-by-default for deliverables, align on
audience/format/type/scope — the O7 gate now fires in documents mode —
parallel collection, save_document contract, verify step, revise-over-
recreate; smoke-covered). The post-execution document review lenses + fix
cycle still planned (design: the internal design record §5).

**O23. Placement is a managed taxonomy.** Storage is organized, not
accidental: the placement template generalizes to arbitrary property
tokens — e.g. `{customer}/{category}/{title}.{ext}` — so documents file
by customer, then by category (monthly reports, health reports, plans).
Category defaults from the format's family; the DOCUMENTS tab mirrors
the same tree. Management verbs: supersede, archive, document sets
(a report + its appendices), cross-references.
Accept: two monthly reports for the same customer land in the same
folder as versions/siblings; changing the template re-homes future saves
without breaking the index.
**Status: PLANNED** (design: the internal design record §5).

**O24. Format vs type — produce vs render.** A FORMAT is a named,
authorable structural template: ordered sections, widget slots, and a
data contract (what must be collected to fill it). A TYPE is a render
target: markdown | html | pdf. One composed document renders to any
type; conversion is DETERMINISTIC pipeline code (pdf via Electron's
printToPDF — no new dependencies), never a model call. The model
composes content into the format; the framework renders and converts.
The shipped save_document schema conflates these (its `type` is a label,
its `format` is a file extension) and migrates to the ratified terms.
Accept: the same composed document produces html and pdf with identical
content; formats are rows the user can author like agents/skills; skills
can ship formats.
**Status: PARTIAL** — two slices shipped: (1) html→pdf conversion
(`render-pdf.js` + `documents:toPdf`, offscreen hardened window,
live-verified); (2) **format targets v1** — a per-project sample document
(the library's `formats/` folder, or the `output_format` setting) is the
visual standard: DOCUMENTS mode names it in the mode note, the planner is
told to read it before composing, and skills carry only section semantics
— branding belongs to the SYSTEM, not to skills. A user installs a
better-looking sample (with their branding) and every deliverable follows
it. Exception ratified: the format's web-font stylesheet links are the
only permitted external references (fallback stacks required). Format
ROWS, markdown target, and the save_document schema migration still
planned (design: the internal design record §5).

**O25. Widgets relate data to presentation.** A library of data-bound
components fills format slots: callout, analysis, summary, table, and
chart (bar, line, donut, radar, heatmap). Contract: `{widget, data,
options}` — the model authors DATA, never hand-rolled markup — rendered
deterministically per type: self-contained inline SVG for html/pdf (no
CDN, print-safe, offline-safe), and defined markdown degradations
(chart → caption + data table, callout → blockquote, table → md table).
Structured widget data is what makes the verify pass mechanical: numbers
in a chart are checkable against collected values.
*Source: the MSSP report skills hand-author these today — proof of need;
one shared renderer replaces N hand-rolled ones.*
Accept: identical widget data renders in all three types; a chart in a
pdf has no external requests; the verify pass can read widget data
without parsing markup.
**Status: PLANNED** (design: the internal design record §5).

---

## Traceability

| Objective | Design element | Where |
|---|---|---|
| O1, O2, O6 | tool pack + jail + env scrub | `src/main/coding-tools.js`, smoke §coding |
| O4 | permission hierarchy | `coding-tools.js` gates + `ipc.js` approveAction/askUser + bypass chip |
| O5 | diff summaries in approvals | `coding-tools.js` call() summaries |
| O7, O8 | `align` outcome + `record` | `plan-derive.js` submit_plan schema + `ipc.js` align gate |
| O9 | step-commits | `coding-tools.js` commitStep + `execute.js` onStepComplete |
| O10 | plan-shape contract | `plan-derive.js` DERIVE_PROMPT coding rules |
| O11 | verify layers 2–3: review + fix cycle | `src/main/review.js` + `ipc.js` review pass |
| O13 | checkpoint/revert | planned — rides O9 |
| O15 | canonical project docs | `src/main/project-docs.js` + `plan-derive.js` docs context/rule + `ipc.js` spec append |
| O16 | fan-out groups + merge contracts | shipped: `plan-derive.js` group/orchestrator schema + `execute.js` group runner + `ipc.js` mergeGroup (design: the internal design record §3) |
| O17 | guard-chain registry | planned — new `guards.js`; re-homes `filter.js`, approveAction, env scrub (design: the internal design record §4) |
| O18 | group proxy + access control + audit | planned — proxy service reusing `guards.js`; provider base-URL routing in `providers/` (design: the internal design record §4c) |
| O19 | shared policy bundles + inheritance | planned — bundle fetch/apply in `guards.js` registry; propagation via `subagent.js` (design: the internal design record §4d) |
| O20 | document tool pack | shipped: `buildLibraryTools` (coding-tools.js) + DOCUMENTS mode wiring (ipc.js); planned: `revise_document` |
| O21 | provenance capture + manifest | planned — `variables.js` source capture + `documents.js` properties |
| O22 | document lifecycle + review lenses | shipped: DOCUMENTS_RULES + documents-mode align (`plan-derive.js`); planned: lenses in `review.js` |
| O23 | placement taxonomy + management | planned — `documents.js` placementPath property tokens; `repo.documents` verbs |
| O24 | format/type split + deterministic render | shipped: html→pdf (`render-pdf.js` + `documents:toPdf`) + format targets v1 (ipc.js documents block + `plan-derive.js` FORMAT TARGET rule); planned: format rows, md target, schema migration |
| O25 | widget library | planned — new `widgets.js` deterministic renderer (SVG + md degradations) |

---

## Licensing

Shamrock is offered under **FSL-1.1-ALv2** (`LICENSE`), copyright 2026
Christopher Jordan. Free for all use including internal commercial use and
client work; a commercial license is required only for *competing use* —
offering Shamrock, or something substantially similar built from it, as a
product or service to others. Every release converts to Apache 2.0 two years
after publication.

Decided because: the product is a desktop app, so AGPL's network clause has no
leverage; pure non-commercial terms would block the internal adoption the
distribution model depends on; and MIT gives away the commercial path entirely.
The name and clover mark are trademarks held outside the FSL grant, and
contributions carry a DCO sign-off so the copyright chain stays clean enough to
keep selling commercial licenses. See `LICENSING.md`.
