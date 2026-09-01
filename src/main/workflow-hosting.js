'use strict';

const fs = require('node:fs');
const path = require('node:path');
const devServer = require('./dev-server');

function latestReportPath(root) {
  const reports = path.join(root, 'reports');
  try {
    const date = fs.readdirSync(reports).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.existsSync(path.join(reports, name, 'index.html'))).sort().pop();
    return date ? `/reports/${date}/index.html` : null;
  } catch { return null; }
}

function stockHostPaths(root) {
  return [latestReportPath(root), fs.existsSync(path.join(root, 'stock-selection-history.xlsx')) ? '/stock-selection-history.xlsx' : null].filter(Boolean);
}

async function ensureStockHost({ projectId, root }) {
  const paths = stockHostPaths(root);
  if (paths.length < 2) return { running: false, verified: false, frameworkOwned: true, verifiedPaths: [], error: 'dated report or history workbook is missing' };
  const current = devServer.status(projectId);
  if (!current.running || !current.frameworkOwned) await devServer.startStatic({ projectId, root });
  return devServer.health(projectId, paths);
}

module.exports = { latestReportPath, stockHostPaths, ensureStockHost };
