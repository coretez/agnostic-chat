'use strict';

// A minimal fake MCP server for testing the stdio client: answers `initialize`
// and `tools/list` over newline-delimited JSON-RPC. Not a real server.

let buf = '';
const FAKE_TOOLS = [
  { name: 'echo', description: 'Echo back the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'search_docs', description: 'Search project documents', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }
];

function fakeToolCall(message) {
  const { name, arguments: args = {} } = message.params || {};
  if (name === 'echo') return `echo: ${args.text}`;
  if (name === 'add') return String((args.a || 0) + (args.b || 0));
  return `ran ${name}`;
}

function handleFakeRequest(message) {
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } });
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: FAKE_TOOLS } });
  else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: fakeToolCall(message) }] } });
  else if (message.method === 'resources/list') send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'ui://fake/panel', name: 'Panel', mimeType: 'text/html' }] } });
  else if (message.method === 'resources/read') {
    const uri = (message.params || {}).uri;
    send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri, mimeType: 'text/html', text: '<h1>fake widget</h1>' }] } });
  } else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
}

function handleInputChunk(chunk) {
  buf += chunk;
  let newline;
  while ((newline = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, newline); buf = buf.slice(newline + 1);
    if (!line.trim()) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    handleFakeRequest(message);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', handleInputChunk);
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
