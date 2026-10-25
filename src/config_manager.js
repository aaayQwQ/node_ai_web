'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function createConfigManager(root) {
  const file = path.join(root, 'config', 'config.json');

  function read() {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function write(value) {
    const current = read();
    const next = Object.assign({}, current, value);

    next.port = Number(next.port) || 3001;
    next.topP = Number.isFinite(Number(next.topP)) ? Math.min(1, Math.max(0, Number(next.topP))) : 1;
    next.maxTokens = Math.max(1, Math.min(200000, Number(next.maxTokens) || 4096));
    next.contextWindow = Math.max(1, Math.min(100, Number(next.contextWindow) || 20));
    next.customHeaders = next.customHeaders && typeof next.customHeaders === 'object' && !Array.isArray(next.customHeaders)
      ? Object.fromEntries(Object.entries(next.customHeaders).filter(([key, value]) =>
        /^[A-Za-z0-9-]{1,80}$/.test(key) && typeof value === 'string' && value.length <= 4000 && !/[\r\n]/.test(value)))
      : {};
    next.temperature = Number.isFinite(Number(next.temperature))
      ? Math.min(2, Math.max(0, Number(next.temperature)))
      : 0.7;
    next.providers = Array.isArray(next.providers)
      ? next.providers.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
        .map(item => ({
          id: item.id.slice(0, 80),
          name: item.name.slice(0, 120),
          baseURL: String(item.baseURL || '').slice(0, 2000),
          apiKey: String(item.apiKey || ''),
          model: String(item.model || '').slice(0, 300),
          customHeaders: item.customHeaders && typeof item.customHeaders === 'object' && !Array.isArray(item.customHeaders)
            ? Object.fromEntries(Object.entries(item.customHeaders).filter(([key, value]) =>
              /^[A-Za-z0-9-]{1,80}$/.test(key) && typeof value === 'string' && value.length <= 4000 && !/[\\r\\n]/.test(value)))
            : {}
        }))
      : [];
    next.selectedModels = Array.isArray(next.selectedModels)
      ? next.selectedModels.filter(item => item && typeof item.providerId === 'string' && typeof item.modelId === 'string')
        .map(item => ({
          providerId: item.providerId.slice(0, 80),
          modelId: item.modelId.slice(0, 300),
          enabled: item.enabled !== false
        }))
      : [];
    next.enabledPlugins = Array.isArray(next.enabledPlugins)
      ? next.enabledPlugins.filter(item => typeof item === 'string')
      : [];

    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  return { read, write, file };
};
