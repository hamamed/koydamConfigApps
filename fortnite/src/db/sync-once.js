import { migrate } from './index.js';
import { syncCosmetics, syncNews, syncShop, syncStatus } from '../upstream.js';

migrate();

for (const [name, fn] of [['cosmetics', syncCosmetics], ['shop', syncShop], ['news', syncNews]]) {
  const started = Date.now();
  try {
    const n = await fn();
    console.log(`  ${name}: ${n} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.log(`  ${name}: FAILED — ${err.message}`);
  }
}
console.table(syncStatus());
