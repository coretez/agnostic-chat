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
shell always asks; (3) bypass — in effect a SHELL bypass, since writes are
already free with git. Honest framing: git does NOT roll back shell effects
(network, installs, deletes outside the tree), so the standing grant is
confirmed by a main-process dialog stating exactly that risk — a renderer
message alone cannot flip it. Still git-gated, revocable, and visible.
*Source: Claude Code permission modes; Harness.io approval stages; usage
feedback — per-file approval was unusable at project scale.*
Accept: deny mutates nothing and tells the model not to retry; writes flow
without prompts in a git repo and ask without one; shell prompts unless
bypassed; bypass ignored without `.git`; enabling bypass requires the
main-side confirmation; standing bypass shows a chip.
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

*The failure mode, measured 2026-08-14.* `record` sits in the same tool call
as `goal`, `steps`, `produces` and `merge` — every one of which is scoped to
THIS request — and then asks the opposite question: what outlives it. The
planner answers in the frame it is already in, and proposes the request's
own parameters. Observed live under permissive wording: `output_path`,
`output_format` (run 1, which reached the SPEC), then `output_target`,
`format`, `scope` (isolated A/B). **The junk keys differ every run**, so the
guard has to be an allowlist of durable keys — a denylist cannot enumerate
what it has not seen. Two layers, each independently verified: naming the
legal keys in the schema stops most proposals at the source, and the
vocabulary filter rejects the rest. Asymmetry that sets the bias: a false
positive lands at `user` confidence and is therefore STICKY — no later
observation can overwrite it — while a false negative costs nothing, since
the user can simply restate. Reject when unsure.

Accept: a decision stated by the user reaches the store via the plan's
`record` field; a task parameter never does, and the rejection is visible
(`records` event: proposed/kept/dropped). **Status: SHIPPED** (record →
store at `user` confidence + SPEC decision records; durable-key vocabulary
+ dropped-key reporting). *Open, in DEBT:* an inferred record is stored at
`user` confidence with `source: 'align'` though nothing verifies a
ratification, and `record` is offered on every turn while its sibling
`decisions` is mode-gated.

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
*The list insight (2026-08-14).* These documents are LISTS — SPEC is objectives
with stable ids, DEBT is a checklist with keys, a plan is ordered steps. Plain-
text list practice (todo.txt; Org mode; agile backlog refinement) has three
lessons the canonical set has not taken:
- **Entries are DATA, not prose.** todo.txt puts state, priority, dates,
  `+project`, `@context` and `key:value` in a fixed order on one line so
  standard tools can sort and filter it. DEBT buries lens/severity/file in a
  sentence; it is greppable by luck, not by design.
- **Scale comes from VIEWS, not from filing.** Org mode holds thousands of
  tasks across hundreds of files and stays usable because nobody reads the
  files — they read an agenda that queries across them. Shamrock does the
  opposite: `load()` injects the WHOLE canonical set into every planning call,
  so each document costs tokens on every turn whether or not it is relevant,
  and gets less useful as it grows. The planner wants "open high-severity
  findings touching the files this plan names", not four documents.
- **Lists rot without a cadence.** A backlog left alone becomes a graveyard of
  vague, outdated items; refinement is a recurring practice, and untouched
  entries get archived. O30 grooms the CODE. Nothing grooms the ledger — twice
  in one session an entry stayed open after its fix had shipped.
Also missing: a workflow beyond the `- [ ]`/`- [x]` binary (the ledger already
has a de-facto third state, PROMOTE TO GATE, encoded in prose), and any WIP
bound — O11 caps a fix cycle at one, but nothing caps the ledger.

*Source: docs-as-code; Architecture Decision Records (Nygard); Diátaxis;
requirements traceability; todo.txt; GNU Org mode agenda; agile backlog
refinement.*
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
**Every guard reports its DENOMINATOR, not only its rejections.** A module
that emits solely on block/rewrite makes silence ambiguous: "nothing was
inspected", "nothing matched", and "the module never ran" all look identical
from outside, so a broken guard is indistinguishable from a working one.
Each inspection therefore reports what it saw as well as what it did
(`inspected`, `allowed`, `blocked/rewritten/flagged`). Learned the hard way
on the O8 record filter: a dropped-only event led to a confident claim that
the guard had rejected junk when in fact nothing had ever been proposed to
it — the guard had not run at all.
Accept: filter.js, the approval gate, and the env scrub are re-expressed as
registry guards with zero behavior change; an IN-2 injection scanner and an
EG-2 secret scrub ship as the first new modules; every verdict lands in
process events; a point that inspected zero items is distinguishable from a
point that inspected many and allowed them all.
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
*Observed weaknesses, from a real Expo monthly run (2026-08-14).* The stored
tree today is:

    monthly-report/expo/expo-monthly-security-report-2026-07-2026-07.html
    monthly-report/expo/msoc-monthly-report-expo-july-2025-2025-07.md
    raw-data/expo/expo-monthly-security-report-2026-07-data-2026-07.xls

- **The period is written twice.** The template appends `-{period}` to a title
  that already carries it, giving `…-2026-07-2026-07`. The template must not
  re-state a token the title already contains.
- **Version is doing the job of IDENTITY.** July went to v4 with v1–v3 in
  `.versions/`. That is right for *revisions of July*, but nothing separates
  "a corrected July" from "the next month's report". For a periodic document
  the PERIOD is the identity and the version is the revision within it;
  conflating them means a re-run for the same period silently becomes v5, and
  a re-run for a new period looks like an unrelated file.
- **A series is invisible.** Two monthly reports for the same tenant sit in one
  flat folder under different naming conventions, with nothing expressing "the
  Expo monthly report series" — no ordering, no latest, no gap detection (a
  missing month is undetectable).
- **The deliverable and its appendix are unlinked.** The `.xls` raw-data export
  belongs to that HTML report; they live in different type folders with no
  relation recorded. This is the "document sets" verb, still unbuilt.

Accept: two monthly reports for the same customer land in the same
folder as versions/siblings; changing the template re-homes future saves
without breaking the index; a period token appears exactly once in a
filename; a periodic series can list its members in order and name the
latest; a report and its appendices resolve to one set.
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
*Scope correction (2026-08-14): this is the RENDER SURFACE, not a document
feature.* Rich content arrives from three directions and today only one of
them renders at all. The model emits fenced blocks — a ```mermaid diagram
displays as SOURCE because renderer.js captures the fence language and then
renders every block as `<pre>`. MCP tool results carry `image`, `audio` and
embedded `resource` blocks — `mcp/client.js` filters to `type === 'text'` and
DISCARDS the rest silently, so a server returning a chart produces a result
that looks thin to the model, with no error and nothing in the glass box.
Documents want the same widgets. One renderer serves all three, or each grows
its own and they drift.

The split that decides sequencing is TRUST, not source:
- **Model-authored data** (a mermaid fence, a `{widget, data}` block) is data
  we render ourselves with a deterministic renderer — no markup from
  elsewhere, no script. This is safe to ship NOW and does not wait on O17.
  Mermaid in chat + html + pdf is the first slice and the smallest one.
- **Server-supplied content** (MCP `image`/`resource`, `ui://` app resources)
  is untrusted input from an external process. Preserving it is safe and
  urgent — a dropped block must at minimum leave a visible marker naming what
  was dropped, because silent loss is the same lie the guard chain exists to
  prevent. RENDERING it is a trust-boundary change and waits for O17 EG-3;
  rendering server HTML inside a CSP-locked, sandboxed renderer would hand an
  external server the scripting surface Phase 4 closed.

Accept: identical widget data renders in all three types; a chart in a
pdf has no external requests; the verify pass can read widget data
without parsing markup; a ```mermaid fence renders as a diagram rather than
source; an MCP content block that cannot be rendered yet still leaves a
marker instead of vanishing.
**Status: PLANNED** (design: the internal design record §5). Sequencing:
mermaid render → MCP drop-markers → widget library → `ui://` behind EG-3.

## G. Rules → gates — the rulebook is enforced, not advisory

`docs/AGENT_RULES.md` is the prompt-facing rulebook (distilled from Anthropic,
OpenAI, and Moonshot first-party guidance). Its meta-rule is the contract for
this ring: **a rule violated twice is promoted into a gate** — a framework-run
check, a guard module, or a prompt-contract line. These objectives wire the
rulebook's non-negotiables into deterministic gates so the rules stop being
probabilistic compliance.

**O26. The check command is a framework gate.** A per-project check command
(tests / lint / build — from project settings, or discovered from the repo)
is run by the FRAMEWORK, never by planner memory: (1) at turn start in coding
mode, before the first mutation, to establish a baseline — pre-existing
breakage is attributed, not inherited; (2) after every mutating step, with
failures injected back into the step loop under the root-cause rule (fix it,
never suppress it); (3) its final result feeds synthesis and anchors the O11
review as its first deterministic lens. Success is silent; failure is verbose.
*Source: OpenAI harness engineering ("promote the rule into code"); Anthropic
best practices ("give Claude a check it can run"); Kimi K2 verifiable rewards
over rubric judgment; AGENT_RULES §Verification.*
Accept: a mutating turn with a configured check runs baseline + per-step
checks; a failing check blocks step completion until fixed or escalated (O12
bounds apply); check results land in process events and in the review pass.
**Status: SHIPPED (v1)** — `check_command` per-project setting (Overview
card), granted through the SAME main-side confirmation as the O4 bypass
(it is standing consent to run shell unprompted — a renderer message alone
cannot install it). The baseline runs LAZILY, immediately before the
turn's first mutation, so a question-only turn never pays for a slow suite
while attribution is preserved (a pre-existing failure is labelled as not
the model's). Gated on **all three paths**: per-step in execute.js (one
bounded fix step on failure; fix steps re-check but never re-insert — no
spiral; a step that ran the check itself last and successfully is not
re-run), one post-parallel check covering sub-agent mutations the isolated
traces hide, and one check on a mutating flat turn. A check still failing
at turn end reaches synthesis as an incomplete step-result, anchors the
O11 review as its first deterministic finding, sets the reply's honesty
marker, and lands in the DEBT ledger. Smoke-covered.

**O27. Findings are durable — the debt ledger.** Findings the ONE bounded
O11 fix cycle leaves unfixed, and recurring evaluator findings, append to a
tech-debt tracker doc in the O15 canonical set (DEBT) — finding, source turn,
rule violated. A finding recorded twice becomes a promotion candidate: the
app surfaces "promote to gate" — extend the O26 check command or register an
O17 guard module. Nothing evaporates; scope discovered off-task is recorded,
not chased.
*Source: OpenAI tech-debt-tracker + "human taste captured once, enforced
continuously"; AGENT_RULES meta-rule + §Scope.*
Accept: an unfixed review finding appears in the tracker with its source
turn; a repeat finding is flagged as a promotion candidate.
**Status: SHIPPED (v1)** — DEBT joins the O15 canonical set
(project-docs.js appendDebt); review findings that consumed the fix cycle
land as "fix attempted — unverified", unresolved check failures as
"unresolved", drift findings as "drift scan"; a repeated key is flagged
**REPEAT ×N — PROMOTE TO GATE**. Smoke-covered. Deferred: evaluator
(stage L) findings feeding the ledger.

**O28. Test integrity — stated rule, then action guardrail.** CODING_RULES
gains the line: a failing test is never removed or weakened to reach green —
fix the root cause; editing the test is legitimate only when the test itself
is wrong, and the step must say so. When O17 lands, an EG-1 action guardrail
enforces it: a mutation to a test file while the current step is a
verification/fix step gets verdict `flag` — routed to the approval prompt
even under O4 bypass.
*Source: Anthropic long-running harness ("it is unacceptable to remove or
edit tests" — feature ledger is append-only); AGENT_RULES §Verification.*
Accept: DERIVE_PROMPT and the CODING MODE note carry the rule now; with
guards live, a test-file edit inside a fix step prompts despite bypass.
**Status: PARTIAL** — the rule text shipped in both places (TEST INTEGRITY
in CODING_RULES; the runtime CODING MODE note; every check-gate fix prompt
restates it). The EG-1 action guardrail rides O17. Smoke-covered.

**O29. The repo speaks first — map + rulebook injection.** Pass 2 receives
a depth-2 repo map so plans name real files, not imagined ones; and a
working-dir rulebook (`AGENT_RULES.md` | `AGENTS.md` | `CLAUDE.md`, first
found) is auto-injected beside the cheat sheet under a rulebook banner.
Injection is a ledger event — visible in the assembled-prompt viewer like
everything else. No rulebook, silent pass: the chain's existence is the
contract (same posture as O17 passthrough).
*Source: OpenAI AGENTS.md-as-table-of-contents / progressive disclosure —
"anything the agent can't access effectively doesn't exist";
AGENT_RULES §Intent.*
Accept: a plan against a real repo names only existing paths or
explicitly-new ones; the rulebook shows in the assembled prompt;
its token cost appears in the ledger.
**Status: SHIPPED** — the depth-2 repo map already fed Pass 2; the
rulebook half now ships: readRulebook (project-docs.js — AGENT_RULES.md ▸
docs/AGENT_RULES.md ▸ AGENTS.md ▸ CLAUDE.md, first found) injected into
the CODING MODE note (execution) and planContext under the PROJECT
RULEBOOK banner (planning + refinement), with a `rulebook` process event.
No rulebook = silent passthrough. Smoke-covered.

**O30. Drift pass — backward-looking garbage collection.** Per-turn review
(O11) sees one turn; drift is a cross-turn phenomenon and currently
invisible. A maintenance turn — user-invoked first, schedulable later —
scans the working tree against SPEC/DESIGN and the rulebook's golden
principles, plus doc-gardening over the O15 set (docs contradicting the code
they describe). Findings land in the O27 ledger; small fixes run as ONE
bounded fix plan with ordinary step-commits and O4 gates — debt is paid
continuously in small increments, never in heroic bursts.
*Source: OpenAI entropy/GC — recurring golden-principles scans +
doc-gardening agents, after Friday cleanup failed to scale;
AGENT_RULES §Scope.*
Accept: a drift turn on a seeded repo yields tracker entries and a bounded
fix commit; it never mutates outside the O4 permission gates; clean is a
first-class outcome.
**Status: SHIPPED (v1)** — drift.js scans the ~8 most recently modified
source files against the rulebook + canonical docs with a drift lens
(doc-staleness findings filed against the doc names); findings → DEBT
ledger; strictly READ-ONLY (fixes run as ordinary turns with ordinary
gates — a stronger guarantee than the accept's "fix commit", which is
deliberately left to the user). User-invoked: Overview → MAINTENANCE.
Smoke-covered. Deferred: scheduling.

**O31. The Librarian — the library organizes itself.** Documents pile up and
sessions pile up; a flat list stops working around twenty items, and a growing
project must stay findable without the user filing anything. One fast-model
call files each artifact — at save time for documents (normalizing
type/entity/period against the project's EXISTING vocabulary before the
deterministic template places the file) and at turn end for sessions (title
when untitled, one-line summary, tags) — with deterministic validation
(librarian.js) deciding what lands: known facets only (topic / kind / entity /
period / status), slug-deduped, capped at 5, existing spellings win over fresh
coinage even when the model ignores instructions. Organization is VIRTUAL:
faceted tags over documents AND chats (shared vocabulary → the cross-cutting
view: one tag filters deliverables and sessions together), views pivot
(recency / kind / entity / topic), and nothing ever moves on disk — the
`.versions/` chains and saved paths stay intact. A bounded on-demand tidy pass
files the backlog. Filing can never break a save or a turn (failure = saved
unfiled), never blocks the reply (session filing runs after the turn returns,
announcing itself on `librarian:update`), and every tag carries provenance
(librarian vs user).
*Source: the mess observed live — libraries and session lists rot as they
grow; multi-tag facets because no single organization fits every retrieval.*
Accept: spelling variants of a tag land on one row (slug dedupe); a filing
failure still saves the document; the session list shows librarian summaries;
a tag click filters documents and chats together; tidy is bounded and
reversible. **Status: SHIPPED (v1)** — librarian.js + tags schema (v20) +
save/turn wiring in ipc.js + library views in the renderer; smoke-covered.
Extensions: user tag editing in the reader, entity rollups, auto-archive
suggestions for stale sessions.

**O32. The Registrar — the canonical docs are a managed list, not prose.**
The canonical set is already made of LISTS (objectives with ids, findings with
keys, decision records, the traceability table) but each one is hand-tended,
and hand-tending fails: twice in one session a DEBT entry stayed open after
its fix had shipped, and O8's own text carries an *"Open, in DEBT"* note that
nothing verifies. An internal, deterministic list service owns five verbs over
those lists — the model never has to remember to call it, like step-commits
and the doc-writer.

- **CREATE** — append an item with a stable key, structured fields, and a
  state. Fields are DATA in fixed positions (`state · sev · lens · file ·
  issue · fix · key`), the todo.txt lesson: sortable and filterable by
  ordinary tools rather than greppable by luck. `appendDebt` is the v0 of this
  verb and migrates onto it.
- **MAINTAIN** — edit fields and move state. State is a WORKFLOW, not the
  `- [ ]`/`- [x]` binary: at minimum open → fixed-unverified → closed, plus
  the promote-to-gate state the ledger already expresses in prose because it
  has nowhere else to put it.
- **VALIDATE — the integrity pass, prose ↔ items, both directions.**
  Deterministic and cheap; every check is a grep, not a model call:
  *items → prose*: an item names a file that no longer exists; an item's
  claimed fix (a named symbol) is absent from the tree; a closed item whose
  symbol vanished — a regression.
  *prose → items*: an objective marked PARTIAL or PLANNED with no open item
  or plan reference; an *"Open, in DEBT"* note with no matching open item; an
  objective missing from the traceability table, or a table row pointing at a
  path that does not exist; an item marked open whose fix IS present in the
  tree — the exact drift that bit twice.
- **CLOSE** — ticking requires evidence, not intent: the named symbol present,
  or the smoke assertion that pins it named on the item. An item cannot close
  itself by being forgotten.
- **LIST VIEW — the agenda, and the point of the whole objective.** Org mode
  holds thousands of tasks because nobody reads the files; they read a query.
  `project-docs.load()` today injects the WHOLE canonical set into every
  planning call, so a document costs tokens on every turn regardless of
  relevance and gets worse as it grows — precisely backwards. The planner gets
  a VIEW ("open high-severity items touching the files this plan names"), the
  user gets one in the DOCUMENTS tab, and a document that never satisfies a
  query is thereby visibly dead — the use-signal the O15 entry asks for.
*Checked against what list tools actually ship, so the gaps are chosen rather
than forgotten.* Carried in from the five verbs above: stable ids, states,
priority, structured fields, queries, archiving. **Also required, and absent
from the first cut:**
- **Item ↔ objective link.** This whole repo is built on O-ids that commits and
  design elements cite — yet a finding names a `file` and no objective. An item
  carries the id it belongs to (`O26`), so an objective can list its own open
  items and the *"Open, in DEBT"* notes stop being unverifiable prose. This is
  the prose↔item edge made structural, and it is what makes VALIDATE cheap.
- **Auto-close from a commit.** Trackers close an item when a commit cites it.
  Shamrock already writes step-commits (O9) — a commit naming an item key closes
  it with the commit as the evidence CLOSE demands. This alone would have
  prevented both observed drifts, because closing would not have depended on
  anyone remembering.
- **Dependencies / blocked-by.** Real and currently prose-only: O28's guardrail
  half waits on O17, EG-3 gates the MCP rich-content work, O18/O19 wait on
  O17 A–D. A view that cannot say "ready" versus "blocked" ranks unreachable
  work alongside reachable work.
- **Annotations, append-only.** Org logs state changes; Taskwarrior appends
  notes. Editing an item in place loses WHY it moved — the two ledger
  corrections this session rewrote lines and kept the reasoning only because a
  human wrote it back in.
- **Age and archive.** Every item already carries a date, so staleness is
  computable. Untouched-for-N moves to archived rather than lingering; an
  age-weighted rank (Taskwarrior's urgency idea) surfaces the graveyard on its
  own instead of waiting for someone to notice.
- **A WIP bound on the open list.** O11 caps a fix cycle at one and O26 caps
  fix insertion at one; nothing caps the ledger, which reached 14 entries in a
  day. Past the bound, adding requires closing or archiving — "stop saying
  maybe later" enforced rather than intended.
*Deliberately NOT taken (single-operator tool, and each would be ceremony):*
assignees, estimation/sizing, milestones, recurrence, comment threads, item
templates. Provenance is covered by `lens` (which pass found it); recurrence
is the O30 cadence's job, not an item's.

*Source: todo.txt (fixed-position fields, key:value, one line per item); GNU
Org mode (workflow states, agenda, state-change logging, archiving); Taskwarrior
(dependencies, annotations, age-weighted urgency); issue trackers (close-from-
commit, cross-references); agile backlog refinement (lists rot without a
cadence; archive the untouched; bound the WIP).*
Accept: the integrity pass finds the two real drifts already observed (an open
item whose fix shipped; an objective note with no matching item) with zero
model calls; a plan receives a filtered view rather than four whole documents,
and the tokens saved are visible in the ledger; closing an item without
evidence is refused; the pass runs on the O30 cadence and its findings land in
DEBT like any other. **Status: PLANNED.**

**O33. Routines — a plan that ran once becomes a plan that runs on a
schedule.** Producing the Expo monthly report worked; there is no way to make
it *routine*. The user must be present, must remember, and must re-ask. That
gap is smaller than it looks: **the plan is already the recipe.** `submit_plan`
returns a typed artifact — `{goal, steps:[{task, produces, delegate, parallel,
group}], merge, orchestrator}` — and today it is derived fresh and discarded.
A routine is that artifact, kept, bound, and fired.

- **CAPTURE.** After a turn completes, its plan is offerable as a routine —
  the plan, the request that produced it, the mode, the skills in play, the
  project, and the document targets in force. Saved by the user, never
  silently: "make this a routine" is a decision, and O8's lesson is that
  inferring durability is where this goes wrong.
- **BIND, don't freeze.** A captured July report must not re-issue July
  forever. Period-like inputs become BINDINGS evaluated at fire time
  (`period = previous_month`), so the 1 September run asks for August. Bindings
  are declared data, not string substitution over the request text.
- **REPLAY over RE-DERIVE, with a fallback.** Re-deriving from the same
  sentence is not reproducible: measured across identical prompts, plans
  ranged 3–8 steps and 117k–1.07M input tokens. Replaying the captured steps
  is cheaper and predictable. Re-derive only when replay cannot bind — a tool
  a step names no longer exists — and record that it happened.
- **SCHEDULE.** A spec ("01:00 on the 1st of each month"), the next fire time,
  the last outcome, and an explicit enable/disable. Missed windows (machine
  asleep, app closed) resolve by policy — run late once, or skip — never
  silently.
- **HEADLESS SAFETY is the hard part.** Nobody is awake at 01:00 to answer a
  gate. A routine therefore runs under a stated policy, and the defaults are
  refusals: an O7 align that wants a direction ABORTS and notifies rather than
  guessing; an O4 shell approval is not silently granted; the O26 check gate
  still applies; and — the one this test made vivid — the **precondition gate**
  must abort a run whose declared tools are unreachable. A dead connector at
  01:00 must never yield a plausible report built from a prior month's numbers.
  This is the "no unmanaged path" requirement O19 already names for headless
  runs, arriving before the proxy does.
- **PROVENANCE is mandatory here.** An unattended document is read later by
  someone who did not watch it being made, so every routine output states its
  as-of time and the queries behind it (O21). A stale-but-real figure survives
  scrutiny in a way an invented one does not — which is precisely why it is
  more dangerous.
- **OUTCOME lands somewhere.** Success files the deliverable through O23;
  failure writes to the O27 ledger and notifies. A routine that quietly stops
  producing is the worst failure mode, so "did not run" must be as visible as
  "ran and failed".
*Source: cron/launchd semantics for missed windows; CI scheduled pipelines
(pinned recipe + bound parameters, not a re-derived one); the measured
non-reproducibility of re-derivation in this harness.*
Accept: a completed turn can be saved as a named routine; its next run binds
the following period without editing; a scheduled run reproduces the captured
steps rather than re-planning; a routine whose connector is unauthorized
aborts and notifies instead of producing a document; every routine output
carries an as-of time; the run history shows ran / failed / skipped per fire.
**Status: PLANNED.**

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
| O33 | routines — capture a plan, bind it, schedule it | planned — new `routines.js` (capture from a completed plan + bindings) + `scheduler.js` (fire, missed-window policy, run history); headless policy reuses the O26 check gate and the precondition gate; outcomes to O23 / O27 |
| O32 | the Registrar — list service over the canonical docs | planned — new `registrar.js`; migrates `project-docs.appendDebt`; VALIDATE runs on the O30 cadence; LIST VIEW replaces whole-set injection in `project-docs.load()` |
| O25 | widget library | planned — new `widgets.js` deterministic renderer (SVG + md degradations) |
| O26 | framework check gate | shipped: `runCheckCommand` (coding-tools.js) + `gateStep` (execute.js) + baseline/final wiring + Overview CHECK COMMAND card (ipc.js, renderer); smoke §O26 |
| O27 | debt ledger + promotion | shipped: DEBT canonical doc + `appendDebt` repeat flagging (project-docs.js); review/check/drift findings wired in ipc.js; smoke §O27. Deferred: evaluator feed |
| O28 | test-integrity rule + guardrail | partial: rule in `plan-derive.js` CODING_RULES + ipc.js CODING MODE note + fix prompts; EG-1 module rides O17 `guards.js` |
| O29 | repo map + rulebook injection | shipped: `readRulebook` (project-docs.js) → CODING MODE note + `planContext` banner + process event; smoke §O29 |
| O30 | drift pass | shipped: `drift.js` + `project:drift` IPC + Overview MAINTENANCE card; findings → O27; smoke §O30. Deferred: scheduling |
| O31 | the Librarian — self-organizing library + sessions | shipped v1: `src/main/librarian.js` + tags/chat_tags/document_tags (db v20) + save-time/turn-end filing (`ipc.js`) + faceted views + tidy (renderer) |

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
