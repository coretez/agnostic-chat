'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { latestReportPath } = require('./workflow-hosting');

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function latestReportFile(root) {
  const route = latestReportPath(root);
  return route ? path.join(root, route.replace(/^\//, '')) : '';
}

function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

function scoreAppears(html, score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return false;
  return html.includes(String(value)) || html.includes(value.toFixed(1));
}

function missingCandidateEvidence(result, html) {
  return (result.all_evaluated || []).filter((candidate) =>
    !html.includes(String(candidate.ticker || '')) || !scoreAppears(html, candidate.total_score));
}

function outcomeMatches(result, html) {
  const selections = Array.isArray(result.selections) ? result.selections : [];
  if (!selections.length) return /no\s+(?:qualifying\s+)?(?:selection|pick)|\bNONE\b/i.test(html);
  return selections.every((selection) => html.includes(String(selection.ticker || '')));
}

function reportFailures(result, html) {
  const failures = [];
  if (!html.includes(String(result.run_date || ''))) failures.push('run date');
  if (!html.includes(String(result.retrieval_time_utc || ''))) failures.push('retrieval timestamp');
  const missing = missingCandidateEvidence(result, html);
  if (missing.length) failures.push(`${missing.length} candidate ticker/score pair(s)`);
  if (!outcomeMatches(result, html)) failures.push('selection outcome');
  return failures;
}

function verifyStockReport(root) {
  const result = readJsonFile(path.join(root || '', 'analysis_result.json'));
  const reportFile = latestReportFile(root);
  if (!result) return { ok: false, detail: 'analysis_result.json is missing or invalid' };
  if (!reportFile) return { ok: false, detail: 'dated HTML report is missing' };
  const failures = reportFailures(result, readTextFile(reportFile));
  return failures.length
    ? { ok: false, detail: `report does not match canonical analysis: ${failures.join(', ')}` }
    : { ok: true, detail: `${result.all_evaluated?.length || 0} candidate result(s), timestamp, date, and outcome match the report` };
}

function sourceOwnsPublication(filePath) {
  const source = readTextFile(filePath);
  return /stock-selection-history\.xlsx/i.test(source)
    && /reports[\\/]/i.test(source) && /index\.html/i.test(source);
}

function verifyStockPublisher(programPaths = []) {
  const publisher = programPaths.find(sourceOwnsPublication);
  return publisher
    ? { ok: true, detail: `reusable publication path found in ${path.basename(publisher)}` }
    : { ok: false, detail: 'analysis program does not own both XLSX and dated HTML publication' };
}

module.exports = { missingCandidateEvidence, verifyStockReport, verifyStockPublisher };
