import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SOURCE_SUFFIX } from '../../src/showcase.js';

/**
 * Writes the note of where a clip came from beside it — `{ source: 'artwork' }`
 * or `{ source: 'youtube', channel, video }` — which the panel counts to show
 * how far cutting clips from showcases has got. Written after the clip, and
 * renamed into place, so a note never describes a clip that is not there yet.
 */
export async function writeSource(dir, id, note) {
  const target = path.join(dir, `${id}${SOURCE_SUFFIX}`);
  const staging = `${target}.partial`;
  await writeFile(staging, JSON.stringify(note));
  await rename(staging, target);
}
