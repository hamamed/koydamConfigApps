/**
 * Which categories an answer may sensibly lose «ال» from.
 *
 * In these five the answers are ordinary nouns — القلم, الشمس, السباحة — and
 * the article is decoration. Everywhere else it belongs to the answer: a
 * proverb needs it to be a sentence, and الطهطاوي, البيهقي, الجرجاني, القاهرة
 * are simply how those names are written. Offering to strip it there is
 * offering to break the answer.
 *
 * Shared by scripts/strip-article.js, which sweeps, and the Answers page,
 * which strips one at a time — so the two can never disagree about what is
 * safe to touch.
 */
export const NOUN_CATEGORIES = Object.freeze([
  'معلومات عامة', 'رياضات', 'مرادف', 'النحو والإعراب', 'شخصيات كرتونية',
]);

export const isNounCategory = (title) => NOUN_CATEGORIES.includes(String(title ?? '').trim());

/**
 * Proper nouns that live inside those categories: names of people, places,
 * works and bodies. A rule cannot tell الأزهر from القلم, so they are named.
 *
 * Both the sweep and the Answers page read this, so neither can offer to strip
 * an answer the other protects.
 */
export const KEEP_ARTICLE = new Set([
  // Places, countries, cities, rivers, mountains, seas
  'الأرجنتين', 'الأطلس', 'الأقصر', 'الألب', 'الأمازون', 'الأندلس', 'الأنديز', 'الإسكندرية',
  'الإمارات', 'البتراء', 'البحرين', 'البرازيل', 'البندقية', 'الجزائر', 'الحديبية', 'الخرطوم',
  'الدانوب', 'الدوحة', 'الرباط', 'الرياض', 'الزوراء', 'السعودية', 'السودان', 'السويد',
  'السيبيري', 'الشهباء', 'الصين', 'العراق', 'الغانج', 'الفاتيكان', 'الفرات', 'الفولغا',
  'الفيحاء', 'القادسية', 'القاهرة', 'القدس', 'القسطنطينية', 'القيروان', 'القرويين', 'الكرملين',
  'الكويت', 'الكولوسيوم', 'اللوفر', 'المحروسة', 'المغرب', 'المكسيك', 'المملكة', 'المنامة',
  'المتوسط', 'النيل', 'الهند', 'الهيمالايا', 'اليابان', 'اليرموك', 'اليمن', 'اليونان',
  'الخندق', 'الروضة', 'التايمز', 'البنتاغون',
  // Planets
  'المريخ', 'المشتري', 'الزهرة',
  // People, dynasties, peoples
  'الأصفهاني', 'الإدريسي', 'الإسكندر', 'البخاري', 'الخنساء', 'الخوارزمي', 'الرازي', 'الطبري',
  'السومريون', 'الفاطميون', 'الفراعنة', 'الفينيقيون', 'الليديون', 'المتنبي', 'المعري', 'المماليك',
  'المنصور', 'الأيوبية', 'الفاروق', 'القادر', 'الفاتح', 'العاص', 'الرشيد', 'المعتصم',
  // Works, awards, bodies, institutions
  'الأغاني', 'البخلاء', 'الإنجيل', 'المعلقات', 'المعلقة', 'المقامات', 'المقدمة', 'الموناليزا',
  'الأوسكار', 'اليونسكو', 'اليونيسف', 'الأزهر', 'النظامية', 'المستنصرية', 'البديع',
  // Quran chapters and Islamic proper nouns that slipped into general knowledge
  'الكوثر', 'التوبة', 'البقرة', 'النبوي', 'الهجرة', 'الطور',
  // Monuments and epithets that read as ordinary nouns once the article is off:
  // «الحمراء» is the palace, «الزيتونة» the mosque, «الصديق» أبو بكر.
  'الحمراء', 'الزيتونة', 'الصديق', 'العين', 'الفيصل', 'الكعبة',
]);
