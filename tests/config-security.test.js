'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createConfigManager = require('../src/config_manager');

const previousMasterKey = process.env.NODE_AI_WEB_MASTER_KEY;
process.env.NODE_AI_WEB_MASTER_KEY = 'test-only-master-key-for-config-tests';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-ai-config-test-'));
try {
  const directory = path.join(root, 'config');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    host: '127.0.0.1',
    port: 3001,
    apiKey: 'plain-api-secret',
    webPassword: 'plain-web-password',
    customHeaders: { 'X-API-Key': 'plain-header-secret' },
    providers: [{
      id: 'test',
      name: 'Test',
      baseURL: 'https://api.example.com',
      apiKey: 'plain-provider-secret',
      customHeaders: { Authorization: 'Bearer plain-provider-header' }
    }]
  }));

  const manager = createConfigManager(root);
  const loaded = manager.read();
  assert.strictEqual(loaded.apiKey, 'plain-api-secret');
  assert.strictEqual(loaded.webPassword, 'plain-web-password');
  assert.strictEqual(loaded.providers[0].apiKey, 'plain-provider-secret');

  const stored = fs.readFileSync(file, 'utf8');
  assert(stored.indexOf('secretsEncrypted') !== -1);
  assert.strictEqual(stored.indexOf('plain-api-secret'), -1);
  assert.strictEqual(stored.indexOf('plain-web-password'), -1);
  assert.strictEqual(stored.indexOf('plain-provider-secret'), -1);
  assert.strictEqual(stored.indexOf('plain-header-secret'), -1);

  manager.write({ model: 'test-model' });
  const reloaded = manager.read();
  assert.strictEqual(reloaded.apiKey, 'plain-api-secret');
  assert.strictEqual(reloaded.providers[0].apiKey, 'plain-provider-secret');
  assert.strictEqual(reloaded.model, 'test-model');
  console.log('Configuration encryption tests passed.');
} finally {
  try { fs.rmdirSync(root, { recursive: true }); } catch (_) {}
  if (previousMasterKey === undefined) delete process.env.NODE_AI_WEB_MASTER_KEY;
  else process.env.NODE_AI_WEB_MASTER_KEY = previousMasterKey;
}
