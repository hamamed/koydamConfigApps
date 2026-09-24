import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ayahForClue, buildClue, MAX_WORDS, meaningfulWords } from '../src/quran-clues.js';

/** Real ayat, in the edition the bank is written in. */
const DUHA_3 = 'مَا وَدَّعَكَ رَبُّكَ وَمَا قَلَىٰ';
const QURAYSH_4 = 'الَّذِي أَطْعَمَهُمْ مِّن جُوعٍ وَآمَنَهُم مِّنْ خَوْفٍ';
const KAWTHAR_1 = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ إِنَّا أَعْطَيْنَاكَ الْكَوْثَرَ';
const FATIHA_1 = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';
const BAQARA_2 = 'ذَٰلِكَ الْكِتَابُ لَا رَيْبَ ۛ فِيهِ ۛ هُدًى لِّلْمُتَّقِينَ';
const ISRA_23 = '۞ وَقَضَىٰ رَبُّكَ أَلَّا تَعْبُدُوا إِلَّا إِيَّاهُ وَبِالْوَالِدَيْنِ إِحْسَانًا ۚ إِمَّا يَبْلُغَنَّ '
  + 'عِندَكَ الْكِبَرَ أَحَدُهُمَا أَوْ كِلَاهُمَا فَلَا تَقُل لَّهُمَا أُفٍّ وَلَا تَنْهَرْهُمَا وَقُل لَّهُمَا قَوْلًا كَرِيمًا';

test('an answer in the middle of the ayah is blanked where it stands', () => {
  // The whole point: «وآمنهم» is not the last word, so the words after it stay.
  const clue = buildClue({ ayah: QURAYSH_4, answer: 'وآمنهم', at: 4, surah: 'قريش' });
  assert.equal(clue, 'الَّذِي أَطْعَمَهُمْ مِّن جُوعٍ … مِّنْ خَوْفٍ ﴿قريش﴾');
});

test('an answer at the end of the ayah leaves the blank last, with the whole verse before it', () => {
  const clue = buildClue({ ayah: DUHA_3, answer: 'قلى', at: 4, surah: 'الضحى' });
  assert.equal(clue, 'مَا وَدَّعَكَ رَبُّكَ وَمَا … ﴿الضحى﴾');
});

test('the clue stops at its own ayah', () => {
  // الكوثر 2 is «فَصَلِّ لِرَبِّكَ وَانْحَرْ»; none of it may appear in a clue for ayah 1.
  const clue = buildClue({ ayah: KAWTHAR_1, answer: 'الكوثر', at: 6, surah: 'الكوثر' });
  assert.equal(clue, 'إِنَّا أَعْطَيْنَاكَ … ﴿الكوثر﴾');
  assert.ok(!clue.includes('فَصَلِّ'));
});

test('the basmala this edition prefixes to a first ayah is not part of the clue', () => {
  assert.equal(ayahForClue(KAWTHAR_1, 'الكوثر'), 'إِنَّا أَعْطَيْنَاكَ الْكَوْثَرَ');
});

test('but it stays when the answer is inside it', () => {
  // «الرحيم» is the Fatiha's first ayah; cutting the basmala would leave nothing.
  assert.equal(ayahForClue(FATIHA_1, 'الرحيم'), FATIHA_1);
  assert.equal(buildClue({ ayah: FATIHA_1, answer: 'الرحيم', at: 3, surah: 'الفاتحة' }),
               'بِسْمِ اللَّهِ الرَّحْمَٰنِ … ﴿الفاتحة﴾');
});

test('waqf marks are kept in the line but are not counted as words', () => {
  assert.equal(meaningfulWords(BAQARA_2).length, 7, 'the two ۛ are marks, not words');
  const clue = buildClue({ ayah: BAQARA_2, answer: 'للمتقين', at: 6, surah: 'البقرة' });
  assert.equal(clue, 'ذَٰلِكَ الْكِتَابُ لَا رَيْبَ ۛ فِيهِ ۛ هُدًى … ﴿البقرة﴾');
});

test('a long ayah is cut to a window around the blank, not shown whole', () => {
  const clue = buildClue({ ayah: ISRA_23, answer: 'أفا', at: 18, surah: 'الإسراء' });
  assert.equal(clue, null, 'and an answer that is not in the ayah builds nothing');

  const real = buildClue({ ayah: ISRA_23, answer: 'أف', at: 18, surah: 'الإسراء' });
  const shown = meaningfulWords(real.replace(/\s*﴿.*$/u, ''));
  assert.ok(shown.length <= MAX_WORDS, `${shown.length} words is more than ${MAX_WORDS}`);
  assert.ok(real.includes('فَلَا تَقُل لَّهُمَا …'), real);
  assert.ok(real.includes('وَلَا تَنْهَرْهُمَا'), 'and it keeps context on both sides');
  assert.ok(!real.includes('۞'), 'the hizb mark is a scribe\'s sign, not a word');
});

test('an answer that is not where it is said to be builds nothing', () => {
  assert.equal(buildClue({ ayah: DUHA_3, answer: 'قلى', at: 1, surah: 'الضحى' }), null);
  assert.equal(buildClue({ ayah: DUHA_3, answer: 'وقلى', at: 4, surah: 'الضحى' }), null);
});

test('the basmala stays when the ayah alone would leave no clue at all', () => {
  // العصر 1 is «وَالْعَصْرِ» and the answer is that word: drop the basmala and
  // the whole clue is a blank.
  const asr1 = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ وَالْعَصْرِ';
  assert.equal(buildClue({ ayah: asr1, answer: 'والعصر', at: 4, surah: 'العصر' }),
               'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ … ﴿العصر﴾');

  // قريش 1 is «لِإِيلَافِ قُرَيْشٍ»: one word is the whole verse, so it stands
  // on its own and the basmala goes.
  const quraysh1 = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ لِإِيلَافِ قُرَيْشٍ';
  assert.equal(buildClue({ ayah: quraysh1, answer: 'قريش', at: 5, surah: 'قريش' }),
               'لِإِيلَافِ … ﴿قريش﴾');

  // الهمزة 1 has enough of its own, so the basmala goes.
  const humaza1 = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ وَيْلٌ لِّكُلِّ هُمَزَةٍ لُّمَزَةٍ';
  assert.equal(buildClue({ ayah: humaza1, answer: 'لمزة', at: 7, surah: 'الهمزة' }),
               'وَيْلٌ لِّكُلِّ هُمَزَةٍ … ﴿الهمزة﴾');
});
