import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CC_BY, createAudioImport, readVideoId, reasonFor, watchUrl } from '../src/audio-import.js';

/** yt-dlp stood in for: what it was asked, and what it answers. */
function stub({ info = {}, onClip } = {}) {
  const calls = [];
  const tools = {
    run: async (bin, args) => {
      calls.push({ bin, args });
      if (args.includes('--dump-single-json')) {
        return { stdout: JSON.stringify({ title: 't', channel: 'c', duration: 600, license: CC_BY, ...info }) };
      }
      if (onClip) await onClip(args);
      return { stdout: '' };
    },
  };
  return { calls, importer: createAudioImport({ tools }) };
}

test('a video id is read from every shape of link, and nothing else', () => {
  const id = 'aqz-KE-bpKQ';
  for (const link of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=90s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=xyz`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `youtube.com/watch?v=${id}`,
  ]) assert.equal(readVideoId(link), id, link);

  for (const bad of ['', 'https://vimeo.com/12345', 'https://evil.example/watch?v=aqz-KE-bpKQ',
    'https://www.youtube.com/watch?v=short', 'not a url', null]) {
    assert.equal(readVideoId(bad), null, String(bad));
  }
});

test('only the id reaches yt-dlp, never the pasted text', async () => {
  const { calls, importer } = stub();
  await importer.probe('https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PL;rm%20-rf');
  assert.deepEqual(calls[0].args.at(-1), watchUrl('aqz-KE-bpKQ'));
});

test('the licence decides whether a clip may be published, not whether it may be had', () => {
  const importer = createAudioImport({ tools: { run: async () => ({ stdout: '{}' }) } });
  assert.deepEqual(importer.terms({ licence: CC_BY, seconds: 60 }), { cleared: true, licence: 'CC BY 3.0' });
  assert.deepEqual(importer.terms({ licence: 'Standard YouTube License', seconds: 60 }),
    { cleared: false, licence: 'Standard YouTube License' });
  assert.deepEqual(importer.terms({ licence: '', seconds: 60 }),
    { cleared: false, licence: 'رخصة يوتيوب القياسية' }, 'an unstated licence is not a permission');
  assert.match(importer.terms({ licence: CC_BY, seconds: 5 * 60 * 60 }).error, /أربع ساعات/);
});

test('a video under any licence is fetched, and comes back held back', async () => {
  const { importer } = stub({
    info: { license: 'Standard YouTube License' },
    onClip: async (args) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp3'), Buffer.from('ID3 clip'));
    },
  });
  const got = await importer.clip('https://youtu.be/aqz-KE-bpKQ', { start: 10, seconds: 8 });
  assert.equal(got.error, undefined, 'nothing is refused for its licence');
  assert.deepEqual(got.terms, { cleared: false, licence: 'Standard YouTube License' });
});

test('a CC-BY video hands back the seconds asked for, with its credit', async () => {
  const { calls, importer } = stub({
    info: { title: 'Big Buck Bunny', channel: 'Blender' },
    onClip: async (args) => {
      const { writeFile } = await import('node:fs/promises');
      const out = args[args.indexOf('-o') + 1];
      await writeFile(out.replace('%(ext)s', 'mp3'), Buffer.from('ID3 clip'));
    },
  });
  const { audio, video, terms, error } = await importer.clip(`https://youtu.be/aqz-KE-bpKQ`, { start: 80, seconds: 8 });
  assert.equal(error, undefined);
  assert.deepEqual(terms, { cleared: true, licence: 'CC BY 3.0' }, 'CC BY arrives ready to publish');
  assert.deepEqual([video.title, video.channel, video.url], ['Big Buck Bunny', 'Blender', watchUrl('aqz-KE-bpKQ')]);
  assert.equal(audio.toString(), 'ID3 clip');
  // Only the asked-for window left YouTube, with a second of slack.
  const sections = calls[1].args[calls[1].args.indexOf('--download-sections') + 1];
  assert.equal(sections, '*80-89');
});

test('a start past the end of the video is refused before anything is fetched', async () => {
  const { calls, importer } = stub({ info: { duration: 120 } });
  assert.match((await importer.clip('https://youtu.be/aqz-KE-bpKQ', { start: 300, seconds: 8 })).error, /بعد نهاية/);
  assert.equal(calls.length, 1);
});

test('a link that is not a YouTube video never runs anything', async () => {
  const { calls, importer } = stub();
  assert.match((await importer.probe('https://vimeo.com/12345')).error, /رابط فيديو يوتيوب/);
  assert.equal(calls.length, 0);
});

test('a failure says what actually went wrong, not what did not', () => {
  assert.match(reasonFor({ stderr: 'ERROR: Sign in to confirm you’re not a bot.' }), /يحجب طلبات الخادم/);
  assert.match(reasonFor({ message: 'spawn yt-dlp ENOENT' }), /غير مثبّت/);
  assert.match(reasonFor({ stderr: 'ERROR: Private video' }), /غير متاح/);
  assert.match(reasonFor({ stderr: 'something else' }), /تأكد من الرابط/);
});
