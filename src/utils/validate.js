export const CATEGORIES = ['shirt', 'pants', 'tshirt', 'avatar'];

export const CATEGORY_LABELS = {
  shirt: 'Shirt',
  pants: 'Pants',
  tshirt: 'T-Shirt',
  avatar: 'Avatar',
};

/** Plural forms the iOS client sends in `?category=`, mapped back to the stored singular. */
const CATEGORY_ALIASES = {
  shirt: 'shirt', shirts: 'shirt',
  pant: 'pants', pants: 'pants',
  tshirt: 'tshirt', tshirts: 'tshirt', 't-shirt': 'tshirt', 't-shirts': 'tshirt',
  avatar: 'avatar', avatars: 'avatar', '3d': 'avatar', texture: 'avatar',
};

export function normaliseCategory(value) {
  if (!value) return null;
  return CATEGORY_ALIASES[String(value).trim().toLowerCase()] || null;
}

export const SORTS = ['trending', 'newest', 'mostDownloaded'];

export function normaliseSort(value) {
  const sort = String(value || '').trim();
  return SORTS.includes(sort) ? sort : 'trending';
}

/**
 * The dimensions Roblox expects for classic clothing. Uploads that don't match are flagged
 * rather than rejected outright — an avatar texture legitimately isn't 585×559, and a creator
 * shouldn't be blocked because our validator is stricter than Roblox is.
 */
export const TEMPLATE_SIZE = { width: 585, height: 559 };

export function checkTemplateDimensions(category, width, height) {
  if (category === 'avatar') return { ok: true, warning: null };
  if (width === TEMPLATE_SIZE.width && height === TEMPLATE_SIZE.height) {
    return { ok: true, warning: null };
  }
  return {
    ok: true,
    warning:
      `Template is ${width}×${height}. Roblox classic clothing expects ` +
      `${TEMPLATE_SIZE.width}×${TEMPLATE_SIZE.height} — this will still upload, but check the ` +
      `artwork lines up before publishing.`,
  };
}

/**
 * Why someone reported a skin.
 *
 * A fixed vocabulary rather than free text: it makes the reports sortable, lets the admin see
 * "nine people say this template is misaligned" at a glance, and keeps the reporting flow to one
 * tap. The optional note carries anything the list doesn't cover.
 */
export const REPORT_REASONS = {
  broken: "Doesn't work in Roblox",
  sizing: 'Wrong size or misaligned',
  quality: 'Poor quality artwork',
  inappropriate: 'Inappropriate content',
  copyright: 'Copyright or stolen design',
  other: 'Something else',
};

export function normaliseReason(value) {
  const reason = String(value || '').trim().toLowerCase();
  return Object.hasOwn(REPORT_REASONS, reason) ? reason : null;
}

/** Reports that need a human to look at them urgently, surfaced first in the admin. */
export const URGENT_REASONS = new Set(['inappropriate', 'copyright']);

/** Trims, collapses whitespace and enforces a length ceiling on free-text fields. */
export function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
