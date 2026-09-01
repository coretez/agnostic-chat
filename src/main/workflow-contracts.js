'use strict';

// Deterministic reliability contract placed between a user's request and the
// probabilistic planner. The contract does not decide the content; it defines
// the consequential scope, work budget, evidence requirements, and the facts
// the runtime must be able to prove before it reports success.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { verifyStockReport, verifyStockPublisher } = require('./stock-artifact-verifier');

const CONTRACT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'kind', 'scope', 'budgets', 'evidence', 'toolPolicy', 'acceptance'],
  properties: {
    version: { const: 1 },
    kind: { enum: ['generic', 'website', 'monthly-report', 'top-cases', 'mode-flow', 'stock-analysis'] },
    scope: { type: 'object' },
    budgets: { type: 'object' },
    evidence: { type: 'object' },
    toolPolicy: { type: 'object' },
    acceptance: { type: 'array', items: { type: 'string' } }
  }
};

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const NUMBER_WORDS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 });
const CASE_COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';

function mostRecentCompleteMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function requestedPeriod(text) {
  const s = String(text || '');
  const iso = s.match(/\b(20\d{2})[-/]([01]?\d)\b/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}`;
  const named = s.match(new RegExp(`\\b(${MONTHS})\\s+(20\\d{2})\\b`, 'i'));
  if (named) return `${named[1][0].toUpperCase()}${named[1].slice(1).toLowerCase()} ${named[2]}`;
  const relative = s.match(/\b(last|past|previous|current|this)\s+(\d+\s+)?(day|week|month|quarter|year)s?\b/i);
  if (relative) return relative[0].toLowerCase();
  const range = s.match(/\b20\d{2}-\d{2}-\d{2}\s+(?:through|to|–|—)\s+20\d{2}-\d{2}-\d{2}\b/i);
  return range ? range[0] : null;
}

function classify(text) {
  const s = String(text || '');
  // Requested deliverable outranks incidental examples. The website benchmark
  // names “Expo monthly report” and “top-five case investigation” in a section
  // it asks the site to describe; keyword-first classification mistook that
  // inventory for the task itself and stopped to ask for a report month.
  if (/\b(?:build|create|make|design|revise|improve)\b[\s\S]{0,80}\b(website|web\s*site|landing\s+page)\b/i.test(s)) return 'website';
  if (new RegExp(`\\b(?:top\\s+${CASE_COUNT}\\s+cases?|${CASE_COUNT}\\s+highest[-\\s]+(?:risk|priority)[\\s\\S]{0,30}cases?)\\b`, 'i').test(s)) return 'top-cases';
  if (/\b(monthly|m-?soc)\b[\s\S]{0,50}\breport\b|\breport\b[\s\S]{0,50}\bmonthly\b/i.test(s)) return 'monthly-report';
  if (/\b(flow\s*diagram|flowchart)\b/i.test(s) && /\b(code|coding)\b/i.test(s) && /\b(document|documents)\b/i.test(s)) return 'mode-flow';
  if (/\b(stock|equity|securities)\b/i.test(s)
      && /\b(analysis|analy[sz]e|selection|pick|candidate|invest)\b/i.test(s)
      && /\b(news|trend|price|market)\b/i.test(s)) return 'stock-analysis';
  if (/\b(website|web\s*site|landing\s+page)\b/i.test(s)) return 'website';
  return 'generic';
}

function requestedCaseCount(text) {
  const s = String(text || '');
  const pattern = new RegExp(`\\b(?:top\\s+(${CASE_COUNT})\\s+cases?|(${CASE_COUNT})\\s+highest[-\\s]+(?:risk|priority)[\\s\\S]{0,30}cases?)\\b`, 'i');
  const match = s.match(pattern);
  if (!match) return null;
  const raw = String(match[1] || match[2] || '').toLowerCase();
  const value = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return Math.max(1, Math.min(50, value));
}

function entityFrom(text) {
  const s = String(text || '');
  const m = s.match(/\b(?:for|tenant|customer)\s+([A-Z][A-Za-z0-9_-]{1,50})\b/);
  return m ? m[1] : null;
}

function missingPeriodIssue(kind, period) {
  if (period || !['top-cases', 'monthly-report'].includes(kind)) return null;
  const cases = kind === 'top-cases';
  return {
    key: 'period',
    question: cases ? 'What time window should define the top cases?' : 'Which month should the report cover?',
    recommendation: cases ? `Use ${mostRecentCompleteMonth()} so ranking and comparison are reproducible.` : `Use ${mostRecentCompleteMonth()}.`,
    recommendedValue: mostRecentCompleteMonth()
  };
}

function acceptanceChecksFor(kind) {
  const checks = ['steps-complete'];
  if (!['generic', 'top-cases'].includes(kind)) checks.push('artifact-produced');
  const extra = {
    website: ['project-check-passing'],
    'monthly-report': ['period-matches', 'standalone-assets'],
    'top-cases': ['requested-case-count', 'case-verdicts'],
    'mode-flow': ['mermaid-flow', 'source-inspected', 'source-cited'],
    'stock-analysis': ['runnable-program', 'publisher-program', 'daily-html', 'interactive-html', 'report-consistency', 'history-spreadsheet', 'spreadsheet-formulas', 'source-cited', 'primary-source-evidence', 'selection-gates', 'market-session-honesty', 'host-verified']
  };
  return checks.concat(extra[kind] || []);
}

function outputTokenBudget(kind) {
  return { 'monthly-report': 32000, 'top-cases': 24000, 'mode-flow': 20000, 'stock-analysis': 20000 }[kind] || 10000;
}

function workflowBudgets(kind, count) {
  const complex = ['monthly-report', 'top-cases', 'mode-flow', 'stock-analysis'].includes(kind);
  return {
    maxPlanSteps: 8, maxReplans: 1,
    maxDelegates: kind === 'top-cases' ? Math.min(count || 5, 5) : 4,
    stepIterations: 8, maxStepDurationMs: kind === 'stock-analysis' ? 360000 : 0,
    maxProviderResponseMs: complex ? 360000 : 180000,
    maxStepOutputTokens: outputTokenBudget(kind), acceptanceRepairs: 1
  };
}

function evidencePolicy(kind, text) {
  return {
    requireFresh: /\b(fresh|live|current|right now|today)\b/i.test(String(text)),
    requireSourceInspection: kind === 'mode-flow',
    requireSourceCitations: ['mode-flow', 'stock-analysis'].includes(kind)
  };
}

function workflowToolPolicy(kind) {
  return {
    mcp: ['website', 'mode-flow', 'stock-analysis'].includes(kind) ? 'deny' : 'select',
    projectSkills: kind === 'stock-analysis' ? 'deny' : 'select'
  };
}

function createWorkflowContract({ text = '', mode = 'work', turnId = null } = {}) {
  const kind = classify(text);
  const period = requestedPeriod(text);
  const count = requestedCaseCount(text);
  const issue = missingPeriodIssue(kind, period);
  return {
    version: 1, id: turnId || null, kind, mode,
    scope: { period, count, entity: entityFrom(text), issues: issue ? [issue] : [] },
    budgets: workflowBudgets(kind, count), evidence: evidencePolicy(kind, text),
    toolPolicy: workflowToolPolicy(kind), acceptance: acceptanceChecksFor(kind)
  };
}

function renderContract(contract) {
  if (!contract) return '';
  const scope = contract.scope || {};
  return [
    'WORKFLOW CONTRACT (runtime-enforced):',
    `- kind: ${contract.kind}`,
    `- scope: ${JSON.stringify({ period: scope.period || null, count: scope.count || null, entity: scope.entity || null })}`,
    `- budgets: ${JSON.stringify(contract.budgets)}`,
    `- evidence: ${JSON.stringify(contract.evidence)}`,
    `- tool policy: ${JSON.stringify(contract.toolPolicy || {})}`,
    `- acceptance checks: ${(contract.acceptance || []).join(', ')}`,
    '- Plan only work needed to satisfy these checks. Do not invent missing scope, repeat completed retrieval, or exceed the declared budgets.'
  ].join('\n');
}

function filterMcpToolset(contract, toolset = { tools: [], routes: new Map() }) {
  const tools = Array.isArray(toolset.tools) ? toolset.tools : [];
  if (!contract || !contract.toolPolicy || contract.toolPolicy.mcp !== 'deny') return { ...toolset, blocked: 0 };
  return { ...toolset, tools: [], routes: new Map(), blocked: tools.length };
}

function shouldRepairAcceptance(exec, contract, acceptance) {
  const hasIncompleteStep = !!(exec && Array.isArray(exec.stepResults) && exec.stepResults.some((step) => step && step.incomplete));
  return !!(exec && exec.completed && !exec.aborted && !hasIncompleteStep && acceptance && !acceptance.ok
    && contract && contract.budgets && contract.budgets.acceptanceRepairs > 0);
}

function scopeAlignment(contract) {
  const issues = contract && contract.scope && Array.isArray(contract.scope.issues) ? contract.scope.issues : [];
  if (!issues.length) return null;
  return {
    simple: true,
    align: true,
    goal: 'Resolve workflow scope before execution',
    steps: [], record: [], droppedRecords: [],
    decisions: issues.map((i) => ({
      question: i.question,
      options: [`Use ${i.recommendedValue}`, 'Specify another exact window'],
      recommendation: i.recommendation
    }))
  };
}

const STOCK_PLAN = {
  simple: false,
  align: false,
  goal: 'Build, run, publish, and validate the daily paper-stock analysis program',
  record: [], droppedRecords: [],
  merge: 'Report the dated hosted URL, spreadsheet path, qualifying paper selections or explicit no-pick result, validation status, and remaining limitations. Never present a paper selection as a directive to buy.',
  steps: [
    { id: 1, task: 'Inspect the working directory and any existing stock-analysis source program, dated reports, evidence bundle, and history ledger. Preserve prior append-only decisions. Determine the latest COMPLETED US market session; before 4:05 p.m. America/New_York, today is not a completed close.', produces: 'existing artifact inventory and honest market as-of date', delegate: false, parallel: false, group: '', agent: 'auto' },
    { id: 2, task: 'Create or revise a reusable deterministic source program (analyze.js, analyze.mjs, or analyze.py) plus a validator before collecting live evidence. The same program must own the full repeatable pipeline: collect and analyze AAPL, AMZN, AVGO, GOOGL, JPM, META, MSFT, NVDA, XOM, plus SPY; calculate 20/60 completed-trading-session trends, volume, and SPY-relative strength; keep scoring and gates explicit; prevent look-ahead bias; preserve immutable decisions; place no trades; allow zero picks; append the immutable XLSX decision; and generate the dated interactive HTML report from the canonical analysis result. Do not leave publication as a one-off helper script or model-authored page.', produces: 'runnable end-to-end analysis and publication source, scoring configuration, and validator', delegate: false, parallel: false, group: '', agent: 'auto' },
    { id: 3, task: 'Run the deterministic source program to collect the apples-to-apples market bundle directly into evidence.json. Then use bounded search/fetch only for candidates that can still qualify: at least one company/SEC primary source and one independent news source each. Record retrieval time, market-data as-of time, publication dates, source type, and direct URLs. Cap model-driven search/fetch calls at 10, reuse results already written to disk, and never invent unavailable data.', produces: 'timestamped evidence.json with auditable price, benchmark, primary, and independent inputs', delegate: false, parallel: false, group: '', agent: 'auto' },
    { id: 4, task: 'FIRST run the reusable source program’s publication path to append today’s immutable decision to stock-selection-history.xlsx and regenerate reports/YYYY-MM-DD/index.html from the canonical analysis result. If the program has no working publication path, revise the reusable program once and run it; do not hand-author the page, create one-off repair scripts, or spend the step broadly inventorying generated files. Then inspect only the generated outputs needed to verify them. The workbook must have valid formulas with no #REF!, #DIV/0!, #VALUE!, #NAME?, or #N/A errors. The page must contain ranked candidates or explicit no-pick, citations, risks, prior performance, methodology, freshness, disclaimer, and working filter/sort controls.', produces: 'program-generated valid XLSX history ledger and dated self-contained interactive HTML report', delegate: false, parallel: false, group: '', agent: 'auto' },
    { id: 5, task: 'Do not start or manage a server in the model workflow. Confirm the dated report route and workbook route, plus any required local asset paths. After execution, the framework will deterministically start or restart the persistent project host and independently health-check both artifacts.', produces: 'report route, workbook route, and local asset manifest for framework-owned hosting', delegate: false, parallel: false, group: '', agent: 'auto' },
    { id: 6, task: 'Run the validator and check source links, primary-source evidence, workbook formulas, trading-session horizons, append-only chronology, duplicate prevention, arithmetic, HTML interactions, market-session timestamp honesty, page-to-ledger consistency, live host status, and every selection gate. Correct failures once, rebuild, restart with start_server if needed, and rerun validation before reporting.', produces: 'passing validation checklist, correction status, and qualifying selections or explicit no-pick result', delegate: false, parallel: false, group: '', agent: 'auto' }
  ]
};

function stockPlanFromBoundary(remainingFrom) {
  const steps = STOCK_PLAN.steps.map((step) => ({ ...step }));
  const boundary = Number(remainingFrom);
  const remaining = remainingFrom == null || !Number.isFinite(boundary)
    ? steps : steps.filter((step) => Number(step.id) >= boundary);
  return { ...STOCK_PLAN, record: [], droppedRecords: [], steps: remaining };
}

function foldMonthlySaveSteps(steps) {
  const folded = [];
  for (let index = 0; index < steps.length; index += 1) {
    const current = steps[index];
    const next = steps[index + 1];
    const composes = /\b(?:compose|draft|write|revis(?:e|ed)|build)\b[\s\S]{0,120}\b(?:html|report|document)\b/i.test(current.task || '');
    const saves = next && /\bsave\b[\s\S]{0,100}\b(?:save_document|document|report|html)\b/i.test(next.task || '');
    if (!composes || !saves) { folded.push(current); continue; }
    folded.push({ ...current, task: `${current.task}\n\n${next.task}\n\nGenerate the document directly as the save_document call in this step. Do not return the full document body as an intermediate conclusion. After the tool succeeds, return only the saved path and a compact status summary.`, produces: next.produces || current.produces });
    index += 1;
  }
  return folded;
}

function plansImplementationSourceInspection(step) {
  return /\bread(?:ing)?\b[\s\S]{0,180}(?:\bimplementation\s+(?:source|files?)\b|\bsrc\/|\.(?:js|ts|py)\b)/i.test(step.task || '');
}

function ensureModeFlowSave(steps) {
  const saveIndex = steps.findIndex((step) => /\b(?:create|compose|draft|write|revise|build|generate|save)\b[\s\S]{0,300}\bsave_document\b/i.test(step.task || ''));
  const hasSourceInspection = steps.some(plansImplementationSourceInspection);
  if (saveIndex >= 0 && hasSourceInspection) return steps;
  if (saveIndex >= 0) return steps.map((step, index) => index === saveIndex ? {
    ...step,
    task: `Before composing, inspect the Shamrock implementation with read_file using the working-directory source map. Read relevant files under src/, including src/main/ipc.js, src/main/workflow-contracts.js, src/main/coding-tools.js, and src/main/mcp/manager.js when present. Cite only implementation paths actually read in the Source evidence section.\n\n${step.task}`
  } : step);
  const id = steps.reduce((max, step) => Math.max(max, Number(step.id) || 0), 0) + 1;
  return [...steps, { id, task: 'Inspect the relevant Shamrock implementation source files from the working-directory map with read_file, then create and save the requested Code mode and Documents mode Markdown document with save_document. Include exactly three Mermaid flowcharts, the comparison table, legend, authentication and STOP/recovery paths, decision checklist, and a Source evidence section citing the implementation paths actually read. Validate the complete saved artifact before returning its path.', produces: 'saved source-grounded mode-flow document path and validation status', parallel: false, group: '', agent: 'auto' }];
}

function capDelegatedSteps(steps, maximum) {
  let delegated = 0;
  return steps.map((step) => {
    if (!(step.delegate || step.parallel)) return step;
    delegated += 1;
    return delegated <= maximum ? step : { ...step, delegate: false, parallel: false, group: '' };
  });
}

function constrainPlan(plan, contract, options = {}) {
  if (!plan || !Array.isArray(plan.steps) || !contract) return plan;
  if (contract.kind === 'stock-analysis') plan = stockPlanFromBoundary(options.remainingFrom);
  const maxSteps = contract.budgets.maxPlanSteps;
  const originalCount = plan.steps.length;
  let steps = plan.steps.slice(0, maxSteps);
  if (originalCount > maxSteps && plan.steps.length) steps[maxSteps - 1] = plan.steps[plan.steps.length - 1];
  if (contract.kind === 'monthly-report') steps = foldMonthlySaveSteps(steps);
  if (contract.kind === 'mode-flow') steps = ensureModeFlowSave(steps);
  steps = capDelegatedSteps(steps, contract.budgets.maxDelegates);
  return { ...plan, steps, budgetExceeded: originalCount > maxSteps ? { planSteps: originalCount, maxPlanSteps: maxSteps } : null };
}

function readArtifact(a) {
  if (a && typeof a.content === 'string' && a.content) return a.content;
  if (a && a.path) { try { return fs.readFileSync(a.path, 'utf8'); } catch {} }
  return '';
}

function stockWorkspaceArtifacts(root) {
  if (!root) return [];
  const base = path.resolve(root);
  const found = [];
  const add = (p, title = path.basename(p)) => { try { if (fs.statSync(p).isFile()) found.push({ path: p, title }); } catch {} };
  add(path.join(base, 'stock-selection-history.xlsx'));
  for (const name of ['evidence.json', 'evidence_bundle.json', 'validation_report.json']) add(path.join(base, name));
  try {
    for (const day of fs.readdirSync(path.join(base, 'reports'))) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) add(path.join(base, 'reports', day, 'index.html'), `Stock analysis ${day}`);
    }
  } catch {}
  try {
    for (const name of fs.readdirSync(base)) {
      if (/^(?:analy[sz]e|stock[-_]?analysis|pipeline|main)\.(?:js|mjs|cjs|py)$/i.test(name)) add(path.join(base, name));
    }
  } catch {}
  return found;
}

function xmlDecode(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Small read-only ZIP reader for XLSX acceptance checks. It intentionally
// supports the ordinary STORE/DEFLATE entries Excel writers emit and does not
// execute office macros or depend on a shell utility.
function endOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 65557);
  for (let index = buffer.length - 22; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function centralDirectoryEntry(buffer, offset) {
  if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  return {
    method: buffer.readUInt16LE(offset + 10), compressedSize: buffer.readUInt32LE(offset + 20),
    localOffset: buffer.readUInt32LE(offset + 42),
    name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
    nextOffset: offset + 46 + nameLength + extraLength + commentLength
  };
}

function inflateZipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) return null;
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  return entry.method === 8 ? zlib.inflateRawSync(compressed) : null;
}

function zipTextEntries(filePath, accept) {
  try {
    const buffer = fs.readFileSync(filePath);
    const eocd = endOfCentralDirectory(buffer);
    if (eocd < 0) return [];
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const entry = centralDirectoryEntry(buffer, offset);
      if (!entry) break;
      const data = accept(entry.name) ? inflateZipEntry(buffer, entry) : null;
      if (data) entries.push({ name: entry.name, text: data.toString('utf8') });
      offset = entry.nextOffset;
    }
    return entries;
  } catch { return []; }
}

function inspectStockWorkbook(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (stat.size < 1024 || head.readUInt16LE(0) !== 0x4b50) return { valid: false, detail: 'workbook is not a valid XLSX package' };
  } catch { return { valid: false, detail: 'workbook cannot be read' }; }
  const xml = zipTextEntries(filePath, (name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (!xml.length) return { valid: false, detail: 'workbook contains no worksheets' };
  const formulas = [];
  for (const entry of xml) for (const match of entry.text.matchAll(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/gi)) formulas.push(xmlDecode(match[1]));
  const placeholder = formulas.filter((f) => /\b(?:SelectionDate|EntryPrice|EntrySPY|day absolute)\b/i.test(f));
  const calendarOffsets = formulas.filter((f) => /\$?[A-Z]{1,3}\d+\s*\+\s*(?:1|5|20)\b/i.test(f));
  if (formulas.length < 6) return { valid: false, detail: `only ${formulas.length} return formula(s) found; expected at least 6` };
  if (placeholder.length) return { valid: false, detail: `${placeholder.length} prose placeholder formula(s) would evaluate as #NAME?` };
  if (calendarOffsets.length) return { valid: false, detail: `${calendarOffsets.length} formula(s) use calendar-day offsets instead of trading sessions` };
  return { valid: true, detail: `${formulas.length} formula(s) parsed with no placeholder or calendar-day horizon defects` };
}

function marketSessionHonesty(text, nowValue) {
  const now = nowValue ? new Date(nowValue) : new Date();
  if (!Number.isFinite(now.getTime())) return { ok: false, detail: 'validation time is invalid' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const preClose = ['Sat', 'Sun'].includes(parts.weekday) || Number(parts.hour) < 16 || (Number(parts.hour) === 16 && Number(parts.minute) < 5);
  const claimsTodayClose = new RegExp(`${today}.{0,50}(?:market\\s+)?close|(?:market\\s+)?close.{0,50}${today}`, 'i').test(String(text || ''));
  const closeStatements = String(text || '').split(/[\n.!?]+/).filter((statement) =>
    statement.includes(today) && /\b(?:market\s+)?close\b/i.test(statement));
  // "Today is not yet a completed close" is an honest warning, not an
  // affirmative same-day close claim. Only unnegated statements can fail.
  const affirmativeTodayClose = claimsTodayClose && closeStatements.some((statement) =>
    !/\b(?:not|not\s+yet|isn['’]?t|hasn['’]?t|has\s+not|before|unfinished|pending|cannot|can['’]?t)\b/i.test(statement));
  if (preClose && affirmativeTodayClose) return { ok: false, detail: `${today} is labeled as a completed close before the session is complete` };
  return { ok: true, detail: 'market-data timing does not claim an unfinished session as a completed close' };
}

function parseProperties(a) {
  if (!a) return {};
  if (a.properties && typeof a.properties === 'object') return a.properties;
  try { return a.properties_json ? JSON.parse(a.properties_json) : {}; } catch { return {}; }
}

function sourceRefsFrom(ctx) {
  const explicit = Array.isArray(ctx.sourceRefs) ? ctx.sourceRefs : [];
  const traced = (ctx.toolTrace || [])
    .filter((t) => t && t.ok !== false && t.name === 'read_file' && t.args && t.args.path)
    .map((t) => String(t.args.path));
  return [...new Set([...explicit, ...traced])].filter((ref) => {
    const normalized = String(ref).replace(/\\/g, '/');
    if (/(^|\/)(?:docs|documents)(?:\/|$)/i.test(normalized)) return false;
    return /\.(?:c|cc|cpp|cxx|h|hpp|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|kts|swift|rb|php|cs|sh|bash|zsh)$/i.test(normalized);
  });
}

function caseIdsFrom(ctx, text) {
  const explicit = Array.isArray(ctx.caseIds) ? ctx.caseIds.map(String) : [];
  if (explicit.length) return [...new Set(explicit)];
  const traced = [];
  for (const t of (ctx.toolTrace || [])) {
    const args = (t && t.args) || {};
    for (const [key, value] of Object.entries(args)) {
      if (/case(_?id)?$/i.test(key) && value != null) traced.push(String(value));
    }
  }
  const source = String(text || '');
  const written = [...source.matchAll(/\bcase(?:\s+id)?["']?\s*[:#-]\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:@\\/() -]{2,})/gi)].map((m) => m[1].replace(/["'`,}\]]+\s*$/, '').trim());
  const ranked = [...source.matchAll(/["']?top_case_\d+_id["']?\s*[:=]\s*["'`]([^"'`\n]+)["'`]/gi)].map((m) => m[1].trim());
  return [...new Set([...explicit, ...traced, ...written, ...ranked])];
}

function validMermaid(text) {
  const blocks = [...String(text || '').matchAll(/```mermaid\s*\n([\s\S]*?)```/gi)].map((m) => m[1].trim());
  return blocks.some((block) => /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/m.test(block)
    && /-->|---|==>|->>|-->>|\bstatediagram\b/i.test(block));
}

function addCheck(checks, id, ok, detail) {
  checks.push({ id, ok: !!ok, detail });
}

function validationArtifacts(contract, ctx) {
  let artifacts = Array.isArray(ctx.artifacts) ? ctx.artifacts : [];
  if (contract.kind !== 'stock-analysis') return artifacts;
  const discovered = stockWorkspaceArtifacts(ctx.workingDir);
  const seen = new Set(artifacts.map((artifact) => path.resolve(String(artifact.path || ''))));
  return [...artifacts, ...discovered.filter((artifact) => !seen.has(path.resolve(artifact.path)))];
}

function validateStepCompletion(checks, stepResults) {
  const incomplete = stepResults.some((result) => result && result.incomplete);
  const ok = stepResults.length > 0 && !incomplete;
  const detail = !stepResults.length ? 'no execution step results were recorded'
    : incomplete ? 'one or more execution steps are incomplete' : `${stepResults.length} step result(s) completed`;
  addCheck(checks, 'steps-complete', ok, detail);
}

function validateWebsite(checks, ctx, artifacts) {
  const website = artifacts.some((artifact) => /\.(html?|vue|jsx?|tsx?)$/i.test(artifact.path || '') || /website|landing/i.test(artifact.doc_type || artifact.title || ''));
  addCheck(checks, 'website-artifact', website, website ? 'website source artifact found' : 'no website source artifact found');
  const ran = ctx.check && ctx.check.ran;
  const passing = ran ? !!ctx.check.ok : ctx.checkRequired === false;
  const detail = ran ? (passing ? 'configured project check passed' : 'configured project check failed')
    : passing ? 'project has no configured check' : 'configured project check did not run';
  addCheck(checks, 'project-check-passing', passing, detail);
}

function normalizedMonthKey(value) {
  const text = String(value || '').toLowerCase();
  const iso = text.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const named = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/);
  if (!named) return '';
  const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(named[1]) + 1;
  return `${named[2]}-${String(month).padStart(2, '0')}`;
}

function monthlyArtifactMatches(artifact, period) {
  const properties = parseProperties(artifact);
  const typeMatches = /monthly|m-?soc/i.test(artifact.doc_type || artifact.title || '');
  const periodText = String(period || '').toLowerCase();
  const requestedMonth = normalizedMonthKey(period);
  const artifactMonth = normalizedMonthKey(properties.period) || normalizedMonthKey(artifact.title);
  return typeMatches && (!period || (requestedMonth && requestedMonth === artifactMonth)
    || String(properties.period || '').toLowerCase().includes(periodText) || String(artifact.title || '').toLowerCase().includes(periodText));
}

function validateMonthlyReport(checks, contract, artifacts, artifactText) {
  const matching = artifacts.filter((artifact) => monthlyArtifactMatches(artifact, contract.scope.period));
  const matchDetail = matching.length === 1 ? 'one report matches the requested period' : `${matching.length} reports match the requested period; expected exactly one`;
  addCheck(checks, 'period-matches', matching.length === 1, matchDetail);
  const remoteAssets = /<(?:script|img)\b[^>]*\bsrc\s*=\s*["']https?:\/\/|<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i.test(artifactText);
  addCheck(checks, 'standalone-assets', !remoteAssets, remoteAssets ? 'report depends on remote runtime assets' : 'no remote runtime assets found');
}

function freshCaseObservationCount(ctx) {
  if (Number(ctx.freshObservations || 0)) return Number(ctx.freshObservations);
  const identifiers = [];
  for (const trace of (ctx.toolTrace || [])) {
    if (!trace || trace.ok === false || !/(investigate|describe|get|fetch|search).*(case|fingerprint)|(case|fingerprint).*(investigate|describe|get|fetch|search)/i.test(trace.name || '')) continue;
    for (const [key, value] of Object.entries(trace.args || {})) {
      if (/case(_?id)?$|fingerprint(_?hash)?$/i.test(key) && value != null) identifiers.push(String(value));
    }
  }
  return new Set(identifiers).size;
}

function caseVerdictCount(ctx, text) {
  if (Array.isArray(ctx.verdicts)) return ctx.verdicts.length;
  const source = String(text || '');
  const labeled = (source.match(/\bverdict["']?\s*:/gi) || []).length;
  const observations = new Set([...source.matchAll(/\bso-[a-z0-9]+\b/gi)].map((match) => match[0].toLowerCase()));
  return Math.max(labeled, observations.size);
}

function validateTopCases(checks, contract, ctx, allText) {
  const identifiers = caseIdsFrom(ctx, allText);
  const expected = contract.scope.count || 5;
  addCheck(checks, 'requested-case-count', identifiers.length === expected, `${identifiers.length} unique case identifiers found; expected ${expected}`);
  const verdicts = caseVerdictCount(ctx, allText);
  addCheck(checks, 'case-verdicts', verdicts >= expected, `${verdicts} case verdict(s) found; expected at least ${expected}`);
  if (!contract.evidence.requireFresh) return;
  const fresh = freshCaseObservationCount(ctx);
  addCheck(checks, 'fresh-observations', fresh >= expected, `${fresh} fresh observation(s) found; expected ${expected}`);
}

function validateModeFlow(checks, ctx, artifactText) {
  const completeFlow = validMermaid(artifactText) && /\bcode|coding\b/i.test(artifactText) && /\bdocuments?\b/i.test(artifactText);
  addCheck(checks, 'mermaid-flow', completeFlow, completeFlow ? 'Mermaid flow covers code and document modes' : 'Mermaid flow or one required mode is missing');
  const references = sourceRefsFrom(ctx);
  addCheck(checks, 'source-inspected', references.length > 0, references.length ? `${references.length} source file(s) inspected` : 'no source-file read is present in the tool trace');
  const cited = references.filter((reference) => artifactText.includes(reference) || artifactText.includes(path.basename(reference)));
  addCheck(checks, 'source-cited', cited.length > 0, cited.length ? `${cited.length} inspected source file(s) cited in the artifact` : 'the artifact does not cite an inspected source file');
}

function stockArtifactGroups(artifacts) {
  return {
    html: artifacts.filter((artifact) => /(?:^|\/)reports\/\d{4}-\d{2}-\d{2}\/index\.html$/i.test(String(artifact.path || '')) || /stock.*analysis/i.test(artifact.title || '')),
    workbooks: artifacts.filter((artifact) => /stock-selection-history\.xlsx$/i.test(String(artifact.path || '')) || (/stock/i.test(artifact.title || '') && /xlsx|spreadsheet|raw-data/i.test(artifact.format || artifact.doc_type || ''))),
    programs: artifacts.filter((artifact) => /(?:^|\/)(?:analy[sz]e|stock[-_]?analysis|pipeline|main)\.(?:js|mjs|cjs|py)$/i.test(String(artifact.path || '')))
  };
}

function validateStockFiles(checks, ctx, groups) {
  addCheck(checks, 'runnable-program', groups.programs.length > 0, groups.programs.length ? 'reusable stock-analysis source program found' : 'no reusable analyze.js/.mjs/.py source program found');
  const publisher = verifyStockPublisher(groups.programs.map((program) => program.path));
  addCheck(checks, 'publisher-program', publisher.ok, publisher.detail);
  addCheck(checks, 'daily-html', groups.html.length > 0, groups.html.length ? 'dated stock-analysis HTML found' : 'no dated reports/YYYY-MM-DD/index.html artifact found');
  const interactive = groups.html.some((artifact) => /<(?:input|select)\b/i.test(readArtifact(artifact)) && /addEventListener\s*\(/i.test(readArtifact(artifact)));
  addCheck(checks, 'interactive-html', interactive, interactive ? 'filter/sort controls and event handlers found' : 'interactive filter/sort controls were not found');
  const consistency = verifyStockReport(ctx.workingDir);
  addCheck(checks, 'report-consistency', consistency.ok, consistency.detail);
}

function validateStockWorkbook(checks, workbooks) {
  addCheck(checks, 'history-spreadsheet', workbooks.length > 0, workbooks.length ? 'stock selection history spreadsheet found' : 'stock-selection-history.xlsx was not produced');
  const result = workbooks.length ? inspectStockWorkbook(workbooks[0].path) : { valid: false, detail: 'no workbook available to inspect' };
  addCheck(checks, 'spreadsheet-formulas', result.valid, result.detail);
}

function validateStockEvidence(checks, ctx, allText) {
  const cited = /https?:\/\//i.test(allText) || (ctx.toolTrace || []).some((trace) => /search|fetch/i.test(trace.name || '') && trace.ok !== false);
  addCheck(checks, 'source-cited', cited, cited ? 'public source evidence is present' : 'no public source URLs or successful research calls found');
  const primary = ctx.primarySourceVerification || { ok: false, detail: 'primary sources were not independently verified' };
  addCheck(checks, 'primary-source-evidence', primary.ok, primary.detail);
  const gateEvidence = /(?:80\s*\/\s*100|score.{0,30}80).{0,500}(?:relative strength|risk gate|qualif)/is.test(allText);
  addCheck(checks, 'selection-gates', gateEvidence, gateEvidence ? 'selection threshold and gates are evidenced' : 'selection gate evidence is missing');
  const timing = marketSessionHonesty(allText, ctx.now);
  addCheck(checks, 'market-session-honesty', timing.ok, timing.detail);
}

function validateStockHost(checks, server = {}) {
  const hosted = server.running === true && server.frameworkOwned === true && server.verified === true
    && server.url && /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i.test(server.url);
  const detail = hosted ? `framework host verified ${(server.verifiedPaths || []).length} artifact path(s) at ${server.url}`
    : 'framework-owned host did not pass report and workbook health checks';
  addCheck(checks, 'host-verified', hosted, detail);
}

function validateStockAnalysis(checks, ctx, artifacts, allText) {
  const groups = stockArtifactGroups(artifacts);
  validateStockFiles(checks, ctx, groups);
  validateStockWorkbook(checks, groups.workbooks);
  validateStockEvidence(checks, ctx, allText);
  validateStockHost(checks, ctx.serverStatus);
}

function recoverDurableArtifactCompletion(checks, contract, artifacts, stepResults) {
  const stepCheck = checks.find((check) => check.id === 'steps-complete');
  const durableKind = ['website', 'monthly-report', 'top-cases', 'mode-flow', 'stock-analysis'].includes(contract.kind);
  if (!stepCheck || stepCheck.ok || !durableKind || !artifacts.length) return;
  if (!stepResults.some((result) => result && result.incomplete)) return;
  const substantiveChecks = checks.filter((check) => check.id !== 'steps-complete');
  if (!substantiveChecks.length || substantiveChecks.some((check) => !check.ok)) return;
  stepCheck.ok = true;
  stepCheck.detail = 'provider stopped after publication; independent checks verified the durable artifact';
}

function validateWorkflow(contract, ctx = {}) {
  const checks = [];
  const stepResults = Array.isArray(ctx.stepResults) ? ctx.stepResults : [];
  const artifacts = validationArtifacts(contract, ctx);
  const artifactText = artifacts.filter((artifact) => !/\.xlsx$/i.test(String(artifact.path || ''))).map(readArtifact).join('\n\n');
  const allText = [artifactText, ...stepResults.map((result) => result && result.conclusion || '')].join('\n\n');
  validateStepCompletion(checks, stepResults);
  if ((contract.acceptance || []).includes('artifact-produced')) addCheck(checks, 'artifact-produced', artifacts.length > 0, artifacts.length ? `${artifacts.length} new or revised artifact(s)` : 'no new or revised artifact was linked to this turn');
  if (contract.kind === 'website') validateWebsite(checks, ctx, artifacts);
  if (contract.kind === 'monthly-report') validateMonthlyReport(checks, contract, artifacts, artifactText);
  if (contract.kind === 'top-cases') validateTopCases(checks, contract, ctx, allText);
  if (contract.kind === 'mode-flow') validateModeFlow(checks, ctx, artifactText);
  if (contract.kind === 'stock-analysis') validateStockAnalysis(checks, ctx, artifacts, allText);
  if (contract.budgetExceeded) addCheck(checks, 'plan-budget', false, `planner proposed ${contract.budgetExceeded.planSteps} steps; maximum is ${contract.budgetExceeded.maxPlanSteps}`);
  recoverDurableArtifactCompletion(checks, contract, artifacts, stepResults);
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

function renderResumeContext(run, checkpoints = []) {
  if (!run) return '';
  const completed = checkpoints.filter((c) => !(c.result && c.result.incomplete)).map((c) => ({
    step: c.step_key,
    result: c.result && (c.result.conclusion || c.result),
    values: c.values || null
  }));
  const partial = checkpoints.filter((c) => c.result && c.result.incomplete).map((c) => ({ step: c.step_key, result: c.result.conclusion || '(no conclusion)', values: c.values || null }));
  const priorFailures = String(run.error || '').trim();
  return [
    'RESUMABLE WORKFLOW CHECKPOINT:',
    `- run: ${run.turn_id}`,
    `- kind: ${run.kind}`,
    `- completed steps: ${completed.length}`,
    JSON.stringify(completed),
    `- incomplete retry checkpoints: ${partial.length}`,
    JSON.stringify(partial),
    `- prior acceptance failures: ${priorFailures || '(none recorded)'}`,
    'Continue from the first unfinished outcome. Treat completed steps as durable evidence and do not replay their side effects or identical reads.',
    'If prior acceptance failures are listed, correct those exact defects before doing broad inventory or exploratory inspection. Verify the correction, then continue with the remaining planned outcomes.'
  ].join('\n');
}

// Planning and execution use separate message ledgers. Put the durable resume
// digest into execution after ordinary history compaction so a completed
// delegated result is available to the first unfinished step.
function withResumeContext(messages, resumeContext) {
  const history = Array.isArray(messages) ? [...messages] : [];
  const context = String(resumeContext || '').trim();
  if (!context) return history;
  return [{
    role: 'system',
    content: 'DURABLE RESUME EVIDENCE — authoritative results from completed workflow checkpoints:\n\n' + context
  }, ...history];
}

function resumePlan(plan, checkpoints = []) {
  if (!plan || !Array.isArray(plan.steps) || !checkpoints.length) return plan;
  const completed = new Set(checkpoints.filter((row) => !(row.result && row.result.incomplete)).map((row) => String(row.step_key)));
  return { ...plan, steps: plan.steps.filter((step) => !completed.has(String(step.id))) };
}

function focusResumedStockStep(plan, run, checkpoints = []) {
  if (!plan || !Array.isArray(plan.steps) || !run || run.kind !== 'stock-analysis') return plan;
  const partial = checkpoints.find((checkpoint) => checkpoint.result && checkpoint.result.incomplete);
  if (!partial) return plan;
  const defects = String(run.error || '').split(';').filter((item) => /publisher-program|report-consistency/i.test(item)).join('; ');
  const steps = plan.steps.map((step) => String(step.id) !== String(partial.step_key) ? step : {
    ...step,
    task: `FOCUSED RESUME — prior inspection is complete. Correct only the reusable publisher defects before continuing: ${defects || 'the analyzer must own workbook and dated HTML publication'}. FIRST run python3 publisher_validator.py. If it passes, return its proof immediately without reading or editing anything. If it fails, read analyze.py once, then edit that reusable program so one canonical analysis result deterministically publishes stock-selection-history.xlsx and reports/YYYY-MM-DD/index.html with matching retrieval timestamp and ticker scores. Reuse existing workbook/report helpers when present. Run only a syntax check and publisher_validator.py; do not repeat broad inventory, workbook inspection, or unrelated research in this step.`
  });
  return { ...plan, steps };
}

function effectiveStepOutputTokenBudget(contract) {
  const configured = Number(contract && contract.budgets && contract.budgets.maxStepOutputTokens) || 10000;
  // A live stock run needed to regenerate a self-contained ~25 KB HTML page
  // through a write tool. The old 8k ceiling truncated the tool arguments and
  // correctly discarded them, but made the workflow impossible to finish.
  // Keep a finite artifact-sized ceiling and upgrade persisted stock runs too.
  return contract && contract.kind === 'stock-analysis' ? 20000 : configured;
}

function effectiveStepDurationBudget(contract) {
  const configured = Number(contract && contract.budgets && contract.budgets.maxStepDurationMs) || 0;
  return contract && contract.kind === 'stock-analysis' ? (configured || 360000) : configured;
}

function effectiveProviderResponseBudget(contract) {
  const configured = Number(contract && contract.budgets && contract.budgets.maxProviderResponseMs);
  if (configured > 0) return Math.max(30000, Math.min(600000, configured));
  return contract && ['monthly-report', 'top-cases', 'mode-flow', 'stock-analysis'].includes(contract.kind) ? 360000 : 180000;
}

module.exports = {
  CONTRACT_SCHEMA, classify, requestedPeriod, requestedCaseCount, createWorkflowContract, renderContract,
  scopeAlignment, constrainPlan, filterMcpToolset, shouldRepairAcceptance, validateWorkflow, renderResumeContext, withResumeContext, resumePlan, focusResumedStockStep, effectiveStepOutputTokenBudget, effectiveStepDurationBudget, effectiveProviderResponseBudget, validMermaid, mostRecentCompleteMonth
};
