import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { openDatabase } from '../src/db/index.js';
import { EDITORS, readGuess, readWheel } from '../src/daily-game-editor.js';
import { createDailyGames } from '../src/daily-games.js';

test('wheel and guess reuse the list rules', () => {
  const { game } = readWheel('حملا: حمل حلم حامل', 2);
  assert.deepEqual(game.words, ['حلم', 'حمل', 'حامل']);
  assert.deepEqual([...game.letters].sort(), [...'حملا'].sort());
  assert.ok(readWheel('قلمع: قلم سمك عمل').errors[0].includes('سمك'));
  const guess = readGuess('مدرسة').game;
  assert.deepEqual(guess.words, [{ word: 'مدرسة', display: 'مدرسة' }]);
  assert.equal(guess.word, 'مدرسة', 'the word the app reads');
  assert.equal(guess.tries, 6, 'six tries for the one word');
  assert.ok(readGuess('مدرسة\nملعقة').errors, 'the day hides one word now');
  assert.match(readGuess('قلم').errors[0], /5–5/);
  assert.ok(readGuess('مدرسة\nمدرسة').errors, 'two lines are two words, whatever they say');
});

test('every game turns into text and back into the same words', () => {
  const samples = {
    wheel: readWheel('حملا: حمل حلم حامل', 1).game,
    guess: readGuess('مدرسة\nملعقة').game,
  };
  const words = (g) => JSON.stringify(g, (k, v) => (['letters', 'bubbles', 'order'].includes(k) ? undefined : v));
  for (const [kind, game] of Object.entries(samples)) {
    const again = EDITORS[kind].read(EDITORS[kind].toText(game), 1).game;
    assert.equal(words(again), words(game), kind);
  }
});

let db;
let games;

beforeEach(() => {
  db = openDatabase(':memory:');
  games = createDailyGames(db, { appConfig: createAppConfig(db) });
});

test('a saved game wins over the automatic one, and can go back to automatic', () => {
  const auto = games.forDate('2026-09-20').guess;
  games.saveGame('2026-09-20', 'guess', readGuess('مدرسة').game);
  assert.equal(games.forDate('2026-09-20').guess.word, 'مدرسة');
  assert.equal(games.saved('2026-09-20').guess.source, 'typed');
  assert.equal(games.resetGame('2026-09-20', 'guess'), true);
  assert.deepEqual(games.forDate('2026-09-20').guess, auto);
});

test('freezing saves the automatic pick, so list edits no longer move that day', () => {
  const before = games.forDate('2026-09-21');
  assert.equal(games.freeze('2026-09-21').added, 2, 'wheel and guess (no questions for the rest)');
  games.saveList('guess', 'مكتبة');
  assert.equal(games.forDate('2026-09-21').guess.word, before.guess.word);
  assert.notEqual(games.forDate('2026-09-22').guess.word, before.guess.word === 'مكتبة' ? 'x' : before.guess.word);
  assert.deepEqual(games.plannedBetween('2026-09-20', '2026-09-22'), { '2026-09-21': { wheel: 'auto', guess: 'auto' } });
  assert.equal(games.freeze('2026-09-21').added, 0);
});
