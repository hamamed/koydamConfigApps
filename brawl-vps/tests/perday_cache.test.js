import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.BRAWL_API_TOKEN ??= 'test-token';
process.env.LOG_LEVEL = 'error';
delete process.env.REDIS_URL;

const { cacheDel, cacheGet, cacheSet } = await import('../src/cache/store.js');
const { cachedOrBuilding, cachedShared } = await import('../src/community/perday.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a cold key waits for its build and keeps a stale shadow copy', async () => {
  const key = `t:cold:${Math.random()}`;
  const value = await cachedOrBuilding(key, 60, async () => ({ n: 1 }));
  assert.deepEqual(value, { n: 1 });
  assert.deepEqual(await cacheGet(key), { n: 1 });
  assert.deepEqual(await cacheGet(`stale:${key}`), { n: 1 });
});

test('an expired key answers at once with the stale copy and rebuilds behind it', async () => {
  const key = `t:stale:${Math.random()}`;
  await cacheSet(`stale:${key}`, { n: 'old' }, 600);
  let release;
  const gate = new Promise((r) => { release = r; });
  const started = Date.now();
  const value = await cachedOrBuilding(key, 60, async () => { await gate; return { n: 'new' }; });
  assert.deepEqual(value, { n: 'old' });
  assert.ok(Date.now() - started < 200, 'stale copy is served without waiting for the build');
  release();
  await wait(20);
  assert.deepEqual(await cacheGet(key), { n: 'new' });
  assert.deepEqual(await cacheGet(`stale:${key}`), { n: 'new' });
});

test('a failed background rebuild keeps the stale copy and does not crash', async () => {
  const key = `t:fail:${Math.random()}`;
  await cacheSet(`stale:${key}`, { n: 'old' }, 600);
  const value = await cachedOrBuilding(key, 60, async () => { throw new Error('db down'); });
  assert.deepEqual(value, { n: 'old' });
  await wait(20);
  assert.deepEqual(await cacheGet(`stale:${key}`), { n: 'old' });
});

test('a cold build slower than the wait answers null and still fills the cache', async () => {
  const key = `t:slow:${Math.random()}`;
  const value = await cachedOrBuilding(key, 60, async () => { await wait(60); return { n: 2 }; }, 10);
  assert.equal(value, null);
  await wait(80);
  assert.deepEqual(await cacheGet(key), { n: 2 });
});

test('cachedShared runs one build for concurrent callers', async () => {
  const key = `t:shared:${Math.random()}`;
  let builds = 0;
  const build = async () => { builds += 1; await wait(20); return [1, 2]; };
  const [a, b] = await Promise.all([cachedShared(key, 60, build), cachedShared(key, 60, build)]);
  assert.deepEqual(a, [1, 2]);
  assert.deepEqual(b, [1, 2]);
  assert.equal(builds, 1);
  assert.deepEqual(await cachedShared(key, 60, build), [1, 2]);
  assert.equal(builds, 1);
  await cacheDel(key);
});
