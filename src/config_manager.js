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
