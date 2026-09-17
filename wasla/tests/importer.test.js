import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { openDatabase } from '../src/db/index.js';
import { commitImport, planImport, readImportCsv } from '../src/importer.js';
import { createRepository } from '../src/repository.js';

let repo;

beforeEach(() => {
  repo = createRepository(openDatabase(':memory:'));
});

const HEADER = 'answer,clue,title,type,emoji,image,zoom,focus_x,focus_y,blurred,audio,level';
const media = new Map([
  ['lion.jpg', { kind: 'image', file: 'aaaaaaaaaaaaaaaaaaaaaaaa.jpg' }],
  ['roar.m4a', { kind: 'audio', file: 'bbbbbbbbbbbbbbbbbbbbbbbb.m4a' }],
]);

test('the CSV needs a header with answer, clue and title, and no unknown columns', () => {
  assert.match(readImportCsv('').error, /empty/);
  assert.match(readImportCsv('clue,title\nx,y\n').error, /answer/);
  assert.match(readImportCsv('answer,clue\nمصر,x\n').error, /title/);
  assert.match(readImportCsv('answer,clue,title,colour\nمصر,x,y,red\n').error, /colour/);
  assert.match(readImportCsv('answer,clue,title\n"مصر,x,y\n').error, /quote/);
  assert.match(readImportCsv('answer,clue,title\n').error, /no rows/);

  const { rows } = readImportCsv('﻿Clue , Answer,Title\n"بلد، فيه النيل",مصر,بلدان\n');
  assert.deepEqual(rows, [{ row: 1, values: { clue: 'بلد، فيه النيل', answer: 'مصر', title: 'بلدان' } }]);
});

test('each row is checked with the same rules as the question form', () => {
  const { rows } = readImportCsv([
    HEADER,
    'أسد,ملك الغابة,حيوانات,,,lion.jpg,2,0.3,0.4,yes,,1',
    'Lion,x,t,,,,,,,,,',
    'قمر,x,t,,,missing.jpg,,,,,,',
    'قمر,x,t,,,roar.m4a,,,,,,',
    'زئير,صوت الأسد,أصوات,audio,,,,,,,roar.m4a,1',
    'مصر,x,بلدان,emoji,🇪🇬,,,,,,,',
    'قمر,بلا عنوان,,,,,,,,,,',
  ].join('\n'));

  const plan = planImport(repo, rows, media);
  assert.equal(plan.length, 7);

  const [lion, latin, missing, wrongKind, roar, egypt, untitled] = plan;
  assert.equal(lion.error, null);
  assert.deepEqual([lion.playAnswer, lion.type, lion.title, lion.levelNumber, lion.levelName, lion.levelIsNew],
    ['اسد', 'image', 'حيوانات', 1, 'Level 1', true]);
  assert.deepEqual([lion.input.zoom, lion.input.focusX, lion.input.blurred], ['2', '0.3', 'yes']);
  assert.match(latin.error, /Arabic letters/);
  assert.match(missing.error, /missing\.jpg/);
  assert.match(wrongKind.error, /picture/);
  assert.equal(roar.error, null);
  assert.equal(roar.type, 'audio');
  assert.equal(egypt.type, 'emoji');
  assert.equal(egypt.levelNumber, null);
  assert.match(untitled.error, /title/i);
});

test('the level column is a level number: existing, or new levels added one after another', () => {
  repo.createLevel();
  repo.createLevel();
  const { rows } = readImportCsv([
    'answer,clue,title,level',
    'مصر,x,t,1',
    'مرس,x,t,3',
    'سمر,x,t,4',
    'نمر,x,t,6',
    'رسم,x,t,0',
    'قمر,x,t,بلدان',
    'نمر,x,t,2.5',
  ].join('\n'));

  const [existing, next, after, gap, zero, named, fraction] = planImport(repo, rows, media);
  assert.deepEqual([existing.error, existing.levelNumber, existing.levelIsNew], [null, 1, false]);
  assert.deepEqual([next.error, next.levelNumber, next.levelIsNew], [null, 3, true]);
  assert.deepEqual([after.error, after.levelNumber, after.levelIsNew], [null, 4, true]);
  assert.match(gap.error, /no Level 6.*use 5/);
  assert.match(zero.error, /level number/);
  assert.match(named.error, /level number/);
  assert.match(fraction.error, /level number/);
});

test('one file can add several new levels, created in order', () => {
  const { rows } = readImportCsv([
    'answer,clue,title,level',
    'مصر,x,t,2',
    'مرس,x,t,1',
    'سمر,x,t,2',
    'رسم,x,t,1',
  ].join('\n'));

  const result = commitImport(repo, planImport(repo, rows, media));

  assert.deepEqual(result.levels.map((l) => [l.number, l.created, l.added]), [[1, true, 2], [2, true, 2]]);
  assert.equal(repo.listLevels().length, 2);
});

test('picture, sound and emoji questions may have only a title; text questions need a clue', () => {
  const { rows } = readImportCsv([
    'answer,clue,title,type,emoji,image',
    'أسد,,حيوانات,image,,lion.jpg',
    'مصر,,بلدان,emoji,🇪🇬,',
    'قمر,,طبيعة,text,,',
  ].join('\n'));

  const [picture, emoji, text] = planImport(repo, rows, media);
  assert.equal(picture.error, null);
  assert.equal(emoji.error, null);
  assert.match(text.error, /clue/i);
});

test('confirming imports only the valid rows, adds the next level and lays levels out', () => {
  const existing = repo.createLevel();
  const old = repo.createQuestion({ title: 'عام', answer: 'مصر', clue: 'x' }).question.id;
  repo.setLevelQuestions(existing.id, [old]);

  const { rows } = readImportCsv([
    HEADER,
    'أسد,ملك الغابة,حيوانات,,,lion.jpg,,,,,,2',
    'دب,حيوان,حيوانات,,,,,,,,,2',
    'Bad,x,حيوانات,,,,,,,,,2',
    'مرس,x,بلدان,,,,,,,,,1',
    'قمر,بلا مستوى,طبيعة,,,,,,,,,',
  ].join('\n'));

  const result = commitImport(repo, planImport(repo, rows, media));

  assert.equal(result.imported, 4);
  assert.deepEqual(result.usedFiles, ['aaaaaaaaaaaaaaaaaaaaaaaa.jpg']);
  const animals = repo.levelByNumber(2);
  assert.equal(animals.words.length + animals.unplaced.length, 2);
  assert.deepEqual(animals.words.concat(animals.unplaced).map((w) => w.title), ['حيوانات', 'حيوانات']);
  assert.equal(repo.getLevel(existing.id).words.length, 2);
  assert.equal(repo.listQuestions().length, 5);
  assert.equal(repo.listLevels().length, 2);
  assert.deepEqual(result.levels.map((l) => [l.number, l.name, l.created]), [[1, 'Level 1', false], [2, 'Level 2', true]]);
});

test('nothing is imported when a row fails at confirm time', () => {
  const { rows } = readImportCsv(`${HEADER}\nأسد,x,t,,,,,,,,,\nقمر,x,t,,,,,,,,,`);
  const plan = planImport(repo, rows, media);
  // Something changed between preview and confirm that the checks did not see.
  const broken = plan.map((p, i) => (i === 1 ? { ...p, input: { ...p.input, zoom: 99 } } : p));

  assert.throws(() => commitImport(repo, broken), /zoom/i);
  assert.equal(repo.listQuestions().length, 0);
});

test('an old CSV: category stands in for a blank title, and pack is ignored', () => {
  const parsed = readImportCsv([
    'answer,clue,category,pack,level',
    'أسد,ملك الغابة,حيوانات,animals,1',
    'دب,حيوان,حيوانات,no-such-pack,1',
  ].join('\n'));
  assert.equal(parsed.error, undefined);

  const plan = planImport(repo, parsed.rows, media);
  assert.deepEqual(plan.map((p) => p.error), [null, null]);
  assert.deepEqual(plan.map((p) => p.title), ['حيوانات', 'حيوانات']);
  plan.forEach((p) => assert.equal('packSlug' in p, false));

  const result = commitImport(repo, plan);
  assert.equal(result.imported, 2);
  assert.deepEqual(result.levels.map((l) => [l.name, l.created, l.added]), [['Level 1', true, 2]]);
  assert.equal('packId' in repo.levelByNumber(1), false);
});

test('a title column wins over an old category column', () => {
  const { rows } = readImportCsv('answer,clue,title,category\nأسد,x,حيوانات,قديم\nدب,x,,قديم\n');
  const [titled, fallback] = planImport(repo, rows, media);

  assert.equal(titled.title, 'حيوانات');
  assert.equal(fallback.title, 'قديم');
});
