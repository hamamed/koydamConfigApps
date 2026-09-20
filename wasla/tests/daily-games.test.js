import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig, DEFAULT_CONFIG } from '../src/app-config.js';
import { foldForPlay, letters } from '../src/arabic.js';
import { openDatabase } from '../src/db/index.js';
import {
  buildBubbles, buildGroups, buildGuess, buildScramble, buildWheel, createDailyGames, GUESS_LETTERS,
  parseGuessWords, parseWheelSets, spelledFrom, splitParts, titleGroups,
} from '../src/daily-games.js';
import { DEFAULT_GUESS_WORDS, DEFAULT_WHEEL_SETS } from '../src/daily-games-words.js';
import { parseDay } from '../src/daily.js';
import { createRepository } from '../src/repository.js';

const CONTENT = {
  مدن: ['طنجة', 'مراكش', 'الرباط', 'فاس', 'أغادير', 'مكناس'],
  رياضة: ['كرة', 'ملعب', 'حارس', 'بطولة', 'مدافع', 'هجوم'],
  طبيعة: ['شمس', 'ورد', 'محيط', 'صحراء', 'واحة', 'نخلة'],
  مهن: ['طبيب', 'معلم', 'مهندس', 'طاهي'],
  حيوانات: ['قرد', 'دجاج', 'سمكة', 'عصفور'],
};

let db;
let repo;
let games;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  for (const [title, answers] of Object.entries(CONTENT)) {
    answers.forEach((answer) => repo.createQuestion({ title, answer, clue: `دليل ${answer}` }));
  }
  games = createDailyGames(db, { appConfig: createAppConfig(db) });
});

const rows = () => db.prepare('SELECT id, answer, clue, title FROM questions ORDER BY id').all();

test('pieces are two letters, the last taking an odd one, never a single letter', () => {
  assert.deepEqual(splitParts('طبيب'), ['طب', 'يب']);
  assert.deepEqual(splitParts('مراكش'), ['مر', 'اكش']);
  assert.deepEqual(splitParts('جغرافيا'), ['جغ', 'را', 'فيا']);
  for (const word of ['مدرسة', 'مستشفيات', 'ابو']) {
    const parts = splitParts(word);
    assert.equal(parts.join(''), word);
    assert.ok(parts.every((p) => letters(p).length >= 2));
  }
});

test('the scramble has five clued words, shortest first, each shuffled away from itself', () => {
  const scramble = buildScramble(rows(), 42);
  assert.equal(scramble.words.length, 5);
  const lengths = scramble.words.map((w) => letters(w.word).length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
  for (const w of scramble.words) {
    assert.notEqual(w.letters, w.word);
    assert.deepEqual([...w.letters].sort(), [...w.word].sort());
    assert.ok(w.clue);
  }
});

test('the scramble skips answers without a clue and gives up below five words', () => {
  const few = rows().slice(0, 4);
  assert.equal(buildScramble(few, 1), null);
  const noClues = rows().map((r) => ({ ...r, clue: '  ' }));
  assert.equal(buildScramble(noClues, 1), null);
});

test('bubbles use one theme with five words, and the bubbles are exactly their pieces', () => {
  const bubbles = buildBubbles(titleGroups(rows(), [4, 8]), 10, 7);
  assert.equal(bubbles.words.length, 5);
  assert.ok(Object.keys(CONTENT).includes(bubbles.theme));
  assert.deepEqual([...bubbles.bubbles].sort(), bubbles.words.flatMap((w) => w.parts).sort());
  for (const w of bubbles.words) assert.equal(w.parts.join(''), w.word);
});

test('groups are four titles of four different words, in a shuffled order of all sixteen ids', () => {
  const set = buildGroups(titleGroups(rows(), [3, 8]), 99);
  assert.equal(set.groups.length, 4);
  const ids = set.groups.flatMap((g) => g.words.map((w) => w.id));
  assert.equal(new Set(ids).size, 16);
  assert.deepEqual([...set.order].sort(), [...ids].sort());
  const words = set.groups.flatMap((g) => g.words.map((w) => w.word));
  assert.equal(new Set(words).size, 16);
  assert.equal(new Set(set.groups.map((g) => g.title)).size, 4);
});

test('groups need four usable titles', () => {
  const three = rows().filter((r) => r.title !== 'مهن' && r.title !== 'حيوانات');
  assert.equal(buildGroups(titleGroups(three, [3, 8]), 1), null);
});

test('the built-in lists are clean', () => {
  const guess = parseGuessWords(DEFAULT_GUESS_WORDS);
  assert.deepEqual(guess.problems, []);
  assert.ok(guess.words.length >= 60);
  assert.ok(guess.words.every((w) => letters(w.word).length === GUESS_LETTERS && w.word === foldForPlay(w.display)));
  const wheel = parseWheelSets(DEFAULT_WHEEL_SETS);
  assert.deepEqual(wheel.problems, []);
  assert.ok(wheel.sets.length >= 20);
  for (const set of wheel.sets) assert.ok(set.words.every((w) => spelledFrom(w, set.letters)));
});

test('list lines that cannot be used are reported with their line number', () => {
  const guess = parseGuessWords('مدرسة\nقلم\nمدرسة\nhello');
  assert.equal(guess.words.length, 1);
  assert.deepEqual(guess.problems.map((p) => p.line), [2, 3, 4]);
  const wheel = parseWheelSets('قلمع: قلم علم عمل\nقلم: قلم علم\nبحرا: بحر حرب سمك');
  assert.equal(wheel.sets.length, 1);
  assert.deepEqual(wheel.problems.map((p) => p.line), [2, 3]);
  assert.match(wheel.problems[1].reason, /سمك/);
});

test('spelling from letters respects how often each letter is there', () => {
  assert.ok(spelledFrom('حمل', 'حملا'));
  assert.ok(!spelledFrom('مملح', 'حملا'));
});

test('the wheel sends shuffled letters and its words shortest first', () => {
  const { sets } = parseWheelSets(DEFAULT_WHEEL_SETS);
  const wheel = buildWheel(sets, 20_000, 5);
  const set = sets.find((s) => [...s.letters].sort().join('') === [...wheel.letters].sort().join(''));
  assert.ok(set);
  const lengths = wheel.words.map((w) => letters(w).length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
});

test('the guess word rotates by day and comes back after the whole list', () => {
  const { words } = parseGuessWords(DEFAULT_GUESS_WORDS);
  const first = buildGuess(words, 100);
  assert.equal(first.tries, 6);
  assert.deepEqual(buildGuess(words, 100 + words.length), first);
  const week = new Set(Array.from({ length: 7 }, (_, i) => buildGuess(words, 100 + i).word));
  assert.equal(week.size, 7);
});

test('a date always gets the same set, and different dates different ones', () => {
  const a = games.forDate('2026-09-18');
  assert.deepEqual(games.forDate('2026-09-18'), a);
  const b = games.forDate('2026-09-19');
  assert.notDeepEqual(a, b);
  assert.equal(a.date, '2026-09-18');
  assert.equal(a.coins, DEFAULT_CONFIG.dailyGameCoins);
  assert.equal(a.allBonus, DEFAULT_CONFIG.dailyAllGamesBonus);
  for (const kind of ['scramble', 'bubbles', 'groups', 'wheel', 'guess']) assert.ok(a[kind], kind);
});

test('a bad date gets nothing', () => {
  assert.equal(games.forDate('2026-02-30'), null);
  assert.equal(games.forDate('tomorrow'), null);
});

test('games without enough questions are null while the lists still make wheel and guess', () => {
  db.prepare('DELETE FROM questions').run();
  const set = games.forDate('2026-09-18');
  assert.equal(set.scramble, null);
  assert.equal(set.bubbles, null);
  assert.equal(set.groups, null);
  assert.ok(set.wheel);
  assert.ok(set.guess);
});

test('saving a list refuses any bad line and keeps the old list', () => {
  const result = games.saveList('guess', 'مدرسة\nقلم');
  assert.match(result.error, /1 line/);
  assert.equal(result.problems[0].line, 2);
  assert.equal(games.lists().guess.edited, false);
});

test('a saved list is used for new days and can go back to the built-in one', () => {
  assert.deepEqual(games.saveList('guess', 'مدرسة'), { count: 1 });
  const day = parseDay('2026-09-18').day;
  assert.ok(day > 0);
  assert.equal(games.forDate('2026-09-18').guess.word, 'مدرسة');
  assert.equal(games.lists().guess.edited, true);
  assert.equal(games.resetList('guess'), true);
  assert.equal(games.lists().guess.edited, false);
  assert.ok(games.lists().guess.count > 1);
  assert.equal(games.saveList('nope', 'x').error, 'Unknown list.');
  assert.match(games.saveList('wheel', '').error, /at least one/);
});
