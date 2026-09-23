#!/usr/bin/env node
/**
 * Cuts a clip out of a Creative Commons YouTube video **on this machine**, and
 * writes it next to the credit it has to carry.
 *
 * YouTube refuses the VPS — it blocks datacentre addresses and asks the server
 * to "sign in to confirm you're not a bot" — so the panel cannot fetch a video
 * itself. A laptop is an ordinary address and is not refused, so the fetch
 * happens here.
 *
 * With WASLA_URL and WASLA_TOKEN set the clip is posted straight into the
 * library (POST /api/v1/audio-clips, the server's SERVICE_TOKEN); without them
 * it is written to a file and the credit is printed, to upload by hand.
 *
 * Any video can be fetched. What its licence says travels with the clip: one
 * licensed Creative Commons Attribution arrives ready to publish, any other
 * arrives held back, and a held-back clip is served to no player until its
 * permission is recorded in the panel.
 *
 *   WASLA_URL=https://wassla.hamaprojects.com WASLA_TOKEN=… \
 *   node scripts/youtube-clip.js <url> --start 1:20 --seconds 8 \
 *        [--title "صوت المطر"] [--category "أصوات الطبيعة"] [--out ~/Desktop]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { readTime } from '../src/audio-clips.js';
import { createAudioImport } from '../src/audio-import.js';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const url = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);

if (!url || args.includes('--help')) {
  console.log(`  node scripts/youtube-clip.js <url> --start 1:20 --seconds 8 [--title …] [--category …] [--out .]

  Any video is taken. One licensed «Creative Commons Attribution» arrives
  ready to publish; any other is held back until its permission is recorded
  on the panel's «مكتبة الأصوات» page, and is sent to no player before that.`);
  process.exit(url ? 0 : 1);
}

const start = readTime(flag('start', '0'));
const seconds = Number(flag('seconds', '8'));
if (start === null) {
  console.error('  --start is seconds or m:ss.');
  process.exit(1);
}
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) {
  console.error('  --seconds is 1 to 30.');
  process.exit(1);
}

const importer = createAudioImport();

console.log('  Reading the video…');
const found = await importer.probe(url);
if (found.error) {
  console.error(`  ${found.error}`);
  process.exit(1);
}
const rights = importer.terms(found.video);
if (rights.error) {
  console.error(`  ${rights.error}`);
  process.exit(1);
}
console.log(`  «${found.video.title}» — ${found.video.channel} · ${rights.licence}`
  + `${rights.cleared ? ' · جاهز للنشر' : ' · محجوز عن النشر حتى تسجّل الإذن'}`);

console.log(`  Fetching ${seconds}s from ${flag('start', '0')}…`);
const got = await importer.clip(url, { start, seconds });
if (got.error) {
  console.error(`  ${got.error}`);
  process.exit(1);
}

const title = flag('title') || found.video.title;
const category = flag('category', '');
const panel = (process.env.WASLA_URL ?? '').replace(/\/+$/, '');
const token = process.env.WASLA_TOKEN ?? '';

// Straight into the library when this machine has been told where to put it.
if (panel && token) {
  console.log(`  Uploading to ${panel}…`);
  const body = new FormData();
  body.set('sound', new Blob([got.audio], { type: 'audio/mpeg' }), 'clip.mp3');
  body.set('title', title);
  body.set('category', category);
  body.set('start', '0');
  body.set('seconds', String(seconds));
  body.set('source', found.video.url);
  body.set('licence', got.terms.licence);
  body.set('author', found.video.channel);
  body.set('cleared', got.terms.cleared ? '1' : '0');

  const answer = await fetch(`${panel}/api/v1/audio-clips`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  const said = await answer.json().catch(() => ({}));
  if (!answer.ok) {
    console.error(`  ${answer.status}: ${said.error ?? 'the panel refused the clip.'}`);
    process.exit(1);
  }
  console.log(`\n  في المكتبة: «${said.clip.title}» · ${said.clip.seconds}s`
    + `${said.clip.category ? ` · ${said.clip.category}` : ''} · ${said.clip.licence} · ${said.clip.author}`
    + `${said.clip.cleared ? '' : '\n  محجوز عن النشر — سجّل الإذن في «مكتبة الأصوات» قبل أن يصل التطبيق.'}`);
  process.exit(0);
}

const name = title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60);
const out = path.resolve(flag('out', process.cwd()), `${name || found.video.id}.mp3`);
await fs.writeFile(out, got.audio);

console.log(`\n  ${out}\n`);
console.log('  ارفعه في «مكتبة الأصوات» بهذه البيانات:');
console.log(`    الاسم    ${title}`);
console.log(`    الفئة    ${category || '—'}`);
console.log(`    من       0   ·   لمدة ${seconds}`);
console.log(`    المصدر   ${found.video.url}`);
console.log(`    الرخصة   ${rights.licence}`);
console.log(`    صاحبه    ${found.video.channel}`);
console.log('\n  (WASLA_URL و WASLA_TOKEN يرفعانه تلقائياً بدل هذا.)');
