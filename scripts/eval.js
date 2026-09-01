'use strict';

// FOCUSED EVAL RUNNER — the fast way to answer "what does the MODEL do?"
//
// smoke.js answers what the CODE does, deterministically, in seconds. Model
// behaviour needs a different instrument: on 2026-08-14 three theories about
// diagram compression were each investigated with 5-50 minute agentic runs,
// and every one produced a confident wrong answer from a single sample. The
// same three were refuted in ~15 minutes here — one model call per trial,
// several variants, and REPLICATES PER ARM, which is what caught a "winner"
// that reversed on repetition.
//
//   npm run eval            — run every eval in scripts/evals/
//   npm run eval redraw     — run one by name
//
// Costs real API calls, so it is deliberately NOT part of `npm test`.
//
// An eval module exports:
//   { name, description, source?, variants: {label: promptText},
//     predicates: {label: (text) => boolean}, replicates? }

const { liveDbPath } = require('./_app-identity'); // MUST come first — see the file for why

const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EVAL_DIR = path.join(__dirname, 'evals');
const DEFAULT_REPLICATES = 3;

/** The provider the app itself is configured with, against a throwaway DB copy. */
function openConnector(tmp) {
  const live = liveDbPath();
  fs.copyFileSync(live, path.join(tmp, 'eval.db'));
  require('../src/main/db').openDatabase(path.join(tmp, 'eval.db'));
  const repo = require('../src/main/db/repo');
  const { getConnector } = require('../src/main/providers');
  const provider = repo.providers.list().find((p) => p.enabled);
  if (!provider) throw new Error('no enabled provider — connect one in the app first');
  const key = repo.providers.reveal(provider.id);
  if (!key) throw new Error('no API key stored for ' + (provider.label || provider.type));
  return { connector: getConnector(provider, key), model: provider.default_model || process.env.EVAL_MODEL };
}

async function askOnce(connector, model, prompt) {
  try {
    const r = await connector.chat({ model, messages: [{ role: 'user', content: prompt }], maxTokens: 2000 });
    return r.text || '';
  } catch (e) { return 'ERROR: ' + (e && e.message); }
}

/** One arm: N replicates, scored against every predicate. */
async function runArm({ connector, model, prompt, predicates, replicates, outDir, label }) {
  const names = Object.keys(predicates);
  const hits = Object.fromEntries(names.map((n) => [n, 0]));
  for (let i = 1; i <= replicates; i++) {
    const text = await askOnce(connector, model, prompt);
    const marks = names.map((n) => {
      const ok = !!predicates[n](text);
      if (ok) hits[n] += 1;
      return `${ok ? '✓' : '✗'} ${n}`;
    });
    console.log(`  ${marks.join('   ')}   ${label} #${i}`);
    fs.writeFileSync(path.join(outDir, `${label.replace(/\W+/g, '_')}_${i}.txt`), text);
  }
  return hits;
}

function report(evalName, tally, replicates) {
  console.log(`\n=== ${evalName}: tally out of ${replicates} ===`);
  for (const [arm, hits] of Object.entries(tally)) {
    const cells = Object.entries(hits).map(([n, c]) => `${n} ${c}/${replicates}`).join('   ');
    console.log(`  ${arm.padEnd(28)} ${cells}`);
  }
  console.log('  (a result that does not repeat across replicates is noise, not a finding)');
}

async function runEval(mod, ctx, tmp) {
  const replicates = mod.replicates || DEFAULT_REPLICATES;
  console.log(`\n### ${mod.name} — ${mod.description}`);
  const tally = {};
  for (const [label, prompt] of Object.entries(mod.variants)) {
    const outDir = path.join(tmp, mod.name);
    fs.mkdirSync(outDir, { recursive: true });
    tally[label] = await runArm({ ...ctx, prompt, predicates: mod.predicates, replicates, outDir, label });
  }
  report(mod.name, tally, replicates);
}

app.whenReady().then(async () => {
  const only = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shamrock-eval-'));
  const ctx = openConnector(tmp);
  console.log(`model: ${ctx.model}\noutputs: ${tmp}`);

  const files = fs.readdirSync(EVAL_DIR).filter((f) => f.endsWith('.js'));
  const chosen = files.filter((f) => !only || f.replace(/\.js$/, '') === only);
  if (!chosen.length) throw new Error(`no eval matched "${only}" (have: ${files.map((f) => f.replace(/\.js$/, '')).join(', ')})`);
  for (const f of chosen) await runEval(require(path.join(EVAL_DIR, f)), ctx, tmp);

  console.log('\nEVALS COMPLETE');
  app.exit(0);
}).catch((e) => { console.error('\nEVAL ERROR:', e && e.message); app.exit(1); });
