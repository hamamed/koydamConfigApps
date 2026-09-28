import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createAutopost, nextSlot, readTimes, slotsDue } from '../src/autopost.js';
import { openDatabase } from '../src/db/index.js';
import { checkToken, createMetaAccount } from '../src/meta-account.js';
import { createMetaClient, MetaError, TARGETS } from '../src/meta-publish.js';
import { createRepository } from '../src/repository.js';

// ── The clock ────────────────────────────────────────────────────────────────

test('times are read as GMT hours, sorted, without repeats', () => {
  assert.deepEqual(readTimes('18:00, 9:30،18:00').times, ['09:30', '18:00']);
  assert.match(readTimes('').error, /وقتاً/);
  assert.match(readTimes('25:00').error, /25:00/);
  assert.match(readTimes('6pm').error, /6pm/);
  assert.match(readTimes('01:00 02:00 03:00 04:00 05:00 06:00 07:00').error, /6/);
});

test('a slot is due from its minute for half an hour, and not before or after', () => {
  const at = (iso) => new Date(`${iso}Z`);
  assert.deepEqual(slotsDue(at('2026-09-28T17:59:00'), ['18:00']), []);
  assert.deepEqual(slotsDue(at('2026-09-28T18:00:00'), ['18:00']), ['2026-09-28 18:00']);
  assert.deepEqual(slotsDue(at('2026-09-28T18:29:00'), ['18:00']), ['2026-09-28 18:00']);
  assert.deepEqual(slotsDue(at('2026-09-28T18:31:00'), ['18:00']), [], 'the server was down: skipped, not posted late');
  assert.deepEqual(slotsDue(at('2026-09-29T00:05:00'), ['23:50']), ['2026-09-28 23:50'], 'across midnight');
});

test('the next slot is the first time still to come, tomorrow when today\'s are gone', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  assert.equal(nextSlot(now, ['09:00', '18:00']).toISOString(), '2026-09-28T18:00:00.000Z');
  assert.equal(nextSlot(new Date('2026-09-28T19:00:00Z'), ['09:00', '18:00']).toISOString(), '2026-09-29T09:00:00.000Z');
  assert.equal(nextSlot(now, []), null);
});

// ── Meta ─────────────────────────────────────────────────────────────────────

/** A fake Graph API: answers from `routes` by "METHOD path", and keeps every call. */
function fakeGraph(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const params = Object.fromEntries(init.body ? new URLSearchParams(init.body) : u.searchParams);
    const key = `${init.method} ${u.pathname.replace(/^\/v[\d.]+\//, '')}`;
    calls.push({ key, params });
    const answer = routes[key];
    const body = typeof answer === 'function' ? answer(params, calls) : answer;
    if (!body) return { ok: false, status: 404, json: async () => ({ error: { message: `no route ${key}` } }) };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
  return { fetch, calls };
}

const account = { pageId: '111', igUserId: '222', token: 'PAGETOKEN' };

test('a Facebook post is the photo and its caption, with a link to it', async () => {
  const graph = fakeGraph({ 'POST 111/photos': { id: '9', post_id: '111_9' } });
  const client = createMetaClient({ fetch: graph.fetch });
  const out = await client.publish('facebook_post', account, { imageUrl: 'https://chabbek.com/media/posts/a.jpg', caption: 'ما هذا؟' });
  assert.deepEqual(out, { remoteId: '111_9', link: 'https://www.facebook.com/111_9' });
  assert.deepEqual(graph.calls[0].params, { url: 'https://chabbek.com/media/posts/a.jpg', caption: 'ما هذا؟', access_token: 'PAGETOKEN' });
});

test('a Facebook story is an unpublished photo of its own, then the story', async () => {
  const graph = fakeGraph({ 'POST 111/photos': { id: '77' }, 'POST 111/photo_stories': { success: true, post_id: '111_88' } });
  const out = await createMetaClient({ fetch: graph.fetch }).publish('facebook_story', account, { imageUrl: 'https://x/s.jpg' });
  assert.equal(out.remoteId, '111_88');
  assert.equal(graph.calls[0].params.published, 'false');
  assert.equal(graph.calls[1].params.photo_id, '77');
});

test('an Instagram post waits for its container, then publishes and reads its link', async () => {
  let asked = 0;
  const graph = fakeGraph({
    'POST 222/media': { id: 'c1' },
    'GET c1': () => ({ status_code: ++asked < 2 ? 'IN_PROGRESS' : 'FINISHED' }),
    'POST 222/media_publish': { id: 'm1' },
    'GET m1': { permalink: 'https://www.instagram.com/p/abc/' },
  });
  const out = await createMetaClient({ fetch: graph.fetch, wait: async () => {} })
    .publish('instagram_post', account, { imageUrl: 'https://x/p.jpg', caption: 'نص' });
  assert.deepEqual(out, { remoteId: 'm1', link: 'https://www.instagram.com/p/abc/' });
  assert.deepEqual(graph.calls[0].params, { image_url: 'https://x/p.jpg', caption: 'نص', access_token: 'PAGETOKEN' });
  assert.equal(graph.calls.find((c) => c.key === 'POST 222/media_publish').params.creation_id, 'c1');
});

test('an Instagram story is a STORIES container; a refused image stops before publishing', async () => {
  const graph = fakeGraph({ 'POST 222/media': { id: 'c2' }, 'GET c2': { status_code: 'ERROR' } });
  const client = createMetaClient({ fetch: graph.fetch, wait: async () => {} });
  await assert.rejects(client.publish('instagram_story', account, { imageUrl: 'https://x/s.jpg' }), /ERROR/);
  assert.equal(graph.calls[0].params.media_type, 'STORIES');
  assert.ok(!graph.calls.some((c) => c.key === 'POST 222/media_publish'));
  await assert.rejects(client.publish('instagram_post', { ...account, igUserId: null }, { imageUrl: 'x' }), /إنستغرام/);
});

test('a Facebook reel is started, handed over by URL, published, and watched while it processes', async () => {
  const uploads = [];
  const graph = fakeGraph({
    'POST 111/video_reels': (params) => (params.upload_phase === 'start' ? { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v1' } : { success: true }),
    'GET v1': { status: { video_status: 'ready' } },
  });
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://rupload.facebook.com/')) {
      uploads.push({ url: String(url), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return graph.fetch(url, init);
  };
  const out = await createMetaClient({ fetch, wait: async () => {} })
    .publish('facebook_reel', account, { videoUrl: 'https://chabbek.com/media/posts/r.mp4', caption: 'ما هذا؟' });
  assert.deepEqual(out, { remoteId: 'v1', link: 'https://www.facebook.com/reel/v1' });
  assert.match(uploads[0].url, /\/video-upload\/v[\d.]+\/v1$/);
  assert.deepEqual(uploads[0].headers, { Authorization: 'OAuth PAGETOKEN', file_url: 'https://chabbek.com/media/posts/r.mp4' });
  const finish = graph.calls.find((c) => c.params.upload_phase === 'finish');
  assert.equal(finish.params.video_state, 'PUBLISHED');
  assert.equal(finish.params.description, 'ما هذا؟');
});

test('a Facebook reel that fails to process is reported, not taken as posted', async () => {
  const graph = fakeGraph({
    'POST 111/video_reels': (params) => (params.upload_phase === 'start' ? { video_id: 'v2' } : { success: true }),
    'GET v2': { status: { video_status: 'error' } },
  });
  const fetch = async (url, init) => (String(url).startsWith('https://rupload.')
    ? { ok: true, status: 200, json: async () => ({ success: true }) } : graph.fetch(url, init));
  await assert.rejects(createMetaClient({ fetch, wait: async () => {} }).publish('facebook_reel', account, { videoUrl: 'x', caption: 'y' }), /process/);
});

test('an Instagram reel is a REELS container with its cover at the finished post, shared to the feed', async () => {
  let asked = 0;
  const graph = fakeGraph({
    'POST 222/media': { id: 'c3' },
    'GET c3': () => ({ status_code: ++asked < 4 ? 'IN_PROGRESS' : 'FINISHED' }),
    'POST 222/media_publish': { id: 'm3' },
    'GET m3': { permalink: 'https://www.instagram.com/reel/xyz/' },
  });
  const out = await createMetaClient({ fetch: graph.fetch, wait: async () => {} })
    .publish('instagram_reel', account, { videoUrl: 'https://x/r.mp4', caption: 'نص' });
  assert.equal(out.link, 'https://www.instagram.com/reel/xyz/');
  assert.deepEqual(graph.calls[0].params, {
    media_type: 'REELS', video_url: 'https://x/r.mp4', caption: 'نص', share_to_feed: 'true', thumb_offset: '6000', access_token: 'PAGETOKEN',
  });
});

test('Meta\'s own error message is what the panel shows', async () => {
  const graph = fakeGraph({ 'POST 111/photos': { error: { message: 'Invalid OAuth access token.', code: 190 } } });
  await assert.rejects(createMetaClient({ fetch: graph.fetch }).publish('facebook_post', account, { imageUrl: 'x', caption: 'y' }),
    (err) => err instanceof MetaError && err.code === 190 && /Invalid OAuth/.test(err.message));
});

test('a Page key reads as the Page and its Instagram; a personal key is refused plainly', async () => {
  const page = fakeGraph({
    'GET me': { id: '111', name: 'شبّك' },
    'GET 111': { id: '111', instagram_business_account: { id: '222', username: 'chabbek' } },
  });
  assert.deepEqual(await createMetaClient({ fetch: page.fetch }).inspect('T'),
    { pageId: '111', pageName: 'شبّك', igUserId: '222', igUsername: 'chabbek' });
  const person = fakeGraph({
    'GET me': { id: '5', name: 'Someone' },
    'GET 5': { error: { message: '(#100) Tried accessing nonexisting field (instagram_business_account) on node type (User)' } },
  });
  await assert.rejects(createMetaClient({ fetch: person.fetch }).inspect('T'), /حسابك الشخصي/);
});

// ── The Page key ─────────────────────────────────────────────────────────────

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasla-autopost-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const pageClient = { inspect: async () => ({ pageId: '111', pageName: 'شبّك', igUserId: '222', igUsername: 'chabbek' }) };

test('a key is checked with Meta, kept readable by the service alone, and never shown', async () => {
  assert.ok(checkToken('').error);
  assert.ok(checkToken('abc def!').error);
  assert.equal(checkToken(' EAAB\nxyz ').token, 'EAABxyz');

  const db = openDatabase(':memory:');
  const meta = createMetaAccount(db, { dir: path.join(dir, 'meta'), client: pageClient });
  assert.equal(meta.status().connected, false);
  assert.equal(meta.load(), null);

  const { status } = await meta.connect('EAABsecret');
  assert.equal(status.connected, true);
  assert.equal(status.igUsername, 'chabbek');
  assert.ok(!JSON.stringify(status).includes('EAABsecret'), 'the status never carries the key');
  assert.equal(fs.statSync(path.join(dir, 'meta', 'page-token')).mode & 0o777, 0o600);
  assert.deepEqual(meta.load(), { pageId: '111', igUserId: '222', token: 'EAABsecret' });

  meta.disconnect();
  assert.equal(meta.status().connected, false);
  assert.ok(!fs.existsSync(path.join(dir, 'meta', 'page-token')));
});

test('a key Meta refuses is not kept', async () => {
  const meta = createMetaAccount(openDatabase(':memory:'), {
    dir: path.join(dir, 'meta'), client: { inspect: async () => { throw new MetaError('Invalid OAuth access token.'); } },
  });
  assert.match((await meta.connect('EAABbad')).error, /Invalid OAuth/);
  assert.equal(meta.status().connected, false);
});

// ── The slots ────────────────────────────────────────────────────────────────

/** A database with `n` credited picture questions, all in one published level, and one more that is not in any. */
function world(n = 2) {
  const db = openDatabase(':memory:');
  const repo = createRepository(db);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const { question } = repo.createQuestion({ title: 'حيوانات', answer: ['حمار', 'اسد', 'فيل'][i], clue: 'x' });
    db.prepare("UPDATE questions SET image_file = ?, image_author = 'A. Photographer', image_licence = 'CC BY 4.0' WHERE id = ?")
      .run(`pic${i}.jpg`, question.id);
    ids.push(question.id);
  }
  const level = repo.createLevel();
  repo.setLevelQuestions(level.id, ids);
  db.prepare('UPDATE levels SET published = 1 WHERE id = ?').run(level.id);
  const { question: loose } = repo.createQuestion({ title: 'حيوانات', answer: 'نمر', clue: 'x' });
  db.prepare("UPDATE questions SET image_file = 'loose.jpg', image_author = 'B', image_licence = 'CC0' WHERE id = ?").run(loose.id);
  return { db, repo, ids, loose: loose.id };
}

function setup({ n = 2, connected = true, failing = [], clock = '2026-09-28T18:05:00Z' } = {}) {
  const { db, repo, ids, loose } = world(n);
  const posted = [];
  const client = {
    publish: async (target, creds, content) => {
      if (failing.includes(target)) throw new MetaError('(#10) Application does not have permission for this action');
      posted.push({ target, creds, content });
      return { remoteId: `${target}-id`, link: target.endsWith('post') ? `https://example.com/${target}` : null };
    },
  };
  const rendered = [];
  const render = async (post, size, opts) => { rendered.push({ post, size, opts }); return Buffer.from(`jpeg-${size}`); };
  const reels = [];
  const renderReel = async (post, file, opts) => { reels.push({ post, file, opts }); fs.writeFileSync(file, 'mp4'); return file; };
  const account = { status: () => ({ connected }), load: () => (connected ? { pageId: '111', igUserId: '222', token: 'T' } : null) };
  let now = new Date(clock);
  const autopost = createAutopost(db, {
    repo, account, client, render, renderReel, siteSettings: { appStoreUrl: () => 'https://apps.apple.com/app/id1' },
    siteBase: 'https://chabbek.com', postsDir: path.join(dir, 'posts'), imagesDir: path.join(dir, 'questions'),
    log: { error: () => {}, info: () => {} }, now: () => now,
  });
  return { db, ids, loose, autopost, posted, rendered, reels, setNow: (iso) => { now = new Date(iso); } };
}

test('nothing is posted until it is switched on, and then at its time, to every target ticked', async () => {
  const s = setup();
  await s.autopost.tick();
  assert.equal(s.posted.length, 0, 'off by default');

  assert.equal(s.autopost.saveSchedule({ enabled: true, times: '18:00', targets: Object.keys(TARGETS), showCredit: true }).error, undefined);
  await s.autopost.tick();
  assert.deepEqual(s.posted.map((p) => p.target), Object.keys(TARGETS));
  const [post] = s.posted;
  assert.equal(post.content.imageUrl.startsWith('https://chabbek.com/media/posts/'), true);
  assert.match(post.content.caption, /ما هذا؟/);
  assert.match(post.content.caption, /A\. Photographer · CC BY 4\.0/, 'the caption always credits the picture');
  assert.deepEqual([...new Set(s.rendered.map((r) => r.size))].sort(), ['square', 'story'], 'each size drawn once');
  assert.equal(s.posted.find((p) => p.target === 'instagram_story').content.imageUrl.endsWith('-story.jpg'), true);
  assert.equal(s.reels.length, 1, 'one reel for both networks');
  assert.equal(s.posted.find((p) => p.target === 'instagram_reel').content.videoUrl.endsWith('-reel.mp4'), true);
  assert.equal(s.posted.find((p) => p.target === 'facebook_reel').content.videoUrl, s.posted.find((p) => p.target === 'instagram_reel').content.videoUrl);
  assert.equal(fs.readdirSync(path.join(dir, 'posts')).length, 3);

  const rows = s.autopost.history();
  assert.equal(rows.length, Object.keys(TARGETS).length);
  assert.ok(rows.every((r) => r.status === 'done' && r.slot === '2026-09-28 18:00'));
});

test('a slot runs once, however often the clock ticks', async () => {
  const s = setup();
  s.autopost.saveSchedule({ enabled: true, times: '18:00', targets: ['facebook_post'], showCredit: true });
  await s.autopost.tick();
  await s.autopost.tick();
  s.setNow('2026-09-28T18:20:00Z');
  await s.autopost.tick();
  assert.equal(s.posted.length, 1);
});

test('each slot takes a question not posted yet, from a published level; then the oldest again', async () => {
  const s = setup({ n: 2 });
  s.autopost.saveSchedule({ enabled: true, times: '09:00, 18:00', targets: ['facebook_post'], showCredit: true });
  const questionOf = () => s.autopost.history(1)[0].question_id;
  s.setNow('2026-09-28T09:00:00Z'); await s.autopost.tick();
  const first = questionOf();
  s.setNow('2026-09-28T18:00:00Z'); await s.autopost.tick();
  const second = questionOf();
  assert.notEqual(first, second);
  assert.deepEqual([first, second].sort(), [...s.ids].sort(), 'never the question outside a published level');
  s.setNow('2026-09-29T09:00:00Z'); await s.autopost.tick();
  assert.ok(s.ids.includes(questionOf()));
});

test('a target Meta refuses is recorded with Meta\'s reason, and the others still post', async () => {
  const s = setup({ failing: ['instagram_story'] });
  s.autopost.saveSchedule({ enabled: true, times: '18:00', targets: Object.keys(TARGETS), showCredit: false });
  await s.autopost.tick();
  const rows = s.autopost.history();
  const failed = rows.find((r) => r.target === 'instagram_story');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /permission/);
  assert.equal(rows.filter((r) => r.status === 'done').length, Object.keys(TARGETS).length - 1);
  assert.ok(s.rendered.every((r) => r.opts.showCredit === false), 'the credit left off the picture, as set');
});

test('with no Page connected nothing is posted, and by hand it says why', async () => {
  const s = setup({ connected: false });
  s.autopost.saveSchedule({ enabled: true, times: '18:00', targets: ['facebook_post'], showCredit: true });
  await s.autopost.tick();
  assert.equal(s.posted.length, 0);
  assert.match((await s.autopost.postNow()).error, /صفحة/);
});

test('posting by hand takes the question asked for, even outside a level, and is its own slot', async () => {
  const s = setup();
  const out = await s.autopost.postNow({ questionId: s.loose, targets: ['facebook_post'] });
  assert.equal(out.question.id, s.loose);
  assert.ok(s.autopost.history(1)[0].slot.startsWith('now '));
});

test('the schedule refuses bad times, and switching on with nowhere to post', () => {
  const s = setup();
  assert.ok(s.autopost.saveSchedule({ enabled: true, times: 'soon', targets: ['facebook_post'] }).error);
  assert.ok(s.autopost.saveSchedule({ enabled: true, times: '18:00', targets: [] }).error);
  assert.deepEqual(s.autopost.saveSchedule({ enabled: false, times: '20:00', targets: ['bogus', 'instagram_post'], showCredit: true }).schedule,
    { enabled: false, times: ['20:00'], targets: ['instagram_post'], showCredit: true });
  assert.deepEqual(s.autopost.schedule().times, ['20:00']);
});
