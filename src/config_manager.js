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
    next.customHeaders = next.customHeaders && typeof next.customHeaders === 'object' && !Array.isArray(next.customHeaders) ? next.customHeaders : {};
    next.temperature = Number.isFinite(Number(next.temperature))
      ? Math.min(2, Math.max(0, Number(next.temperature)))
      : 0.7;
    next.enabledPlugins = Array.isArray(next.enabledPlugins)
      ? next.enabledPlugins.filter(item => typeof item === 'string')
      : [];

    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  return { read, write, file };
};
