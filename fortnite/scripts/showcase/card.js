import { TIERS, resolveTier } from '../../src/tiers.js';

/**
 * What a clip says about a cosmetic: its tier, the rarity chip and the name,
 * worded as the app's detail sheet words them. The chip is the rarity name
 * upper-cased, or the tier label where upstream gives no name.
 *
 * @param {object} item one cosmetic from Fortnite-API `/v2/cosmetics/br`
 * @returns {{ tier: string, chip: string, name: string }}
 */
export function cardText(item) {
  const tier = resolveTier(item.rarity?.value, item.series?.value);
  const rarityName = item.rarity?.displayValue ?? null;
  const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id;

  return { tier, chip: (rarityName ?? TIERS[tier].label).toUpperCase(), name };
}
