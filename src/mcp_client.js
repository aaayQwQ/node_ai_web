'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const PROTOCOL_VERSION = '2024-11-05';
const TIMEOUT_MS = 15000;
const MAX_WS_MESSAGE = 2 * 1024 * 1024;

module.exports = function createMCPManager(root, log) {
  const file = path.join(root, 'config', 'mcp-servers.json');
  let nextId = 1;
  const httpSessions = new Map();

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function writeAll(servers) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(servers, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch (_) {}
    fs.renameSync(temporary, file);
  }

  function normalize(input, existing) {
    const value = Object.assign({}, existing || {}, input || {});
    value.id = String(value.id || ('mcp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)));
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(value.id) || value.id.includes('__')) throw new Error('MCP 服务 ID 只能包含字母、数字、下划线和连字符，且不能包含双下划线。');
    value.name = String(value.name || '自定义 MCP 服务').trim().slice(0, 100);
    value.type = String(value.type || 'http').toLowerCase();
    if (!['http', 'sse', 'websocket', 'stdio'].includes(value.type)) throw new Error('MCP 类型仅支持 HTTP、SSE、WebSocket、Stdio。');
    value.enabled = Boolean(value.enabled);
    value.approval = value.approval === 'auto' ? 'auto' : 'confirm';
    value.headers = value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers) ? value.headers : {};
    value.headers = Object.fromEntries(Object.entries(value.headers).filter(([k, v]) =>
      /^[a-zA-Z0-9-]{1,80}$/.test(k) && typeof v === 'string' && v.length <= 4000));
    value.timeout = Math.max(1000, Math.min(60000, Number(value.timeout) || TIMEOUT_MS));
    if (value.type === 'stdio') {
      value.command = String(value.command || '').trim().slice(0, 500);
      value.args = Array.isArray(value.args) ? value.args.map(x => String(x).slice(0, 500)).slice(0, 40) : [];
      value.env = value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env : {};
      if (!value.command) throw new Error('Stdio 服务必须填写 Command。');
      if (/[\r\n\0]/.test(value.command)) throw new Error('Command 含有非法字符。');
    } else {
      value.url = String(value.url || '').trim();
      if (!value.url) throw new Error('HTTP/SSE 服务必须填写 Endpoint URL。');
      const parsed = new URL(value.url);
      const allowedProtocols = value.type === 'websocket' ? ['ws:', 'wss:'] : value.type === 'sse' ? ['http:', 'https:'] : ['http:', 'https:'];
      if (!allowedProtocols.includes(parsed.protocol)) {
        throw new Error(value.type === 'websocket' ? 'WebSocket MCP URL 必须以 ws:// 或 wss:// 开头。' : 'HTTP/SSE MCP URL 只支持 HTTP 或 HTTPS。');
      }
      if (parsed.username || parsed.password) throw new Error('请勿将账号密码写在 URL 中。');
    }
    return value;
  }

  function publicServer(server) {
    const copy = Object.assign({}, server);
    copy.headers = Object.keys(copy.headers || {}).reduce((result, key) => {
      result[key] = /authorization|auth|token|secret|api[-_]?key/i.test(key) ? '••••••••' : copy.headers[key];
      return result;
    }, {});
    copy.env = Object.keys(copy.env || {}).reduce((result, key) => {
      result[key] = '••••••••';
      return result;
    }, {});
    return copy;
  }

  function list() {
    return readAll().map(publicServer);
  }

  function save(input) {
    const servers = readAll();
    const index = input && input.id ? servers.findIndex(item => item.id === input.id) : -1;
    const existing = index >= 0 ? servers[index] : null;
    const value = normalize(input, existing);
    if (existing) {
      for (const [key, headerValue] of Object.entries(value.headers || {})) {
        if (headerValue === '••••••••' && existing.headers && Object.prototype.hasOwnProperty.call(existing.headers, key)) {
          value.headers[key] = existing.headers[key];
        }
      }
      for (const [key, envValue] of Object.entries(value.env || {})) {
        if (envValue === '••••••••' && existing.env && Object.prototype.hasOwnProperty.call(existing.env, key)) {
          value.env[key] = existing.env[key];
        }
      }
    }
    if (servers.some(item => item.id === value.id && item !== existing)) throw new Error('MCP 服务 ID 重复。');
    if (index >= 0) servers[index] = value;
    else servers.unshift(value);
    writeAll(servers);
    httpSessions.delete(value.id);
    return publicServer(value);
  }

  function remove(id) {
    const servers = readAll();
    const next = servers.filter(item => item.id !== id);
    if (next.length === servers.length) throw new Error('找不到指定的 MCP 服务。');
    writeAll(next);
    httpSessions.delete(id);
    return { ok: true };
  }

  function get(id) {
    return readAll().find(item => item.id === id) || null;
  }

  function requestHTTP(urlValue, headers, body, timeout) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(urlValue); } catch (_) { reject(new Error('MCP URL 无效。')); return; }
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: Object.assign({ Accept: 'application/json, text/event-stream' }, headers || {},
          body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
            reject(new Error('MCP HTTP ' + res.statusCode + '：' + text.slice(0, 600)));
            return;
          }
          if (!text.trim()) { resolve({}); return; }
          if ((res.headers['content-type'] || '').includes('text/event-stream')) {
            const data = text.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trim()).filter(Boolean);
            for (const item of data.reverse()) {
              try { const parsed = JSON.parse(item); parsed._headers = res.headers; resolve(parsed); return; } catch (_) {}
            }
            reject(new Error('MCP SSE 响应中没有有效 JSON data。'));
            return;
          }
          try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object') parsed._headers = res.headers; resolve(parsed); }
          catch (_) { reject(new Error('MCP 服务返回了非 JSON 响应。')); }
        });
      });
      req.setTimeout(timeout || TIMEOUT_MS, () => req.destroy(new Error('MCP 请求超时。')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  function stdioCall(server, method, params) {
    return new Promise((resolve, reject) => {
      const env = Object.assign({}, process.env);
      for (const [key, value] of Object.entries(server.env || {})) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') env[key] = value;
      }
      const child = spawn(server.command, server.args || [], {
        env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
      const id = ++nextId;
      let buffer = '';
      let stderr = '';
      let settled = false;
      let requestSent = false;
      const timer = setTimeout(() => finish(new Error('MCP Stdio 请求超时。')), server.timeout || TIMEOUT_MS);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch (_) {}
        if (error) reject(error); else resolve(result);
      }
      child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString(); });
      child.on('error', error => finish(new Error('无法启动 MCP 命令：' + error.message)));
      child.on('close', code => {
        if (!settled) finish(new Error('MCP 进程提前退出 (' + code + ')。请检查命令、参数与服务端日志。'));
      });
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.length > 2 * 1024 * 1024) return finish(new Error('MCP Stdio 响应过大。'));
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch (_) { continue; }
          if (message.id === 1 && !requestSent) {
            if (message.error) {
              finish(new Error(message.error.message || 'MCP 初始化失败。'));
              return;
            }
            requestSent = true;
            child.stdin.write(next);
          } else if (message.id === id) {
            if (message.error) finish(new Error(message.error.message || 'MCP JSON-RPC 调用失败。'));
            else finish(null, message.result || {});
          }
        }
      });
      child.stdin.on('error', () => {});
      const init = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Node AI Web', version: '1.0.0' } }
      };
      const next = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
        + JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n';
      child.stdin.write(JSON.stringify(init) + '\n');
      // Wait for initialize response before sending requests.
      // Continue only after the server replies to initialize, as required by MCP.
    });
  }

  function sseRPC(server, method, params) {
    return new Promise((resolve, reject) => {
      const sourceURL = new URL(server.url);
      const transport = sourceURL.protocol === 'https:' ? https : http;
      const pending = new Map();
      let endpoint = null;
      let buffer = '';
      let eventName = '';
      let dataLines = [];
      let finished = false;
      let initStarted = false;
      const timeout = setTimeout(() => finish(new Error('MCP SSE 请求超时。')), server.timeout || TIMEOUT_MS);

      function finish(error, result) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        try { getReq.destroy(); } catch (_) {}
        if (error) reject(error); else resolve(result);
      }

      function handleMessage(message) {
        if (!message || message.jsonrpc !== '2.0') return;
        if (!pending.has(message.id)) return;
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || 'MCP JSON-RPC 错误。'));
        else waiter.resolve(message.result || {});
      }

      function post(methodName, requestParams, id) {
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          const payload = JSON.stringify({ jsonrpc: '2.0', id, method: methodName, params: requestParams || {} });
          requestHTTP(endpoint, server.headers, payload, server.timeout).then(response => {
            if (response && response.jsonrpc === '2.0') handleMessage(response);
            else if (response && response.result !== undefined && pending.has(id)) handleMessage({ jsonrpc: '2.0', id, result: response.result });
            // A 202 / empty body means the response will arrive on the SSE stream.
          }).catch(error => {
            if (pending.has(id)) {
              pending.delete(id);
              rej(error);
            }
          });
        });
      }

      async function initializeAndCall() {
        if (initStarted || !endpoint) return;
        initStarted = true;
        try {
          await post('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'Node AI Web', version: '1.0.0' }
          }, 1);
          const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
          await requestHTTP(endpoint, server.headers, notification, server.timeout).catch(() => ({}));
          const result = await post(method, params, 2);
          finish(null, result);
        } catch (error) {
          finish(error);
        }
      }

      const getReq = transport.request(sourceURL, {
        method: 'GET',
        headers: Object.assign({}, server.headers || {}, { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' })
      }, response => {
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          finish(new Error('MCP SSE HTTP ' + response.statusCode));
          return;
        }
        response.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            if (!line) {
              const data = dataLines.join('\n');
              if (eventName === 'endpoint' && data) {
                try { endpoint = new URL(data, sourceURL).href; } catch (_) {}
                initializeAndCall();
              } else if (data) {
                try { handleMessage(JSON.parse(data)); } catch (_) {}
              }
              eventName = '';
              dataLines = [];
            } else if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
        });
        response.on('error', error => finish(error));
        response.on('end', () => { if (!finished) finish(new Error('MCP SSE 连接提前关闭。')); });
      });
      getReq.setTimeout(server.timeout || TIMEOUT_MS, () => getReq.destroy(new Error('MCP SSE 连接超时。')));
      getReq.on('error', error => finish(error));
      getReq.end();
    });
  }


  // Minimal dependency-free WebSocket JSON-RPC transport for MCP endpoints.
  // The connection is opened per operation; initialize and the requested method
  // run on the same socket, which supports servers requiring a single WS session.
  function websocketRPC(server, method, params) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(server.url); } catch (_) { reject(new Error('WebSocket MCP URL 无效。')); return; }
      if (!['ws:', 'wss:'].includes(url.protocol)) {
        reject(new Error('WebSocket MCP URL 必须以 ws:// 或 wss:// 开头。'));
        return;
      }
      const secure = url.protocol === 'wss:';
      const port = Number(url.port || (secure ? 443 : 80));
      const key = crypto.randomBytes(16).toString('base64');
      const expectedAccept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const connectOptions = { host: url.hostname, port };
      if (secure) connectOptions.servername = url.hostname;
      const socket = secure ? tls.connect(connectOptions) : net.connect(connectOptions);
      let buffer = Buffer.alloc(0);
      let upgraded = false;
      let settled = false;
      let responseQueue = [];
      let responseWaiters = [];
      let nextRpcId = 1;
      let requestTimer;
      let fragmentOpcode = 0;
      let fragments = [];

      const timeout = Math.max(1000, Number(server.timeout) || TIMEOUT_MS);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(requestTimer);
        try { socket.destroy(); } catch (_) {}
        if (error) reject(error); else resolve(result);
      }
      function deliver(message) {
        const index = responseQueue.findIndex(item => item && item.id !== undefined);
        if (responseWaiters.length) responseWaiters.shift()(message);
        else responseQueue.push(message);
      }
      function waitMessage() {
        return new Promise((res, rej) => {
          if (responseQueue.length) { res(responseQueue.shift()); return; }
          if (settled) { rej(new Error('WebSocket MCP 连接已关闭。')); return; }
          responseWaiters.push(res);
        });
      }
      function sendFrame(opcode, payload) {
        if (socket.destroyed) throw new Error('WebSocket MCP 连接已关闭。');
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
        let header;
        if (data.length < 126) {
          header = Buffer.alloc(2);
          header[1] = 0x80 | data.length;
        } else if (data.length <= 0xffff) {
          header = Buffer.alloc(4);
          header[1] = 0x80 | 126;
          header.writeUInt16BE(data.length, 2);
        } else {
          header = Buffer.alloc(10);
          header[1] = 0x80 | 127;
          header.writeUInt32BE(0, 2);
          header.writeUInt32BE(data.length, 6);
        }
        header[0] = 0x80 | opcode;
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
        socket.write(Buffer.concat([header, mask, masked]));
      }
      function sendJSON(value) {
        sendFrame(1, JSON.stringify(value));
      }
      function rpcRequest(rpcMethod, rpcParams) {
        const id = nextRpcId++;
        sendJSON({ jsonrpc: '2.0', id, method: rpcMethod, params: rpcParams || {} });
        return waitMessage().then(message => {
          if (!message || message.id !== id) throw new Error('WebSocket MCP 返回了不匹配的 JSON-RPC 响应。');
          if (message.error) throw new Error(message.error.message || 'WebSocket MCP JSON-RPC 调用失败。');
          return message.result || {};
        });
      }
      function parseFrames() {
        while (buffer.length >= 2 && !settled) {
          const first = buffer[0], second = buffer[1];
          const fin = Boolean(first & 0x80);
          const opcode = first & 0x0f;
          const masked = Boolean(second & 0x80);
          let length = second & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2); offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            const high = buffer.readUInt32BE(2);
            const low = buffer.readUInt32BE(6);
            if (high > 0 || low > MAX_WS_MESSAGE) return finish(new Error('WebSocket MCP 消息超过 2 MB 限制。'));
            length = low; offset = 10;
          }
          const maskLength = masked ? 4 : 0;
          if (length > MAX_WS_MESSAGE) return finish(new Error('WebSocket MCP 消息超过 2 MB 限制。'));
          if (buffer.length < offset + maskLength + length) return;
          let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
          if (masked) {
            const mask = buffer.subarray(offset, offset + 4);
            const decoded = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) decoded[i] = payload[i] ^ mask[i & 3];
            payload = decoded;
          }
          buffer = buffer.subarray(offset + maskLength + length);
          if (opcode === 8) return finish(new Error('WebSocket MCP 服务关闭了连接。'));
          if (opcode === 9) { try { sendFrame(10, payload); } catch (_) {} continue; }
          if (opcode === 10) continue;
          if (opcode === 1 || opcode === 2) {
            fragmentOpcode = opcode;
            fragments = [payload];
          } else if (opcode === 0 && fragmentOpcode) {
            fragments.push(payload);
          } else continue;
          if (!fin) continue;
          const complete = Buffer.concat(fragments);
          fragmentOpcode = 0; fragments = [];
          if (opcode === 2) return finish(new Error('WebSocket MCP 返回了二进制消息，当前只支持 JSON 文本消息。'));
          let parsed;
          try { parsed = JSON.parse(complete.toString('utf8')); }
          catch (_) { return finish(new Error('WebSocket MCP 返回了无效的 JSON-RPC 消息。')); }
          if (parsed && parsed.id !== undefined) deliver(parsed);
        }
      }
      socket.setTimeout(timeout, () => finish(new Error('WebSocket MCP 请求超时。')));
      socket.on('error', error => finish(new Error('WebSocket MCP 连接失败：' + error.message)));
      socket.on('close', () => {
        if (!settled) finish(new Error('WebSocket MCP 连接意外关闭。'));
      });
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > 32768) finish(new Error('WebSocket MCP 握手响应过大。'));
            return;
          }
          const head = buffer.subarray(0, end).toString('latin1');
          const rest = buffer.subarray(end + 4);
          buffer = rest;
          const lines = head.split('\r\n');
          if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] || '')) {
            return finish(new Error('WebSocket MCP 握手失败：' + (lines[0] || '无 HTTP 状态')));
          }
          const responseHeaders = {};
          for (const line of lines.slice(1)) {
            const at = line.indexOf(':');
            if (at > 0) responseHeaders[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
          }
          if (responseHeaders['sec-websocket-accept'] !== expectedAccept) {
            return finish(new Error('WebSocket MCP 握手校验失败（Sec-WebSocket-Accept 不匹配）。'));
          }
          upgraded = true;
          parseFrames();
        } else parseFrames();
      });
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        const target = url.pathname + url.search || '/';
        const defaultPort = secure ? 443 : 80;
        const host = (url.hostname.includes(':') ? '[' + url.hostname + ']' : url.hostname)
          + (port === defaultPort ? '' : ':' + port);
        const headers = Object.assign({}, server.headers || {});
        const lines = [
          'GET ' + target + ' HTTP/1.1',
          'Host: ' + host,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: ' + key,
          'Sec-WebSocket-Version: 13'
        ];
        for (const [name, value] of Object.entries(headers)) {
          if (!/^[a-zA-Z0-9-]{1,80}$/.test(name) || /[\r\n]/.test(String(value))) continue;
          if (/^(host|upgrade|connection|sec-websocket-key|sec-websocket-version)$/i.test(name)) continue;
          lines.push(name + ': ' + value);
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n');
      });
      requestTimer = setTimeout(() => finish(new Error('WebSocket MCP 请求超时。')), timeout);
      (async () => {
        try {
          // Wait until the server completes the HTTP Upgrade handshake.
          while (!upgraded && !settled) await new Promise(r => setTimeout(r, 10));
          if (settled) return;
          const initialized = await rpcRequest('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'Node AI Web', version: '1.0.0' }
          });
          sendJSON({ jsonrpc: '2.0', method: 'notifications/initialized' });
          const result = await rpcRequest(method, params);
          finish(null, result);
        } catch (error) {
          finish(error);
        }
      })();
    });
  }

  async function rpc(server, method, params) {
    if (server.type === 'stdio') return stdioCall(server, method, params);
    if (server.type === 'sse') return sseRPC(server, method, params);
    if (server.type === 'websocket') return websocketRPC(server, method, params);

    let session = httpSessions.get(server.id);
    if (!session) {
      const initId = ++nextId;
      const initialized = await requestHTTP(server.url, server.headers, JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Node AI Web', version: '1.0.0' }
        }
      }), server.timeout);
      if (initialized && initialized.error) {
        throw new Error(initialized.error.message || 'MCP 初始化失败。');
      }
      const responseHeaders = initialized && initialized._headers ? initialized._headers : {};
      session = {
        id: responseHeaders['mcp-session-id'] || '',
        protocolVersion: initialized && initialized.result && initialized.result.protocolVersion
          ? initialized.result.protocolVersion : PROTOCOL_VERSION
      };
      httpSessions.set(server.id, session);
      const notifyHeaders = Object.assign({}, server.headers || {});
      if (session.id) notifyHeaders['Mcp-Session-Id'] = session.id;
      notifyHeaders['MCP-Protocol-Version'] = session.protocolVersion;
      await requestHTTP(server.url, notifyHeaders, JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      }), server.timeout).catch(() => ({}));
    }

    const headers = Object.assign({}, server.headers || {});
    if (session.id) headers['Mcp-Session-Id'] = session.id;
    headers['MCP-Protocol-Version'] = session.protocolVersion;
    const result = await requestHTTP(server.url, headers, JSON.stringify({
      jsonrpc: '2.0', id: ++nextId, method, params: params || {}
    }), server.timeout);
    if (result && result.error) throw new Error(result.error.message || 'MCP JSON-RPC 调用失败。');
    return result && result.result !== undefined ? result.result : result;
  }

  async function discover(id) {
    const server = get(id);
    if (!server) throw new Error('找不到指定的 MCP 服务。');
    if (!server.enabled) throw new Error('该 MCP 服务尚未启用。');
    const result = await rpc(server, 'tools/list', {});
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map(tool => ({
      serverId: server.id,
      serverName: server.name,
      approval: server.approval,
      type: 'function',
      function: {
        name: server.id + '__' + String(tool.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40),
        description: String(tool.description || '').slice(0, 2000),
        parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema : { type: 'object', properties: {} }
      },
      originalName: tool.name
    }));
  }

  async function listTools() {
    const servers = readAll().filter(server => server.enabled);
    const results = await Promise.all(servers.map(async server => {
      try { return await discover(server.id); }
      catch (error) {
        log('WARN', 'MCP 工具发现失败 [' + server.name + ']：' + error.message);
        return [];
      }
    }));
    return results.flat();
  }

  async function callTool(name, args) {
    const split = String(name || '').indexOf('__');
    if (split < 1) throw new Error('MCP 工具名称无效。');
    const serverId = name.slice(0, split);
    const server = get(serverId);
    if (!server || !server.enabled) throw new Error('MCP 服务不存在或已停用。');
    const registered = await discover(serverId);
    const selected = registered.find(tool => tool.function.name === name);
    if (!selected) throw new Error('找不到该 MCP 工具；请刷新工具列表后重试。');
    const result = await rpc(server, 'tools/call', { name: selected.originalName, arguments: args || {} });
    return result;
  }

  return { list, save, remove, get, listTools, discover, callTool };
};
