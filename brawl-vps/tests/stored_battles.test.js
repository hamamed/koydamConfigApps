import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.BRAWL_API_TOKEN ??= 'test-token';
process.env.LOG_LEVEL = 'error';
const { apiStamp, storedBattleItems } = await import('../src/transform/stored_battles.js');

test('timestamps match the live battle log exactly (the app dedupes on them)', () => {
  assert.equal(apiStamp('2026-11-10T11:33:04Z'), '20261110T113304.000Z');
  assert.equal(apiStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '20260102T030405.000Z');
});

const row = (over) => ({
  battle_key: 'k1', battle_time: '2026-11-10T11:33:04Z', mode: 'brawlBall', map: 'Sunny Soccer', battle_type: 'ranked',
  duration: 120, is_showdown: false, player_tag: '#ME', player_name: 'Me', team_index: 0, brawler_id: 16000000,
  brawler_name: 'SHELLY', brawler_power: 11, brawler_trophies: 700, is_star_player: false, won: true, trophy_change: 8, ...over,
});

test('a stored 3v3 battle becomes a battle-log item from the player\'s side', () => {
  const items = storedBattleItems([
    row({}),
    row({ player_tag: '#A', player_name: 'Ally', is_star_player: true, trophy_change: null }),
    row({ player_tag: '#R', player_name: 'Rival', team_index: 1, won: false, trophy_change: null }),
  ], '#ME');
  assert.equal(items.length, 1);
  const b = items[0];
  assert.equal(b.battleTime, '20261110T113304.000Z');
  assert.equal(b.result, 'victory');
  assert.equal(b.trophyChange, 8);
  assert.equal(b.starPlayer.tag, '#A');
  assert.equal(b.isStarPlayer, false);
  assert.deepEqual(b.teams.map((t) => t.map((p) => p.tag)), [['#ME', '#A'], ['#R']]);
  assert.equal(b.playerBrawler.id, 16000000);
});

test('showdown has no stored placement: draw, no rank; battles without the player are dropped', () => {
  const items = storedBattleItems([
    row({ battle_key: 'sd', is_showdown: true, won: null, team_index: null, mode: 'soloShowdown' }),
    row({ battle_key: 'other', player_tag: '#X' }),
  ], '#ME');
  assert.equal(items.length, 1);
  assert.equal(items[0].result, 'draw');
  assert.equal(items[0].rank, null);
});
