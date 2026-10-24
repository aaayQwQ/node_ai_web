'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function createLogger(root) {
  const directory = path.join(root, 'logs');

  function log(level, message) {
    fs.mkdirSync(directory, { recursive: true });

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const safeMessage = String(message)
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]');
    const line = '[' + now.toISOString() + '] [' + level + '] '
      + safeMessage + '\n';

    try {
      fs.appendFileSync(path.join(directory, day + '.log'), line, 'utf8');

      const files = fs.readdirSync(directory)
        .filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort();

      while (files.length > 14) {
        fs.unlinkSync(path.join(directory, files.shift()));
      }
    } catch (error) {
      console.error('Log write failed: ' + error.message);
    }
  }

  return log;
};
