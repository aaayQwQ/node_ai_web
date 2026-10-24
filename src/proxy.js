'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function normalizeBaseURL(value) {
  const input = String(value || '').trim();

  if (!input) {
    throw new Error('请先填写 API Base URL。');
  }

  const parsed = new URL(input);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 只支持 http:// 或 https://。');
  }

  if (parsed.username || parsed.password) {
    throw new Error('请不要把账号或密码放在 Base URL 里。');
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');

  // 允许粘贴常见的完整 API 路径，并把它还原成 API 根地址。
  parsed.pathname = parsed.pathname
    .replace(/\/v1\/v1$/i, '/v1')
    .replace(/\/(chat\/completions|models|embeddings)$/i, '')
    .replace(/\/v1\/(chat\/completions|models|embeddings)$/i, '/v1')
    .replace(/\/+$/, '');

  return parsed;
}

function endpointURL(baseURL, endpoint) {
  const base = normalizeBaseURL(baseURL);
  let route = '/' + String(endpoint || '').replace(/^\/+/, '');
  const basePath = base.pathname.replace(/\/+$/, '');

  // Base URL 末尾已经有 /v1 时，不再拼第二次 /v1。
  if (/\/v1$/i.test(basePath)) {
    route = route.replace(/^\/v1(?=\/|$)/i, '');
  }

  base.pathname = (basePath + route).replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base;
}

function request(urlValue, options, body, timeout) {
  return new Promise((resolve, reject) => {
    let parsed;

    try {
      parsed = urlValue instanceof URL ? urlValue : new URL(urlValue);
    } catch (error) {
      reject(new Error('无效的上游 URL：' + error.message));
      return;
    }

    const transport = parsed.protocol === 'http:' ? http : https;
    const requestOptions = {
      method: options.method || 'GET',
      headers: Object.assign({}, options.headers || {})
    };

    const req = transport.request(parsed, requestOptions, response => {
      const chunks = [];

      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const statusCode = response.statusCode || 502;

        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(
            '上游 HTTP ' + statusCode + ' (' + parsed.href + ')：'
            + (text.slice(0, 1200) || response.statusMessage || '无错误详情')
          );
          error.status = statusCode;
          error.url = parsed.href;
          reject(error);
          return;
        }

        resolve({
          statusCode,
          headers: response.headers,
          body: text,
          url: parsed.href
        });
      });

      response.on('error', reject);
    });

    req.setTimeout(timeout || 120000, () => {
      req.destroy(new Error('上游请求超时：' + parsed.href));
    });

    req.on('error', reject);

    if (body !== undefined && body !== null) {
      req.write(body);
    }

    req.end();
  });
}

function authHeaders(apiKey, extra) {
  const headers = Object.assign({}, extra || {});
  if (apiKey) {
    headers.Authorization = 'Bearer ' + apiKey;
  }
  return headers;
}

async function json(urlValue, headers, body, timeout) {
  const result = await request(urlValue, {
    method: body === undefined || body === null ? 'GET' : 'POST',
    headers: authHeaders('', headers)
  }, body, timeout || 30000);

  try {
    return JSON.parse(result.body);
  } catch (_) {
    const error = new Error(
      '上游返回的不是 JSON。请求地址：' + result.url
      + '；响应内容：' + result.body.slice(0, 500)
    );
    error.status = 502;
    throw error;
  }
}

async function check(baseURL, apiKey) {
  const target = endpointURL(baseURL, '/v1/models');
  const result = await request(target, {
    method: 'GET',
    headers: authHeaders(apiKey, { Accept: 'application/json' })
  }, null, 15000);

  return {
    url: result.url,
    statusCode: result.statusCode,
    body: result.body
  };
}

async function chat(config, payload, clientResponse, signal, log) {
  const target = endpointURL(config.baseURL, '/v1/chat/completions');
  const headers = authHeaders(config.apiKey, {
    'Content-Type': 'application/json',
    Accept: payload.stream ? 'text/event-stream' : 'application/json'
  });
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const parsed = target;
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.request(parsed, {
      method: 'POST',
      headers
    }, upstream => {
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const chunks = [];

        upstream.on('data', chunk => chunks.push(chunk));
        upstream.on('end', () => {
          const detail = Buffer.concat(chunks).toString('utf8').slice(0, 1200);
          const error = new Error(
            '上游 HTTP ' + upstream.statusCode + ' (' + parsed.href + ')：'
            + (detail || upstream.statusMessage || '无错误详情')
          );
          error.status = upstream.statusCode || 502;
          error.url = parsed.href;
          reject(error);
        });
        return;
      }

      if (!payload.stream) {
        upstream.pipe(clientResponse);
        upstream.on('end', resolve);
        upstream.on('error', reject);
        clientResponse.on('error', reject);
        clientResponse.writeHead(upstream.statusCode || 200, {
          'Content-Type': upstream.headers['content-type'] || 'application/json',
          'Cache-Control': 'no-store'
        });
        return;
      }

      clientResponse.writeHead(upstream.statusCode || 200, {
        'Content-Type': upstream.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      upstream.on('data', chunk => {
        if (!clientResponse.destroyed) {
          clientResponse.write(chunk);
        }
      });
      upstream.on('end', () => {
        if (!clientResponse.destroyed) {
          clientResponse.end();
        }
        resolve();
      });
      upstream.on('error', error => {
        log('ERROR', '流式响应中断：' + error.message);
        if (!clientResponse.destroyed) {
          clientResponse.end();
        }
        reject(error);
      });

      if (signal) {
        signal.onAbort = () => {
          req.destroy();
          upstream.destroy();
        };
      }
    });

    req.setTimeout(120000, () => {
      req.destroy(new Error('上游聊天请求超时：' + parsed.href));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  normalizeBaseURL,
  endpointURL,
  request,
  json,
  check,
  chat
};
