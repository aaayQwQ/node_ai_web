'use strict';

const dns = require('dns');
const net = require('net');

function isPublicIPv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const a = p[0], b = p[1], c = p[2];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6) return false;
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fc') ||
      value.startsWith('fd') || value.startsWith('fe8') ||
      value.startsWith('fe9') || value.startsWith('fea') ||
      value.startsWith('feb') || value.startsWith('ff') ||
      value.startsWith('2001:db8:')) return false;
  const first = parseInt(value.split(':')[0] || '0', 16);
  return (first & 0xe000) === 0x2000;
}

function lookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!Array.isArray(addresses) || !addresses.length) {
      return callback(new Error('目标域名没有可用的 DNS 地址。'));
    }
    if (process.env.NODE_AI_WEB_ALLOW_PRIVATE_UPSTREAM !== 'true' &&
        addresses.some(item => !isPublicAddress(item.address))) {
      return callback(new Error('安全策略阻止访问私有、回环、链路本地或保留 IP 地址。'));
    }
    let selected = addresses;
    if (options.family) selected = selected.filter(item => item.family === options.family);
    if (!selected.length) return callback(new Error('目标域名没有匹配的 IP 地址。'));
    if (options.all) return callback(null, selected);
    callback(null, selected[0].address, selected[0].family);
  });
}

module.exports = { lookup, isPublicAddress };
