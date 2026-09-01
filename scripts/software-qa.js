'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOTS = ['src', 'scripts', 'test-projects'];
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git']);
const CONTROL_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const VAGUE_NAMES = new Set(['fn', 'func', 'handler', 'helper', 'doit', 'work', 'processdata', 'thing']);
const FUNCTION_PATTERNS = [
  { kind: 'function', regex: /\b(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/g },
  { kind: 'arrow', regex: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g },
  { kind: 'property', regex: /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g },
  { kind: 'method', regex: /^\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm },
  { kind: 'callback', regex: /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g },
  { kind: 'anonymous', regex: /(?:async\s*)?\([^)]*\)\s*=>\s*\{/g }
];

function listJavaScriptFiles(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) listJavaScriptFiles(path.join(directory, entry.name), files);
    else if (entry.isFile() && /\.(?:js|mjs|cjs|ts|tsx)$/.test(entry.name)) files.push(path.join(directory, entry.name));
  }
  return files;
}

function preserveNewlines(value) {
  return value.replace(/[^\n]/g, ' ');
}

function maskNonCode(source) {
  const nonCode = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\])+\/[dgimsuvy]*|`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"/g;
  return maskDeclaredTemplates(source).replace(nonCode, preserveNewlines);
}

function maskDeclaredTemplates(source) {
  const templateRegion = /\/\/\s*qa-template-start[^\n]*\n[\s\S]*?\/\/\s*qa-template-end[^\n]*/g;
  return source.replace(templateRegion, preserveNewlines);
}

function closingBrace(source, openingBrace) {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function executableLineCount(body) {
  return body.split('\n').filter((line) => {
    const code = line.replace(/[{}()[\],;]+/g, '').trim();
    return code.length > 0;
  }).length;
}

function normalizedBody(body) {
  return body.replace(/\b[A-Za-z_$][\w$]*\b/g, 'id').replace(/\s+/g, '').replace(/[{}()[\],;]/g, '');
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function candidateFromMatch(file, source, masked, pattern, match) {
  const openingBrace = match.index + match[0].lastIndexOf('{');
  const closing = closingBrace(masked, openingBrace);
  if (closing < 0) return null;
  const callbackName = String(match[1] || '').split('.').pop();
  const name = pattern.kind === 'callback' ? `${callbackName}Callback` : (match[1] || 'anonymous');
  return { file, name, kind: pattern.kind, line: lineNumberAt(source, match.index), start: match.index, openingBrace, closing };
}

function withoutNestedFunctions(masked, candidate, candidates) {
  const body = masked.slice(candidate.openingBrace + 1, candidate.closing).split('');
  const nested = candidates.filter((item) => item.openingBrace > candidate.openingBrace && item.closing < candidate.closing);
  for (const item of nested) {
    const start = item.start - candidate.openingBrace - 1;
    const end = item.closing - candidate.openingBrace - 1;
    for (let index = start; index <= end; index += 1) if (body[index] !== '\n') body[index] = ' ';
  }
  return body.join('');
}

function finalizeCandidate(masked, candidate, candidates) {
  const body = withoutNestedFunctions(masked, candidate, candidates);
  return { ...candidate, lines: executableLineCount(body), normalized: normalizedBody(body) };
}

function functionsInFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const masked = maskNonCode(source);
  const found = new Map();
  for (const pattern of FUNCTION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of masked.matchAll(pattern.regex)) {
      const candidate = candidateFromMatch(file, source, masked, pattern, match);
      if (candidate && !CONTROL_NAMES.has(candidate.name) && !found.has(candidate.openingBrace)) found.set(candidate.openingBrace, candidate);
    }
  }
  const candidates = [...found.values()];
  return candidates.map((candidate) => finalizeCandidate(masked, candidate, candidates));
}

function duplicateGroups(functions) {
  const groups = new Map();
  for (const item of functions.filter((candidate) => candidate.normalized.length >= 120)) {
    const digest = crypto.createHash('sha1').update(item.normalized).digest('hex');
    groups.set(digest, [...(groups.get(digest) || []), item]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function relativeLocation(item) {
  return `${path.relative(process.cwd(), item.file)}:${item.line} (${item.name}, ${item.lines} lines)`;
}

function printSection(title, rows) {
  if (!rows.length) return;
  console.error(`\n${title} (${rows.length})`);
  for (const row of rows) console.error(`- ${row}`);
}

function main() {
  const files = ROOTS.flatMap((root) => listJavaScriptFiles(path.join(process.cwd(), root)));
  const functions = files.flatMap(functionsInFile);
  const longFunctions = functions.filter((item) => item.lines > 20).sort((a, b) => b.lines - a.lines);
  const vagueNames = functions.filter((item) => item.kind !== 'callback' && VAGUE_NAMES.has(item.name.toLowerCase()));
  const duplicates = duplicateGroups(functions);
  printSection('Functions over 20 executable lines', longFunctions.map(relativeLocation));
  printSection('Non-descriptive function names', vagueNames.map(relativeLocation));
  printSection('Exact normalized duplicate functions', duplicates.map((group) => group.map(relativeLocation).join(' | ')));
  if (longFunctions.length || vagueNames.length || duplicates.length) process.exitCode = 1;
  else console.log(`Software QA passed: ${functions.length} functions across ${files.length} files.`);
}

if (require.main === module) main();
module.exports = { maskNonCode, maskDeclaredTemplates, functionsInFile, executableLineCount, duplicateGroups, withoutNestedFunctions };
