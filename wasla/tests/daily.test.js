import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createDaily, parseDay } from '../src/daily.js';
import { openDatabase } from '../src/db/index.js';
import { createRepository } from '../src/repository.js';

let repo;
let daily;

beforeEach(() => {
  const db = openDatabase(':memory:');
  repo = createRepository(db);
  daily = createDaily(db, repo);
});

function publishedLevel() {
  const ids = ['مصر', 'مرس'].map((answer) => repo.createQuestion({ title: 'عام', answer, clue: 'x' }).question.id);
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, ids);
  repo.setPublished(level.id, true);
  return level;
}

test('a date must be a real calendar day written YYYY-MM-DD', () => {
  assert.equal(parseDay('2026-09-17').date, '2026-09-17');
  assert.equal(parseDay('2026-09-17').day, 20713);
  for (const bad of ['2026-9-17', '2026-02-30', '2026-13-01', '17-09-2026', '2026-09-17T00:00', '', null, '2026-09-17 ']) {
    assert.equal(parseDay(bad), null, String(bad));
  }
});

test('with nothing scheduled, the same date always picks the same published level', () => {
  const levels = ['a', 'b', 'c'].map(publishedLevel);

  const pick = daily.forDate('2026-09-17');
  assert.equal(pick.source, 'automatic');
  // Day 20713 of the epoch, three published levels: index 20713 % 3 = 1.
  assert.equal(pick.levelId, levels[1].id);
  assert.equal(daily.forDate('2026-09-17').levelId, pick.levelId);
  assert.equal(daily.forDate('2026-09-18').levelId, levels[2].id);
});

test('a scheduled level wins over the automatic pick, and clearing it falls back', () => {
  const [a, b] = ['a', 'b'].map(publishedLevel);
  assert.equal(daily.schedule('2026-09-17', b.id).error, undefined);
  assert.deepEqual(daily.forDate('2026-09-17'), { levelId: b.id, source: 'scheduled' });

  daily.clear('2026-09-17');
  assert.equal(daily.forDate('2026-09-17').source, 'automatic');
  assert.ok([a.id, b.id].includes(daily.forDate('2026-09-17').levelId));
});

test('only a published level can be scheduled, and an unpublished one falls back', () => {
  const a = publishedLevel('a');
  const draft = repo.createLevel();
  assert.match(daily.schedule('2026-09-17', draft.id).error, /published/);
  assert.match(daily.schedule('2026-02-30', a.id).error, /date/);

  daily.schedule('2026-09-17', a.id);
  const b = publishedLevel('b');
  repo.setPublished(a.id, false);
  assert.deepEqual(daily.forDate('2026-09-17'), { levelId: b.id, source: 'automatic' });
});

test('no published levels means no daily puzzle', () => {
  assert.equal(daily.forDate('2026-09-17'), null);
});

test('upcoming days list what is scheduled and what would be picked', () => {
  const [a, b] = ['a', 'b'].map(publishedLevel);
  daily.schedule('2026-09-18', a.id);

  const days = daily.upcoming('2026-09-17', 3);
  assert.deepEqual(days.map((d) => [d.date, d.source]), [
    ['2026-09-17', 'automatic'], ['2026-09-18', 'scheduled'], ['2026-09-19', 'automatic'],
  ]);
  assert.equal(days[1].levelId, a.id);
  assert.ok([a.id, b.id].includes(days[0].levelId));
});
