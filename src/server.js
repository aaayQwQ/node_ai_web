'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const makeConfig = require('./config_manager');
const makeLogger = require('./logger');
const makePlugins = require('./plugin_engine');
const proxy = require('./proxy');

function start(root) {
  const config = makeConfig(root);
  const log = makeLogger(root);
  const plugins = makePlugins(root, config, log);
  const counts = new Map();
  const historyFile = path.join(root, 'config', 'history.json');

  plugins.init();

  function send(res, status, obj) {
    if (res.writableEnded) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;

      req.on('data', chunk => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        body += chunk;
      });

      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (_) {
          reject(new Error('Invalid JSON'));
        }
      });

      req.on('error', reject);
    });
  }

  function authorized(req, cfg) {
    if (!cfg.webPassword) return true;
    const auth = req.headers.authorization || '';
    return auth === 'Bearer ' + cfg.webPassword ||
      req.headers['x-web-password'] === cfg.webPassword;
  }

  function rateAllowed(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (counts.get(ip) || []).filter(time => now - time < 60000);

    if (recent.length >= 60) {
      counts.set(ip, recent);
      return false;
    }

    recent.push(now);
    counts.set(ip, recent);
    return true;
  }

  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    let pathname;

    try {
      pathname = decodeURIComponent(parsed.pathname || '/');
    } catch (_) {
      return send(res, 400, { error: { message: 'Invalid URL path' } });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Web-Password',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
      });
      return res.end();
    }

    try {
      const cfg = config.read();

      if (pathname === '/health') {
        return send(res, 200, {
          ok: true,
          node: process.version,
          uptime: Math.floor(process.uptime()),
          memoryMB: Math.round(process.memoryUsage().rss / 1048576),
          plugins: plugins.list(),
          baseURL: cfg.baseURL,
          model: cfg.model
        });
      }

      if (
        (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) &&
        !authorized(req, cfg)
      ) {
        return send(res, 401, { error: { message: 'Unauthorized' } });
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        const safeConfig = Object.assign({}, cfg, {
          apiKey: cfg.apiKey ? '••••••••' + cfg.apiKey.slice(-4) : ''
        });
        return send(res, 200, safeConfig);
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const previous = config.read();

        if (body.apiKey && /^•/.test(body.apiKey)) {
          body.apiKey = previous.apiKey;
        }

        config.write(Object.assign({}, previous, body));
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/history' && req.method === 'GET') {
        let history = [];
        try {
          history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        } catch (_) {}
        return send(res, 200, history);
      }

      if (pathname === '/api/history' && req.method === 'POST') {
        const history = await readBody(req);
        fs.writeFileSync(
          historyFile,
          JSON.stringify(Array.isArray(history) ? history : [], null, 2)
        );
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/plugins' && req.method === 'GET') {
        return send(res, 200, plugins.list());
      }

      if (
        pathname.startsWith('/api/plugins/') &&
        pathname.endsWith('/reload') &&
        req.method === 'POST'
      ) {
        const id = pathname.split('/')[3];
        try {
          return send(res, 200, plugins.reload(id));
        } catch (error) {
          return send(res, 400, { error: { message: error.message } });
        }
      }

      if (pathname === '/api/test' && req.method === 'POST') {
        const test = await readBody(req);
        const base = String(test.baseURL || cfg.baseURL || '').replace(/\/+$/, '');

        if (!/^https?:\/\//i.test(base)) {
          return send(res, 400, { error: { message: 'Invalid Base URL' } });
        }

        const startedAt = Date.now();
        const authHeaders = test.apiKey
          ? { Authorization: 'Bearer ' + test.apiKey }
          : (cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {});

        const result = await proxy.json(base + '/v1/models', authHeaders, null);
        return send(res, 200, {
          ok: true,
          rtt: Date.now() - startedAt,
          count: (result.data || []).length,
          models: result.data || []
        });
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        if (!cfg.baseURL) {
          return send(res, 400, { error: { message: 'Configure Base URL first' } });
        }

        const base = cfg.baseURL.replace(/\/+$/, '');
        const headers = cfg.apiKey
          ? { Authorization: 'Bearer ' + cfg.apiKey }
          : {};

        return send(res, 200, await proxy.json(base + '/v1/models', headers, null));
      }

      if (pathname === '/v1/embeddings' && req.method === 'POST') {
        const body = JSON.stringify(await readBody(req));
        const base = String(cfg.baseURL || '').replace(/\/+$/, '');
        const headers = { 'Content-Type': 'application/json' };

        if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

        return send(
          res,
          200,
          await proxy.json(base + '/v1/embeddings', headers, body)
        );
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        if (!rateAllowed(req)) {
          return send(res, 429, {
            error: { message: 'Rate limit exceeded (60 requests/minute)' }
          });
        }

        if (!cfg.baseURL || !cfg.apiKey) {
          return send(res, 400, {
            error: { message: 'Set Base URL and API key in Settings first' }
          });
        }

        const input = await readBody(req);
        const payload = Object.assign({
          model: cfg.model,
          temperature: cfg.temperature
        }, input);

        if (!Array.isArray(payload.messages)) {
          return send(res, 400, {
            error: { message: 'messages must be an array' }
          });
        }

        if (
          cfg.systemPrompt &&
          !payload.messages.some(message => message.role === 'system')
        ) {
          payload.messages.unshift({
            role: 'system',
            content: cfg.systemPrompt
          });
        }

        const context = {
          request: payload,
          config: { baseURL: cfg.baseURL, model: cfg.model }
        };

        plugins.hook('beforeRequest', context);

        const abort = {};
        res.on('close', () => {
          if (!res.writableEnded && abort.onAbort) abort.onAbort();
        });

        try {
          await proxy.chat(cfg, context.request, res, abort, log);
          plugins.hook('afterResponse', {
            request: context.request,
            status: res.statusCode
          });
        } catch (error) {
          log('ERROR', error.stack || error.message);

          if (!res.headersSent) {
            send(res, error.status || 502, {
              error: { message: error.message }
            });
          } else if (!res.writableEnded) {
            res.end();
          }

          plugins.hook('onRequestError', { error: error.message });
        }

        return;
      }

      if (pathname.startsWith('/api/plugin/')) {
        return send(res, 404, {
          error: { message: 'No custom action route registered' }
        });
      }

      const publicDir = path.resolve(root, 'public');
      const file = path.resolve(publicDir, pathname === '/' ? 'index.html' : '.' + pathname);

      if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
        return send(res, 403, { error: { message: 'Forbidden' } });
      }

      fs.readFile(file, (error, data) => {
        if (error) {
          return send(res, 404, { error: { message: 'Not found' } });
        }

        res.writeHead(200, {
          'Content-Type': mime[path.extname(file)] || 'application/octet-stream'
        });
        res.end(data);
      });
    } catch (error) {
      log('ERROR', error.stack || error.message);
      send(res, 400, { error: { message: error.message } });
    }
  });

  server.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch (_) {}
  });

  const initialConfig = config.read();
  const host = initialConfig.host || '127.0.0.1';
  const port = Number(initialConfig.port) || 3001;

  server.listen(port, host, () => {
    log('INFO', 'Listening on http://' + host + ':' + port);
    plugins.hook('onServerStart', { server });
  });

  process.on('uncaughtException', error => {
    log('FATAL', error.stack || error.message);
  });

  process.on('unhandledRejection', error => {
    log('ERROR', 'unhandled rejection: ' + error);
  });

  return server;
}

module.exports = { start };
