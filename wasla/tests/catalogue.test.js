import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AVATAR_LOCKS, avatarCatalogue, BADGES, badgeTitle, frameCatalogue, lockNote, readBadge } from '../src/catalogue.js';
import { AVATARS, FRAMES } from '../src/profiles.js';

test('every locked avatar is an avatar the API accepts', () => {
  for (const id of Object.keys(AVATAR_LOCKS)) {
    assert.ok(AVATARS.includes(id), `${id} is locked in the catalogue but is not an avatar`);
  }
  assert.equal(avatarCatalogue().length, AVATARS.length);
  assert.equal(frameCatalogue().length, FRAMES.length);
});

test('a badge that opens an avatar is a badge the app can send', () => {
  for (const lock of Object.values(AVATAR_LOCKS)) {
    if (lock.kind === 'badge') assert.ok(BADGES.includes(lock.badge), `${lock.badge} is not in the badge list`);
  }
});

test('badge ids are read back into their counter and goal', () => {
  assert.deepEqual(readBadge('wasla.streak.30'), { kind: 'streak', goal: 30 });
  assert.equal(readBadge('wasla.nothing.3'), null);
  assert.equal(readBadge('streak.30'), null);
  assert.equal(readBadge(''), null);
  assert.equal(BADGES.length, 29);
  assert.equal(new Set(BADGES).size, BADGES.length, 'no badge is listed twice');
});

test('badge titles count in Arabic: the plural for 3–10, the singular after', () => {
  assert.equal(badgeTitle('wasla.words.10'), 'حللت 10 كلمات');
  assert.equal(badgeTitle('wasla.words.50'), 'حللت 50 كلمة');
  assert.equal(badgeTitle('wasla.levels.1'), 'أنهيت أول لغز');
  assert.equal(badgeTitle('wasla.levels.5'), 'أنهيت 5 ألغاز');
  assert.equal(badgeTitle('wasla.levels.25'), 'أنهيت 25 لغزاً');
  assert.equal(badgeTitle('wasla.levels.100'), 'أنهيت 100 لغز');
  assert.equal(badgeTitle('wasla.streak.3'), 'سلسلة 3 أيام');
  assert.equal(badgeTitle('wasla.points.500'), 'جمعت 500 نقطة');
  assert.equal(badgeTitle('wasla.nothing.5'), 'wasla.nothing.5', 'an id it does not know is left alone');
});

test('a lock reads as the panel shows it, and a free avatar has no note', () => {
  assert.equal(lockNote('crown'), 'شارة «سلسلة 30 يوماً»');
  assert.equal(lockNote('firework'), '200 عملة');
  assert.match(lockNote('fanous'), /رمضان/);
  assert.equal(lockNote('face'), '');
});
