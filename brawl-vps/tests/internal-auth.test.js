import assert from 'node:assert/strict';
import { test } from 'node:test';

import { internalAccess } from '../src/internal-auth.js';

const TOKEN = 'a-long-random-token-0123456789';

test('the control routes exist only with a token, only for direct local calls, only with the right token', () => {
  assert.equal(internalAccess({ authorization: `Bearer ${TOKEN}` }, ''), 'disabled');
  assert.equal(internalAccess({ authorization: `Bearer ${TOKEN}` }, TOKEN), 'ok');
  assert.equal(internalAccess({ authorization: 'Bearer nope' }, TOKEN), 'denied');
  assert.equal(internalAccess({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.9' }, TOKEN), 'outside');
});
