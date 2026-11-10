'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const createMCPManager = require('../src/mcp_client');

async function main() {
  const previousPrivateSetting = process.env.NODE_AI_WEB_ALLOW_PRIVATE_UPSTREAM;
  process.env.NODE_AI_WEB_ALLOW_PRIVATE_UPSTREAM = 'true';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-ai-mcp-test-'));
  const requests = [];
  const diagnostics = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const message = body ? JSON.parse(body) : {};
      requests.push({ method: req.method, headers: req.headers, message });

      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      let result;
      if (message.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'test-session');
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'hello', description: 'Test tool', inputSchema: { type: 'object', properties: {} } }] };
      } else if (message.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'hello from MCP' }] };
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'unknown method' }));
        return;
      }

      // Exercise a complete JSON response whose TCP connection stays open.
      // The client must resolve as soon as the JSON-RPC object is complete.
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        return;
      }

      // Streamable HTTP may also return a request-scoped SSE response.
      // Send the matching JSON-RPC event but deliberately keep the stream open.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message\\ndata: ' + JSON.stringify({
        jsonrpc: '2.0', id: message.id, result
      }) + '\\n\\n');
    });
  });

  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    fs.writeFileSync(path.join(root, 'config', 'mcp-servers.json'), JSON.stringify({
      mcpServers: {
        mcd_mcp_server: {
          type: 'streamable_http',
          url: 'http://127.0.0.1:' + address.port + '/mcp'
        }
      }
    }));

    const manager = createMCPManager(root, (level, message) => {
      diagnostics.push(level + ': ' + message);
    });
    const tools = await manager.listTools();
    assert.strictEqual(tools.length, 1, 'tool discovery should return one tool. Diagnostics: ' + diagnostics.join(' | '));
    assert.strictEqual(tools[0].function.name, 'mcd_mcp_server__hello');

    const result = await manager.callTool(tools[0].function.name, {});
    assert.strictEqual(result.content[0].text, 'hello from MCP');

    const initialize = requests.find(item => item.message.method === 'initialize');
    const toolList = requests.find(item => item.message.method === 'tools/list');
    const toolCall = requests.find(item => item.message.method === 'tools/call');
    assert(initialize, 'initialize request should be sent');
    assert(toolList, 'tools/list request should be sent');
    assert(toolCall, 'tools/call request should be sent');
    assert.strictEqual(toolList.headers['mcp-session-id'], 'test-session');
    assert.strictEqual(toolCall.headers['mcp-session-id'], 'test-session');
    assert.strictEqual(toolList.headers['mcp-protocol-version'], '2024-11-05');
    console.log('MCP Streamable HTTP tests passed.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { fs.rmdirSync(root, { recursive: true }); } catch (_) {}
    if (previousPrivateSetting === undefined) delete process.env.NODE_AI_WEB_ALLOW_PRIVATE_UPSTREAM;
    else process.env.NODE_AI_WEB_ALLOW_PRIVATE_UPSTREAM = previousPrivateSetting;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
