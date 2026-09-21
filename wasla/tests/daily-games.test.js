import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig, DEFAULT_CONFIG } from '../src/app-config.js';
import { foldForPlay, letters } from '../src/arabic.js';
import { openDatabase } from '../src/db/index.js';
import {
  buildGuess, buildWheel, createDailyGames, GUESS_LETTERS, GUESS_TRIES, GUESS_WORDS,
  parseGuessWords, parseWheelSets, spelledFrom,
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

test('the guess hides two different words, and the pair rotates by day', () => {
  const { words } = parseGuessWords(DEFAULT_GUESS_WORDS);
  const first = buildGuess(words, 100);
  assert.equal(first.tries, GUESS_TRIES);
  assert.equal(first.words.length, GUESS_WORDS);
  assert.notEqual(first.words[0].word, first.words[1].word);
  assert.equal(first.word, first.words[0].word, 'older app builds read one word');
  for (const w of first.words) assert.equal(letters(w.word).length, GUESS_LETTERS);
  const week = new Set(Array.from({ length: 7 }, (_, i) => buildGuess(words, 100 + i).word));
  assert.equal(week.size, 7);
  assert.equal(buildGuess([words[0]], 3).words.length, 1, 'one word left is still a game');
  assert.equal(buildGuess([], 3), null);
});

test('the wheel takes a set worth a whole day when the list has one', () => {
  const sets = [{ letters: 'حملا', words: ['حمل', 'حلم', 'لحم'] }, { letters: 'بحرا', words: ['بحر', 'حرب', 'ربح', 'حبر', 'بحار', 'حارب'] }];
  for (let day = 0; day < 7; day++) assert.equal(buildWheel(sets, day, 4).words.length, 6, 'never the three-word set');
  assert.equal(buildWheel([sets[0]], 0, 4).words.length, 3, 'unless it is all there is');
});

test('a date always gets the same set, and different dates different ones', () => {
  const a = games.forDate('2026-09-18');
  assert.deepEqual(games.forDate('2026-09-18'), a);
  const b = games.forDate('2026-09-19');
  assert.notDeepEqual(a, b);
  assert.equal(a.date, '2026-09-18');
  assert.equal(a.coins, DEFAULT_CONFIG.dailyGameCoins);
  assert.equal(a.allBonus, DEFAULT_CONFIG.dailyAllGamesBonus);
  for (const kind of ['wheel', 'guess']) assert.ok(a[kind], kind);
});

test('a bad date gets nothing', () => {
  assert.equal(games.forDate('2026-02-30'), null);
  assert.equal(games.forDate('tomorrow'), null);
});

test('the lists make wheel and guess even with no questions at all', () => {
  db.prepare('DELETE FROM questions').run();
  const set = games.forDate('2026-09-18');
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
  assert.equal(games.saveList('nope', 'x').error, 'قائمة غير معروفة.');
  assert.match(games.saveList('wheel', '').error, /على الأقل/);
});

test('another pick differs from the automatic one, and is a playable game', () => {
  const date = '2026-09-22';
  const auto = games.automatic(date);
  const again = games.pickAgain(date, 'wheel', 7);
  assert.ok(again?.words?.length, 'a wheel came back');
  assert.notDeepEqual(again, auto.wheel);
  again.words.forEach((word) => assert.ok(spelledFrom(word, again.letters), `${word} is spelled from the letters`));
});

test('another pick moves the guess word and the wheel set on too', () => {
  const date = '2026-09-22';
  const auto = games.automatic(date);
  const guesses = new Set();
  const wheels = new Set();
  for (let nonce = 1; nonce <= 6; nonce++) {
    guesses.add(games.pickAgain(date, 'guess', nonce).word);
    wheels.add(games.pickAgain(date, 'wheel', nonce).letters);
  }
  assert.ok(guesses.size > 1, 'the guess word is not the same every time');
  assert.ok(wheels.size > 1, 'the wheel letters are not the same every time');
  assert.ok([...guesses].some((word) => word !== auto.guess.word), 'at least one differs from the automatic pick');
});

test('another pick refuses a kind or a date it does not know', () => {
  assert.equal(games.pickAgain('2026-09-22', 'nonsense', 1), null);
  assert.equal(games.pickAgain('not-a-date', 'guess', 1), null);
});

test('copying a day puts the games it would serve on another date', () => {
  const from = '2026-09-22';
  const onto = '2026-09-23';
  const picked = games.pickAgain(from, 'wheel', 3);
  games.saveGame(from, 'wheel', picked, 'typed');

  const result = games.copyDay(onto, from);
  assert.equal(result.copied, 2, 'both games were copied');
  assert.deepEqual(games.forDate(onto).wheel, picked, 'the typed game came across');
  // The automatic games of that day are copied as they stood, not recomputed for the new date.
  assert.deepEqual(games.forDate(onto).guess, games.forDate(from).guess);
  assert.equal(games.saved(onto).guess.source, 'auto');
});

test('a day cannot be copied onto itself, and an unknown date is refused', () => {
  assert.equal(games.copyDay('2026-09-22', '2026-09-22').error, 'اختر يوماً آخر للنسخ منه.');
  assert.equal(games.copyDay('2026-09-22', 'yesterday').error, 'هذا ليس تاريخاً صحيحاً.');
});

test('clearing a day takes every game back to automatic', () => {
  const date = '2026-09-22';
  const auto = games.automatic(date);
  games.freeze(date);
  assert.equal(Object.keys(games.saved(date)).length, 2);

  assert.equal(games.clearDay(date), 2, 'both rows went');
  assert.deepEqual(games.saved(date), {});
  assert.deepEqual(games.forDate(date).wheel, auto.wheel, 'the automatic pick is served again');
  assert.equal(games.clearDay(date), 0, 'clearing an automatic day changes nothing');
});
