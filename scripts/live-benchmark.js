'use strict';

// Drives the running development build through its real preload/main-process
// API over Electron's local DevTools channel. This is intentionally separate
// from smoke.js: it spends real model/tool calls and writes real benchmark
// chats/artifacts into the configured Shamrock database.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TARGETS_URL = process.env.SHAMROCK_CDP_URL || 'http://127.0.0.1:9222/json/list';

const BENCHMARKS = {
  website: {
    projectId: 5, mode: 'code', title: 'E2E rerun — website reliability contract',
    prompt: 'Build a polished, responsive one-page website for Shamrock, the model-agnostic project workspace. Work only inside this project directory. Create a self-contained static site using index.html and styles.css, with JavaScript only if it adds a useful lightweight interaction. Use a dark terminal/developer visual direction with a restrained green accent. Include: a clear hero explaining “one project, any model”; a section for Work, Documents, and Code modes; a section describing these five benchmark projects (website, Expo monthly report, top-five case investigation, mode flow diagram, and daily stock analysis); and a final call to action. Requirements: semantic HTML, visible keyboard focus, mobile layout down to 320px, reduced-motion support, no external dependencies, and no placeholder copy. Validate the finished files with available local checks. Do not ask follow-up questions; make reasonable product decisions. Finish by reporting the files created, checks run, and any remaining limitations.'
  },
  monthly: {
    projectId: 6, mode: 'documents', title: 'E2E rerun — Expo July 2026 monthly report',
    prompt: 'Benchmark 02 final rerun. Produce the final July 2026 Expo monthly security report by reviewing and revising the existing report in this project\'s document library.\n\nExecution contract:\n- Use the live Fluency Expo connector and the dedicated Expo monthly report skill.\n- Scope: July 1-31, 2026. Audience: Expo executives first, with operational detail for the SOC. Branding: Expo with Fluency Security as security partner.\n- Collect all live evidence once in one delegated evidence-collection step. That collector must return a complete compact evidence bundle with every count, breakdown, named finding, source status, case of note, and data gap needed for drafting and validation.\n- All downstream analysis, drafting, saving, and verification steps must use that delegated evidence bundle. They must not call the live evidence tools again or page the case list again.\n- Revalidate totals, dispositions, top fingerprints, actors, cases of note, signature coverage, and data-source health. Do not invent figures.\n- Correct every unsupported or misleading statement. A fingerprint case count is not a number of days.\n- Keep the fixed eight-chapter executive report structure, self-contained HTML, print styling, and explicit data-gap language.\n- Revise the existing saved artifact rather than starting over. Save the final HTML to the document library as type monthly-report.\n- Validate arithmetic, cross-chapter consistency, HTML structure, and print readiness after saving using the evidence bundle and the saved file.\n- In the final chat reply, state only the final evidence set and actual artifact status. Do not narrate discarded drafts or describe replaced plan steps as unfinished when revised steps completed their outcomes.\n- The scope and format are fully decided; do not ask follow-up questions.'
  },
  cases: {
    projectId: 7, mode: 'work', title: 'E2E rerun — Expo top five cases',
    prompt: 'Investigate the five highest-risk Expo cases in the populated July 2025 case window and produce one validated, decision-ready HTML report.\n\nAuthentication continuity is mandatory. Remain signed in throughout the run. If the access token approaches expiry, continue through the application\'s automatic renewal. If authorization ultimately fails, report it and do not guess.\n\nBounded workflow:\n1. Resolve Expo scope once.\n2. Call list_cases exactly once with grid_account "expo", range_from "2025-07-01", range_to "2025-07-31", limit 5, sort_field "riskScore", sort_order "desc", include_fingerprint true, include_ai_description false, and no status restriction.\n3. Use the five returned unique rows in their returned risk order. Set top_case_1_id through top_case_5_id to their exact case IDs. Do not call another Expo tool during ranking and do not call list_cases again anywhere in the run.\n4. Run one parallel investigation group with exactly five workers. Worker N must use top_case_N_id and grid_account "expo". Each worker must complete: prepare_case_investigation; expand_case_records; describe_expanded_case; get_case; describe_fingerprint; analyze_signature_findings; record_case_investigation. Return exact case fields, risk/status/owner, evidence, timeline, affected identity/assets, fingerprint/signature findings, supported MITRE mapping, verdict, confidence, recommended action, and record observation IDs.\n5. Save one self-contained print-ready HTML report with save_document, format html, type investigation. No shell and no PDF.\n6. Validate that all five top_case_N_id values and five record_case_investigation results appear. If not, save an explicitly partial report but do not claim success.\n\nThe report needs an executive comparison table ordered 1-5, detailed sections for all five cases, retrieval time, Expo scope, methodology/window, and honest limitations.'
  },
  flow: {
    projectId: 8, mode: 'documents', title: 'E2E rerun — source-grounded mode flow',
    workingDir: process.cwd(),
    prompt: 'Create and save a polished flow-diagram document that explains Shamrock\'s Code mode and Documents mode.\n\nAudience: engineering, product, and security operators.\nDeliverable: one Markdown document using Mermaid diagrams, saved with save_document as format "md" and type "process-diagram". Do not create a PDF and do not use shell commands. Do not ask follow-up questions; the requirements below are complete.\n\nDocument requirements:\n1. Title, purpose, scope, and a concise mode-selection guide.\n2. One overview Mermaid flowchart showing the shared path from user request through mode selection, planning, scoped context/tools, execution, validation, artifact handoff, and durable chat/project records.\n3. A detailed Code mode Mermaid flowchart covering: working-directory jail; source/rulebook discovery; plan; read-only work; mutation approval/bypass gate; baseline/step commits; project check command; one bounded fix step; code/security review; debt capture; final handoff; STOP/failure recovery.\n4. A detailed Documents mode Mermaid flowchart covering: alignment gate for audience/format/type when missing; evidence gathering; analysis; drafting; save_document placement; librarian filing/tags; revision/versioning; validation; chat-to-document link; final handoff; STOP/failure recovery.\n5. A comparison table for intent, allowed operations, approvals, persistence, validation, outputs, and failure behavior.\n6. A legend that distinguishes deterministic framework gates, model decisions, external tools/data, saved artifacts, and user decisions.\n7. Operational notes on authentication continuity for connected tools: stored OAuth session, proactive refresh near expiry, single-flight refresh for parallel calls, one replay after 401, and explicit failure rather than fabricated data.\n8. Keep every Mermaid node label parse-safe: avoid raw parentheses or quotes inside labels; use short labels.\n9. End with a concise Choosing a mode decision checklist.\n\nValidation before handoff:\n- exactly three Mermaid flowchart blocks;\n- both Code mode and Documents mode named explicitly;\n- approval, validation, versioning, STOP/recovery, and authentication paths shown;\n- Markdown is well structured and the saved path is reported.'
  },
  stock: {
    projectName: 'Shamrock E2E — Daily Stock Analysis',
    workingDir: path.join(process.cwd(), 'test-projects', 'shamrock-runs', 'daily-stock-analysis'),
    mode: 'code', title: 'E2E — daily public-market stock analysis',
    prompt: `Create a stock-analysis program that uses current public news, market data, and price trends to identify paper-investment candidates, then tracks whether its selections were right over time. This is a research benchmark, not personalized financial advice: do not place trades, connect a brokerage, or claim guaranteed returns.

Execution contract:
1. Research a broad, liquid US-listed stock universe using current public sources. Record the retrieval time, source URL, publication time when available, and market-data as-of time. Prefer primary sources such as company filings and investor relations, plus reputable financial news. Never invent missing figures or citations.
2. Use a documented, repeatable scoring model that separates news/catalyst evidence, price and volume trend, market/sector context, valuation or fundamental evidence when available, and downside risk. Prevent look-ahead bias: every daily decision must use only information available at that decision timestamp.
3. Select zero to five paper-investment candidates. A "good selection" must score at least 80/100, have positive medium-term trend and relative strength, contain no unresolved severe risk flag, and have evidence from at least two independent sources including one primary source. If none qualify, say so and do not force a pick.
4. Keep an append-only spreadsheet named stock-selection-history.xlsx. Include a daily selections ledger, daily price observations, benchmark observations using SPY, score components, source links, confidence, thesis, risks, invalidation condition, and calculated 1-, 5-, and 20-trading-day absolute and SPY-relative returns as those horizons mature. Never rewrite the original selection thesis or decision-time values.
5. Create one self-contained interactive HTML page for the current market date under reports/YYYY-MM-DD/index.html. It must show the ranked candidates or explicit no-pick result, score breakdowns, cited news and primary evidence, interactive sorting/filtering, risk and invalidation notes, prior-pick performance, benchmark comparison, methodology, data freshness, and a prominent paper-research disclaimer.
6. Publish the dated HTML page through the project's configured host. Verify that the public or local hosted URL loads successfully and that the page has no broken local assets. Report the exact URL. Do not silently substitute an unhosted file.
7. Validate the spreadsheet formulas and required columns, HTML structure and interactions, source links, arithmetic, duplicate prevention, chronological append behavior, and consistency between the page and spreadsheet.
8. Evaluate this run against the contract. Correct any failures, rebuild the affected artifacts, restart the host if necessary, and rerun validation once before reporting the result.

Notification rule: say "Good selections found" only when at least one stock passes every gate in item 3. Otherwise say "No qualifying selections today." Report candidates as paper selections with uncertainty and downside risks, never as a directive to buy.`
  }
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve; this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
          return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const values = (msg.params.args || []).map((a) => a.value ?? a.description).filter((v) => v != null);
          if (values.some((v) => String(v).startsWith('[LIVE-E2E]'))) process.stdout.write(values.join(' ') + '\n');
        }
      };
    });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const name = process.argv[2];
  const benchmark = BENCHMARKS[name];
  if (!benchmark) throw new Error(`Choose one benchmark: ${Object.keys(BENCHMARKS).join(', ')}`);
  if (benchmark.workingDir) fs.mkdirSync(benchmark.workingDir, { recursive: true });
  const targets = await getJson(TARGETS_URL);
  const target = targets.find((t) => t.type === 'page' && t.title === 'Shamrock');
  if (!target) throw new Error('The running Shamrock window was not found.');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  const resumeChatId = Number(process.env.SHAMROCK_RESUME_CHAT_ID) || null;
  const input = JSON.stringify({ name, ...benchmark, resumeChatId });
  const expression = `(async () => {
    const b = ${input};
    if (!b.projectId && b.projectName) {
      const projects = await window.api.projects.list();
      const existing = projects.find((p) => p.name === b.projectName);
      const project = existing || await window.api.projects.create({ name: b.projectName });
      b.projectId = project.id;
    }
    if (b.workingDir) await window.api.projects.setWorkingDir(b.projectId, b.workingDir);
    const provider = (await window.api.providers.list()).find((p) => p.enabled);
    if (!provider) throw new Error('no enabled provider');
    const model = provider.default_model || (provider.models && provider.models[0]);
    const chats = b.resumeChatId ? await window.api.chats.list(b.projectId) : [];
    const chat = b.resumeChatId ? chats.find((candidate) => Number(candidate.id) === Number(b.resumeChatId)) : await window.api.chats.create({ projectId: b.projectId, title: b.title, model });
    if (!chat) throw new Error('resume chat not found');
    await window.api.chats.setMode(chat.id, b.mode);
    const resumeRun = b.resumeChatId ? await window.api.workflows.latest(chat.id) : null;
    const requestText = resumeRun ? 'Resume the checkpointed workflow. Correct the recorded acceptance defects first, then continue only the unfinished outcomes.' : b.prompt;
    await window.api.messages.add({ chatId: chat.id, role: 'user', content: requestText });
    const persistedMessages = resumeRun ? await window.api.messages.list(chat.id) : [{ role: 'user', content: requestText }];
    const requestMessages = persistedMessages.map((message) => ({ role: message.role, content: message.content }));
    const turnId = 'live-' + b.name + '-' + Date.now().toString(36);
    const processEvents = [];
    const unsub = window.api.onChatProgress((ev) => {
      if (ev.turnId && ev.turnId !== turnId) return;
      if (ev.type === 'action-approve') window.api.continueChat(1, turnId);
      if (ev.type === 'limit') window.api.continueChat(0, turnId);
      if (ev.type === 'stuck') window.api.continueChat(0, turnId);
      if (ev.type === 'process') {
        const compact = { kind: ev.kind, step: ev.step, steps: ev.steps, status: ev.status, failures: ev.failures, runId: ev.runId };
        processEvents.push(compact);
        console.log('[LIVE-E2E]', b.name, JSON.stringify(compact));
      }
      if (ev.type === 'document-saved') console.log('[LIVE-E2E]', b.name, JSON.stringify({ kind: 'document-saved', path: ev.path, version: ev.version }));
    });
    const started = Date.now();
    try {
      const result = await window.api.sendMessage({ providerId: provider.id, model, messages: requestMessages, text: requestText, projectId: b.projectId, chatId: chat.id, turnId, resumeRunId: resumeRun && resumeRun.id });
      await window.api.messages.add({ chatId: chat.id, role: 'assistant', content: result.reply || '', metadata: { model: result.model, tools: result.toolTrace || [], acceptance: result.acceptance || null } });
      const authStatus = await window.api.mcp.authStatus();
      return {
        benchmark: b.name, projectId: b.projectId, chatId: chat.id, turnId,
        durationMs: Date.now() - started, reply: result.reply,
        planned: result.planned, aborted: result.aborted, truncated: result.truncated,
        firewallBlocked: result.firewallBlocked, acceptance: result.acceptance,
        authStatus,
        tools: (result.toolTrace || []).map((t) => ({ name: t.name, ok: t.ok, durationMs: t.durationMs, resultChars: t.resultChars, filteredChars: t.filteredChars })),
        processEvents
      };
    } finally { unsub(); }
  })()`;
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  cdp.close();
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  process.stdout.write('[LIVE-E2E-RESULT] ' + JSON.stringify(result.result.value) + '\n');
}

main().catch((error) => { console.error('[LIVE-E2E-ERROR]', error && (error.stack || error.message)); process.exitCode = 1; });
