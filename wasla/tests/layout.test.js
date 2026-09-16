import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cellsOf, generateLayout } from '../src/layout.js';

const words = (...answers) => answers.map((answer, i) => ({ id: i + 1, answer }));

/** Every cell the layout fills, checked for clashes along the way. */
function grid(layout, list) {
  const byId = new Map(list.map((w) => [w.id, w.answer]));
  const cells = new Map();
  for (const p of layout.placements) {
    for (const cell of cellsOf({ ...p, answer: byId.get(p.id) })) {
      const key = `${cell.row},${cell.col}`;
      const existing = cells.get(key);
      assert.ok(!existing || existing === cell.letter, `letters clash at ${key}`);
      cells.set(key, cell.letter);
    }
  }
  return cells;
}

/** Rebuilds every run of two or more letters; each must be a placed word. */
function runs(layout, list) {
  const cells = grid(layout, list);
  const found = [];
  const at = (r, c) => cells.get(`${r},${c}`);
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      if (!at(r, c)) continue;
      if (!at(r, c - 1) && at(r, c + 1)) {
        let s = ''; for (let k = c; at(r, k); k++) s += at(r, k);
        found.push(s);
      }
      if (!at(r - 1, c) && at(r + 1, c)) {
        let s = ''; for (let k = r; at(k, c); k++) s += at(k, c);
        found.push(s);
      }
    }
  }
  return found.sort();
}

test('cellsOf walks across by column and down by row', () => {
  assert.deepEqual(
    cellsOf({ answer: 'مصر', row: 1, col: 2, direction: 'across' }).map((c) => [c.row, c.col, c.letter]),
    [[1, 2, 'م'], [1, 3, 'ص'], [1, 4, 'ر']],
  );
  assert.deepEqual(
    cellsOf({ answer: 'مصر', row: 1, col: 2, direction: 'down' }).map((c) => [c.row, c.col]),
    [[1, 2], [2, 2], [3, 2]],
  );
});

test('places every word of a connectable set, crossing on shared letters', () => {
  const list = words('المغرب', 'مصر', 'باريس', 'تونس', 'عمان');
  const layout = generateLayout(list, { seed: 1 });

  assert.deepEqual(layout.unplaced, []);
  assert.equal(layout.placements.length, 5);
  // No accidental words: the only runs of letters are the answers themselves.
  assert.deepEqual(runs(layout, list), list.map((w) => w.answer).sort());
});

test('the grid is normalised to start at row 0 and column 0', () => {
  const layout = generateLayout(words('الشمس', 'شجرة', 'سمك', 'كلب', 'كرة', 'كتاب'), { seed: 3 });

  assert.equal(Math.min(...layout.placements.map((p) => p.row)), 0);
  assert.equal(Math.min(...layout.placements.map((p) => p.col)), 0);
  assert.ok(layout.rows > 0 && layout.cols > 0);
});

test('reports a word that shares no letter with the rest as unplaced', () => {
  const list = [{ id: 1, answer: 'مصر' }, { id: 2, answer: 'مرس' }, { id: 3, answer: 'جحخ' }];
  const layout = generateLayout(list, { seed: 1 });

  assert.deepEqual(layout.unplaced, [3]);
  assert.equal(layout.placements.length, 2);
});

test('the same seed gives the same layout, so a preview matches what is saved', () => {
  const list = words('الشمس', 'شجرة', 'سمك', 'كلب', 'كرة', 'كتاب');
  assert.deepEqual(generateLayout(list, { seed: 7 }), generateLayout(list, { seed: 7 }));
});

test('an empty list is an empty grid', () => {
  assert.deepEqual(generateLayout([]), { rows: 0, cols: 0, placements: [], unplaced: [] });
});
