/**
 * The lab games' content: جِذر (words from a root) and قوافي (finish the line).
 *
 * Both were hard-coded in the app. They live here now, as two lists of plain
 * text edited in the panel and served by `/api/v1/lab`; the app keeps its own
 * copy as a fallback, so a phone with no answer from the server still plays.
 *
 * The text formats are the ones a person would write by hand:
 *
 *   جِذر    `كتب: كتب كتاب كاتب مكتبة`
 *   قوافي   `الصديق وقت ــــ | الضيق | الفرح، السفر، العمل | مثل سائر | 🤝⏳`
 *
 * In a riddle the `ــــ` marks the gap: what comes before it and after it are
 * shown, and the answer fills it. A line with no gap mark is read as a gap at
 * the end, which is where most proverbs put it.
 */
import { foldForPlay, letters } from './arabic.js';
import { DEFAULT_RIDDLES, DEFAULT_ROOTS } from './lab-content.js';

export const LAB_LISTS = Object.freeze(['roots', 'riddles']);
export const ROOT_LETTERS = 3;
export const MIN_ROOT_WORDS = 3;
export const MAX_ROOT_WORDS = 14;
export const RIDDLE_DECOYS = 3;
export const MAX_LIST_CHARS = 40_000;

/** The gap in a riddle: four or more of the Arabic tatweel, or three or more underscores. */
const GAP = /ـ{3,}|_{3,}/u;
const ARABIC_TEXT = /^[؀-ۿ\s،؛:.!؟«»—\-']+$/u;
const ARABIC_WORD = /^[ء-يّـ]+$/u;

const lines = (text) => String(text ?? '').split('\n').map((line, index) => ({ line: index + 1, raw: line.trim() }))
  .filter((entry) => entry.raw && !entry.raw.startsWith('#'));

/** `{ roots, problems }` — a root and the words it accepts, one per line. */
export function parseRoots(text) {
  const roots = [];
  const problems = [];
  const seen = new Set();
  for (const { line, raw } of lines(text)) {
    const [head, rest] = raw.split(':');
    const root = (head ?? '').trim();
    const words = (rest ?? '').split(/[\s،]+/).map((word) => word.trim()).filter(Boolean);
    const problem = !rest ? 'اكتب الجذر ثم نقطتين ثم كلماته'
      : letters(root).length !== ROOT_LETTERS ? `الجذر ثلاثة حروف، و«${root}» ${letters(root).length}`
        : !ARABIC_WORD.test(root) ? 'الجذر حروف عربية فقط'
          : seen.has(foldForPlay(root)) ? `الجذر «${root}» مكرر`
            : words.length < MIN_ROOT_WORDS ? `الجذر يحتاج ${MIN_ROOT_WORDS} كلمات على الأقل`
              : words.length > MAX_ROOT_WORDS ? `أكثر من ${MAX_ROOT_WORDS} كلمة`
                : words.find((word) => !ARABIC_WORD.test(word)) ? `«${words.find((word) => !ARABIC_WORD.test(word))}» ليست حروفاً عربية`
                  : null;
    if (problem) problems.push({ line, text: raw, reason: problem });
    else {
      seen.add(foldForPlay(root));
      roots.push({ root, words: [...new Set(words)] });
    }
  }
  return { roots, problems };
}

/** `{ riddles, problems }` — the line, its answer, its decoys and whose it is. */
export function parseRiddles(text) {
  const riddles = [];
  const problems = [];
  for (const { line, raw } of lines(text)) {
    const parts = raw.split('|').map((part) => part.trim());
    // A fifth part is the emoji clue اكشف المثل shows over its board; it is optional.
    const [body, answer, decoyText, source, emoji] = parts;
    const decoys = (decoyText ?? '').split(/[،,]+/).map((word) => word.trim()).filter(Boolean);
    const problem = parts.length !== 4 && parts.length !== 5
      ? 'السطر أربعة أجزاء مفصولة بـ | : النص | الجواب | البدائل | المصدر (ويمكن جزء خامس للإيموجي)'
      : !body ? 'النص فارغ'
        : !answer ? 'الجواب فارغ'
          : decoys.length !== RIDDLE_DECOYS ? `البدائل ${RIDDLE_DECOYS} كلمات مفصولة بفواصل، وهنا ${decoys.length}`
            : !source ? 'اكتب المصدر: مثل سائر، أو اسم الشاعر'
              : !ARABIC_TEXT.test(body) ? 'النص حروف عربية فقط'
                : [answer, ...decoys].find((word) => !ARABIC_TEXT.test(word)) ? 'الجواب والبدائل حروف عربية فقط'
                  : decoys.includes(answer) ? 'الجواب مكرر في البدائل'
                    : null;
    if (problem) {
      problems.push({ line, text: raw, reason: problem });
      continue;
    }
    const gap = body.search(GAP);
    const before = (gap === -1 ? body : body.slice(0, gap)).trim();
    const after = gap === -1 ? '' : body.slice(gap).replace(GAP, '').trim();
    riddles.push({ before, after, answer, decoys, source, emoji: emoji ?? '' });
  }
  return { riddles, problems };
}

const PARSERS = Object.freeze({ roots: parseRoots, riddles: parseRiddles });
const DEFAULTS = Object.freeze({ roots: DEFAULT_ROOTS, riddles: DEFAULT_RIDDLES });

export function createLab(db) {
  const stored = (name) => db.prepare('SELECT body FROM lab_lists WHERE name = ?').pluck().get(name) ?? null;
  const body = (name) => stored(name) ?? DEFAULTS[name];

  /** Both lists with what they parse to, for the panel. */
  function lists() {
    return LAB_LISTS.map((name) => {
      const text = body(name);
      const parsed = PARSERS[name](text);
      const items = name === 'roots' ? parsed.roots : parsed.riddles;
      return { name, text, edited: stored(name) !== null, count: items.length, items, problems: parsed.problems };
    });
  }

  /** The قوافي list as اكشف المثل reads it: only the lines that parse. */
  const riddles = () => parseRiddles(body('riddles')).riddles;

  /** Saves a list when every line is usable; `{ error, problems }` otherwise. */
  function saveList(name, text) {
    if (!LAB_LISTS.includes(name)) return { error: 'قائمة غير معروفة.' };
    const clean = String(text ?? '').trim();
    if (clean.length > MAX_LIST_CHARS) return { error: `القائمة حتى ${MAX_LIST_CHARS.toLocaleString('en')} حرفاً.`, problems: [] };
    const parsed = PARSERS[name](clean);
    const count = name === 'roots' ? parsed.roots.length : parsed.riddles.length;
    if (parsed.problems.length) return { error: `${parsed.problems.length} سطراً يحتاج إصلاحاً؛ لم يُحفظ شيء.`, problems: parsed.problems };
    if (!count) return { error: 'تحتاج القائمة مدخلاً واحداً على الأقل.', problems: [] };
    db.prepare(`INSERT INTO lab_lists (name, body) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`).run(name, clean);
    return { count };
  }

  /** Back to the built-in list. */
  const resetList = (name) => db.prepare('DELETE FROM lab_lists WHERE name = ?').run(name).changes > 0;

  /** What `/api/v1/lab` serves: only the lines that parse, so the app never sees a broken one. */
  function content() {
    return {
      roots: parseRoots(body('roots')).roots,
      riddles: parseRiddles(body('riddles')).riddles,
    };
  }

  return { riddles, lists, saveList, resetList, content };
}
