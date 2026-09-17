import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createEvents, readEventBatch } from '../src/events.js';
import { createRepository } from '../src/repository.js';

const DEVICE = '8a1f5b2e-3c4d-4e5f-9a0b-1c2d3e4f5a6b';
const AT = '2026-09-17T10:00:00Z';

let db;
let repo;
let events;
let level;
let words;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  events = createEvents(db, repo);
  words = ['مصر', 'مرس'].map((answer) => repo.createQuestion({ title: 'عام', answer, clue: 'x' }).question.id);
  level = repo.createLevel();
  repo.setLevelQuestions(level.id, words);
  repo.setPublished(level.id, true);
});

const open = (word, device = DEVICE) => ({ type: 'question_opened', level: 1, word, at: AT, device });

function record(list) {
  const byDevice = new Map();
  for (const { device, ...event } of list) {
    byDevice.set(device, [...(byDevice.get(device) ?? []), event]);
  }
  let n = 0;
  for (const [device, batch] of byDevice) {
    n += events.record(readEventBatch({ device, events: batch }));
  }
  return n;
}

test('a batch needs a device id and a list of at most 100 events', () => {
  assert.match(readEventBatch(null).error, /JSON object/);
  assert.match(readEventBatch({ events: [] }).error, /device/);
  assert.match(readEventBatch({ device: 'x', events: [] }).error, /device/);
  assert.match(readEventBatch({ device: DEVICE }).error, /events/);
  assert.match(readEventBatch({ device: DEVICE, events: Array(101).fill(open(words[0])) }).error, /100/);
  assert.equal(readEventBatch({ device: DEVICE, events: [] }).events.length, 0);
});

test('unknown types and malformed events are dropped, the rest kept', () => {
  const batch = readEventBatch({ device: DEVICE, events: [
    { type: 'question_opened', level: 1, word: words[0], at: AT },
    { type: 'ad_watched', level: 1 },
    { type: 'help_used', level: 1, word: words[0], help: 'teleport', at: AT },
    { type: 'help_used', level: 1, word: words[0], help: 'revealLetter', at: AT },
    { type: 'question_solved', level: 1, word: words[0], seconds: -3, at: AT },
    { type: 'question_solved', level: 'one', word: words[0], seconds: 3, at: AT },
    { type: 'level_completed', level: 1, seconds: 95, stars: 2, at: AT },
    { type: 'level_completed', level: 1, seconds: 95, stars: 9, at: AT },
    'nonsense',
  ] });
  assert.equal(batch.events.length, 3);
  assert.equal(events.record(batch), 3);
});

test('question stats count opens, solves, time, helps, give-ups and players', () => {
  const [egypt, other] = words;
  const second = 'b2c3d4e5-0000-4000-8000-000000000000';
  record([
    open(egypt), open(egypt), open(egypt, second), open(other),
    { type: 'question_solved', level: 1, word: egypt, seconds: 10, at: AT, device: DEVICE },
    { type: 'question_solved', level: 1, word: egypt, seconds: 20, at: AT, device: second },
    { type: 'help_used', level: 1, word: egypt, help: 'revealLetter', at: AT, device: DEVICE },
    { type: 'help_used', level: 1, word: egypt, help: 'revealLetter', at: AT, device: DEVICE },
    { type: 'help_used', level: 1, word: egypt, help: 'unblurImage', at: AT, device: DEVICE },
    { type: 'question_left', level: 1, word: other, at: AT, device: DEVICE },
  ]);

  const stats = events.questionStats({ sort: 'opens', dir: 'desc' });
  const row = stats.find((s) => s.questionId === egypt);
  assert.equal(row.answer, 'مصر');
  assert.equal(row.opens, 3);
  assert.equal(row.solves, 2);
  assert.equal(Math.round(row.solveRate * 100), 67);
  assert.equal(row.avgSeconds, 15);
  assert.equal(row.left, 0);
  assert.equal(row.devices, 2);
  assert.equal(Math.round(row.helpsPerOpen.revealLetter * 100), 67);
  assert.equal(Math.round(row.helpsPerOpen.unblurImage * 100), 33);
  assert.equal(row.helpsPerOpen.solveWord, 0);
  assert.equal(stats[0].questionId, egypt);

  const otherRow = stats.find((s) => s.questionId === other);
  assert.deepEqual([otherRow.opens, otherRow.solves, otherRow.solveRate, otherRow.left], [1, 0, 0, 1]);
});

test('hard questions are those solved under half the time over at least ten opens', () => {
  const [hard, easy] = words;
  record([
    ...Array.from({ length: 10 }, () => open(hard)),
    ...Array.from({ length: 4 }, () => ({ type: 'question_solved', level: 1, word: hard, seconds: 5, at: AT, device: DEVICE })),
    ...Array.from({ length: 9 }, () => open(easy)),
  ]);
  assert.deepEqual(events.questionStats({ hard: true }).map((s) => s.questionId), [hard]);
});

test('sorting only accepts known columns', () => {
  record([open(words[0]), open(words[0]), open(words[1])]);
  assert.deepEqual(events.questionStats({ sort: 'opens', dir: 'asc' }).map((s) => s.opens), [1, 2]);
  assert.doesNotThrow(() => events.questionStats({ sort: 'opens; DROP TABLE events', dir: 'sideways' }));
});

test('level stats average time and stars over completions, keyed to the level played', () => {
  record([
    { type: 'level_completed', level: 1, seconds: 100, stars: 3, at: AT, device: DEVICE },
    { type: 'level_completed', level: 1, seconds: 50, stars: 2, at: AT, device: DEVICE },
    { type: 'level_completed', level: 0, seconds: 70, stars: 1, at: AT, device: DEVICE },
  ]);
  // Moving the level later must not move its history to another level.
  const other = repo.createLevel();
  repo.moveLevel(other.id, 'up');

  const rows = events.levelStats();
  const played = rows.find((r) => r.levelId === level.id);
  assert.deepEqual([played.name, played.completions, played.avgSeconds, played.avgStars], ['Level 2', 2, 75, 2.5]);
  const daily = rows.find((r) => r.levelId === null);
  assert.deepEqual([daily.name, daily.completions], ['Daily puzzle', 1]);
});

test('word search events need level 0; found needs a word id, completed needs seconds and stars', () => {
  const batch = readEventBatch({ device: DEVICE, events: [
    { type: 'wordsearch_started', level: 0, at: AT },
    { type: 'wordsearch_started', level: 3, at: AT },
    { type: 'wordsearch_word_found', level: 0, word: words[0], at: AT },
    { type: 'wordsearch_word_found', level: 0, at: AT },
    { type: 'wordsearch_completed', level: 0, seconds: 120.5, stars: 2, at: AT },
    { type: 'wordsearch_completed', level: 0, seconds: 120, stars: 4, at: AT },
    { type: 'wordsearch_completed', level: 0, stars: 2, at: AT },
  ] });
  assert.deepEqual(batch.events.map((e) => [e.type, e.level, e.word, e.seconds, e.stars]), [
    ['wordsearch_started', 0, null, null, null],
    ['wordsearch_word_found', 0, words[0], null, null],
    ['wordsearch_completed', 0, null, 120.5, 2],
  ]);
});

test('daily game events need level 0, seconds and stars', () => {
  const batch = readEventBatch({ device: DEVICE, events: [
    { type: 'scramble_completed', level: 0, seconds: 40, stars: 3, at: AT },
    { type: 'bubbles_completed', level: 0, seconds: 50, stars: 2, at: AT },
    { type: 'groups_completed', level: 0, seconds: 60, stars: 0, at: AT },
    { type: 'wheel_completed', level: 0, seconds: 70, stars: 1, at: AT },
    { type: 'guess_completed', level: 0, seconds: 80, stars: 3, at: AT },
    { type: 'guess_completed', level: 2, seconds: 80, stars: 3, at: AT },
    { type: 'wheel_completed', level: 0, stars: 1, at: AT },
    { type: 'groups_completed', level: 0, seconds: 60, stars: 5, at: AT },
  ] });
  assert.deepEqual(batch.events.map((e) => [e.type, e.seconds, e.stars]), [
    ['scramble_completed', 40, 3],
    ['bubbles_completed', 50, 2],
    ['groups_completed', 60, 0],
    ['wheel_completed', 70, 1],
    ['guess_completed', 80, 3],
  ]);
});

test('word search events stay out of question stats and get their own row in level stats', () => {
  record([
    open(words[0]),
    { type: 'wordsearch_word_found', level: 0, word: words[0], at: AT, device: 'c3d4e5f6-0000-4000-8000-000000000000' },
    { type: 'wordsearch_completed', level: 0, seconds: 90, stars: 3, at: AT, device: DEVICE },
    { type: 'wordsearch_completed', level: 0, seconds: 150, stars: 2, at: AT, device: DEVICE },
  ]);
  const row = events.questionStats().find((s) => s.questionId === words[0]);
  assert.deepEqual([row.opens, row.devices], [1, 1]);

  const rows = events.levelStats();
  assert.equal(rows.some((r) => r.name === 'Daily puzzle'), false);
  const search = rows.find((r) => r.name === 'Daily word search');
  assert.deepEqual([search.levelId, search.completions, search.avgSeconds, search.avgStars, search.devices], [null, 2, 120, 2.5, 1]);
});

test('pruning removes events older than the retention window', () => {
  record([open(words[0]), open(words[1])]);
  db.prepare("UPDATE events SET received_at = datetime('now', '-200 days') WHERE word = ?").run(words[0]);

  assert.equal(events.prune(180), 1);
  assert.equal(events.questionStats().filter((s) => s.opens).length, 1);
});

test('questions nobody has opened sort after the rest, whichever the direction', () => {
  const unopened = repo.createQuestion({ title: 'عام', answer: 'قمر', clue: 'x' }).question.id;
  record([open(words[0]), open(words[1]), { type: 'question_solved', level: 1, word: words[1], seconds: 4, at: AT, device: DEVICE }]);

  for (const dir of ['asc', 'desc']) {
    const order = events.questionStats({ sort: 'solveRate', dir }).map((s) => s.questionId);
    assert.equal(order.at(-1), unopened, dir);
  }
  assert.deepEqual(events.questionStats({ sort: 'solveRate', dir: 'asc' }).slice(0, 2).map((s) => s.questionId), [words[0], words[1]]);
});
