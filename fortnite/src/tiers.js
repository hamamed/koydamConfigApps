/**
 * The Fortnite Companion app's tiers: which colour a cosmetic is drawn in.
 *
 * A mirror of FortniteCompanion/DesignSystem/Rarity.swift, so the panel and the
 * rendered clips colour an item exactly as the app does. Change one, change
 * both.
 *
 * `gradientEnd` is listed rather than derived. The app computes it as the tier
 * colour shifted by hue −0.045, saturation +0.10, brightness −0.34 in HSB
 * (with fixed values for common, shadow and crew); these are those results.
 */

export const TIERS = Object.freeze({
  common: { label: 'Common', color: 'FFFFFF', gradientEnd: 'B9B9C6', glowOpacity: 0.18, prefersDarkText: true },
  uncommon: { label: 'Uncommon', color: '319236', gradientEnd: '183B0E', glowOpacity: 0.35, prefersDarkText: false },
  rare: { label: 'Rare', color: '4C51F7', gradientEnd: '2147A0', glowOpacity: 0.35, prefersDarkText: false },
  epic: { label: 'Epic', color: '9D4DBB', gradientEnd: '3F1F64', glowOpacity: 0.35, prefersDarkText: false },
  legendary: { label: 'Legendary', color: 'FFA500', gradientEnd: 'A83F00', glowOpacity: 0.55, prefersDarkText: false },
  mythic: { label: 'Mythic', color: 'FFD700', gradientEnd: 'A86000', glowOpacity: 0.55, prefersDarkText: true },
  exotic: { label: 'Exotic', color: '00FFFF', gradientEnd: '00A87B', glowOpacity: 0.55, prefersDarkText: true },
  dark: { label: 'Dark', color: '8B00FF', gradientEnd: '2E00A8', glowOpacity: 0.45, prefersDarkText: false },
  frozen: { label: 'Frozen', color: '87CEEB', gradientEnd: '469394', glowOpacity: 0.35, prefersDarkText: true },
  lava: { label: 'Lava', color: 'FF4500', gradientEnd: 'A80000', glowOpacity: 0.45, prefersDarkText: false },
  shadow: { label: 'Shadow', color: '2F2F2F', gradientEnd: '0B0B0F', glowOpacity: 0.30, prefersDarkText: false },
  slurp: { label: 'Slurp', color: '00CED1', gradientEnd: '007A5B', glowOpacity: 0.35, prefersDarkText: false },
  marvel: { label: 'Marvel', color: 'ED1D24', gradientEnd: '960330', glowOpacity: 0.45, prefersDarkText: false },
  dc: { label: 'DC', color: '1877F2', gradientEnd: '006E9B', glowOpacity: 0.45, prefersDarkText: false },
  starwars: { label: 'Star Wars', color: '00B4D8', gradientEnd: '008174', glowOpacity: 0.45, prefersDarkText: false },
  icon: { label: 'Icon', color: '00F0FF', gradientEnd: '00A885', glowOpacity: 0.55, prefersDarkText: true },
  gaminglegends: { label: 'Gaming Legends', color: '4B0082', gradientEnd: '0D002B', glowOpacity: 0.35, prefersDarkText: false },
  crew: { label: 'Crew', color: 'F5C542', gradientEnd: 'B25FE6', glowOpacity: 0.50, prefersDarkText: false },
  unknown: { label: 'Unknown', color: '8A8A99', gradientEnd: '353942', glowOpacity: 0.35, prefersDarkText: false },
});

/** Checked in this order against the upper-cased series, as the app checks them. */
const SERIES_RULES = [
  ['CREW', 'crew'],
  ['MARVEL', 'marvel'],
  ['DC', 'dc'],
  ['STAR WARS', 'starwars'],
  ['ICON', 'icon'],
  ['GAMING LEGENDS', 'gaminglegends'],
  ['DARK', 'dark'],
  ['FROZEN', 'frozen'],
  ['LAVA', 'lava'],
  ['SHADOW', 'shadow'],
  ['SLURP', 'slurp'],
];

/**
 * The tier to draw. Series wins where it names one: an Icon Series outfit is
 * legendary by rarity, and drawing it orange loses what makes it recognisable.
 *
 * @param {string | null | undefined} rarity upstream `rarity.value`
 * @param {string | null | undefined} series upstream `series.value`
 * @returns {keyof typeof TIERS}
 */
export function resolveTier(rarity, series) {
  if (typeof series === 'string') {
    const upper = series.toUpperCase();
    const rule = SERIES_RULES.find(([needle]) => upper.includes(needle));
    if (rule) return rule[1];
  }
  const key = String(rarity ?? '').toLowerCase();
  return Object.hasOwn(TIERS, key) ? key : 'unknown';
}
