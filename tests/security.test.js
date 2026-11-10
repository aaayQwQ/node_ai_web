'use strict';

const assert = require('assert');
const ssrf = require('../src/ssrf');

const blocked = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '::1',
  'fc00::1',
  'fd12::1',
  'fe80::1',
  '2001:db8::1'
];

const allowed = [
  '1.1.1.1',
  '8.8.8.8',
  '2606:4700:4700::1111'
];

blocked.forEach(address => {
  assert.strictEqual(ssrf.isPublicAddress(address), false, 'must block ' + address);
});
allowed.forEach(address => {
  assert.strictEqual(ssrf.isPublicAddress(address), true, 'must allow ' + address);
});

console.log('Security address tests passed: ' + (blocked.length + allowed.length) + ' cases.');
