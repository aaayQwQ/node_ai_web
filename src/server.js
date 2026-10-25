'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const createConfigManager = require('./config_manager');
const createLogger = require('./logger');
const createPluginEngine = require('./plugin_engine');
const proxy = require('./proxy');
const createMCPManager = require('./mcp_client');

function start(root) {
  const config = createConfigManager(root);
  const log = createLogger(root);
  const plugins = createPluginEngine(root, config, log);
  const mcp = createMCPManager(root, log);
  const requestCounts = new Map();
  const historyFile = path.join(root, 'config', 'history.json');

  plugins.init();

  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  function sendJSON(response, statusCode, data) {
    if (response.writableEnded || response.destroyed) return;

    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(data));
  }

  function readJSON(request, maxBytes = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];

      request.on('data', chunk => {
        size += chunk.length;

        if (size > maxBytes) {
          reject(Object.assign(new Error('请求体过大。'), { status: 413 }));
          request.destroy();
          return;
        }

        chunks.push(chunk);
      });

      request.on('end', () => {
        if (size === 0) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_) {
          reject(Object.assign(new Error('请求内容不是有效的 JSON。'), { status: 400 }));
        }
      });

      request.on('error', reject);
    });
  }

  function isAuthorized(request, currentConfig) {
    if (!currentConfig.webPassword) return true;

    const authorization = request.headers.authorization || '';
    return authorization === 'Bearer ' + currentConfig.webPassword
      || request.headers['x-web-password'] === currentConfig.webPassword;
  }

  function isRateAllowed(request) {
    const ip = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (requestCounts.get(ip) || [])
      .filter(timestamp => now - timestamp < 60000);

    if (recent.length >= 60) {
      requestCounts.set(ip, recent);
      return false;
    }

    recent.push(now);
    requestCounts.set(ip, recent);

    if (requestCounts.size > 1000) {
      for (const [key, values] of requestCounts) {
        if (!values.some(timestamp => now - timestamp < 60000)) {
          requestCounts.delete(key);
        }
      }
    }

    return true;
  }

  function safeConfig(currentConfig) {
    return Object.assign({}, currentConfig, {
      apiKey: '',
      customHeaders: Object.fromEntries(Object.entries(currentConfig.customHeaders || {}).map(([key, value]) => [
        key, /authorization|token|secret|api[-_]?key/i.test(key) ? '••••••••' : value
      ])),
      apiKeySet: Boolean(currentConfig.apiKey),
      apiKeyHint: currentConfig.apiKey
        ? '••••••••' + currentConfig.apiKey.slice(-4)
        : '',
      webPassword: '',
      webPasswordSet: Boolean(currentConfig.webPassword)
    });
  }

  async function handleAPI(request, response, pathname) {
    const currentConfig = config.read();

    if (
      (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) &&
      !isAuthorized(request, currentConfig)
    ) {
      sendJSON(response, 401, { error: { message: '网页访问密码不正确。' } });
      return true;
    }

    if (pathname === '/api/config' && request.method === 'GET') {
      sendJSON(response, 200, safeConfig(currentConfig));
      return true;
    }

    if (pathname === '/api/config' && request.method === 'POST') {
      const body = await readJSON(request);
      const update = Object.assign({}, body);

      // 空密钥代表保留原密钥；API Key 不会通过读取配置接口发回浏览器。
      if (!update.apiKey) {
        update.apiKey = currentConfig.apiKey;
      }

      // 密码输入框留空时保留原密码，避免保存其他设置时意外关闭访问保护。
      if (!update.webPassword) {
        update.webPassword = currentConfig.webPassword;
      }

      delete update.apiKeySet;
      delete update.apiKeyHint;

      if (update.customHeaders && typeof update.customHeaders === 'object') {
        const previous = currentConfig.customHeaders || {};
        for (const [key, value] of Object.entries(update.customHeaders)) {
          if (value === '••••••••' && Object.prototype.hasOwnProperty.call(previous, key)) {
            update.customHeaders[key] = previous[key];
          }
        }
      }

      const allowed = [
        'host',
        'port',
        'baseURL',
        'apiKey',
        'model',
        'systemPrompt',
        'webPassword',
        'temperature',
        'topP',
        'maxTokens',
        'contextWindow',
        'customHeaders',
        'enabledPlugins'
      ];
      const filtered = {};

      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(update, key)) {
          filtered[key] = update[key];
        }
      }

      const next = config.write(filtered);
      sendJSON(response, 200, {
        ok: true,
        config: safeConfig(next)
      });
      return true;
    }

    if (pathname === '/api/history' && request.method === 'GET') {
      try {
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        sendJSON(response, 200, Array.isArray(history) ? history : []);
      } catch (_) {
        sendJSON(response, 200, []);
      }
      return true;
    }

    if (pathname === '/api/history' && request.method === 'POST') {
      const history = await readJSON(request);

      if (!Array.isArray(history)) {
        sendJSON(response, 400, { error: { message: '历史记录必须是数组。' } });
        return true;
      }

      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');
      sendJSON(response, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/mcp/servers' && request.method === 'GET') {
      sendJSON(response, 200, mcp.list());
      return true;
    }

    if (pathname === '/api/mcp/servers' && request.method === 'POST') {
      const body = await readJSON(request);
      try {
        const saved = mcp.save(body);
        sendJSON(response, 200, { ok: true, server: saved });
      } catch (error) {
        sendJSON(response, 400, { error: { message: error.message } });
      }
      return true;
    }

    const mcpServerMatch = pathname.match(/^\/api\/mcp\/servers\/([a-zA-Z0-9_-]+)$/);
    if (mcpServerMatch && request.method === 'DELETE') {
      try { sendJSON(response, 200, mcp.remove(mcpServerMatch[1])); }
      catch (error) { sendJSON(response, 404, { error: { message: error.message } }); }
      return true;
    }

    const mcpDiscoverMatch = pathname.match(/^\/api\/mcp\/servers\/([a-zA-Z0-9_-]+)\/discover$/);
    if (mcpDiscoverMatch && request.method === 'POST') {
      try {
        const tools = await mcp.discover(mcpDiscoverMatch[1]);
        sendJSON(response, 200, { ok: true, tools });
      } catch (error) {
        sendJSON(response, 502, { error: { message: error.message } });
      }
      return true;
    }

    if (pathname === '/api/mcp/tools' && request.method === 'GET') {
      sendJSON(response, 200, await mcp.listTools());
      return true;
    }

    if (pathname === '/api/mcp/call' && request.method === 'POST') {
      const body = await readJSON(request);
      try {
        const serverId = String(body.name || '').split('__')[0];
        const serverInfo = mcp.get(serverId);
        if (!serverInfo || !serverInfo.enabled) throw new Error('MCP 服务不存在或已停用。');
        const result = await mcp.callTool(body.name, body.arguments || {});
        log('INFO', 'MCP 工具已执行：' + serverInfo.name + '/' + String(body.name).slice(serverId.length + 2));
        sendJSON(response, 200, { ok: true, result });
      } catch (error) {
        sendJSON(response, 400, { error: { message: error.message } });
      }
      return true;
    }

    if (pathname === '/api/plugins' && request.method === 'GET') {
      sendJSON(response, 200, plugins.list());
      return true;
    }

    const pluginMatch = pathname.match(/^\/api\/plugins\/([a-zA-Z0-9_-]+)\/(reload|enable|disable)$/);

    if (pluginMatch && request.method === 'POST') {
      const [, id, action] = pluginMatch;

      try {
        if (action === 'reload') {
          sendJSON(response, 200, plugins.reload(id));
        } else {
          sendJSON(response, 200, plugins.setEnabled(id, action === 'enable'));
        }
      } catch (error) {
        sendJSON(response, 400, { error: { message: error.message } });
      }

      return true;
    }

    if (pathname === '/api/test' && request.method === 'POST') {
      const body = await readJSON(request);
      const baseURL = body.baseURL || currentConfig.baseURL;
      const apiKey = body.apiKey || currentConfig.apiKey;

      try {
        const result = await proxy.check(baseURL, apiKey);
        let data;

        try {
          data = JSON.parse(result.body);
        } catch (_) {
          throw new Error('模型列表接口没有返回有效 JSON。地址：' + result.url);
        }

        sendJSON(response, 200, {
          ok: true,
          url: result.url,
          rtt: Date.now() - request.startedAt,
          count: Array.isArray(data.data) ? data.data.length : 0,
          models: Array.isArray(data.data) ? data.data : []
        });
      } catch (error) {
        sendJSON(response, error.status || 502, {
          error: {
            message: error.message,
            url: error.url || ''
          }
        });
      }

      return true;
    }

    if (pathname === '/health' && request.method === 'GET') {
      sendJSON(response, 200, {
        ok: true,
        node: process.version,
        uptime: Math.floor(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        pluginCount: plugins.list().length,
        configured: Boolean(currentConfig.baseURL && currentConfig.apiKey),
        model: currentConfig.model || ''
      });
      return true;
    }

    if (pathname === '/v1/models' && request.method === 'GET') {
      try {
        const result = await proxy.request(
          proxy.endpointURL(currentConfig.baseURL, '/v1/models'),
          {
            method: 'GET',
            headers: currentConfig.apiKey
              ? { Authorization: 'Bearer ' + currentConfig.apiKey }
              : {}
          },
          null,
          20000
        );

        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(result.body);
      } catch (error) {
        sendJSON(response, error.status || 502, {
          error: { message: error.message, url: error.url || '' }
        });
      }

      return true;
    }

    if (pathname === '/v1/embeddings' && request.method === 'POST') {
      if (!currentConfig.apiKey || !currentConfig.baseURL) {
        sendJSON(response, 400, {
          error: { message: '请先在设置中填写 Base URL 和 API Key。' }
        });
        return true;
      }

      const body = await readJSON(request);

      try {
        const result = await proxy.request(
          proxy.endpointURL(currentConfig.baseURL, '/v1/embeddings'),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + currentConfig.apiKey
            }
          },
          JSON.stringify(body),
          120000
        );

        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8'
        });
        response.end(result.body);
      } catch (error) {
        sendJSON(response, error.status || 502, {
          error: { message: error.message, url: error.url || '' }
        });
      }

      return true;
    }

    if (pathname === '/v1/chat/completions' && request.method === 'POST') {
      if (!isRateAllowed(request)) {
        sendJSON(response, 429, {
          error: { message: '请求过于频繁，请稍后再试。' }
        });
        return true;
      }

      if (!currentConfig.baseURL || !currentConfig.apiKey) {
        sendJSON(response, 400, {
          error: { message: '请先在设置中填写 Base URL 和 API Key。' }
        });
        return true;
      }

      const input = await readJSON(request);
      const payload = Object.assign({
        model: currentConfig.model,
        temperature: currentConfig.temperature,
        top_p: currentConfig.topP,
        max_tokens: currentConfig.maxTokens
      }, input);

      if (!Array.isArray(payload.messages)) {
        sendJSON(response, 400, {
          error: { message: 'messages 必须是数组。' }
        });
        return true;
      }

      if (
        currentConfig.systemPrompt &&
        !payload.messages.some(message => message && message.role === 'system')
      ) {
        payload.messages.unshift({
          role: 'system',
          content: currentConfig.systemPrompt
        });
      }

      const context = {
        request: payload,
        config: {
          baseURL: currentConfig.baseURL,
          model: currentConfig.model
        }
      };

      plugins.hook('beforeRequest', context);
      const abortSignal = {};

      response.on('close', () => {
        if (!response.writableEnded && abortSignal.onAbort) {
          abortSignal.onAbort();
        }
      });

      try {
        await proxy.chat(currentConfig, context.request, response, abortSignal, log);
        plugins.hook('afterResponse', {
          request: context.request,
          status: response.statusCode
        });
      } catch (error) {
        log('ERROR', error.stack || error.message);

        if (!response.headersSent) {
          sendJSON(response, error.status || 502, {
            error: {
              message: error.message,
              url: error.url || ''
            }
          });
        } else if (!response.writableEnded) {
          response.end();
        }

        plugins.hook('onRequestError', { error: error.message });
      }

      return true;
    }

    return false;
  }

  const server = http.createServer(async (request, response) => {
    request.startedAt = Date.now();

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch (_) {
      sendJSON(response, 400, { error: { message: '请求路径无效。' } });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Web-Password',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
      });
      response.end();
      return;
    }

    try {
      if (await handleAPI(request, response, pathname)) return;
    } catch (error) {
      log('ERROR', error.stack || error.message);

      if (!response.headersSent) {
        sendJSON(response, error.status || 500, {
          error: { message: error.message }
        });
      } else if (!response.writableEnded) {
        response.end();
      }
      return;
    }

    const publicDirectory = path.resolve(root, 'public');
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(publicDirectory, relativePath);

    if (file !== publicDirectory && !file.startsWith(publicDirectory + path.sep)) {
      sendJSON(response, 403, { error: { message: '禁止访问该路径。' } });
      return;
    }

    fs.readFile(file, (error, content) => {
      if (error) {
        sendJSON(response, 404, { error: { message: '找不到页面或静态文件。' } });
        return;
      }

      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300'
      });
      response.end(content);
    });
  });

  server.on('clientError', (_, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (_) {}
  });

  const initialConfig = config.read();
  const host = initialConfig.host || '127.0.0.1';
  const port = Number(initialConfig.port) || 3001;

  server.listen(port, host, () => {
    log('INFO', '服务已启动：http://' + host + ':' + port);
    plugins.hook('onServerStart', { server });
  });

  process.on('uncaughtException', error => {
    log('FATAL', error.stack || error.message);
  });

  process.on('unhandledRejection', error => {
    log('ERROR', '未处理的 Promise 异常：' + (error.stack || error.message || error));
  });

  return server;
}

module.exports = { start };
