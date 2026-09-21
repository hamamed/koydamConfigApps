/**
 * The list of question titles the panel offers (حيوانات، سيارات، عواصم…).
 *
 * A question still stores its title as text, so a title can exist on questions
 * without being on the list (typed in before the list, or imported); the Titles
 * page shows those too and can add them. Renaming a title renames it on every
 * question that has it; a title can only be deleted once no question uses it.
 */

import { MAX_TITLE } from './repository.js';

/** Added once, the first time the list exists; deleting one later does not bring it back. */
export const SUGGESTED_TITLES = Object.freeze([
  'حيوانات', 'طيور', 'حيوانات بحرية', 'حشرات', 'سيارات', 'وسائل النقل', 'دول', 'عواصم', 'مدن', 'أعلام الدول',
  'عملات', 'لغات', 'بحار ومحيطات', 'أنهار', 'جبال', 'فواكه', 'خضروات', 'أطعمة', 'حلويات', 'مشروبات',
  'نباتات', 'أشجار', 'زهور', 'ألوان', 'أشكال', 'أرقام', 'أجزاء الجسم', 'مهن', 'أدوات', 'أثاث',
  'أدوات المطبخ', 'ملابس', 'رياضة', 'كرة القدم', 'مشاهير الرياضة', 'ألعاب', 'الفضاء', 'كواكب', 'علوم', 'اختراعات',
  'تقنية', 'علماء', 'تاريخ', 'جغرافيا', 'إسلاميات', 'أنبياء', 'القرآن الكريم', 'لغة عربية', 'معاني كلمات', 'أدب وشعراء',
  'أمثال شعبية', 'أفلام', 'رسوم متحركة', 'موسيقى', 'آلات موسيقية', 'شخصيات مشهورة', 'ماركات', 'طقس', 'أشهر وأيام', 'أسماء',
]);

const SEEDED_KEY = 'titles_seeded';

/** A title as it is stored: trimmed, 1 to MAX_TITLE characters. `{ name }` or `{ error }`. */
export function readTitle(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/gu, ' ');
  if (!name) return { error: 'اكتب الفئة.' };
  if ([...name].length > MAX_TITLE) return { error: `الفئة حتى ${MAX_TITLE} حرفاً.` };
  return { name };
}

export function createTitles(db) {
  const tx = (fn) => db.transaction(fn)();

  /** Puts the suggested titles on the list once, the first time it runs on a database. */
  function seedOnce() {
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SEEDED_KEY)) return;
    tx(() => {
      const add = db.prepare('INSERT OR IGNORE INTO question_titles (name) VALUES (?)');
      SUGGESTED_TITLES.forEach((name) => add.run(name));
      db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(SEEDED_KEY);
    });
  }

  /**
   * Every title — on the list, or only on questions — with how many questions
   * use it: `[{ name, questions, listed }]`, by name.
   */
  function list() {
    const counts = new Map(db.prepare(`SELECT trim(title) AS name, COUNT(*) AS n FROM questions
      WHERE trim(IFNULL(title, '')) <> '' GROUP BY trim(title)`).all().map((r) => [r.name, r.n]));
    const listed = new Set(db.prepare('SELECT name FROM question_titles').pluck().all());
    return [...new Set([...listed, ...counts.keys()])]
      .map((name) => ({ name, questions: counts.get(name) ?? 0, listed: listed.has(name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  /** The names to offer in a title box. */
  const names = () => list().map((t) => t.name);

  /** Adds one title per line. `{ added, existing, errors: [text] }`. */
  function addMany(text) {
    const lines = String(text ?? '').split(/\r?\n|[،,]/u).map((l) => l.trim()).filter(Boolean);
    const result = { added: 0, existing: 0, errors: [] };
    const add = db.prepare('INSERT OR IGNORE INTO question_titles (name) VALUES (?)');
    tx(() => {
      for (const line of lines) {
        const { name, error } = readTitle(line);
        if (error) result.errors.push(`${line}: ${error}`);
        else if (add.run(name).changes) result.added += 1;
        else result.existing += 1;
      }
    });
    return result;
  }

  /** Renames a title on the list and on every question that has it. `{ renamed }` or `{ error }`. */
  function rename(from, to) {
    const old = String(from ?? '').trim();
    const { name, error } = readTitle(to);
    if (error) return { error };
    if (!old) return { error: 'اختر فئة لإعادة تسميتها.' };
    if (name === old) return { renamed: 0 };
    return tx(() => {
      const renamed = db.prepare("UPDATE questions SET title = ?, updated_at = datetime('now') WHERE trim(title) = ?").run(name, old).changes;
      // The app sees a level changed when a word in it did.
      db.prepare(`UPDATE levels SET updated_at = datetime('now') WHERE id IN
        (SELECT lw.level_id FROM level_words lw JOIN questions q ON q.id = lw.question_id WHERE q.title = ?)`).run(name);
      db.prepare('DELETE FROM question_titles WHERE name = ?').run(old);
      db.prepare('INSERT OR IGNORE INTO question_titles (name) VALUES (?)').run(name);
      // A theme kept out of the word search stays out under its new name.
      if (db.prepare('DELETE FROM wordsearch_excluded_titles WHERE title = ?').run(old).changes) {
        db.prepare('INSERT OR IGNORE INTO wordsearch_excluded_titles (title) VALUES (?)').run(name);
      }
      return { renamed };
    });
  }

  /** Takes a title off the list. Refused while questions use it. `{}` or `{ error }`. */
  function remove(raw) {
    const name = String(raw ?? '').trim();
    const used = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE trim(title) = ?').get(name).n;
    if (used) return { error: `«${name}» مستعملة في ${used} سؤالاً. أعد تسميتها، أو أعطِ تلك الأسئلة فئة أخرى أولاً.` };
    db.prepare('DELETE FROM question_titles WHERE name = ?').run(name);
    return {};
  }

  seedOnce();
  return { list, names, addMany, rename, remove };
}
