import assert from 'node:assert/strict';
import { test } from 'node:test';

import { internalAccess } from '../src/internal-auth.js';

const TOKEN = 'a-long-random-token-0123456789';
const auth = (value) => ({ authorization: value });

test('with no token configured the control routes do not exist', () => {
  assert.equal(internalAccess(auth(`Bearer ${TOKEN}`), ''), 'disabled');
  assert.equal(internalAccess(auth('Bearer '), undefined), 'disabled');
});

test('the right token on a direct local call is let in', () => {
  assert.equal(internalAccess(auth(`Bearer ${TOKEN}`), TOKEN), 'ok');
});

test('a wrong, missing or differently sized token is denied', () => {
  assert.equal(internalAccess(auth('Bearer nope'), TOKEN), 'denied');
  assert.equal(internalAccess(auth(`Bearer ${TOKEN}x`), TOKEN), 'denied');
  assert.equal(internalAccess({}, TOKEN), 'denied');
});

test('anything that came through the proxy is refused, even with the right token', () => {
  assert.equal(internalAccess({ ...auth(`Bearer ${TOKEN}`), 'x-forwarded-for': '203.0.113.9' }, TOKEN), 'outside');
  assert.equal(internalAccess({ ...auth(`Bearer ${TOKEN}`), 'x-real-ip': '203.0.113.9' }, TOKEN), 'outside');
});
