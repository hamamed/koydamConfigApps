/**
 * Fills the catalogue with generated skins so a fresh install has something to look at.
 *
 * The artwork is real: each template is drawn through the same R6 unwrap coordinates the iOS
 * renderer samples from, so a seeded catalogue exercises the whole pipeline — upload processing,
 * preview derivation, the API contract and the 3D preview in the app.
 *
 * Usage:  npm run seed [count]
 */
import sharp from 'sharp';
import { db, migrate } from './index.js';
import { createSkin } from '../services/skins.js';
import { storeTemplate, derivePreview, dominantColor } from '../services/images.js';
import { generateSkinId, slugify } from '../utils/ids.js';
import { TEMPLATE_SIZE, facesFor, FACE_SHADE } from '../utils/template-layout.js';

migrate();

const COUNT = Math.min(Number(process.argv[2]) || 24, 200);

const ADJECTIVES = [
  'Cyberpunk', 'Midnight', 'Neon', 'Frost', 'Golden', 'Void', 'Retro', 'Aurora',
  'Shadow', 'Prism', 'Lunar', 'Toxic', 'Velvet', 'Chrome', 'Ember', 'Glitch',
];

const NOUNS = {
  shirt: ['Hoodie', 'Bomber', 'Varsity Jacket', 'Puffer', 'Windbreaker'],
  pants: ['Cargos', 'Joggers', 'Ripped Jeans', 'Track Pants'],
  tshirt: ['Tee', 'Graphic Tee', 'Jersey', 'Tank'],
  avatar: ['Full Kit', 'Bodysuit', 'Armour Set'],
};

const TAGS = [
  'cyberpunk', 'neon', 'aesthetic', 'y2k', 'streetwear', 'anime',
  'goth', 'vintage', 'sport', 'minimal', 'grunge', 'techwear',
];

const CATEGORIES = Object.keys(NOUNS);

function hsl(hue, saturation, lightness) {
  return `hsl(${Math.round(hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%)`;
}

/** Draws a template through the shared layout, so seeded art lines up with the real thing. */
function templateSvg(hue, category) {
  const complement = (hue + 180) % 360;

  const rects = facesFor(category).map(({ face, rect, shade }) => {
    const isTorsoFront = rect.width === 128 && face === 'front';
    const parts = [
      `<rect x="${rect.left}" y="${rect.top}" width="${rect.width}" height="${rect.height}"
             fill="${hsl(hue, 58, 44 * shade)}"/>`,
      `<rect x="${rect.left}" y="${rect.top}" width="${rect.width}" height="${rect.height * 0.1}"
             fill="${hsl(complement, 72, 56 * shade)}"/>`,
    ];

    if (isTorsoFront) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      parts.push(
        `<circle cx="${cx}" cy="${cy}" r="${rect.width * 0.19}" fill="none"
                 stroke="${hsl(complement, 76, 62)}" stroke-width="${rect.width * 0.055}"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${rect.width * 0.07}" fill="${hsl(complement, 40, 88)}"/>`
      );
    } else if (face === 'front' || face === 'back') {
      parts.push(
        `<rect x="${rect.left + rect.width * 0.22}" y="${rect.top}"
               width="${rect.width * 0.13}" height="${rect.height}"
               fill="${hsl(complement, 70, 54 * shade)}"/>`
      );
    }
    return parts.join('');
  }).join('');

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TEMPLATE_SIZE.width}" height="${TEMPLATE_SIZE.height}">
       ${rects}
     </svg>`
  );
}

const existing = db.prepare('SELECT COUNT(*) AS count FROM skins').get().count;
if (existing > 0) {
  console.log(`  Catalogue already has ${existing} skins — nothing to seed.`);
  process.exit(0);
}

const author = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

console.log(`  Seeding ${COUNT} skins…`);

for (let index = 0; index < COUNT; index += 1) {
  const category = CATEGORIES[index % CATEGORIES.length];
  const title = `${ADJECTIVES[(index * 7) % ADJECTIVES.length]} ${NOUNS[category][(index * 3) % NOUNS[category].length]}`;
  const id = generateSkinId();
  const base = `${slugify(title, id)}-${id.slice(5)}`;

  const png = await sharp(templateSvg((index * 47) % 360, category)).png().toBuffer();
  const stored = await storeTemplate(png, `${base}.png`);
  const preview = await derivePreview(png, `${base}.webp`, category);

  createSkin({
    id,
    title,
    color: await dominantColor(png, category),
    category,
    description: `A ${title.toLowerCase()} for your Roblox avatar.`,
    tags: [TAGS[(index * 5) % TAGS.length], TAGS[(index * 11) % TAGS.length]],
    templateFile: stored.filename,
    previewFile: preview.filename,
    templateW: stored.width,
    templateH: stored.height,
    fileBytes: stored.bytes + preview.bytes,
    isFeatured: index % 6 === 1,
    isPublished: index % 11 !== 5,
    createdBy: author?.id ?? null,
  });

  // Give the seeded catalogue a believable download history so the dashboard charts and the
  // "trending" sort have something real to work with.
  const days = 14;
  const popularity = Math.max(0, 1 - index / COUNT);
  const insertEvent = db.prepare(
    `INSERT INTO download_events (skin_id, day, client_key, created_at)
     VALUES (?, ?, ?, datetime('now', ?))`
  );
  const bump = db.prepare('UPDATE skins SET downloads = downloads + ? WHERE id = ?');

  let total = 0;
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - offset);
    const iso = day.toISOString().slice(0, 10);
    const count = Math.round(Math.random() * 12 * popularity + popularity * 4);
    for (let n = 0; n < count; n += 1) {
      // A bounded pool of fake clients, so unique-downloader counts land in a believable range
      // rather than equalling the download count exactly.
      insertEvent.run(id, iso, `seed-${(index * 7 + n) % 60}-${iso}`, `-${offset} days`);
    }
    total += count;
  }
  bump.run(total + Math.round(popularity * 4000), id);

  process.stdout.write(`\r  ${index + 1}/${COUNT}`);
}

console.log('\n  Seed complete.');
