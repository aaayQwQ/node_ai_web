'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

module.exports = function createConfigManager(root) {
  const file = path.join(root, 'config', 'config.json');
  const keyDirectory = path.join(os.homedir(), '.node-ai-web');
  const keyFile = path.join(keyDirectory, 'master.key');

  function masterKey() {
    if (process.env.NODE_AI_WEB_MASTER_KEY) {
      return crypto.createHash('sha256')
        .update(process.env.NODE_AI_WEB_MASTER_KEY, 'utf8')
        .digest();
    }

    fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(keyDirectory, 0o700); } catch (_) {}

    if (!fs.existsSync(keyFile)) {
      const generated = crypto.randomBytes(32);
      try {
        fs.writeFileSync(keyFile, generated, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }

    const stat = fs.lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('主密钥文件无效。');
    }
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error('主密钥文件长度无效。');
    try { fs.chmodSync(keyFile, 0o600); } catch (_) {}
    return key;
  }

  function encryptValue(value, key) {
    if (typeof value !== 'string' || !value) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final()
    ]);
    return {
      __nodeAiEncrypted: true,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  function decryptValue(value, key) {
    if (!value || typeof value !== 'object' || value.__nodeAiEncrypted !== true) {
      return value;
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(value.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  function transformSecrets(configValue, transform, key) {
    const result = Object.assign({}, configValue);

    ['apiKey', 'webPassword'].forEach(name => {
      if (Object.prototype.hasOwnProperty.call(result, name)) {
        result[name] = transform(result[name], key);
      }
    });

    result.providers = Array.isArray(result.providers)
      ? result.providers.map(provider => {
        const item = Object.assign({}, provider);
        if (Object.prototype.hasOwnProperty.call(item, 'apiKey')) {
          item.apiKey = transform(item.apiKey, key);
        }
        if (item.customHeaders && typeof item.customHeaders === 'object') {
          item.customHeaders = Object.assign({}, item.customHeaders);
          Object.keys(item.customHeaders).forEach(name => {
            if (/authorization|auth|token|secret|api[-_]?key|password/i.test(name)) {
              item.customHeaders[name] = transform(item.customHeaders[name], key);
            }
          });
        }
        return item;
      })
      : result.providers;

    if (result.customHeaders && typeof result.customHeaders === 'object') {
      result.customHeaders = Object.assign({}, result.customHeaders);
      Object.keys(result.customHeaders).forEach(name => {
        if (/authorization|auth|token|secret|api[-_]?key|password/i.test(name)) {
          result.customHeaders[name] = transform(result.customHeaders[name], key);
        }
      });
    }

    return result;
  }

  function persistEncrypted(value, key) {
    const stored = transformSecrets(value, encryptValue, key);
    stored.secretsEncrypted = true;
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.migrate-' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', {
      mode: 0o600
    });
    try { fs.chmodSync(temporary, 0o600); } catch (_) {}
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  }

  function read() {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = masterKey();
    if (stored.secretsEncrypted === true) {
      return transformSecrets(stored, decryptValue, key);
    }
    // One-time migration of existing plaintext credentials.
    persistEncrypted(stored, key);
    return stored;
  }

  function write(value) {
    const current = read();
    const next = Object.assign({}, current, value);

    next.port = Number(next.port) || 3001;
    next.topP = Number.isFinite(Number(next.topP))
      ? Math.min(1, Math.max(0, Number(next.topP))) : 1;
    next.maxTokens = Math.max(1, Math.min(200000, Number(next.maxTokens) || 4096));
    next.contextWindow = Math.max(1, Math.min(100, Number(next.contextWindow) || 20));
    next.mcpAutoApprove = next.mcpAutoApprove === true;

    next.customHeaders = next.customHeaders &&
      typeof next.customHeaders === 'object' && !Array.isArray(next.customHeaders)
      ? Object.fromEntries(Object.entries(next.customHeaders).filter(([name, headerValue]) =>
        /^[A-Za-z0-9-]{1,80}$/.test(name) &&
        typeof headerValue === 'string' &&
        headerValue.length <= 4000 &&
        !/[\r\n]/.test(headerValue)))
      : {};

    next.temperature = Number.isFinite(Number(next.temperature))
      ? Math.min(2, Math.max(0, Number(next.temperature))) : 0.7;

    next.providers = Array.isArray(next.providers)
      ? next.providers.filter(item =>
        item && typeof item.id === 'string' && typeof item.name === 'string')
        .map(item => ({
          id: item.id.slice(0, 80),
          name: item.name.slice(0, 120),
          baseURL: String(item.baseURL || '').slice(0, 2000),
          apiKey: String(item.apiKey || ''),
          model: String(item.model || '').slice(0, 300),
          customHeaders: item.customHeaders &&
            typeof item.customHeaders === 'object' && !Array.isArray(item.customHeaders)
            ? Object.fromEntries(Object.entries(item.customHeaders).filter(([name, headerValue]) =>
              /^[A-Za-z0-9-]{1,80}$/.test(name) &&
              typeof headerValue === 'string' &&
              headerValue.length <= 4000 &&
              !/[\r\n]/.test(headerValue)))
            : {}
        }))
      : [];

    next.selectedModels = Array.isArray(next.selectedModels)
      ? next.selectedModels.filter(item =>
        item && typeof item.providerId === 'string' && typeof item.modelId === 'string')
        .map(item => ({
          providerId: item.providerId.slice(0, 80),
          modelId: item.modelId.slice(0, 300),
          enabled: item.enabled !== false
        }))
      : [];

    next.enabledPlugins = Array.isArray(next.enabledPlugins)
      ? next.enabledPlugins.filter(item => typeof item === 'string')
      : [];

    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.tmp-' + process.pid;
    const stored = transformSecrets(next, encryptValue, masterKey());
    stored.secretsEncrypted = true;
    fs.writeFileSync(temporary, JSON.stringify(stored, null, 2) + '\n', {
      mode: 0o600
    });
    try { fs.chmodSync(temporary, 0o600); } catch (_) {}
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    return next;
  }

  return { read, write, file };
};
