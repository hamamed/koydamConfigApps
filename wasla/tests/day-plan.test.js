import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AHEAD_DAYS, createDayPlanner } from '../src/day-plan.js';

/** Fakes that record which days were planned. */
function world() {
  const planned = new Map();
  const frozen = [];
  const wordSearch = {
    playable: () => [],
    automaticPick: (date, _all, { avoid }) => ({ theme: `theme-${date}`, avoided: avoid, size: 8, seed: 1, board: { rows: [], words: [] } }),
  };
  const wordSearchDays = {
    get: (date) => planned.get(date) ?? null,
    save: (date, day) => { planned.set(date, day); return {}; },
  };
  const dailyGames = { freeze: (date) => { frozen.push(date); return { added: 5 }; } };
  return { planner: createDayPlanner({ dailyGames, wordSearch, wordSearchDays }), planned, frozen };
}

test('a coming day downloaded to play offline is planned, so everyone gets the same games', () => {
  const { planner, planned, frozen } = world();
  assert.equal(planner.planAhead('2026-09-20', '2026-09-18'), true);
  assert.equal(planned.get('2026-09-20').theme, 'theme-2026-09-20');
  assert.deepEqual(frozen, ['2026-09-20']);
});

test('only the coming week: not today, not the past, not further ahead', () => {
  const { planner, frozen } = world();
  assert.equal(AHEAD_DAYS, 7);
  assert.equal(planner.planAhead('2026-09-18', '2026-09-18'), false, 'today stays as it always was');
  assert.equal(planner.planAhead('2026-09-10', '2026-09-18'), false);
  assert.equal(planner.planAhead('2026-09-26', '2026-09-18'), false, 'eight days ahead');
  assert.equal(planner.planAhead('2026-09-25', '2026-09-18'), true, 'seven days ahead');
  assert.deepEqual(frozen, ['2026-09-25']);
});

test('a day planned already keeps its board', () => {
  const { planner, planned } = world();
  planned.set('2026-09-19', { theme: 'fruit' });
  planner.planAhead('2026-09-19', '2026-09-18');
  assert.equal(planned.get('2026-09-19').theme, 'fruit');
  planner.planAhead('2026-09-20', '2026-09-18');
  assert.equal(planned.get('2026-09-20').theme, 'theme-2026-09-20');
});
