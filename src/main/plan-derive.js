'use strict';

// Plan Pass 2 — step derivation ("skill iteration") for the plan-and-execute
// turn model. Pass 1 (context-select.js) picks which skills/tools are in play;
// this pass reads the LOADED skill instructions and derives the ordered steps
// that will actually be executed. refinePlan() is the REACTIVE half: when a
// step gets stuck, it re-derives the remaining tail from results-so-far
// (decisions #1/#2 in the internal planning-architecture record §9 — no proactive
// needsMore loop; re-planning happens on demand, bounded by the caller).
//
// Uses the same forced-tool structured-output pattern as selectContext, with
// the same offered-tool retry for thinking models that reject a forced
// tool_choice.

const { truncateForMenu } = require('./context-select');

// Synthetic tool as a structured-output contract (see context-select.js for
// why forced tool-calling beats prompted JSON here).
const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
  description: "Report the execution plan for the user's request as a structured series of steps plus how to merge their results.",
  inputSchema: {
    type: 'object',
    properties: {
      simple: { type: 'boolean', description: 'true if the request needs no multi-step plan (answer directly / a single tool call at most).' },
      goal: { type: 'string', description: 'One-line statement of what done looks like.' },
      steps: {
        type: 'array',
        description: 'Ordered steps. Each is a complete, self-contained JSON step object. Omit or leave empty when simple=true.',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Complete instruction for this step — executable on its own with the values known so far.' },
            produces: { type: 'string', description: 'What this step must yield for later steps: named values (e.g. "case_id, tenant_id") or an artifact ("the saved report path"). Drives working-memory capture.' },
            delegate: { type: 'boolean', description: 'true to run this step as an ISOLATED sub-agent: its bulk work stays out of the main context and only its conclusion returns. Use for self-contained research/pulls that would flood the main thread.' },
            agent: { type: 'string', description: 'For delegated steps: the named agent to use, or "auto" for a general sub-agent.' },
            parallel: { type: 'boolean', description: 'true only if this step does not depend on values discovered by its neighbors (delegated steps marked parallel may run concurrently).' },
            group: { type: 'string', description: 'Optional fan-out group name (short, e.g. "collect"). CONSECUTIVE steps sharing a group run CONCURRENTLY as isolated sub-agents, then their results are MERGED into one result by the orchestrator contract before any later step runs. Use when several steps pull from independent sources.' }
          },
          required: ['task']
        }
      },
      merge: { type: 'string', description: "How to combine the step results into the final answer (structure, emphasis, format). Empty string if the last step's output IS the final answer." },
      orchestrator: {
        type: 'object',
        description: 'The recombination contract for fan-out groups — the planner that divides work must also say how it merges (required whenever any step has a group).',
        properties: {
          merge: { type: 'string', description: 'How to combine a group\'s results into one digest: structure, dedupe rules, and which named values (ids, paths, numbers) must survive verbatim.' },
          on_conflict: { type: 'string', description: 'How to treat contradictory findings between group members, e.g. "prefer the newest data", "surface both with sources".' }
        }
      },
      decisions: {
        type: 'array',
        description: 'ALIGNMENT (O7): when the request sets a development direction the user has not decided (platform, stack, structure, distribution), return the open decisions INSTEAD of steps — the turn ends awaiting the user. Omit when the direction is already fixed.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The decision the user must make, as one clear question.' },
            options: { type: 'array', items: { type: 'string' }, description: 'The viable choices, each with its key tradeoff in a few words.' },
            recommendation: { type: 'string', description: 'Your recommended choice and why, in one sentence.' }
          },
          required: ['question']
        }
      },
      record: {
        type: 'array',
        description: 'ONLY durable development-direction decisions the user has STATED, and ONLY with one of these exact keys: platform, stack, framework, language, runtime, database, distribution, structure, package_manager, test_framework, ui_framework, hosting, license, document_branding, document_format, document_rawdata. e.g. {key:"platform", value:"react-native"}. These outlive the request and apply to EVERY future turn. NEVER record task parameters (an output path, a file name, this request\'s format), project titles, task descriptions, restatements of the request, or your own picks — anything else is discarded.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'snake_case name, e.g. platform, stack, distribution.' },
            value: { type: 'string', description: 'The decided value, short.' }
          },
          required: ['key', 'value']
        }
      }
    },
    required: ['simple', 'goal']
  }
};

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

// O8: a durable decision is a DIRECTION, not a task parameter. Shape alone is
// not enough — driving a real turn promoted `output_path =
// docs/HARNESS_FLOWCHART.md` and `output_format = markdown_with_single_mermaid
// _block` to permanent user-confidence values (and into the SPEC) because both
// are well-formed snake_case. Validate against a KNOWN VOCABULARY instead, the
// way the librarian validates facets: guards add restriction, never permission.
const DURABLE_KEYS = new Set([
  'platform', 'stack', 'framework', 'language', 'runtime', 'database',
  'distribution', 'structure', 'package_manager', 'test_framework',
  'ui_framework', 'hosting', 'license',
  'document_branding', 'document_format', 'document_rawdata'
]);
const RECORD_KEY = /^[a-z][a-z0-9_]{1,30}$/;

const recordIsDurable = (r) =>
  RECORD_KEY.test(r.key) && DURABLE_KEYS.has(r.key) && r.value.length > 0 && r.value.length <= 100;

/**
 * Split proposed records into kept and dropped. The dropped keys are reported
 * so the caller can emit them (O14): a guard that discards silently cannot be
 * told apart from a planner that proposed nothing — which is exactly how the
 * first verification of this filter produced a claim with no evidence.
 * @returns {{records:Array<{key,value}>, dropped:string[]}}
 */
function partitionRecords(raw) {
  const proposed = (Array.isArray(raw) ? raw : [])
    .filter((r) => r && typeof r.key === 'string' && r.value != null)
    .map((r) => ({ key: r.key.trim().toLowerCase().replace(/\s+/g, '_'), value: String(r.value).trim() }));
  return {
    records: proposed.filter(recordIsDurable),
    dropped: proposed.filter((r) => !recordIsDurable(r)).map((r) => r.key)
  };
}

/** Ratified direction decisions, deterministically validated (O8). */
function normalizeRecords(raw) { return partitionRecords(raw).records; }

function planContext({ cheatSheet, loadedSkills = [], tools = [], store, agents = [], projectDocs = '', repoMap = '', rulebook = '', formatTarget = '', branding = '', rawData = false }) {
  const parts = [];
  if (cheatSheet) parts.push('PROJECT BRIEF:\n' + clip(cheatSheet, 4000));
  if (rulebook) {
    // O29: the working-dir rulebook (AGENT_RULES.md | AGENTS.md | CLAUDE.md)
    // travels beside the brief — plans and steps must comply with it, and
    // anything the repo's own rulebook forbids is out of bounds for a plan.
    parts.push('PROJECT RULEBOOK (non-negotiable rules for all work in this repository — every plan and step must comply):\n' + clip(rulebook, 6000));
  }
  if (formatTarget) {
    // O24: the documents harness's visual standard — plans that produce a
    // document must read it early and compose against it.
    parts.push('OUTPUT FORMAT TARGET (library file — the visual standard every produced document must reproduce; plan an early step to read it): ' + formatTarget);
  }
  if (branding) parts.push('TARGET DOCUMENT BRANDING (apply to every deliverable): ' + clip(branding, 800));
  if (rawData) parts.push('RAW DATA EXPORT: ON — plans that produce a report must also save the collected tabular data as a spreadsheet (save_document, format "xlsx", type "raw-data", content JSON {"sheets":[{"name","rows"}]}).');
  if (repoMap) {
    // Coding mode: the planner must plan against REAL files, not guesses —
    // steps that name actual paths execute; steps that imagine them wander.
    parts.push('WORKING DIRECTORY MAP (plan against these real files):\n' + clip(repoMap, 4000));
  }
  if (projectDocs) {
    // O15: the canonical docs are the source of truth for objective and
    // purpose — the planner derives intent from HERE, never by reading code.
    parts.push('PROJECT DOCUMENTATION (source of truth for objectives, ratified decisions, design, and how things work — derive intent and constraints from here, not by exploring code):\n\n' + projectDocs);
  }
  if (loadedSkills.length) {
    // The whole point of Pass 2: the SKILL'S OWN INSTRUCTIONS shape the steps.
    // Generous clip: a real SKILL.md procedure runs ~20k chars (~5k tok) and
    // cutting mid-procedure yields plans that stop where the clip did; the
    // planning call is a one-off fast-model call, so completeness wins here.
    parts.push('SKILL INSTRUCTIONS IN PLAY (derive your steps from these):\n\n'
      + loadedSkills.map((s) => `## ${s.name}\n${clip(s.definition || s.description || '', 24000)}`).join('\n\n'));
  }
  if (tools.length) {
    // Name + a one-line description (same sentence-boundary clip the selection
    // menu uses): the planner can only sequence steps sensibly if it knows what
    // each tool DOES, not just what it is called. Bare names produced plans
    // that guessed at tool behavior. Descriptions here are already scoped —
    // this list is the post-ceiling toolset, not the full catalog.
    parts.push('AVAILABLE TOOLS (name — what it does):\n'
      + tools.map((t) => `- ${t.name}: ${truncateForMenu(t.description, 200, 60)}`).join('\n'));
  }
  if (agents.length) parts.push('NAMED AGENTS (for parallel steps):\n' + agents.map((a) => `- ${a.name}: ${clip(a.description, 160)}`).join('\n'));
  const known = store && typeof store.render === 'function' ? store.render() : '';
  if (known) parts.push(known);
  return parts.join('\n\n') || '(no additional context)';
}

// Coding-mode plan-shape contract (HARNESS_OBJECTIVES O7/O10): alignment
// before direction-setting work, verification after code-writing work, and no
// steps the runtime can't perform. Appended to the guidance only when the
// coding harness is active this turn.
const CODING_RULES = `
- PLAN BY DEFAULT (never wander): NEVER return simple=true when the request (a) will create or modify files or code, or (b) names stages, phases, or an ordered sequence ("structure then content then style", "first X, then Y"), or (c) asks for a design, proposal, architecture, or review of something multi-part — INCLUDING when the deliverable is prose, documentation, or a recommendation rather than code. Each named stage becomes its own step with its own "produces". For code the canonical shape is (1) read/locate the relevant files (name real paths from the working directory map), (2..n) implement each coherent change, (last) verify via tests/build and fix failures. simple=true is ONLY for a single question, a lookup, or one explanation. A staged or mutating request answered without a plan is a failure.
- ALIGN FIRST (never race): if the request requires choosing a development direction — platform, framework/stack, project structure, distribution target — and that choice is NOT already fixed by KNOWN VALUES, the project brief, or the request itself, do NOT plan steps. Call submit_plan with "decisions": one entry per open decision (question, viable options with tradeoffs, your recommendation). Never silently pick a direction for the user.
- RECORD DECISIONS: when the user's request itself states a direction ("build it in Swift", "internal only"), put it in "record" as {key, value} so it persists as a durable known value. Record only the user's decisions, never your own picks.
- VERIFY (three layers): a plan whose steps create or modify code MUST end with a verification step that (1) runs the project's tests or build via run_command and fixes what fails, and while implementing you must also satisfy (2) quality — DRY, modular, no brute-force where a simpler idiom exists — and (3) security — no injection, secrets in code, or unvalidated input. Changed files are independently reviewed on those lenses after execution; code that fails review costs a fix cycle.
- TEST INTEGRITY (O28): a failing test is NEVER deleted, skipped, or weakened to reach green — fix the root cause in the code. Editing a test is legitimate ONLY when the test itself is wrong, and the step's result must say so explicitly.
- CAPABILITY BOUNDARY: steps may only prescribe actions the listed tools can perform. MCP tools exist only inside this assistant's session — code you plan can NEVER call MCP; apps need the service's own API or a bridge. If a skill prescribes an action with no matching tool, adapt it or state what is skipped and why — never emit a step that pretends.
- DOCUMENTATION: the canonical project docs (SPEC/DESIGN/PSEUDOCODE/KNOWLEDGE) are maintained AUTOMATICALLY by the pipeline after execution — do NOT plan documentation steps and do NOT call save_document with those types. save_document is for deliverables (reports, exports) only.`;

// Documents-mode plan-shape contract (HARNESS_OBJECTIVES O22, mirror of
// CODING_RULES): alignment before audience/format decisions, collect →
// analyze → draft → verify shape, deliverables land via save_document.
// Appended only when the documents harness is active this turn.
const DOCUMENTS_RULES = `
- PLAN BY DEFAULT (never wander): NEVER return simple=true when the request asks for a document, report, brief, analysis, plan, or any named deliverable. The canonical shape is (1..n) collect from each needed source, (n+1) analyze the collected material, (n+2) draft and save the deliverable with save_document, (last) verify it. simple=true is ONLY for a single question or lookup.
- ALIGN FIRST (never race): if the request requires choosing the document's AUDIENCE (who reads it), FORMAT (its structure/sections), TYPE (markdown | html | pdf), or SCOPE — and that choice is NOT already fixed by KNOWN VALUES, the project brief, or the request — do NOT plan steps. Call submit_plan with "decisions". Never silently pick for the user.
- RECORD DECISIONS: when the request states them ("HTML report for the CISO"), put audience/format/type in "record" as {key, value} so they persist.
- COLLECT IN PARALLEL: collection steps that pull from independent sources should be delegate=true, and parallel when they don't depend on each other's discoveries.
- BUILD ON THE LIBRARY: when the request extends or revises existing work, an early step reads the relevant library documents (read_file at the PROJECT LIBRARY paths). Revise an existing document by saving the same title/type again (versioning is automatic) — never create a near-duplicate.
- DELIVERABLE CONTRACT: the final document is saved with save_document (title, type, format, properties including customer/tenant and period where they apply); the chat reply is a short summary naming the saved file — never the full document pasted into chat.
- VERIFY: a plan that produces a document MUST end with a verification step that re-checks the saved document's claims against the collected data and sources, its internal consistency (numbers, dates, names), and its completeness against the request — fixing and re-saving if needed.
- FORMAT TARGET: when the context names an OUTPUT FORMAT TARGET file, the plan MUST read it (read_file) before any compose step, and the compose step MUST reproduce its visual system — fonts, masthead, header, section styling, tables, charts, print rules — with the new content. The format is the project's standard, not a suggestion.
- DOCUMENT TARGETS: the project's Target Document Format, Target Document Branding, and raw-data export are project-level facts — when set they appear in this context. If the user asks for a document while the format or branding is MISSING from the context, include a decision for each missing target (the user can answer in chat or set them on the project OVERVIEW under DOCUMENT TARGETS). When the user states a target in chat, put it in "record" — {key:"document_branding"}, {key:"document_format"}, or {key:"document_rawdata", value:"on"|"off"} — so it persists to the project.`;

const DERIVE_PROMPT = (ctx, request, codingMode = false, documentsMode = false) =>
`You are the planning stage of an LLM assistant. Decide whether the user's request needs a multi-step plan, and if so derive the steps — informed by the skill instructions in play (they often prescribe a procedure: follow it).

${ctx}

USER REQUEST:
${request}

Guidance:
- If the request is conversational or trivially answerable, call submit_plan with simple=true and no steps.
- Otherwise prefer 2–6 concrete, ordered steps. Each step must be a complete instruction that could be executed on its own with the values known so far.
- For each step, state what it "produces" — the named values (ids, paths) or artifact later steps will need. Steps that discover identifiers come before steps that use them.
- DELEGATION: mark a step delegate=true when it is self-contained and would flood the main thread with bulk it doesn't need to keep (pulling a large report, sweeping many records) — an isolated sub-agent does the work and returns only its conclusion. Name a listed agent when one fits, else "auto". Mark delegated steps "parallel" only when they don't depend on each other's discoveries.
- GROUPING (fan-out): when several steps pull from INDEPENDENT sources, give them the same short "group" name and place them consecutively — they run concurrently and are MERGED into ONE result before the next step. Whenever any step has a group, provide "orchestrator": merge (how the group's results combine — structure, dedupe rules, which named values must survive verbatim) and on_conflict (how contradictory findings are treated). The step after a group consumes the merged result, so its task should reference it.
- MERGING: say in "merge" how the step results should be combined into the final answer (structure, format, emphasis) — or leave it empty if the last step's output IS the answer. If a skill above prescribes an output format, the merge instruction must follow it.${codingMode ? CODING_RULES : ''}${documentsMode ? DOCUMENTS_RULES : ''}

Call submit_plan now.`;

const REFINE_PROMPT = (ctx, goal, doneDigest, stuck, reason, request) =>
`You are re-planning mid-execution. The goal below is partially complete, but the current step is stuck — revise the REMAINING steps using everything learned so far. Do not repeat completed work.

${ctx}

GOAL: ${goal}

COMPLETED SO FAR:
${doneDigest || '(nothing completed yet)'}

STUCK STEP: ${stuck.task}
WHY IT STUCK: ${reason} — its partial result: ${clip(stuck.partial, 1200) || '(none)'}

ORIGINAL REQUEST:
${request}

Call submit_plan with the revised REMAINING steps only (a different approach to the stuck work, or a way around it). If everything needed is already gathered and no further steps are required, return simple=true with no steps.`;

async function callForPlan(connector, model, content) {
  const messages = [{ role: 'user', content }];
  let r;
  try {
    r = await connector.chat({ model, messages, tools: [SUBMIT_PLAN_TOOL], forceTool: true, maxTokens: 8000 });
  } catch (e) {
    // Thinking models can reject forced tool_choice — retry with it offered.
    r = await connector.chat({ model, messages, tools: [SUBMIT_PLAN_TOOL], maxTokens: 8000 });
  }
  const call = (r.toolCalls || [])[0];
  return (call && call.args && typeof call.args === 'object') ? call.args : null;
}

function normalizeSteps(steps, startId = 1) {
  return (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s.task === 'string' && s.task.trim())
    .map((s, i) => ({
      id: startId + i,
      task: s.task.trim(),
      produces: typeof s.produces === 'string' ? s.produces.trim() : '',
      // A step runs isolated if the planner asked for delegation OR marked it
      // parallel (parallel execution requires isolation) — `parallel` stays
      // the executor's handoff flag for backward compatibility. A group
      // implies both: fan-out members are by definition isolated + parallel.
      parallel: !!(s.delegate || s.parallel || s.group),
      group: typeof s.group === 'string' ? s.group.trim().toLowerCase() : '',
      agent: s.agent || 'auto'
    }));
}

/**
 * Derive the turn's plan from the loaded skills + tools + known values.
 * @returns {Promise<{simple:boolean, goal:string, steps:Array, error?:string}>}
 *   On any failure returns {simple:true} — the caller falls back to the flat
 *   loop, so planning can never make a turn WORSE than today's behavior.
 */
async function derivePlan({ connector, model, userText, cheatSheet, loadedSkills, tools, store, agents, codingMode = false, documentsMode = false, projectDocs = '', repoMap = '', rulebook = '', formatTarget = '', branding = '', rawData = false }) {
  try {
    const ctx = planContext({ cheatSheet, loadedSkills, tools, store, agents, projectDocs, repoMap, rulebook, formatTarget, branding, rawData });
    const parsed = await callForPlan(connector, model, DERIVE_PROMPT(ctx, userText || '', codingMode, documentsMode));
    if (!parsed) return { simple: true, goal: '', steps: [], error: 'planner returned no tool call' };
    // User decisions stated in the request — persisted by the caller at
    // `user` confidence so they survive turns and outrank model guesses (O8),
    // validated against the durable vocabulary above.
    const { records: record, dropped: droppedRecords } = partitionRecords(parsed.record);
    // Alignment outcome (O7): open direction decisions end the turn awaiting
    // the user — no steps run. Only honored in the modes whose rules elicit
    // it (coding: platform/stack; documents: audience/format/type).
    const decisions = ((codingMode || documentsMode) && Array.isArray(parsed.decisions) ? parsed.decisions : [])
      .filter((d) => d && typeof d.question === 'string' && d.question.trim())
      .map((d) => ({
        question: d.question.trim(),
        options: (Array.isArray(d.options) ? d.options : []).filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim()),
        recommendation: typeof d.recommendation === 'string' ? d.recommendation.trim() : ''
      }));
    if (decisions.length) return { simple: true, align: true, decisions, goal: parsed.goal || '', steps: [], record , droppedRecords };
    const steps = normalizeSteps(parsed.steps);
    const merge = typeof parsed.merge === 'string' ? parsed.merge.trim() : '';
    // O16: the recombination contract for fan-out groups — the planner that
    // divides work also authors how it merges.
    const orchestrator = parsed.orchestrator && typeof parsed.orchestrator === 'object'
      ? { merge: String(parsed.orchestrator.merge || '').trim(), on_conflict: String(parsed.orchestrator.on_conflict || '').trim() }
      : null;
    // A 0/1-step plan is the trivial-turn gate: nothing to orchestrate.
    if (parsed.simple || steps.length <= 1) return { simple: true, goal: parsed.goal || '', steps, merge, record , droppedRecords };
    return { simple: false, goal: parsed.goal || '', steps, merge, record, orchestrator , droppedRecords };
  } catch (e) {
    return { simple: true, goal: '', steps: [], error: `derivePlan failed: ${e.message}` };
  }
}

/**
 * Reactive re-plan of the remaining tail after a stuck step (decision #1).
 * Matches the `refinePlan` signature executePlan expects.
 * @returns {Promise<{steps:Array}>} empty steps = "nothing more needed".
 */
async function refinePlan({ connector, model, userText, cheatSheet, loadedSkills, tools, agents, plan, done = [], stuckStep, reason, partial, store, projectDocs = '', repoMap = '', rulebook = '', formatTarget = '', branding = '', rawData = false }) {
  try {
    const ctx = planContext({ cheatSheet, loadedSkills, tools, store, agents, projectDocs, repoMap, rulebook, formatTarget, branding, rawData });
    const doneDigest = done.map((d) => `- [step ${d.step}] ${clip(d.task, 160)}: ${clip(d.conclusion, 400)}`).join('\n');
    const stuck = { task: stuckStep ? stuckStep.task : '', partial: partial || '' };
    const parsed = await callForPlan(connector, model, REFINE_PROMPT(ctx, (plan && plan.goal) || '', doneDigest, stuck, reason || 'stuck', userText || ''));
    if (!parsed) return { steps: [] };
    if (parsed.simple) return { steps: [] };
    const startId = stuckStep && stuckStep.id ? stuckStep.id : 1;
    return { steps: normalizeSteps(parsed.steps, startId) };
  } catch {
    // A FAILED refine call must not read as "nothing more needed" (that would
    // silently conclude the turn). Return the stuck step unchanged: the retry
    // burns re-plan budget and the orchestrator escalates to the user.
    return { steps: stuckStep ? [{ id: stuckStep.id, task: stuckStep.task, parallel: false, agent: stuckStep.agent || 'auto' }] : [] };
  }
}

module.exports = { derivePlan, refinePlan, planContext, normalizeRecords, partitionRecords, DURABLE_KEYS, SUBMIT_PLAN_TOOL, DERIVE_PROMPT, REFINE_PROMPT };
