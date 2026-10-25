'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = __dirname;
const DIRECTORIES = [
  'config',
  'logs',
  'src',
  'public',
  'plugins/sys-prompt-injector',
  'scripts'
];

for (const directory of DIRECTORIES) {
  fs.mkdirSync(path.join(ROOT, directory), { recursive: true });
}

const configFile = path.join(ROOT, 'config', 'config.json');
const historyFile = path.join(ROOT, 'config', 'history.json');

if (!fs.existsSync(configFile)) {
  fs.writeFileSync(configFile, JSON.stringify({
    host: '127.0.0.1',
    port: 3001,
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: 'You are a helpful assistant.',
    webPassword: '',
    temperature: 0.7,
    topP: 1,
    maxTokens: 4096,
    contextWindow: 20,
    customHeaders: {},
    enabledPlugins: ['sys-prompt-injector']
  }, null, 2) + '\n');
}

if (!fs.existsSync(historyFile)) {
  fs.writeFileSync(historyFile, '[]\n');
}

if (process.argv.includes('--check')) {
  let config;

  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    console.log('Config JSON: OK');
  } catch (error) {
    console.error('Config JSON: FAIL - ' + error.message);
    process.exit(1);
  }

  console.log('Node.js: ' + process.version);

  if (!config.baseURL) {
    console.log('Upstream URL: not configured');
    process.exit(0);
  }

  const upstream = require('./src/proxy');
  upstream.check(config.baseURL, config.apiKey)
    .then(result => {
      console.log('Upstream URL: ' + result.url);
      console.log('Upstream HTTP: ' + result.statusCode);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        process.exitCode = 1;
      }
    })
    .catch(error => {
      console.error('Upstream check failed: ' + error.message);
      process.exitCode = 1;
    });
} else {
  require('./src/server').start(ROOT);
}
