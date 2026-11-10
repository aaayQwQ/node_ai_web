'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function createLogger(root) {
  const directory = path.join(root, 'logs');

  function redact(value) {
    return String(value)
      .replace(/(authorization|x-api-key|api[-_]?key|webPassword|password|token|secret)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]');
  }

  function log(level, message) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch (_) {}

    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const safeMessage = redact(message);
    const line = '[' + now.toISOString() + '] [' + level + '] '
      + safeMessage + '\n';

    try {
      const logFile = path.join(directory, day + '.log');
      fs.appendFileSync(logFile, line, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(logFile, 0o600); } catch (_) {}

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
