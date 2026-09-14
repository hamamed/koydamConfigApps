import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TIERS, resolveTier } from '../src/tiers.js';

test('series wins over rarity, the way the app resolves a tier', () => {
  assert.equal(resolveTier('legendary', 'Icon Series'), 'icon');
  assert.equal(resolveTier('epic', 'MARVEL SERIES'), 'marvel');
  assert.equal(resolveTier('epic', 'Gaming Legends Series'), 'gaminglegends');
  assert.equal(resolveTier('epic', 'Star Wars Series'), 'starwars');
  assert.equal(resolveTier('epic', 'DC SERIES'), 'dc');
  assert.equal(resolveTier('rare', 'CREW SERIES'), 'crew');
  assert.equal(resolveTier('rare', 'Lava Series'), 'lava');
});

test('a series the app does not know falls back to the rarity', () => {
  assert.equal(resolveTier('rare', 'Some Future Series'), 'rare');
});

test('rarity is matched case-insensitively and anything unknown is unknown', () => {
  assert.equal(resolveTier('EPIC', null), 'epic');
  assert.equal(resolveTier('transcendent', null), 'unknown');
  assert.equal(resolveTier(null, null), 'unknown');
});

test('carries the app palette for a tier', () => {
  assert.deepEqual(TIERS.epic, {
    label: 'Epic', color: '9D4DBB', gradientEnd: '3F1F64', glowOpacity: 0.35, prefersDarkText: false,
  });
  assert.deepEqual(TIERS.legendary, {
    label: 'Legendary', color: 'FFA500', gradientEnd: 'A83F00', glowOpacity: 0.55, prefersDarkText: false,
  });
  assert.equal(TIERS.icon.prefersDarkText, true);
  assert.equal(TIERS.shadow.gradientEnd, '0B0B0F');
});

test('labels follow the app, including the three it spells out', () => {
  assert.equal(TIERS.gaminglegends.label, 'Gaming Legends');
  assert.equal(TIERS.starwars.label, 'Star Wars');
  assert.equal(TIERS.dc.label, 'DC');
  assert.equal(TIERS.common.label, 'Common');
});

test('every tier the app draws is present and well formed', () => {
  const expected = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exotic', 'dark', 'frozen',
    'lava', 'shadow', 'slurp', 'marvel', 'dc', 'starwars', 'icon', 'gaminglegends', 'crew', 'unknown'];

  assert.deepEqual(Object.keys(TIERS).sort(), [...expected].sort());
  Object.entries(TIERS).forEach(([key, tier]) => {
    assert.match(tier.color, /^[0-9A-F]{6}$/, key);
    assert.match(tier.gradientEnd, /^[0-9A-F]{6}$/, key);
    assert.ok(tier.glowOpacity > 0 && tier.glowOpacity <= 1, key);
  });
});
