import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import ejs from 'ejs';

import { config } from '../src/config.js';
import { LADDER_RUNGS } from '../src/daily-ladder.js';
import { BOARDS } from '../src/profiles.js';
import { BOARD_LABELS } from '../src/routes/admin-boards.js';

/**
 * The landing page must say what the panel and the app say: the same number of
 * leaderboards under the same names, the same ladder, the real counts — and no
 * store the game is not in.
 */
function render(overrides = {}, { raw = false } = {}) {
  const locals = {
    title: 'شبّك', seo: { title: 'شبّك', description: 'd', canonical: 'https://chabbek.com/', base: 'https://chabbek.com' },
    assetVersion: '1', supportEmail: 'support@koydam.com', appStoreUrl: 'https://apps.apple.com/app/id6814526352',
    playUrl: '', levels: 161, questions: 5025, hasIcons: false, iconUrl: () => '',
    boards: BOARDS.map((id) => BOARD_LABELS[id].ar), rungs: LADDER_RUNGS,
    ...overrides,
  };
  const text = ejs.render(
    '<%- include("site/landing") %>', locals,
    { filename: path.join(config.root, 'views', 'index.ejs'), views: [path.join(config.root, 'views')] },
  );
  if (raw) return text;
  // What a reader sees, one line: tags out, runs of space folded.
  return text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

const number = (page, label) => page.match(new RegExp(`([\\d,]+) ${label}`))?.[1];

test('the counts are the real ones, the boards and rungs those of the game', () => {
  const page = render();
  assert.equal(number(page, 'لغزاً منشوراً'), '161');
  assert.equal(number(page, 'سؤالاً في البنك'), '5,025');
  assert.equal(number(page, 'درجات في سُلّم كل يوم'), String(LADDER_RUNGS));
  assert.equal(number(page, 'لوحات متصدرين'), String(BOARDS.length));
});

test('an empty bank shows its real count, never an invented one', () => {
  const page = render({ levels: 0, questions: 0 });
  assert.equal(number(page, 'لغزاً منشوراً'), '0');
  assert.doesNotMatch(page, /\b150\b|4,400/);
});

test('every board is named as the panel names it, and only today’s is said to start over', () => {
  const page = render();
  for (const id of BOARDS) assert.ok(page.includes(BOARD_LABELS[id].ar), `missing ${BOARD_LABELS[id].ar}`);
  assert.doesNotMatch(page, /لوحات تتجدّ?د كل يوم|لوحات متصدرين تتجدّ?د/, 'the all-time boards do not reset');
});

test('the crossword is described as it is played, and not every level is ten questions', () => {
  const page = render();
  assert.doesNotMatch(page, /تُختار حروفها بسحب/, 'letters are tapped; dragging picks the question');
  assert.doesNotMatch(page, /كل لغز عشرة أسئلة/);
});

test('a store the game is not in is not promised', () => {
  assert.doesNotMatch(render(), /Google Play/);
  // Once there is a listing, its badge (an image, so the markup) links to it.
  assert.match(render({ playUrl: 'https://play.google.com/store/apps/details?id=x' }, { raw: true }), /href="https:\/\/play\.google\.com/);
});
