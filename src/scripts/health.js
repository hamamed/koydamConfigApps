/**
 * Verifies the whole pipeline end to end.
 *
 *   npm run health -- 2Y082989
 *
 * Checks, in order: token validity + IP allowlist, brawler metadata presence,
 * and that a real player transforms into the shape the Flutter client parses.
 * Run this first when something is broken — it isolates which layer failed.
 */
import { config } from '../config.js';
import { supercell, UpstreamError } from '../supercell/client.js';
import { loadBrawlerMeta, metaStats } from '../transform/brawler_meta.js';
import { transformPlayer } from '../transform/player.js';
import { closeCache } from '../cache/store.js';

const tag = process.argv[2] ?? '2Y082989';
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => console.log(`  ✗ ${m}`);

let failures = 0;

console.log('\nBrawl VPS health check\n');

// 1. Config
console.log('config');
if (config.supercell.token) {
  pass(`token present (${config.supercell.token.length} chars)`);
} else {
  fail('BRAWL_API_TOKEN missing');
  failures += 1;
}
pass(`upstream ${config.supercell.baseUrl}`);
pass(`redis ${config.redis.url ? 'configured' : 'not set (memory fallback)'}`);

// 2. Brawler metadata
console.log('\nbrawler metadata');
const count = await loadBrawlerMeta();
if (count > 0) {
  pass(`${count} brawlers loaded`);
  const stats = metaStats();
  if (stats.stale) fail('metadata is stale — run `npm run sync:brawlers`');
} else {
  fail('no metadata — run `npm run sync:brawlers`');
  failures += 1;
}

// 3. Upstream reachability. This is where an IP allowlist mistake surfaces.
console.log('\nsupercell api');
try {
  const brawlers = await supercell.brawlers();
  pass(`/brawlers reachable (${(brawlers.items ?? []).length} items)`);
} catch (err) {
  failures += 1;
  if (err instanceof UpstreamError && err.status === 403) {
    fail('403 Forbidden — the token\'s allowed IP does not match this server');
    console.log('\n    Fix: find this box\'s public IP with `curl -4 ifconfig.me`,');
    console.log('    then create a new token for that exact IP at');
    console.log('    https://developer.brawlstars.com/#/account\n');
  } else {
    fail(`${err.message}`);
  }
}

// 4. Full transform
console.log(`\nplayer pipeline (#${tag.replace('#', '')})`);
try {
  const raw = await supercell.player(tag);
  const shaped = transformPlayer(raw);

  pass(`fetched ${shaped.name} — ${shaped.trophies} trophies`);
  pass(`${shaped.brawlers.length} brawlers`);

  const enriched = shaped.brawlers.filter((b) => b._enriched).length;
  if (enriched === shaped.brawlers.length) {
    pass('all brawlers enriched with rarity/class/portrait');
  } else {
    fail(
      `${shaped.brawlers.length - enriched} brawlers missing metadata (new release? re-run sync:brawlers)`,
    );
  }

  // Assert the exact fields the Flutter models read.
  const required = [
    'tag', 'name', 'nameColor', 'icon', 'trophies', 'highestTrophies',
    '3vs3Victories', 'soloVictories', 'duoVictories', 'expLevel', 'brawlers',
  ];
  const missing = required.filter((k) => shaped[k] === undefined);
  if (missing.length === 0) {
    pass('payload matches the Flutter client contract');
  } else {
    fail(`missing contract fields: ${missing.join(', ')}`);
    failures += 1;
  }

  const sample = shaped.brawlers[0];
  if (sample) {
    console.log(
      `\n  sample brawler: ${sample.name} — ${sample.rarity} / ${sample.class}, ` +
        `power ${sample.power}, gadgets ${sample.gadgets.length}/${sample.gadgetsTotal}, ` +
        `hypercharge ${sample.hasHypercharge ? 'yes' : 'no'}`,
    );
  }
} catch (err) {
  failures += 1;
  if (err instanceof UpstreamError && err.status === 404) {
    fail(`player #${tag} not found — pass a real tag: npm run health -- YOURTAG`);
  } else {
    fail(err.message);
  }
}

await closeCache();

console.log(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
);
// exitCode, not exit() — see the note in sync-brawlers.js.
process.exitCode = failures === 0 ? 0 : 1;
