import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFromUserAgent, createAppBuilds, versionOf } from '../src/app-builds.js';
import { openDatabase } from '../src/db/index.js';

const UA = (build) => `Wasla/${build} CFNetwork/3860.600.12 Darwin/25.5.0`;

function world(day = '2026-09-28') {
  let now = new Date(`${day}T12:00:00Z`);
  const builds = createAppBuilds(openDatabase(':memory:'), { siteHost: 'chabbek.com', now: () => now });
  return { builds, setDay: (d) => { now = new Date(`${d}T12:00:00Z`); } };
}

test('the build is read from the app\'s own User-Agent, and nothing else counts', () => {
  assert.equal(buildFromUserAgent(UA('2026092802')), '2026092802');
  assert.equal(buildFromUserAgent('Mozilla/5.0 (iPhone)'), null);
  assert.equal(buildFromUserAgent('Wasla/abc CFNetwork'), null);
  assert.equal(buildFromUserAgent(undefined), null);
  assert.equal(versionOf('2026092401'), '1.1');
  assert.equal(versionOf('2026092802'), '1.4');
  assert.equal(versionOf('2026100101'), '2026100101', 'a build not listed shows as its number');
});

test('each phone counts once, at the build it played last; old-domain phones are counted apart', () => {
  const { builds, setDay } = world('2026-09-27');
  builds.record({ device: 'phone-a', userAgent: UA('2026092401'), host: 'wassla.hamaprojects.com' });
  builds.record({ device: 'phone-b', userAgent: UA('2026092502'), host: 'wassla.hamaprojects.com' });
  setDay('2026-09-28');
  // phone-a updated overnight: it now counts as 1.4, on the new domain.
  builds.record({ device: 'phone-a', userAgent: UA('2026092802'), host: 'chabbek.com' });
  builds.record({ device: 'phone-c', userAgent: UA('2026092801'), host: 'chabbek.com' });
  builds.record({ device: 'phone-c', userAgent: UA('2026092801'), host: 'chabbek.com' });

  const summary = builds.summary(7, '2026-09-28');
  assert.equal(summary.total, 3);
  assert.equal(summary.old, 1);
  assert.equal(Math.round(summary.oldShare * 100), 33);
  assert.deepEqual(summary.versions.map((v) => [v.version, v.players, v.old]), [['1.4', 1, 0], ['1.3', 1, 0], ['1.2', 1, 1]]);
  assert.equal(summary.since, '2026-09-27');
});

test('every day of the chart is there, empty days as zero', () => {
  const { builds, setDay } = world('2026-09-26');
  builds.record({ device: 'phone-a', userAgent: UA('2026092401'), host: 'wassla.hamaprojects.com' });
  setDay('2026-09-28');
  builds.record({ device: 'phone-a', userAgent: UA('2026092802'), host: 'chabbek.com' });
  builds.record({ device: 'phone-b', userAgent: UA('2026092502'), host: 'wassla.hamaprojects.com' });
  const days = builds.perDay(3, '2026-09-28');
  assert.deepEqual(days, [
    { date: '2026-09-26', players: 1, old: 1 },
    { date: '2026-09-27', players: 0, old: 0 },
    { date: '2026-09-28', players: 2, old: 1 },
  ]);
});

test('a request that is not the app, or has no host, is not kept', () => {
  const { builds } = world();
  assert.equal(builds.record({ device: 'phone-a', userAgent: 'curl/8.0', host: 'chabbek.com' }), false);
  assert.equal(builds.record({ device: 'phone-a', userAgent: UA('2026092802'), host: '' }), false);
  assert.equal(builds.summary().total, 0);
});
