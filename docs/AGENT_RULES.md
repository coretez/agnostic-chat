# AGENT_RULES

Prompt-ready rules for any agent writing code in this repository. Inject this file
into agent context at session start. Distilled from Anthropic, OpenAI, and Moonshot
first-party engineering guidance (see Sources).

Keep this file under 120 lines. Every rule must trace to an observed failure or a
documented lab finding. If a rule stops earning its place, delete it. If a rule is
violated twice despite being written here, promote it into a lint, hook, or test —
documentation that has to be obeyed is code, not prose.

In this harness the promotion path is concrete (HARNESS_OBJECTIVES §G): repeat
violations land in the debt ledger (O27) and are promoted into the framework
check command (O26) or a guard module (O17). Enforced today: verification
gates (O10/O26), the review pass (O11), scope jail and approvals (O1/O4),
align-before-build (O7), docs-as-truth (O15). This file governs whatever the
gates don't yet.

---

## Verification — the loop closes on a check, not on your judgment

- ALWAYS obtain a check you can run before declaring work done: a test, a build
  exit code, a lint pass, or a rendered-output diff. If no check exists, write
  one first.
- NEVER grade your own work as the final gate. The context that wrote the code
  does not review the code. Review happens in a fresh context that sees only the
  diff and the acceptance criteria.
- ALWAYS show evidence, not assertions: paste the test output, the command run,
  the exit code. "It works" without evidence is an unfinished task.
- NEVER remove, weaken, or edit a failing test to make it pass. Tests and the
  feature ledger are append-only records of intent; only their pass/fail state
  may change.
- ALWAYS fix the root cause. Suppressing an error, loosening a type, or catching
  and ignoring an exception to silence a check is a violation, not a fix.
- NEVER collapse two distinct causes into one signal, label, or code path.
  Every lie this codebase has told came from exactly that: a refused write
  reported as a write, a stalled provider handled as a failed plan, a file's
  existence taken as proof it was written, a model's inference labelled as
  the user's own words, a guard's silence read as the guard working. If two
  different things can produce the same observation, that observation is not
  evidence — split it before you rely on it.
- When reviewing, flag ONLY gaps that affect correctness or the stated
  requirements. Do not manufacture findings; do not demand speculative
  abstraction, defensive code, or tests for impossible states.

## Intent — the repo is the only memory that counts

- ALWAYS read the spec ledger before writing code: DESIGN_SPEC.md,
  HARNESS_OBJECTIVES.md, PHASE_PLAN.md, CONTEXT_STRATEGY.md. New code must be
  consistent with what they record, not merely with the nearest file.
- If a decision was made anywhere other than this repository, it does not exist.
  Before acting on it, write it down here — in the spec, a plan, or this file.
- ALWAYS record non-obvious decisions where the next agent will find them: the
  plan doc for scope decisions, the design spec for architecture, a short note
  in the PR for everything else.
- NEVER leave documentation you know to be stale. Fixing the doc is part of the
  change that made it stale, not a follow-up.
- Plans are artifacts, not scaffolding. Complex work gets a written plan with a
  decision log; the plan is updated as reality diverges, then archived — never
  silently abandoned.

## Architecture — enforce boundaries, allow local freedom

- NEVER add a dependency edge the architecture does not permit. Layer and module
  boundaries are invariants; if the task seems to require crossing one, stop and
  surface it rather than working around it.
- ALWAYS validate data shapes at every boundary (API, file, database, tool
  result). Never build on a guessed shape. How you validate is your choice;
  that you validate is not.
- ALWAYS follow the existing pattern for the thing you are building. Find the
  best current example, name it in your plan, and match it. One codebase, one
  way to do each thing.
- NEVER hand-roll a helper that a shared utility already provides. Extend the
  shared utility if it falls short; invariants live in one place.
- ALWAYS keep functions small: **15 lines is the ceiling.** A function that
  needs more is hiding duplication or doing two jobs — decompose it. Small
  functions are the unit of DRY, of debugging, and of review. Count
  statements, not physical lines: one long value — a template literal, a
  multi-line string, a data table — is ONE line no matter how it wraps.
- NEVER justify a long function by call overhead or stack depth. Compilers
  and JITs inline; that is their job, not yours. Optimize for the reader and
  the debugger, and let the compiler optimize for the machine.
- ALWAYS give a function the narrowest surface that does its job: pass
  exactly the variables it needs, nothing more. The signature is the
  contract — it declares what this function depends on and what is allowed
  to change.
- NEVER thread whole objects, contexts, or "everything" through a call just
  in case. A kitchen-sink signature means the writer did not know what was
  needed or what could change — decide, then pass only that.
  (Both ceilings are deterministically checkable — enforce via the O26
  check command / lint, not by prose, as soon as the gate exists.)
- Prefer boring, composable, well-understood technology. If a library is opaque
  to reason about from inside the repo, reimplementing the needed subset may be
  the better choice — decide in the plan, not mid-edit.
- Intentional exceptions must be explicit: mark them, say why, and record what
  would remove the exception. An unmarked violation is drift.

## Context — spend tokens like the scarce resource they are

- ALWAYS load context just-in-time. Start from the map (this file, the spec
  index), follow pointers to what the task needs, and no further. Do not read
  the repository speculatively.
- ALWAYS delegate wide exploration to a sub-context that returns a summary.
  Raw exploration output does not belong in the working context.
- Success is silent; failure is verbose. Tool and script output should say
  nothing when things pass and everything actionable when they fail.
- NEVER let an instruction file grow into an encyclopedia. This file is a
  rulebook; the docs tree is the encyclopedia; the code is the truth.
- When continuing long work: begin by reading the progress log and running the
  baseline checks. End by leaving the environment clean — committed, logged,
  and honest about what remains.

## Scope and drift — small steps, continuous garbage collection

- ALWAYS work incrementally: one feature, one fix, one refactor per change.
  A change that cannot be reviewed in minutes is too big.
- NEVER expand scope silently. If the task reveals adjacent problems, record
  them (tech-debt tracker, issue, note) and stay on task.
- NEVER copy a pattern you can see is bad just because it exists. Flag it,
  follow the golden principle instead, and record the deviation you found.
- Pay debt continuously in small increments. Cleanup is a scheduled activity
  with its own small PRs, not a deferred heroic effort.
- When you struggle, treat it as a signal about the environment: name the
  missing tool, doc, or guardrail so it can be added. "Try harder" is not a
  remedy.

---

## Sources

- OpenAI — Harness engineering: leveraging Codex in an agent-first world (2026)
- Anthropic — Effective harnesses for long-running agents; Effective context
  engineering for AI agents; Claude Code best practices
- Moonshot AI — Kimi K2 technical report (verifiable rewards over rubric-only
  judgment)
