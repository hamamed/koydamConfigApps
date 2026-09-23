import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { createReports, PER_DEVICE_HOURLY, readReport, REASON_KEYS } from '../src/reports.js';
import { createRepository } from '../src/repository.js';

let db;
let repo;
let reports;
let question;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  reports = createReports(db);
  question = repo.createQuestion({ answer: 'أسد', clue: 'ملك الغابة', title: 'حيوانات' }).question;
});

test('a report needs a reason the app knows, and a note is trimmed to fit', () => {
  assert.match(readReport({ reason: 'nonsense' }).error, /reason/);
  assert.match(readReport({}).error, /reason/);
  assert.match(readReport('not an object').error, /JSON/);

  const { report } = readReport({ reason: 'wrong', note: '  الجواب   غلط  ', device: 'abc' });
  assert.deepEqual(report, { reason: 'wrong', note: 'الجواب غلط', device: 'abc' });
  assert.equal(readReport({ reason: 'wrong', note: 'x'.repeat(500) }).report.note.length, 300);
  assert.equal(readReport({ reason: 'wrong' }).report.note, null, 'no note is null, not an empty string');
});

test('a report is filed against a real question, and only a real one', () => {
  assert.ok(reports.add(question.id, { reason: 'wrong', note: 'غلط', device: 'd1' }).id);
  assert.match(reports.add(999_999, { reason: 'wrong' }).error, /No such question/);
  assert.deepEqual(reports.list().map((r) => [r.answer, r.reason, r.note]), [['أسد', 'wrong', 'غلط']]);
});

test('one device cannot file endlessly', () => {
  for (let i = 0; i < PER_DEVICE_HOURLY; i++) {
    assert.ok(reports.add(question.id, { reason: 'wrong', device: 'flooder' }).id, `report ${i}`);
  }
  assert.match(reports.add(question.id, { reason: 'wrong', device: 'flooder' }).error, /Too many/);
  // Another device is unaffected, and so is one that sends no id.
  assert.ok(reports.add(question.id, { reason: 'wrong', device: 'someone-else' }).id);
  assert.ok(reports.add(question.id, { reason: 'wrong' }).id);
});

test('reports are filtered by state and by reason, and counted by both', () => {
  const second = repo.createQuestion({ answer: 'نمر', clue: 'مرقّط', title: 'حيوانات' }).question;
  reports.add(question.id, { reason: 'wrong' });
  reports.add(question.id, { reason: 'wrong' });
  reports.add(second.id, { reason: 'spelling' });

  assert.equal(reports.list({ status: 'open' }).length, 3);
  assert.deepEqual(reports.list({ reason: 'spelling' }).map((r) => r.answer), ['نمر']);
  // Every row says how many times its question has been reported at all.
  assert.deepEqual(reports.list({ reason: 'wrong' }).map((r) => r.timesReported), [2, 2]);

  const counts = reports.counts();
  assert.deepEqual([counts.open, counts.resolved, counts.total, counts.week], [3, 0, 3, 3]);
  assert.equal(counts.byReason.wrong, 2);
  assert.equal(counts.byReason.image, 0, 'every reason is counted, even at zero');
  assert.deepEqual(counts.worst[0], { questionId: question.id, answer: 'أسد', n: 2 });
  assert.equal(reports.openCount(), 3);
});

test('a report is dealt with, put back, or thrown away', () => {
  const id = reports.add(question.id, { reason: 'wrong' }).id;
  assert.equal(reports.setResolved(id, true), true);
  assert.deepEqual(reports.list({ status: 'open' }), []);
  assert.equal(reports.list({ status: 'resolved' }).length, 1);
  assert.equal(reports.list({ status: 'all' }).length, 1);

  assert.equal(reports.setResolved(id, false), true, 'and back again');
  assert.equal(reports.openCount(), 1);
  assert.equal(reports.setResolved(999_999, true), false);

  assert.equal(reports.remove(id), true);
  assert.equal(reports.remove(id), false);
});

test('every open report about one question closes together', () => {
  reports.add(question.id, { reason: 'wrong' });
  reports.add(question.id, { reason: 'spelling' });
  const other = repo.createQuestion({ answer: 'فيل', clue: 'ضخم', title: 'حيوانات' }).question;
  reports.add(other.id, { reason: 'wrong' });

  assert.equal(reports.resolveQuestion(question.id), 2);
  assert.deepEqual(reports.list({ status: 'open' }).map((r) => r.answer), ['فيل']);
  assert.equal(reports.resolveQuestion(question.id), 0, 'nothing left open to close');
});

test('clearing the resolved leaves the open alone', () => {
  const done = reports.add(question.id, { reason: 'wrong' }).id;
  reports.add(question.id, { reason: 'spelling' });
  reports.setResolved(done, true);

  assert.equal(reports.clearResolved(), 1);
  assert.deepEqual(reports.list({ status: 'all' }).map((r) => r.reason), ['spelling']);
});

test('a deleted question takes its reports with it', () => {
  reports.add(question.id, { reason: 'wrong' });
  repo.deleteQuestion(question.id);
  assert.deepEqual(reports.list({ status: 'all' }), []);
});

test('the reasons the app is offered are the reasons that may be stored', () => {
  for (const key of REASON_KEYS) {
    assert.ok(readReport({ reason: key }).report, key);
  }
});
