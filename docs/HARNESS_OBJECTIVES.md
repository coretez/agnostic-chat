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
compose today; boundary sentence lands with O10).

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
Accept: edit_file prompts contain −/+ lines. **Status: THIS CHANGE.**

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
tool calls. **Status: THIS CHANGE** (`align` outcome).

**O8. Decisions are durable.** Ratified user decisions persist as
`user`-confidence variables — overwrite-protected against model guesses,
re-injected into every future step and plan.
Accept: a decision stated by the user reaches the store via the plan's
`record` field. **Status: THIS CHANGE.**

**O9. The plan is the git history.** Each completed step that mutated the
working tree commits with its `produces` as the message — the typed plan
contract becomes traceable increments. Framework bookkeeping, not a
model-approved action.
*Source: no harness does this; Harness.io's audit trail says it must exist.*
Accept: a 3-step mutating plan leaves ≥1 commit per mutating step.
**Status: THIS CHANGE** (step-commits).

**O10. Plans that write code must verify.** The plan-shape contract: steps
that create/modify code end with a verification step (tests/build via
run_command, fix failures); steps may only prescribe what the listed tools
can do (no pantomime, no MCP-in-app).
*Source: compiler/tests as ground truth — the harnesses' core advantage;
Harness.io Continuous Verification.*
Accept: DERIVE_PROMPT carries the rules; a code-writing plan's last step
runs verification. **Status: THIS CHANGE** (prompt contract).

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
step-commits); a code-changing plan must end with a documentation step
after verification. Docs are real versioned files in the project output
dir, indexed in the library.
*Source: docs-as-code; Architecture Decision Records (Nygard); Diátaxis;
requirements traceability.*
Accept: an align `record` bumps the SPEC doc with the decision appended;
`planContext` carries the docs under a source-of-truth banner;
DERIVE_PROMPT carries the documentation rule. **Status: THIS CHANGE.**

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
