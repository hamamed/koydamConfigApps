import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { createAppConfig } from '../src/app-config.js';
import { openDatabase } from '../src/db/index.js';
import {
  EDITORS, readBubbles, readGroups, readGuess, readScramble, readWheel, TYPED_ID_BASE,
} from '../src/daily-game-editor.js';
import { createDailyGames } from '../src/daily-games.js';

test('scramble: "answer | clue" lines, letters shuffled, hamza folded', () => {
  const { game } = readScramble('أسد | ملك الغابة\nقلم | للكتابة\nباب | ندخل منه', 7);
  assert.equal(game.words.length, 3);
  assert.deepEqual(game.words[0], { ...game.words[0], id: TYPED_ID_BASE + 1, word: 'اسد', display: 'أسد', clue: 'ملك الغابة' });
  assert.notEqual(game.words[0].letters, 'اسد');
  assert.deepEqual([...game.words[0].letters].sort(), [...'اسد'].sort());
});

test('scramble: every problem is reported by line', () => {
  const { errors } = readScramble('أسد\nab | x\nقلم | ك\nقلم | ك');
  assert.equal(errors.length, 3);
  assert.match(errors[0], /Line 1: add a clue/);
  assert.match(errors[1], /Line 2/);
  assert.match(errors[2], /Line 4: .* twice/);
  assert.match(readScramble('قلم | ك').errors[0], /3 to 8/);
});

test('bubbles: theme first, then words cut into pieces, all pieces mixed', () => {
  const { game } = readBubbles('مدن\nطنجة\nمراكش\nفاس', 3);
  assert.equal(game.theme, 'مدن');
  assert.deepEqual(game.words.map((w) => w.parts), [['طن', 'جة'], ['مر', 'اكش'], ['فاس']]);
  assert.deepEqual([...game.bubbles].sort(), ['اكش', 'جة', 'طن', 'فاس', 'مر'].sort());
  assert.match(readBubbles('مدن\nطنجة').errors[0], /3 to 8/);
});

test('groups: four lines of title and four words, no word twice', () => {
  const text = 'مدن: طنجة، فاس، رباط، وجدة\nمهن: طبيب، معلم، مهندس، طاهي\nحيوانات: قرد، دجاج، سمكة، عصفور\nفواكه: تفاح، موز، عنب، رمان';
  const { game } = readGroups(text, 5);
  assert.equal(game.groups.length, 4);
  assert.equal(new Set(game.order).size, 16);
  assert.match(readGroups('مدن: طنجة، فاس').errors[0], /exactly 4 words/);
  assert.match(readGroups(text.replace('موز', 'فاس')).errors[0], /two groups/);
  assert.match(readGroups(text.split('\n').slice(0, 3).join('\n')).errors[0], /exactly 4 groups/);
});

test('wheel and guess reuse the list rules', () => {
  const { game } = readWheel('حملا: حمل حلم حامل', 2);
  assert.deepEqual(game.words, ['حلم', 'حمل', 'حامل']);
  assert.deepEqual([...game.letters].sort(), [...'حملا'].sort());
  assert.ok(readWheel('قلمع: قلم سمك عمل').errors[0].includes('سمك'));
  assert.deepEqual(readGuess('مدرسة').game, { word: 'مدرسة', display: 'مدرسة', tries: 6 });
  assert.match(readGuess('قلم').errors[0], /5–5/);
});

test('every game turns into text and back into the same words', () => {
  const samples = {
    scramble: readScramble('أسد | ملك\nقلم | كتابة\nباب | مدخل', 1).game,
    bubbles: readBubbles('مدن\nطنجة\nمراكش\nفاس', 1).game,
    groups: readGroups('أ: قرد، دجاج، سمكة، عصفور\nب: طبيب، معلم، مهندس، طاهي\nج: طنجة، فاس، رباط، وجدة\nد: تفاح، موز، عنب، رمان', 1).game,
    wheel: readWheel('حملا: حمل حلم حامل', 1).game,
    guess: readGuess('مدرسة').game,
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
