'use strict';

const assert = require('assert');
const proxy = require('../src/proxy');

const cases = [
  {
    input: 'https://api.example.com',
    normalized: 'https://api.example.com/',
    chat: 'https://api.example.com/v1/chat/completions',
    models: 'https://api.example.com/v1/models'
  },
  {
    input: 'https://api.example.com/v1',
    normalized: 'https://api.example.com/v1',
    chat: 'https://api.example.com/v1/chat/completions',
    models: 'https://api.example.com/v1/models'
  },
  {
    input: 'https://api.example.com/v1/',
    normalized: 'https://api.example.com/v1',
    chat: 'https://api.example.com/v1/chat/completions',
    models: 'https://api.example.com/v1/models'
  },
  {
    input: 'https://api.example.com/custom/v1',
    normalized: 'https://api.example.com/custom/v1',
    chat: 'https://api.example.com/custom/v1/chat/completions',
    models: 'https://api.example.com/custom/v1/models'
  },
  {
    input: 'https://api.example.com/v1/v1',
    normalized: 'https://api.example.com/v1',
    chat: 'https://api.example.com/v1/chat/completions',
    models: 'https://api.example.com/v1/models'
  },
  {
    input: 'https://api.example.com/v1/chat/completions',
    normalized: 'https://api.example.com/v1',
    chat: 'https://api.example.com/v1/chat/completions',
    models: 'https://api.example.com/v1/models'
  },
  {
    input: 'https://api.example.com/v1/models',
    normalized: 'https://api.example.com/v1',
    chat: 'https://api.example.com/v1/chat/completions',
    models: 'https://api.example.com/v1/models'
  }
];

for (const testCase of cases) {
  assert.strictEqual(
    proxy.normalizeBaseURL(testCase.input).href,
    testCase.normalized,
    'Base URL normalization: ' + testCase.input
  );

  assert.strictEqual(
    proxy.endpointURL(testCase.input, '/v1/chat/completions').href,
    testCase.chat,
    'Chat endpoint: ' + testCase.input
  );

  assert.strictEqual(
    proxy.endpointURL(testCase.input, '/v1/models').href,
    testCase.models,
    'Models endpoint: ' + testCase.input
  );
}

assert.throws(() => proxy.normalizeBaseURL(''), /Base URL/);
assert.throws(() => proxy.normalizeBaseURL('file:///tmp/api'), /http/);

console.log('Base URL tests passed: ' + cases.length + ' cases.');
