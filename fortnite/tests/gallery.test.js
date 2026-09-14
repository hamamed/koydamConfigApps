import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import Database from 'better-sqlite3';

import { filterOptions, pageHref, queryGallery, readFilters, videoTotals, youtubeId } from '../src/gallery.js';

let database;

const ROWS = [
  { id: 'Character_A', name: 'Alpha', type: 'outfit', rarity: 'epic', showcase_video: 'aaaaaaaaaaa', added_at: '2026-01-05' },
  { id: 'Character_B', name: 'Bravo', type: 'outfit', rarity: 'legendary', showcase_video: null, added_at: '2026-01-04' },
  { id: 'Character_C', name: 'Charlie', type: 'outfit', rarity: 'epic', showcase_video: null, added_at: '2026-01-03' },
  { id: 'Character_D', name: 'Delta', type: 'outfit', rarity: 'rare', showcase_video: 'ddddddddddd', added_at: '2026-01-02' },
  { id: 'EID_Wave', name: 'Wave', type: 'emote', rarity: 'rare', showcase_video: null, added_at: '2026-01-01' },
];

beforeEach(() => {
  database = new Database(':memory:');
  database.exec(`CREATE TABLE cosmetics (
    id TEXT PRIMARY KEY, name TEXT, description TEXT, type TEXT, type_name TEXT,
    rarity TEXT, rarity_name TEXT, series TEXT, set_name TEXT, season TEXT,
    icon_url TEXT, featured_url TEXT, showcase_video TEXT, added_at TEXT, search_blob TEXT)`);
  const insert = database.prepare(
    `INSERT INTO cosmetics (id, name, type, rarity, showcase_video, added_at, search_blob)
     VALUES (@id, @name, @type, @rarity, @showcase_video, @added_at, lower(@name))`,
  );
  ROWS.forEach((row) => insert.run(row));
});

const ids = (result) => result.rows.map((row) => row.id);
const filters = (overrides = {}) => readFilters(overrides);

test('readFilters trims and lowercases search and ignores unknown values', () => {
  const read = readFilters({ search: '  PEELY ', rarity: ' epic ', type: 'outfit', video: 'sideways', page: 'abc' });

  assert.deepEqual(read, { search: 'peely', rarity: 'epic', type: 'outfit', video: '', page: 1 });
});

test('readFilters accepts a real page number and a known video filter', () => {
  assert.equal(readFilters({ page: '3' }).page, 3);
  assert.equal(readFilters({ page: '-2' }).page, 1);
  assert.equal(readFilters({ video: 'clip' }).video, 'clip');
});

test('lists newest first with a total', () => {
  const result = queryGallery(database, filters(), new Set());

  assert.deepEqual(ids(result), ['Character_A', 'Character_B', 'Character_C', 'Character_D', 'EID_Wave']);
  assert.equal(result.total, 5);
});

test('video=clip keeps only cosmetics with a rendered clip', () => {
  const result = queryGallery(database, filters({ video: 'clip' }), new Set(['Character_B', 'Character_C']));

  assert.deepEqual(ids(result), ['Character_B', 'Character_C']);
});

test('video=youtube keeps only cosmetics with an upstream video', () => {
  const result = queryGallery(database, filters({ video: 'youtube' }), new Set(['Character_B']));

  assert.deepEqual(ids(result), ['Character_A', 'Character_D']);
});

test('video=any keeps a clip or a YouTube video, video=none keeps neither', () => {
  const clips = new Set(['Character_B']);

  assert.deepEqual(ids(queryGallery(database, filters({ video: 'any' }), clips)), ['Character_A', 'Character_B', 'Character_D']);
  assert.deepEqual(ids(queryGallery(database, filters({ video: 'none' }), clips)), ['Character_C', 'EID_Wave']);
});

test('search, rarity and type narrow the list together', () => {
  assert.deepEqual(ids(queryGallery(database, filters({ search: 'char' }), new Set())), ['Character_C']);
  assert.deepEqual(ids(queryGallery(database, filters({ rarity: 'rare', type: 'emote' }), new Set())), ['EID_Wave']);
});

test('marks which rows have a clip', () => {
  const result = queryGallery(database, filters({ video: 'any' }), new Set(['Character_B']));

  assert.deepEqual(result.rows.map((row) => row.hasClip), [false, true, false]);
});

test('pages through results and clamps a page past the end to the last', () => {
  const second = queryGallery(database, filters({ page: '2' }), new Set(), { pageSize: 2 });
  assert.deepEqual(ids(second), ['Character_C', 'Character_D']);
  assert.equal(second.pages, 3);
  assert.equal(second.page, 2);

  const beyond = queryGallery(database, filters({ page: '99' }), new Set(), { pageSize: 2 });
  assert.deepEqual(ids(beyond), ['EID_Wave']);
  assert.equal(beyond.page, 3);
});

test('an empty result is one empty page, not page zero', () => {
  const result = queryGallery(database, filters({ search: 'nothing matches' }), new Set());

  assert.equal(result.total, 0);
  assert.equal(result.pages, 1);
  assert.equal(result.page, 1);
  assert.deepEqual(result.rows, []);
});

test('pageHref keeps the filters, drops empty ones and page 1', () => {
  const current = readFilters({ search: 'peely', rarity: '', video: 'clip', page: '4' });

  assert.equal(pageHref('/admin/cosmetics', current, 1), '/admin/cosmetics?search=peely&video=clip');
  assert.equal(pageHref('/admin/cosmetics', current, 5), '/admin/cosmetics?search=peely&video=clip&page=5');
  assert.equal(pageHref('/admin/videos', readFilters({}), 1), '/admin/videos');
});

test('videoTotals counts outfit coverage and videos across every type', () => {
  const totals = videoTotals(database, new Set(['Character_B', 'EID_Wave']));

  assert.deepEqual(totals, { outfits: 4, youtube: 2, clips: 1, missing: 1, withVideo: 4 });
});

test('filterOptions labels each type and rarity by its most common real name', () => {
  database.prepare("UPDATE cosmetics SET type_name = 'Outfit' WHERE type = 'outfit'").run();
  // Upstream placeholders carry the literal string "null", which sorts after "Outfit".
  database.prepare("UPDATE cosmetics SET type_name = 'null' WHERE id = 'Character_A'").run();
  database.prepare("UPDATE cosmetics SET rarity_name = 'Epic' WHERE rarity = 'epic'").run();

  const { types, rarities } = filterOptions(database);

  assert.deepEqual(types, [
    { type: 'outfit', label: 'Outfit', count: 4 },
    { type: 'emote', label: 'emote', count: 1 },
  ]);
  assert.deepEqual(rarities.find((r) => r.rarity === 'epic'), { rarity: 'epic', label: 'Epic', count: 2 });
  assert.deepEqual(rarities.find((r) => r.rarity === 'legendary'), { rarity: 'legendary', label: 'legendary', count: 1 });
});

test('upstream placeholder "null" strings read as missing on a card', () => {
  database.prepare("UPDATE cosmetics SET name = 'null', type_name = 'null', set_name = 'null' WHERE id = 'EID_Wave'").run();

  const [row] = queryGallery(database, filters({ type: 'emote' }), new Set()).rows;

  assert.equal(row.name, 'EID_Wave');
  assert.equal(row.type_name, null);
  assert.equal(row.set_name, null);
});

test('youtubeId accepts an eleven-character id and nothing else', () => {
  assert.equal(youtubeId('y1xhSqnMX-I'), 'y1xhSqnMX-I');
  assert.equal(youtubeId('short'), null);
  assert.equal(youtubeId('y1xhSqnMX-I"><script>'), null);
  assert.equal(youtubeId(null), null);
});
