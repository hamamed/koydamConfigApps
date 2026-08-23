/**
 * Colour maths for the catalogue's colour filter.
 *
 * Skins are stored with the HSL of their dominant garment colour rather than a bucket name, so
 * the buckets can be retuned later without re-processing every upload.
 */

export function rgbToHsl({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return { hue, saturation, lightness };
}

export function rgbToHex({ r, g, b }) {
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Named colour buckets, as hue ranges in degrees.
 *
 * `mono` is defined by the absence of saturation rather than by hue — a black hoodie has a
 * meaningless hue, and lumping it in with whatever it rounds to would put it under a random chip.
 */
export const COLOR_BUCKETS = {
  red: { hue: [345, 15], hex: '#ff5a6e' },
  orange: { hue: [15, 45], hex: '#ffa03d' },
  yellow: { hue: [45, 70], hex: '#ffe23d' },
  green: { hue: [70, 165], hex: '#6bd97a' },
  cyan: { hue: [165, 200], hex: '#2de2e6' },
  blue: { hue: [200, 255], hex: '#5a8dff' },
  purple: { hue: [255, 295], hex: '#a06bff' },
  pink: { hue: [295, 345], hex: '#ff6bd0' },
  mono: { monochrome: true, hex: '#9a9aae' },
};

/** Below this, a colour reads as grey rather than as a hue. */
export const MONOCHROME_SATURATION = 0.16;

export function normaliseColor(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.hasOwn(COLOR_BUCKETS, key) ? key : null;
}

/**
 * SQL fragment + params selecting one bucket.
 *
 * Red wraps past 360°, so its range has to be expressed as two comparisons joined by OR rather
 * than a single BETWEEN — which would match nothing at all.
 */
export function colorFilterSql(bucketName, paramPrefix = 'color') {
  const bucket = COLOR_BUCKETS[bucketName];
  if (!bucket) return null;

  if (bucket.monochrome) {
    return {
      sql: `(s.color_sat IS NOT NULL AND s.color_sat <= @${paramPrefix}Sat)`,
      params: { [`${paramPrefix}Sat`]: MONOCHROME_SATURATION },
    };
  }

  const [from, to] = bucket.hue;
  const params = {
    [`${paramPrefix}Sat`]: MONOCHROME_SATURATION,
    [`${paramPrefix}From`]: from,
    [`${paramPrefix}To`]: to,
  };

  const hueTest =
    from > to
      ? `(s.color_hue >= @${paramPrefix}From OR s.color_hue < @${paramPrefix}To)`
      : `(s.color_hue >= @${paramPrefix}From AND s.color_hue < @${paramPrefix}To)`;

  return {
    sql: `(s.color_hue IS NOT NULL AND s.color_sat > @${paramPrefix}Sat AND ${hueTest})`,
    params,
  };
}

/** The chip list handed to the client, in spectrum order. */
export function colorChips() {
  return Object.entries(COLOR_BUCKETS).map(([name, bucket]) => ({
    name,
    hex: bucket.hex,
  }));
}
