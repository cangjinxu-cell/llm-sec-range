'use strict';

const assert = require('node:assert/strict');
const harness = require('../src/main/harness');

const tokenUrl = 'http://127.0.0.1:62070/?token=abc';
assert.equal(harness.coerceNavigationUrl(tokenUrl), tokenUrl);
assert.equal(harness.coerceNavigationUrl(new URL(tokenUrl)), tokenUrl);
assert.equal(tokenUrl.href, undefined);
assert.equal(harness.coerceNavigationUrl('   '), undefined);
assert.equal(harness.coerceNavigationUrl(undefined), undefined);

const fromStderr = harness.parseAuthUrl('booting\ndsh web: http://127.0.0.1:43123/?token=xyz\n');
assert.ok(fromStderr);
assert.equal(fromStderr.href, 'http://127.0.0.1:43123/?token=xyz');

console.log('REGRESSIONS=PASS');
