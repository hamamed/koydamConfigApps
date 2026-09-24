/**
 * Rewrites the bank's "complete the ayah" clues from the Quranic text.
 *
 * The old clues were cut at the answer, so the blank was always the last thing
 * on the line and the player saw two or three words of the verse. This shows
 * the ayah the answer came from, blanked where the answer stands, and stops at
 * the end of that ayah.
 *
 *   node scripts/rebuild-quran-clues.js            # says what it would change
 *   node scripts/rebuild-quran-clues.js --write    # changes it
 *
 * `--seed` does the same to `scripts/questions-seed.txt`, which holds a hundred
 * of these questions. Without it a reseed would put the old clues back, and the
 * eight corrected answers would return as new rows beside the corrected ones —
 * the seed skips an answer it already finds, and «وقلى» would no longer be there
 * to find.
 *
 * The text is Tanzil's "simple" edition — <https://tanzil.net>, free to
 * redistribute verbatim. It is the orthography most of the bank was already
 * written in: of the words in the existing clues, 96% are spelled the way this
 * edition spells them against 94% for "simple enhanced", and it is the plainer
 * of the two to read on a phone. It is fetched rather than committed: nothing at runtime needs it,
 * and this is a script that runs when the Quranic questions change, not on a
 * deploy. `--quran <file>` reads a saved copy instead of the network.
 */

import fs from 'node:fs';
import process from 'node:process';

import { normalizeAnswer } from '../src/arabic.js';
import { buildClue, key, meaningfulWords, MIN_CONTEXT } from '../src/quran-clues.js';
import { db } from '../src/db/index.js';

const SOURCE = 'https://api.alquran.cloud/v1/quran/quran-simple';
/** A clue that quotes an ayah names its surah between these. */
const SURAH = /^(.*?)\s*﴿([^﴾]+)﴾\s*$/u;

/**
 * Answers that are not the word the verse uses.
 *
 * Each of these asks the player to complete a verse with something that is not
 * in it: «وَأَمَّا السَّائِلَ فَلَا …» is answered «تَنْهَرْ», and the bank said
 * «فتنهر», taking the فـ of the word before. Left alone they cannot be given a
 * clue at all, because there is nowhere in the verse for the blank to go.
 *
 * None of the eight is used in any level, so correcting the answer breaks no
 * grid. They are listed one by one rather than guessed at: changing an answer
 * changes what the player has to spell, and that is not something to infer.
 */
const CORRECTIONS = new Map([
  ['وقلى', { answer: 'قلى', note: 'الضحى 3 reads «وَمَا قَلَىٰ»; the واو belongs to «وَمَا»' }],
  ['فتنهر', { answer: 'تنهر', note: 'الضحى 10 reads «فَلَا تَنْهَرْ»; the فاء belongs to «فَلَا»' }],
  ['الأمور', { answer: 'الأمر', note: 'آل عمران 159 reads «وَشَاوِرْهُمْ فِي الْأَمْرِ», singular' }],
  ['أفا', { answer: 'أف', note: 'الإسراء 23 reads «أُفٍّ»' }],
  ['شكور', { answer: 'الشكور', note: 'سبأ 13 reads «عِبَادِيَ الشَّكُورُ», with the article' }],
  ['الزلزلة', { answer: 'زلزالها', note: 'الزلزلة 1 reads «زِلْزَالَهَا»; الزلزلة is the surah, not the word' }],
  ['التين', { answer: 'والتين', note: 'التين 1 reads «وَالتِّينِ», as the bank already writes «والعصر»' }],
  ['نهارا', { answer: 'إسرارا', note: 'the clue quotes نوح 8-9, which end «وَأَسْرَرْتُ لَهُمْ إِسْرَارًا»' }],
]);

async function readQuran(file) {
  const raw = file
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : await (await fetch(SOURCE)).json();
  return raw.data.surahs.map((surah) => ({
    number: surah.number,
    // «سُورَةُ العَصۡرِ» → «العصر», which is how the clues name it.
    name: normalizeAnswer(surah.name).replace(/^سورة\s*/u, '').trim(),
    // NFC, because the bank writes «رَبَّكَ» as fatha then shadda and the source
    // writes it the other way round. The two render alike and compare unequal,
    // which would otherwise show up as hundreds of changes that change nothing.
    ayahs: surah.ayahs.map((ayah) => ({
      n: ayah.numberInSurah,
      text: ayah.text.trim().normalize('NFC'),
    })),
  }));
}

/**
 * Which ayah a question is about, and which word of it the answer is.
 *
 * The clue is the anchor, not the answer alone: «الدين» ends dozens of ayat,
 * and only the words already shown say which one was meant. A question whose
 * answer is not in the ayah its clue quotes has nowhere to land, and is
 * reported rather than guessed at.
 */
function locate({ answer, clue }, byName, { context = true } = {}) {
  const split = clue.match(SURAH);
  if (!split) return { why: 'the clue names no surah' };
  const surah = byName.get(key(split[2]));
  if (!surah) return { why: `no surah called ${split[2]}` };
  // The bank's own spelling of the name is kept: it writes «الفاتحة» where the
  // edition writes «ٱلْفَاتِحَةِ», and both سبأ and سبإ appear in it.
  const named = split[2];

  const [beforeRaw, afterRaw = ''] = split[1].split('…');
  const before = context ? meaningfulWords(beforeRaw).map(key) : [];
  const after = context ? meaningfulWords(afterRaw).map(key) : [];
  const want = meaningfulWords(answer).map(key);

  const hits = [];
  for (const ayah of surah.ayahs) {
    const words = meaningfulWords(ayah.text).map(key);
    for (let i = 0; i + want.length <= words.length; i += 1) {
      if (!want.every((word, k) => words[i + k] === word)) continue;
      const end = i + want.length;
      // An old clue may run back into the ayah before this one, so only the
      // part of it that fits inside this ayah has to agree.
      const shown = before.slice(Math.max(0, before.length - i));
      const fits = shown.every((word, k) => words[i - shown.length + k] === word)
        && after.every((word, k) => words[end + k] === word);
      if (fits) hits.push({ surah, named, ayah, at: i });
    }
  }
  if (hits.length === 0) return { why: 'the answer is not in the ayah the clue quotes' };
  // More than one place fits: the first is the one the clue's context reached.
  return { hit: hits[0] };
}

/** Rewrites the ayah lines of the seed file. Returns how many changed. */
function rewriteSeed({ path, byName, write }) {
  const before = fs.readFileSync(path, 'utf8');
  let changed = 0;
  const after = before.split('\n').map((line) => {
    const parts = line.split('|');
    if (parts.length < 2 || !parts[1].includes('﴿')) return line;
    const raw = { answer: parts[0].trim(), clue: parts[1].trim() };
    const correction = CORRECTIONS.get(raw.answer);
    const row = correction ? { ...raw, answer: correction.answer } : raw;
    let found = locate(row, byName);
    if (!found.hit && correction) found = locate(row, byName, { context: false });
    if (!found.hit) return line;
    const clue = buildClue({
      ayah: found.hit.ayah.text, answer: row.answer, at: found.hit.at, surah: found.hit.named,
    });
    if (!clue) return line;
    const rest = parts.slice(2).join('|');
    const rebuilt = `${row.answer} | ${clue}${rest ? ` |${rest}` : ''}`;
    if (rebuilt !== line) changed += 1;
    return rebuilt;
  }).join('\n');
  if (write && changed) fs.writeFileSync(path, after, 'utf8');
  return changed;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const seed = args.includes('--seed');
  const file = args.includes('--quran') ? args[args.indexOf('--quran') + 1] : null;

  const quran = await readQuran(file);
  const byName = new Map(quran.map((surah) => [key(surah.name), surah]));

  const rows = db.prepare("SELECT id, answer, clue FROM questions WHERE clue LIKE '%﴿%'").all();
  const update = db.prepare(
    "UPDATE questions SET answer = ?, clue = ?, updated_at = datetime('now') WHERE id = ?");

  const changed = [];
  const same = [];
  const stuck = [];
  const fixed = [];
  for (const raw of rows) {
    const correction = CORRECTIONS.get(raw.answer);
    const row = correction ? { ...raw, answer: correction.answer } : raw;
    if (correction) fixed.push({ was: raw.answer, ...correction });
    // The words already shown are what says which ayah is meant — «الأمر» is in
    // آل عمران twice, and only «وَشَاوِرْهُمْ فِي» picks out 159. A corrected
    // row whose old clue is too malformed to place (التين's «وَ…» split a word
    // in half) falls back to the answer and the surah alone.
    let found = locate(row, byName);
    if (!found.hit && correction) found = locate(row, byName, { context: false });
    if (!found.hit) { stuck.push({ ...row, why: found.why }); continue; }
    const { surah, named, ayah, at } = found.hit;
    const clue = buildClue({ ayah: ayah.text, answer: row.answer, at, surah: named });
    if (!clue) { stuck.push({ ...row, why: 'the clue could not be built' }); continue; }
    // A clue that is all blank and surah asks the player to guess from nothing.
    const context = meaningfulWords(clue.replace(/\s*﴿[^﴾]*﴾\s*$/u, '')).length - 1;
    if (context < MIN_CONTEXT) {
      stuck.push({ ...row, why: `only ${context} word(s) of the verse would be left` });
      continue;
    }
    const settled = clue === row.clue.normalize('NFC') && row.answer === raw.answer;
    (settled ? same : changed)
      .push({ ...row, was: row.clue, wasAnswer: raw.answer, clue, ref: `${named} ${ayah.n}` });
  }

  if (write) {
    db.transaction(() => {
      for (const row of changed) update.run(row.answer, row.clue, row.id);
    })();
  }

  console.log(`${rows.length} ayah questions: ${changed.length} rewritten, `
    + `${same.length} already right, ${stuck.length} left alone.`);
  for (const row of stuck) console.log(`  ! ${row.answer} — ${row.why}\n      ${row.clue}`);
  if (fixed.length) {
    console.log(`\n${fixed.length} answers corrected against the text:`);
    for (const row of fixed) console.log(`  ${row.was} → ${row.answer}\n    ${row.note}`);
  }
  if (seed) {
    const path = new URL('./questions-seed.txt', import.meta.url).pathname;
    const lines = rewriteSeed({ path, byName, write });
    console.log(`\nThe seed file: ${lines} line(s) ${write ? 'rewritten' : 'would change'}.`);
  }

  if (!write) {
    console.log('\nA sample of what would change:');
    const step = process.env.ALL ? 1 : Math.max(1, Math.floor(changed.length / 12));
    for (let i = 0; i < changed.length; i += step) {
      const row = changed[i];
      const name = row.wasAnswer === row.answer ? row.answer : `${row.wasAnswer} → ${row.answer}`;
      console.log(`  ${row.ref} — ${name}\n    was  ${row.was}\n    now  ${row.clue}`);
    }
    console.log('\nNothing was written. Pass --write to apply.');
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
