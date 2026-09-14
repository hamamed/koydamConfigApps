import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardText } from '../scripts/showcase/card.js';

test('a series outfit takes the series tier and its rarity name on the chip', () => {
  const card = cardText({
    id: 'Character_AbstractMirror_Rogue',
    name: 'Solid Snake',
    rarity: { value: 'gaminglegends', displayValue: 'Gaming Legends Series' },
    series: { value: 'Gaming Legends Series' },
  });

  assert.deepEqual(card, { tier: 'gaminglegends', chip: 'GAMING LEGENDS SERIES', name: 'Solid Snake' });
});

test('without a rarity name the chip falls back to the tier label', () => {
  assert.equal(cardText({ id: 'Character_X', name: 'X', rarity: { value: 'gaminglegends' } }).chip, 'GAMING LEGENDS');
});

test('a rarity the app does not know draws as unknown but keeps its own name', () => {
  const card = cardText({ id: 'Character_Y', name: 'Y', rarity: { value: 'transcendent', displayValue: 'Transcendent' } });

  assert.equal(card.tier, 'unknown');
  assert.equal(card.chip, 'TRANSCENDENT');
});

test('a missing name falls back to the id', () => {
  assert.equal(cardText({ id: 'Character_Nameless' }).name, 'Character_Nameless');
});
