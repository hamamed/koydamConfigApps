/**
 * A sample catalogue.
 *
 *   npm run seed          # 30 items
 *   npm run seed 60
 *
 * Everything it makes is real: real 64×64 skin textures, real ZIP archives with real
 * manifests and icons inside them. They go through the same ingest pipeline an upload does,
 * so the seeded catalogue exercises the skin renderer, the archive inspector and the icon
 * lifter rather than side-stepping all three with rows written straight into the database.
 *
 * That is the point of it. Sample data that skips the code under development tells you the
 * app looks fine right up until the first real upload.
 */

import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, migrate } from './index.js';
import { createItem, logAudit } from '../services/items.js';
import { ingest } from '../services/ingest.js';
import { generateItemId } from '../utils/ids.js';
import { writeZip } from '../utils/zip.js';
import { CATEGORIES } from '../utils/validate.js';

const count = Math.min(200, Math.max(1, Number.parseInt(process.argv[2], 10) || 30));

migrate();

const author = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ?? null;

const VERSIONS = ['1.21', '1.21', '1.20.80', '1.20.80', '1.20.30', '1.19.80'];

const NAMES = {
  skin: ['Neon Ninja', 'Frost Knight', 'Ender Wanderer', 'Redstone Engineer', 'Deep Dark Diver',
    'Cherry Blossom', 'Golden Pharaoh', 'Void Walker', 'Copper Automaton', 'Blaze Rider'],
  addon: ['Dragon Mounts', 'More Furniture', 'Working Cars', 'Elemental Magic', 'Cave Monsters',
    'Better Villagers', 'Portal Gun', 'Bigger Backpacks', 'Guns and Grenades', 'Tameable Wolves'],
  texture: ['Soft Realism', 'PvP Bare Bones', 'Water Shaders', 'Cartoon Blocks', 'Medieval Stone',
    'Clean UI', 'Autumn Leaves', 'Neon Night', 'Paper Craft', 'Deep Ocean'],
  world: ['Sky Islands', 'Parkour Palace', 'Haunted Manor', 'Redstone City', 'Survival Bunker',
    'Dropper Deluxe', 'Aquatic Base', 'Desert Temple Run', 'Frozen Kingdom', 'Bedwars Arena'],
  seed: ['Triple Village Spawn', 'Stronghold at Spawn', 'Mushroom Island Start', 'Ancient City Dive',
    'Cherry Grove Valley', 'Woodland Mansion Nearby', 'Ravine Diamonds', 'Ocean Monument View',
    'Badlands Mineshaft', 'Speedrun Portal Room'],
};

const TAGS = {
  skin: ['pvp', 'anime', 'cute', 'dark', 'hero', 'mob', 'girl', 'boy', 'glow'],
  addon: ['mobs', 'weapons', 'magic', 'vehicles', 'furniture', 'utility', 'survival'],
  texture: ['realistic', 'shaders', 'pvp', 'cartoon', 'hd', '16x', 'ui'],
  world: ['adventure', 'parkour', 'horror', 'city', 'minigame', 'survival', 'redstone'],
  seed: ['village', 'stronghold', 'island', 'speedrun', 'structure', 'biome'],
};

/**
 * Deterministic randomness, seeded from the item's own index.
 *
 * `Math.random()` would make every run produce a different catalogue, which is exactly wrong
 * for sample data: two people looking at "the seeded addon with the purple icon" should be
 * looking at the same thing.
 */
function rng(seed) {
  let state = seed * 2654435761 % 2147483647;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

/** A skin texture drawn face by face, so the model detection has something real to read. */
async function makeSkin(random, slim) {
  const W = 64;
  const H = 64;
  const data = Buffer.alloc(W * H * 4, 0);

  const put = (x, y, w, h, [r, g, b]) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) {
        const o = (yy * W + xx) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
  };

  const hue = Math.floor(random() * 360);
  const shirt = hsl(hue, 62, 48);
  const trousers = hsl((hue + 200) % 360, 45, 32);
  const skinTone = pick(random, [[224, 178, 140], [198, 134, 96], [140, 88, 60], [246, 214, 186]]);
  const hair = pick(random, [[60, 40, 24], [24, 24, 28], [186, 148, 62], [140, 40, 40]]);
  const arm = slim ? 3 : 4;

  put(8, 8, 8, 8, skinTone);
  put(8, 8, 8, 3, hair);
  put(10, 12, 1, 1, [40, 70, 160]);
  put(13, 12, 1, 1, [40, 70, 160]);
  put(40, 8, 8, 2, hsl((hue + 120) % 360, 70, 52)); // hat layer: a band

  put(20, 20, 8, 12, shirt);
  put(20, 36, 8, 3, hsl(hue, 20, 92));              // jacket layer: a collar

  // Every face of each arm block, not just the front: the classic/slim test reads the top and
  // back faces, and a texture that leaves them blank looks slim whatever its arm width is.
  if (slim) {
    put(44, 16, 3, 4, skinTone); put(47, 16, 3, 4, skinTone);
    put(40, 20, 4, 12, skinTone); put(44, 20, 3, 12, skinTone);
    put(47, 20, 4, 12, skinTone); put(51, 20, 3, 12, skinTone);
    put(36, 48, 3, 4, skinTone); put(39, 48, 3, 4, skinTone);
    put(32, 52, 4, 12, skinTone); put(36, 52, 3, 12, skinTone);
    put(39, 52, 4, 12, skinTone); put(43, 52, 3, 12, skinTone);
  } else {
    put(44, 16, 4, 4, skinTone); put(48, 16, 4, 4, skinTone);
    put(40, 20, 4, 12, skinTone); put(44, 20, 4, 12, skinTone);
    put(48, 20, 4, 12, skinTone); put(52, 20, 4, 12, skinTone);
    put(36, 48, 4, 4, skinTone); put(40, 48, 4, 4, skinTone);
    put(32, 52, 4, 12, skinTone); put(36, 52, 4, 12, skinTone);
    put(40, 52, 4, 12, skinTone); put(44, 52, 4, 12, skinTone);
  }
  put(44, 20, arm, 5, shirt);
  put(36, 52, arm, 5, shirt);

  put(4, 20, 4, 12, trousers);
  put(20, 52, 4, 12, trousers);
  put(4, 28, 4, 4, [50, 40, 35]);
  put(20, 60, 4, 4, [50, 40, 35]);

  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

function hsl(h, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** A pack icon: a coloured field with a lighter block floating in it. */
async function makeIcon(random) {
  const hue = Math.floor(random() * 360);
  const inner = await sharp({
    create: { width: 40, height: 40, channels: 4, background: rgba(hsl((hue + 40) % 360, 70, 62)) },
  }).png().toBuffer();

  return sharp({ create: { width: 128, height: 128, channels: 4, background: rgba(hsl(hue, 55, 34)) } })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toBuffer();
}

const rgba = ([r, g, b]) => ({ r, g, b, alpha: 1 });

/** A Bedrock manifest, in the shape the game reads. */
function manifest(name, modules, random) {
  return JSON.stringify({
    format_version: 2,
    header: {
      name,
      description: `${name} for MineBox`,
      uuid: crypto.randomUUID(),
      version: [1, Math.floor(random() * 6), 0],
      min_engine_version: [1, 20, 0],
    },
    modules: modules.map((type) => ({ type, uuid: crypto.randomUUID(), version: [1, 0, 0] })),
  }, null, 2);
}

async function makeArchive(kind, name, random) {
  const icon = await makeIcon(random);

  if (kind === 'world') {
    return writeZip([
      // Minecraft finds a world by its level.dat. The contents are not a real NBT structure —
      // the catalogue never parses one, and neither does anything before the game does.
      { name: 'level.dat', data: Buffer.from('MINEBOX SAMPLE WORLD') },
      { name: 'levelname.txt', data: name },
      { name: 'world_icon.jpeg', data: icon },
    ]);
  }

  const modules = kind === 'addon' ? ['data', 'resources'] : ['resources'];
  return writeZip([
    { name: 'manifest.json', data: manifest(name, modules, random) },
    { name: 'pack_icon.png', data: icon },
  ]);
}

const EXTENSIONS = { skin: '.png', addon: '.mcaddon', texture: '.mcpack', world: '.mcworld' };

console.log(`  Seeding ${count} items…`);

const kinds = Object.keys(NAMES);
let made = 0;

for (let index = 0; index < count; index += 1) {
  const random = rng(index + 1);
  const kind = kinds[index % kinds.length];
  const base = NAMES[kind][Math.floor(index / kinds.length) % NAMES[kind].length];
  const title = index < kinds.length * NAMES[kind].length ? base : `${base} ${Math.floor(index / 10) + 1}`;

  const id = generateItemId();
  const slim = random() > 0.5;

  let fileBuffer = null;
  let originalName = null;

  if (kind !== 'seed') {
    fileBuffer = kind === 'skin' ? await makeSkin(random, slim) : await makeArchive(kind, title, random);
    originalName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${EXTENSIONS[kind]}`;
  }

  const stored = await ingest({ id, kind, title, fileBuffer, originalName, previewBuffer: null });

  createItem({
    id,
    kind,
    category: pick(random, CATEGORIES[kind]),
    title,
    description: `${title} — sample content generated by \`npm run seed\`.`,
    edition: 'bedrock',
    mcVersion: pick(random, VERSIONS),
    tags: [pick(random, TAGS[kind]), pick(random, TAGS[kind])].join(', '),
    seedCode: kind === 'seed' ? String(Math.floor(random() * 4_000_000_000) - 2_000_000_000) : undefined,
    seedMeta: kind === 'seed'
      ? {
        highlights: [
          { label: 'Spawn', x: 0, y: 68, z: 0 },
          { label: pick(random, ['Village', 'Temple', 'Ravine', 'Monument']),
            x: Math.floor(random() * 800) - 400, y: 64, z: Math.floor(random() * 800) - 400 },
        ],
      }
      : undefined,
    isFeatured: random() > 0.82,
    isPublished: random() > 0.1,
    createdBy: author,
    ...stored,
  });

  // Plausible history, so the dashboard's charts and the trending sort have something to sort.
  const popularity = Math.floor(random() * random() * 900);
  if (popularity > 0) {
    const insert = db.prepare(
      "INSERT INTO download_events (item_id, day, created_at, client_key) "
      + "VALUES (?, date('now', ?), datetime('now', ?), ?)",
    );
    const bump = db.prepare('UPDATE items SET downloads = downloads + ? WHERE id = ?');

    db.transaction(() => {
      for (let n = 0; n < Math.min(popularity, 240); n += 1) {
        const daysAgo = -Math.floor(random() * 14);
        insert.run(id, `${daysAgo} days`, `${daysAgo} days`, crypto.randomBytes(8).toString('hex'));
      }
      bump.run(popularity, id);
    })();
  }

  made += 1;
  if (made % 10 === 0) console.log(`  …${made}/${count}`);
}

logAudit(author, 'catalogue.seed', null, `${made} items`);

console.log(`  Done. ${made} items — start the server and open /admin.`);
