import path from 'node:path';

import { config } from '../config.js';

/**
 * Root of the wallpaper gallery, resolved once.
 *
 * Deliberately outside the deployed tree. `deploy.sh` rsyncs the repo over the
 * install and would delete anything it does not contain, so a gallery inside
 * `src/` would be wiped by the next code change and every wallpaper would have
 * to be uploaded again.
 */
export const WALLPAPER_ROOT = path.resolve(config.wallpapersDir);
