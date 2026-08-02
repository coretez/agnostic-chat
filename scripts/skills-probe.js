'use strict';
// Diagnostic: call Fluency's version_check + skills_update to see the shape.
const { app } = require('electron');
const os = require('node:os');
const { openDatabase } = require('../src/main/db');
const mcp = require('../src/main/mcp/manager');

app.whenReady().then(async () => {
  try {
    openDatabase(os.homedir() + '/Library/Application Support/agnostic-chat/agnostic-chat.db');
    const ts = await mcp.buildToolset();
    const vc = ts.tools.find((t) => t.name.endsWith('__version_check'));
    const su = ts.tools.find((t) => t.name.endsWith('__skills_update'));
    console.log('has version_check:', !!vc, '| has skills_update:', !!su);
    if (su) console.log('skills_update input schema:', JSON.stringify(su.inputSchema).slice(0, 400));
    if (vc) { try { const r = await mcp.callTool(vc.name, {}, ts.routes); console.log('=== VERSION_CHECK ===\n' + r.text.slice(0, 1000)); } catch (e) { console.log('version_check err:', e.message); } }
    if (su) { try { const r = await mcp.callTool(su.name, {}, ts.routes); console.log('=== SKILLS_UPDATE (first 1800) ===\n' + r.text.slice(0, 1800)); } catch (e) { console.log('skills_update err:', e.message); } }
  } catch (e) {
    console.log('PROBE ERROR:', e && (e.stack || e.message));
  }
  try { mcp.disposeAll(); } catch {}
  app.exit(0);
});
