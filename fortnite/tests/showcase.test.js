import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { createClipIndex } from '../src/showcase.js';

let root;

/** A clip link: the encoded id's file, versioned so a replaced clip gets a new URL. */
const clipUrl = (encodedId) => new RegExp(`^/showcase/${encodedId}\\.mp4\\?v=[0-9a-z]+$`);

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'showcase-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('returns the clip path for an outfit that has a rendered clip', async () => {
  await writeFile(path.join(root, 'Character_AgentSherbert.mp4'), '');
  const index = createClipIndex(root);

  await index.refresh();

  assert.match(index.pathFor('Character_AgentSherbert'), clipUrl('Character_AgentSherbert'));
});

test('returns null for an outfit without a clip', async () => {
  const index = createClipIndex(root);

  await index.refresh();

  assert.equal(index.pathFor('Character_NoSuchOutfit'), null);
});

test('ignores files that are not clips and directories named like one', async () => {
  await writeFile(path.join(root, 'Character_Notes.txt'), '');
  await mkdir(path.join(root, 'Character_Folder.mp4'));
  const index = createClipIndex(root);

  await index.refresh();

  assert.equal(index.pathFor('Character_Notes'), null);
  assert.equal(index.pathFor('Character_Folder'), null);
});

test('encodes ids so an unusual character cannot break the URL', async () => {
  await writeFile(path.join(root, 'Character_Odd Name#1.mp4'), '');
  const index = createClipIndex(root);

  await index.refresh();

  assert.match(index.pathFor('Character_Odd Name#1'), clipUrl('Character_Odd%20Name%231'));
});

test('a missing clip directory means no clips rather than an error', async () => {
  const index = createClipIndex(path.join(root, 'does-not-exist'));

  await index.refresh();

  assert.equal(index.pathFor('Character_AgentSherbert'), null);
});

test('ids lists every cosmetic that has a clip', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-ids-'));
  await writeFile(path.join(dir, 'Character_One.mp4'), '');
  await writeFile(path.join(dir, 'Character_Two.mp4'), '');
  const index = createClipIndex(dir);

  await index.refresh();

  assert.deepEqual([...index.ids()].sort(), ['Character_One', 'Character_Two']);
  await rm(dir, { recursive: true, force: true });
});

test('reload re-reads straight away, without waiting for the listing to go stale', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-reload-'));
  const index = createClipIndex(dir, { refreshMs: 60_000, now: () => 0 });
  await index.refresh();

  await writeFile(path.join(dir, 'Character_Fresh.mp4'), '');
  await index.reload();

  assert.match(index.pathFor('Character_Fresh'), clipUrl('Character_Fresh'));
  await rm(dir, { recursive: true, force: true });
});

test('a replaced clip gets a new link, so a cached copy of the old one is not shown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-version-'));
  const file = path.join(dir, 'Character_Swap.mp4');
  await writeFile(file, 'first render');
  await utimes(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  const index = createClipIndex(dir);
  await index.refresh();
  const first = index.pathFor('Character_Swap');

  await writeFile(file, 'second render');
  await utimes(file, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
  await index.reload();

  assert.match(index.pathFor('Character_Swap'), clipUrl('Character_Swap'));
  assert.notEqual(index.pathFor('Character_Swap'), first);
  await rm(dir, { recursive: true, force: true });
});

test('picks up clips added after the last read once the index is stale', async () => {
  let clock = 0;
  const index = createClipIndex(root, { refreshMs: 1000, now: () => clock });
  await index.refresh();
  assert.equal(index.pathFor('Character_Late'), null);

  await writeFile(path.join(root, 'Character_Late.mp4'), '');
  clock = 5000;
  index.pathFor('Character_Late'); // a stale lookup starts the re-read
  await index.refresh();

  assert.match(index.pathFor('Character_Late'), clipUrl('Character_Late'));
});
