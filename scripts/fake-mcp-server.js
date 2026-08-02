'use strict';

// A minimal fake MCP server for testing the stdio client: answers `initialize`
// and `tools/list` over newline-delimited JSON-RPC. Not a real server.

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'echo', description: 'Echo back the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
        { name: 'search_docs', description: 'Search project documents', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
      ] } });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: a = {} } = msg.params || {};
      let text;
      if (name === 'echo') text = `echo: ${a.text}`;
      else if (name === 'add') text = String((a.a || 0) + (a.b || 0));
      else text = `ran ${name}`;
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
    } else if (msg.method === 'resources/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { resources: [{ uri: 'ui://fake/panel', name: 'Panel', mimeType: 'text/html' }] } });
    } else if (msg.method === 'resources/read') {
      const uri = (msg.params || {}).uri;
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: [{ uri, mimeType: 'text/html', text: '<h1>fake widget</h1>' }] } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
