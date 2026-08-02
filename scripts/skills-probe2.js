'use strict';
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
    const r = await mcp.callTool(vc.name, { client: 'claude' }, ts.routes);
    const obj = JSON.parse(r.text);
    console.log('SKILLS SECTION:\n' + JSON.stringify(obj.skills, null, 2).slice(0, 1400));
    // grab first skill name from likely locations
    const items = obj.skills && (obj.skills.items || obj.skills.list || obj.skills.skills);
    const first = Array.isArray(items) && items[0];
    console.log('\nFIRST ITEM:', JSON.stringify(first));
    if (first) {
      const nm = first.name || first.slug || first.id || first.skill;
      const sr = await mcp.callTool(su.name, { skill_names: [nm], client: 'claude' }, ts.routes);
      console.log('\nSKILLS_UPDATE for', nm, '(first 900):\n' + (sr.text || '').slice(0, 900));
    }
  } catch (e) { console.log('PROBE ERROR:', e && (e.stack || e.message)); }
  try { mcp.disposeAll(); } catch {}
  app.exit(0);
});
