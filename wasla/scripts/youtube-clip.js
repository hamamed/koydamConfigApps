#!/usr/bin/env node
/**
 * Cuts a clip out of a Creative Commons YouTube video **on this machine**, and
 * writes it next to the credit it has to carry.
 *
 * YouTube refuses the VPS — it blocks datacentre addresses and asks the server
 * to "sign in to confirm you're not a bot" — so the panel cannot fetch a video
 * itself. A laptop is an ordinary address and is not refused, so the fetch
 * happens here and the finished MP3 is uploaded through the panel's own form,
 * which cuts, checks and credits it exactly as it would any other file.
 *
 * The licence rule is the panel's: only a video its uploader licensed Creative
 * Commons Attribution, checked before any audio is fetched.
 *
 *   node scripts/youtube-clip.js <url> --start 1:20 --seconds 8 \
 *        [--title "صوت المطر"] [--category "أصوات الطبيعة"] [--out ~/Desktop]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { readTime } from '../src/audio-clips.js';
import { CC_BY_NAME, createAudioImport } from '../src/audio-import.js';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const url = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);

if (!url || args.includes('--help')) {
  console.log(`  node scripts/youtube-clip.js <url> --start 1:20 --seconds 8 [--title …] [--category …] [--out .]

  Only a video licensed «Creative Commons Attribution» is taken; every other
  one is refused. Upload the MP3 it writes on the panel's «مكتبة الأصوات»
  page, with the credit it prints.`);
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
const refusal = importer.usable(found.video);
if (refusal.error) {
  console.error(`  ${refusal.error}`);
  process.exit(1);
}
console.log(`  «${found.video.title}» — ${found.video.channel} · ${CC_BY_NAME}`);

console.log(`  Fetching ${seconds}s from ${flag('start', '0')}…`);
const got = await importer.clip(url, { start, seconds });
if (got.error) {
  console.error(`  ${got.error}`);
  process.exit(1);
}

const name = (flag('title') || found.video.title).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60);
const out = path.resolve(flag('out', process.cwd()), `${name || found.video.id}.mp3`);
await fs.writeFile(out, got.audio);

console.log(`\n  ${out}\n`);
console.log('  ارفعه في «مكتبة الأصوات» بهذه البيانات:');
console.log(`    الاسم    ${flag('title') || found.video.title}`);
console.log(`    الفئة    ${flag('category', '—')}`);
console.log(`    من       0   ·   لمدة ${seconds}`);
console.log(`    المصدر   ${found.video.url}`);
console.log(`    الرخصة   ${CC_BY_NAME}`);
console.log(`    صاحبه    ${found.video.channel}`);
