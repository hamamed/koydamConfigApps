import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appLevelTitle, DAILY_TITLE, levelLabel, levelName } from '../src/level-label.js';

test('a level is labelled by its number in the panel', () => {
  assert.equal(levelLabel(1), 'Level 1');
  assert.equal(levelLabel(12), 'Level 12');
});

test('the app number is shown only when it differs from the panel number', () => {
  assert.equal(levelName({ number: 3, publishedNumber: 3 }), 'Level 3');
  assert.equal(levelName({ number: 3, publishedNumber: null }), 'Level 3');
  assert.equal(levelName({ number: 3, publishedNumber: 2 }), 'Level 3 (app 2)');
});

test('the API titles are built from numbers', () => {
  assert.equal(appLevelTitle(4), 'لغز رقم 4');
  assert.equal(DAILY_TITLE, 'لغز اليوم');
});
