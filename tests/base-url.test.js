'use strict';

const assert = require('assert');
const proxy = require('../src/proxy');

const cases = [
  {
    input: 'https://api.example.com',
    expected: 'https://api.example.com/v1'
  },
  {
    input: 'https://api.example.com/v1',
    expected: 'https://api.example.com/v1'
  },
  {
    input: 'https://api.example.com/v1/',
    expected: 'https://api.example.com/v1'
  },
  {
    input: 'https://api.example.com/custom/v1',
    expected: 'https://api.example.com/custom/v1'
  },
  {
    input: 'https://api.example.com/v1/v1',
    expected: 'https://api.example.com/v1'
  },
  {
    input: 'https://api.example.com/v1/chat/completions',
    expected: 'https://api.example.com/v1'
  },
  {
    input: 'https://api.example.com/v1/models',
    expected: 'https://api.example.com/v1'
  }
];

for (const testCase of cases) {
  assert.strictEqual(
    proxy.normalizeBaseURL(testCase.input).href,
    testCase.expected,
    'Base URL normalization: ' + testCase.input
  );

  assert.strictEqual(
    proxy.endpointURL(testCase.input, '/v1/chat/completions').href,
    testCase.expected + '/chat/completions',
    'Chat endpoint: ' + testCase.input
  );

  assert.strictEqual(
    proxy.endpointURL(testCase.input, '/v1/models').href,
    testCase.expected + '/models',
    'Models endpoint: ' + testCase.input
  );
}

assert.throws(() => proxy.normalizeBaseURL(''), /Base URL/);
assert.throws(() => proxy.normalizeBaseURL('file:///tmp/api'), /http/);

console.log('Base URL tests passed: ' + cases.length + ' cases.');
