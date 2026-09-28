import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanvas } from '@napi-rs/canvas';

import { renderPost, SIZES } from '../src/post-render.js';
import { captionFor, postFor } from '../src/post-content.js';

const question = {
  id: 7, title: 'حيوانات', clue: '', answer: 'حمار', playAnswer: 'حمار',
  imageFile: 'x.jpg', imageAuthor: 'Adrian Pingstone', imageLicence: 'Public domain',
};

/** The JPEG's width and height, from its SOF marker. */
function jpegSize(buffer) {
  assert.equal(buffer[0], 0xff);
  assert.equal(buffer[1], 0xd8, 'a JPEG — Instagram takes nothing else');
  for (let i = 2; i < buffer.length;) {
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return [buffer.readUInt16BE(i + 7), buffer.readUInt16BE(i + 5)];
    i += 2 + length;
  }
  throw new Error('no size in JPEG');
}

test('the server draws the square post and the story at their sizes, as JPEG', async () => {
  const picture = createCanvas(400, 300);
  picture.getContext('2d').fillRect(0, 0, 400, 300);
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(os.tmpdir(), `wasla-render-${process.pid}.png`);
  fs.writeFileSync(file, await picture.encode('png'));
  try {
    const post = postFor(question, { site: 'chabbek.com', appStoreUrl: 'https://apps.apple.com/app/id1' });
    for (const kind of Object.keys(SIZES)) {
      assert.deepEqual(jpegSize(await renderPost(post, kind, { picturePath: file })), SIZES[kind]);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a post never carries the answer, and its caption credits the picture', () => {
  const post = postFor(question, { site: 'chabbek.com' });
  assert.ok(!JSON.stringify(post).includes('حمار'));
  assert.equal(post.letters, 4);
  const caption = captionFor(question, { site: 'chabbek.com' });
  assert.ok(!caption.includes('حمار'));
  assert.match(caption, /Adrian Pingstone · Public domain/);
});
