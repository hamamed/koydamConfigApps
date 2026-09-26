import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { barChart, niceMax } from '../src/charts.js';
import { openDatabase } from '../src/db/index.js';
import { createDevices, readDeviceRegistration } from '../src/devices.js';
import { addDays, biggestDrop, createPlayers } from '../src/players.js';
import { createProfiles } from '../src/profiles.js';
import { createRepository } from '../src/repository.js';

const TODAY = '2026-09-17';

let db;
let repo;
let players;
let levelIds;

/** One stored event, received on `day` at `time` (UTC). */
function event(device, type, day, { level = null, levelId = null, word = null, help = null, time = '12:00:00', stars = null, seconds = null } = {}) {
  db.prepare(`INSERT INTO events (device, type, level_number, level_id, word, help, seconds, stars, at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(device, type, level, levelId, word, help, seconds, stars, `${day} ${time}`);
}

const open = (device, day, n) => event(device, 'question_opened', day, { level: n, levelId: levelIds[n - 1], word: 1 });
const complete = (device, day, n) => event(device, 'level_completed', day, { level: n, levelId: n ? levelIds[n - 1] : null, stars: 3, seconds: 60 });

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRepository(db);
  levelIds = [];
  for (const pair of [['مصر', 'مرس'], ['قمر', 'مرق'], ['نمر', 'رمن']]) {
    const ids = pair.map((answer) => repo.createQuestion({ title: 'عام', answer, clue: 'x' }).question.id);
    const level = repo.createLevel();
    repo.setLevelQuestions(level.id, ids);
    assert.equal(repo.setPublished(level.id, true).error, undefined);
    levelIds.push(level.id);
  }
  // A draft between published levels is not in the funnel.
  repo.createLevel();
  players = createPlayers(db, { repo });

  // ── Fixture ──────────────────────────────────────────────────────────────
  // A: today, yesterday, 8 days ago. B: today only (first seen today).
  // C: 3 days ago and 2 days ago. D: 10 days ago and 3 days ago (D7 return).
  // E: 40 days ago (outside 30 days). F: 1 day ago, plays at 23:59:59.
  open('A', TODAY, 1); complete('A', TODAY, 1); open('A', TODAY, 2); complete('A', TODAY, 2);
  complete('A', TODAY, 0);
  open('A', addDays(TODAY, -1), 1);
  open('A', addDays(TODAY, -8), 1);
  open('B', TODAY, 1); complete('B', TODAY, 1); complete('B', TODAY, 0);
  open('C', addDays(TODAY, -3), 1); complete('C', addDays(TODAY, -3), 1); open('C', addDays(TODAY, -2), 2);
  open('D', addDays(TODAY, -10), 1); open('D', addDays(TODAY, -3), 1);
  open('E', addDays(TODAY, -40), 1);
  event('F', 'question_opened', addDays(TODAY, -1), { level: 1, levelId: levelIds[0], word: 1, time: '23:59:59' });
  // Tomorrow's clock skew must not count today.
  event('G', 'question_opened', addDays(TODAY, 1), { level: 3, levelId: levelIds[2], word: 1, time: '00:00:00' });

  for (const [help, n, day] of [['revealLetter', 3, TODAY], ['solveWord', 1, addDays(TODAY, -5)], ['askFriend', 2, TODAY], ['removeLetters', 4, addDays(TODAY, -31)]]) {
    // The old removeLetters helps come from H, 31 days ago: outside every 30-day window.
    for (let i = 0; i < n; i++) event(help === 'removeLetters' ? 'H' : 'A', 'help_used', day, { level: 1, levelId: levelIds[0], word: 1, help });
  }

  const devices = createDevices(db);
  devices.register(readDeviceRegistration({ device: 'device-A-0000', token: 'a'.repeat(64), platform: 'ios', environment: 'production' }).registration);
  devices.register(readDeviceRegistration({ device: 'device-B-0000', token: 'b'.repeat(64), platform: 'ios', environment: 'sandbox', enabled: false }).registration);
});

test('KPIs count distinct devices by UTC day and completions today', () => {
  assert.deepEqual(players.kpis(TODAY), {
    today: 2,                // A, B (G is tomorrow)
    week: 5,                 // A, B, C, D, F
    month: 5,                // + nobody: E is 40 days ago
    levelsCompletedToday: 3, // A×2, B×1
    dailyCompletedToday: 2,  // A, B
    wordSearchCompletedToday: 0,
    notificationsEnabled: 1,
    newToday: 1,             // B
    newMonth: 5,             // A, B, C, D, F (first seen in the last 30 days)
    questionsSolvedToday: 0,
  });
});

test('word search over 30 days: started, completed, players, average time and stars, words found', () => {
  const ws = (device, type, day, extra = {}) => event(device, type, day, { level: 0, ...extra });
  ws('A', 'wordsearch_started', TODAY);
  ws('A', 'wordsearch_word_found', TODAY, { word: 4 });
  ws('A', 'wordsearch_word_found', TODAY, { word: 5 });
  ws('A', 'wordsearch_completed', TODAY, { seconds: 100, stars: 3 });
  ws('B', 'wordsearch_started', addDays(TODAY, -3));
  ws('B', 'wordsearch_completed', addDays(TODAY, -3), { seconds: 200, stars: 2 });
  ws('C', 'wordsearch_started', addDays(TODAY, -2));
  // Outside the window.
  ws('E', 'wordsearch_completed', addDays(TODAY, -40), { seconds: 999, stars: 0 });

  assert.deepEqual(players.wordSearch(TODAY), {
    days: 30, started: 3, completed: 2, players: 2, avgSeconds: 150, avgStars: 2.5, wordsFound: 2, completionRate: 2 / 3,
  });
  assert.equal(players.kpis(TODAY).wordSearchCompletedToday, 1);
  assert.equal(players.dashboard(TODAY).wordSearch.completed, 2);
});

test('word search with no events reads as zeros and no averages', () => {
  assert.deepEqual(players.wordSearch(TODAY), {
    days: 30, started: 0, completed: 0, players: 0, avgSeconds: null, avgStars: null, wordsFound: 0, completionRate: null,
  });
});

test('players per day covers 30 days, zero-filled, oldest first', () => {
  const days = players.playersPerDay(TODAY);
  assert.equal(days.length, 30);
  assert.deepEqual(days[0], { date: addDays(TODAY, -29), players: 0 });
  assert.deepEqual(days.at(-1), { date: TODAY, players: 2 });
  const get = (n) => days.find((d) => d.date === addDays(TODAY, -n)).players;
  assert.deepEqual([get(1), get(2), get(3), get(5), get(8), get(10)], [2, 1, 2, 1, 1, 1]);
  assert.equal(days.reduce((sum, d) => sum + d.players, 0), 10);
});

test('the funnel counts openers and finishers per published level against level 1', () => {
  const { base, rows, drop } = players.funnel();
  assert.equal(base, 6); // A B C D E F
  assert.deepEqual(rows.map((r) => [r.number, r.opened, r.completed]), [[1, 6, 3], [2, 2, 1], [3, 1, 0]]);
  assert.deepEqual(rows.map((r) => Math.round(r.completedShare * 100)), [50, 17, 0]);
  assert.equal(rows[1].openedShare, 2 / 6);
  assert.deepEqual(drop, { index: 0, stage: 'within', lost: 3 });
});

test('biggest drop can fall between levels, and is null when nothing drops', () => {
  assert.deepEqual(biggestDrop([{ opened: 10, completed: 9 }, { opened: 2, completed: 2 }]), { index: 0, stage: 'between', lost: 7 });
  assert.equal(biggestDrop([{ opened: 0, completed: 0 }]), null);
});

test('helps over the last 30 days, with shares, largest first', () => {
  const { total, rows } = players.helps(TODAY);
  assert.equal(total, 6);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.help, r.count]), [['revealLetter', 3], ['askFriend', 2], ['solveWord', 1]]);
  assert.equal(rows[0].share, 0.5);
  assert.equal(rows.find((r) => r.help === 'removeLetters').count, 0);
  assert.equal(rows.length, 6);
});

test('D1 and D7 retention over complete cohorts', () => {
  const { d1, d7 } = players.retention(TODAY);
  // D1 cohorts end 2 days ago (their day +1 = yesterday is complete).
  // First-seen days in range: C (-3), D (-10), A (-8), H (-31); E (-40) is out, F (-1) and B (today) too recent.
  assert.deepEqual([d1.from, d1.to], [addDays(TODAY, -31), addDays(TODAY, -2)]);
  assert.deepEqual([d1.cohort, d1.returned], [4, 1]); // only C came back the next day (-2)
  // D7 cohorts end 8 days ago: A (-8), D (-10), H (-31). A came back on -1 and D on -3 (both day +7); H never.
  assert.deepEqual([d7.from, d7.to], [addDays(TODAY, -37), addDays(TODAY, -8)]);
  assert.deepEqual([d7.cohort, d7.returned, d7.rate], [3, 2, 2 / 3]);
});

test('the dashboard queries use indexes, not table scans of events', () => {
  const plans = [
    "SELECT COUNT(DISTINCT device) FROM events WHERE received_at >= '2026-09-01' AND received_at < '2026-09-18'",
    "SELECT level_id, type, COUNT(DISTINCT device) FROM events WHERE type IN ('question_opened', 'level_completed') AND level_id IS NOT NULL GROUP BY level_id, type",
    "SELECT help, COUNT(*) FROM events WHERE type = 'help_used' AND received_at >= '2026-09-01' GROUP BY help",
    'SELECT device, MIN(received_at) FROM events GROUP BY device',
  ].map((sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | '));
  for (const plan of plans) {
    assert.match(plan, /USING (COVERING )?INDEX/, plan);
    assert.doesNotMatch(plan, /SCAN events(?! USING)/, plan);
  }
});

test('the bar chart scales to a round maximum and labels the axis', () => {
  assert.equal(niceMax(0), 4);
  assert.equal(niceMax(7), 8);
  assert.equal(niceMax(23), 40);
  assert.equal(niceMax(130), 200);
  const svg = barChart([{ label: '15/09', value: 3 }, { label: '16/09', value: 0 }, { label: '<17>', value: 7 }], { xEvery: 2, label: 'Players' });
  assert.equal((svg.match(/class="wz-chart-bar"/g) ?? []).length, 3);
  assert.equal((svg.match(/class="wz-chart-hit"/g) ?? []).length, 3, 'each day\'s whole column is its hover target');
  assert.equal((svg.match(/<title>/g) ?? []).length, 3);
  assert.match(svg, /aria-label="Players"/);
  assert.match(svg, />8<\/text>/);
  assert.match(svg, />&lt;17&gt;<\/text>/);
  assert.doesNotMatch(svg, />16\/09<\/text>/);
});

// ── The dashboard's extra views ─────────────────────────────────────────────

test('new players: first seen per day over 30 days, and today and this month', () => {
  // First seen: A −8, B today, C −3, D −10, F −1 inside 30 days; E −40 and H −31 outside; G is tomorrow.
  const days = players.newPerDay(TODAY);
  assert.equal(days.length, 30);
  assert.equal(days.at(-1).date, TODAY);
  const byDate = Object.fromEntries(days.map((d) => [d.date, d.players]));
  assert.equal(byDate[TODAY], 1);
  assert.equal(byDate[addDays(TODAY, -3)], 1);
  assert.equal(days.reduce((sum, d) => sum + d.players, 0), 5);
  const kpis = players.kpis(TODAY);
  assert.equal(kpis.newToday, 1);
  assert.equal(kpis.newMonth, 5);
});

test('activity per day: levels finished and questions solved, zero-filled', () => {
  event('A', 'question_solved', TODAY, { level: 1, levelId: levelIds[0], word: 1 });
  event('B', 'question_solved', TODAY, { level: 1, levelId: levelIds[0], word: 1 });
  event('C', 'question_solved', addDays(TODAY, -3), { level: 1, levelId: levelIds[0], word: 1 });
  const days = players.activityPerDay(TODAY);
  assert.equal(days.length, 30);
  const today = days.at(-1);
  assert.deepEqual([today.date, today.levels, today.questions], [TODAY, 3, 2], 'A finished 1 and 2, B finished 1; the daily puzzle is not a level');
  assert.equal(days.find((d) => d.date === addDays(TODAY, -3)).levels, 1);
  assert.equal(players.kpis(TODAY).questionsSolvedToday, 2);
});

test('activity by hour of the day (UTC) over the last 7 days', () => {
  const hours = players.byHour(TODAY);
  assert.equal(hours.length, 24);
  assert.deepEqual(hours.map((h) => h.hour), Array.from({ length: 24 }, (_, i) => i));
  assert.equal(hours[23].players, 1, 'F at 23:59:59 yesterday');
  assert.ok(hours[12].players >= 3, 'the rest play at noon');
  assert.equal(hours[0].players, 0, "tomorrow's clock skew is not the past week");
});

test('daily games finished over 30 days, by game, largest first', () => {
  for (const [type, n] of [['wheel_completed', 3], ['guess_completed', 1], ['connect_completed', 2], ['wordsearch_completed', 2]]) {
    for (let i = 0; i < n; i++) event(`P${i}`, type, TODAY, { level: 0 });
  }
  event('Q', 'bubbles_completed', addDays(TODAY, -40), { level: 0 });
  const games = players.dailyGames(TODAY);
  assert.deepEqual(games.rows.slice(0, 3).map((g) => [g.game, g.count]), [['wheel', 3], ['connect', 2], ['wordsearch', 2]]);
  assert.equal(games.rows.find((g) => g.game === 'bubbles').count, 0, '40 days ago is outside');
  assert.equal(games.total, 8);
});

test('named players: every profile, and those made this month and today', () => {
  const profiles = createProfiles(db, { now: () => new Date(`${TODAY}T10:00:00Z`) });
  profiles.create({ username: 'layla', avatar: 'moon' });
  profiles.create({ username: 'rabab', avatar: 'moon' });
  db.prepare("UPDATE profiles SET created_at = ? WHERE username = 'rabab'").run(`${addDays(TODAY, -45)} 09:00:00`);
  db.prepare("UPDATE profiles SET created_at = ? WHERE username = 'layla'").run(`${TODAY} 09:00:00`);
  assert.deepEqual(players.named(TODAY), { total: 2, month: 1, today: 1 });
});

test('the new dashboard queries use indexes too', () => {
  const plans = [
    "SELECT substr(received_at, 12, 2), COUNT(DISTINCT device) FROM events WHERE received_at >= '2026-09-11' AND received_at < '2026-09-18' GROUP BY 1",
    "SELECT type, COUNT(*) FROM events WHERE type IN ('wheel_completed', 'guess_completed') AND received_at >= '2026-09-01' AND received_at < '2026-09-18' GROUP BY type",
  ].map((sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | '));
  for (const plan of plans) assert.match(plan, /USING (COVERING )?INDEX/, plan);
});
