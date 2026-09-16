import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { commitImport, planImport, readImportCsv } from '../src/importer.js';
import { createRepository } from '../src/repository.js';

let repo;

beforeEach(() => {
  repo = createRepository(openDatabase(':memory:'));
});

const HEADER = 'answer,clue,category,type,emoji,image,zoom,focus_x,focus_y,blurred,audio,level';
const media = new Map([
  ['lion.jpg', { kind: 'image', file: 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg' }],
  ['roar.m4a', { kind: 'audio', file: 'bbbbbbbbbbbbbbbbbbbbbbbb.m4a' }],
]);

test('the CSV needs a header with at least answer and clue, and no unknown columns', () => {
  assert.match(readImportCsv('').error, /empty/);
  assert.match(readImportCsv('clue\nx\n').error, /answer/);
  assert.match(readImportCsv('answer,clue,colour\nمصر,x,red\n').error, /colour/);
  assert.match(readImportCsv('answer,clue\n"مصر,x\n').error, /quote/);
  assert.match(readImportCsv('answer,clue\n').error, /no rows/);

  const { rows } = readImportCsv('﻿Clue , Answer\n"بلد، فيه النيل",مصر\n');
  assert.deepEqual(rows, [{ row: 1, values: { clue: 'بلد، فيه النيل', answer: 'مصر' } }]);
});

test('each row is checked with the same rules as the question form', () => {
  const { rows } = readImportCsv([
    HEADER,
    'أسد,ملك الغابة,حيوانات,,,lion.jpg,2,0.3,0.4,yes,,حيوانات',
    'Lion,x,,,,,,,,,,',
    'قمر,x,,,,missing.jpg,,,,,,',
    'قمر,x,,,,roar.m4a,,,,,,',
    'زئير,صوت الأسد,,audio,,,,,,,roar.m4a,حيوانات',
    'مصر,x,,emoji,🇪🇬,,,,,,,',
  ].join('\n'));

  const plan = planImport(repo, rows, media);
  assert.equal(plan.length, 6);

  const [lion, latin, missing, wrongKind, roar, egypt] = plan;
  assert.equal(lion.error, null);
  assert.deepEqual([lion.playAnswer, lion.type, lion.levelTitle, lion.levelIsNew],
    ['اسد', 'image', 'حيوانات', true]);
  assert.deepEqual([lion.input.zoom, lion.input.focusX, lion.input.blurred], ['2', '0.3', 'yes']);
  assert.match(latin.error, /Arabic letters/);
  assert.match(missing.error, /missing\.jpg/);
  assert.match(wrongKind.error, /picture/);
  assert.equal(roar.error, null);
  assert.equal(roar.type, 'audio');
  assert.equal(egypt.type, 'emoji');
});

test('confirming imports only the valid rows, creates missing levels and lays them out', () => {
  const existing = repo.createLevel('قديم');
  const old = repo.createQuestion({ answer: 'مصر', clue: 'x' }).question.id;
  repo.setLevelQuestions(existing.id, [old]);

  const { rows } = readImportCsv([
    HEADER,
    'أسد,ملك الغابة,,,,lion.jpg,,,,,,حيوانات',
    'دب,حيوان,,,,,,,,,,حيوانات',
    'Bad,x,,,,,,,,,,حيوانات',
    'مرس,x,,,,,,,,,,قديم',
    'قمر,بلا مستوى,,,,,,,,,,',
  ].join('\n'));

  const result = commitImport(repo, planImport(repo, rows, media));

  assert.equal(result.imported, 4);
  assert.deepEqual(result.usedFiles, ['aaaaaaaaaaaaaaaaaaaaaaaa.jpg']);
  const animals = repo.findLevelByTitle('حيوانات');
  assert.equal(animals.words.length + animals.unplaced.length, 2);
  assert.equal(repo.getLevel(existing.id).words.length, 2);
  assert.equal(repo.listQuestions().length, 5);
  assert.deepEqual(result.levels.map((l) => [l.title, l.created]), [['حيوانات', true], ['قديم', false]]);
});

test('nothing is imported when a row fails at confirm time', () => {
  const { rows } = readImportCsv(`${HEADER}\nأسد,x,,,,,,,,,,\nقمر,x,,,,,,,,,,`);
  const plan = planImport(repo, rows, media);
  // Something changed between preview and confirm that the checks did not see.
  const broken = plan.map((p, i) => (i === 1 ? { ...p, input: { ...p.input, zoom: 99 } } : p));

  assert.throws(() => commitImport(repo, broken), /zoom/i);
  assert.equal(repo.listQuestions().length, 0);
});

test('a pack column from an older CSV is accepted and ignored', () => {
  const parsed = readImportCsv([
    'answer,clue,pack,level',
    'أسد,ملك الغابة,animals,حيوانات',
    'دب,حيوان,no-such-pack,حيوانات',
  ].join('\n'));
  assert.equal(parsed.error, undefined);

  const plan = planImport(repo, parsed.rows, media);
  assert.deepEqual(plan.map((p) => p.error), [null, null]);
  plan.forEach((p) => assert.equal('packSlug' in p, false));

  const result = commitImport(repo, plan);
  assert.equal(result.imported, 2);
  assert.deepEqual(result.levels.map((l) => [l.title, l.created, l.added]), [['حيوانات', true, 2]]);
  const level = repo.findLevelByTitle('حيوانات');
  assert.equal('packId' in level, false);
});
