import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { TIERS } from '../src/tiers.js';

const CSS_PATH = new URL('../public/css/gallery.css', import.meta.url);

const rgb = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ');

/** The declarations of one rule, or null when the stylesheet has no such rule. */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : null;
}

test('the panel draws every tier with the app backdrop: tier colour at .55 to gradient end at .95', async () => {
  const css = await readFile(CSS_PATH, 'utf8');

  Object.entries(TIERS).forEach(([key, tier]) => {
    const body = ruleBody(css, `.fg-tier-${key}`);
    assert.ok(body, `.fg-tier-${key} is missing`);
    assert.ok(body.includes(`rgba(${rgb(tier.color)}, .55)`), `.fg-tier-${key} top stop`);
    assert.ok(body.includes(`rgba(${rgb(tier.gradientEnd)}, .95)`), `.fg-tier-${key} bottom stop`);
  });
});

test('the old rarity-keyed backdrops are gone, so nothing can drift back to them', async () => {
  const css = await readFile(CSS_PATH, 'utf8');

  assert.equal(/\.fg-rarity-/.test(css), false);
});
