/**
 * Questions pasted as text — copied from a web page, a document or a chat —
 * turned into the same rows a CSV import makes, so they go through the same
 * preview and confirm (src/importer.js).
 *
 * What it understands, line by line:
 *   - "clue - answer", "clue: answer", "clue = answer", "clue | answer",
 *     "clue → answer", or a tab between them (a copied table);
 *   - "ما عاصمة مصر؟ القاهرة": the last question mark ends the clue;
 *   - a line ending in a question mark is a whole clue, colons and all
 *     ("ماذا تعني الكلمة التالية: أفلاطون؟"), and its answer is on the next line;
 *   - "س: …" then "ج: …" (also السؤال / الجواب / الإجابة, Q / A);
 *   - a clue on one line and its answer on the next;
 *   - "# حيوانات" sets the title for the lines after it.
 * Numbering and bullets ("1-", "(٣)", "•") are dropped. Which side is the
 * answer follows `order`: 'clue-first', 'answer-first', or 'auto' — the side
 * with the question mark is the clue, else the shorter side is the answer.
 */

import { MAX_IMPORT_ROWS } from './importer.js';

export const PASTE_ORDERS = ['auto', 'clue-first', 'answer-first'];
export const MAX_PASTE_CHARS = 200_000;

const NUMBERING = /^\s*(?:[([]?[0-9٠-٩]+\s*[)\].\-–:،)]|[•●▪◦*·\-–—])\s*/u;
const CLUE_LABEL = /^(?:س|سؤال|السؤال|q|question)\s*\d*\s*[:：\-–.]\s*(.*)$/iu;
const ANSWER_LABEL = /^(?:ج|جواب|الجواب|الإجابة|الاجابة|إجابة|اجابة|a|answer)\s*[:：\-–.]\s*(.*)$/iu;
/** Tried in this order; the first found splits the line once. */
const SEPARATORS = ['\t', ' | ', '|', ' → ', '→', ' => ', ' = ', '=', ' — ', ' – ', ' - ', ' : ', ': ', ':'];
const QUESTION_MARK = /[؟?]/u;
const wordCount = (text) => text.split(/\s+/u).filter(Boolean).length;

/** An answer as it was probably meant: no end punctuation, quotes, brackets or trailing remark in parentheses. */
function cleanAnswer(raw) {
  return String(raw)
    .replace(/\s*[([（].*?[)\]）]\s*$/u, '')
    .replace(/^["'«»“”‘’\s]+|["'«»“”‘’\s.،,؛;!؟?]+$/gu, '')
    .trim();
}

const cleanClue = (raw) => String(raw).replace(/^["'«»“”\s]+|["'«»“”\s:：]+$/gu, '').trim();

/** Whether the line is a question on its own: it ends with a question mark. */
const endsAsQuestion = (line) => /[؟?]["'»”)\]]*$/u.test(line);

/**
 * Splits one line into two sides, or null when it has no separator. Text
 * after the last question mark is the answer; a line that ends with one is a
 * whole clue, so a colon inside the question never splits it.
 */
function splitLine(line, order) {
  const mark = Math.max(line.lastIndexOf('؟'), line.lastIndexOf('?'));
  if (mark > 0 && mark < line.length - 1) {
    const rest = line.slice(mark + 1).replace(/^[\s\-–—:=|→"'»”)\]]+/u, '');
    if (rest) return [line.slice(0, mark + 1), rest];
  }
  // "answer: question?" is only read that way when answers are said to come first.
  if (mark > 0 && order !== 'answer-first') return null;
  for (const separator of SEPARATORS) {
    const at = line.indexOf(separator);
    if (at > 0 && at < line.length - separator.length) {
      return [line.slice(0, at), line.slice(at + separator.length)];
    }
  }
  return null;
}

/** `{ clue, answer }` from two sides in the chosen order. */
function decide(first, second, order) {
  if (order === 'clue-first') return { clue: first, answer: second };
  if (order === 'answer-first') return { clue: second, answer: first };
  if (QUESTION_MARK.test(first)) return { clue: first, answer: second };
  if (QUESTION_MARK.test(second)) return { clue: second, answer: first };
  return wordCount(second) <= wordCount(first) ? { clue: first, answer: second } : { clue: second, answer: first };
}

/**
 * `{ rows: [{ row, values: { answer, clue, title, level } }] }` for the
 * importer, or `{ error }` for the whole paste.
 */
export function readPastedQuestions(text, { title = '', level = '', order = 'auto' } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return { error: 'Paste some questions first.' };
  if (source.length > MAX_PASTE_CHARS) return { error: `At most ${MAX_PASTE_CHARS.toLocaleString('en')} characters per paste. Split it.` };
  const how = PASTE_ORDERS.includes(order) ? order : 'auto';

  let currentTitle = String(title ?? '').trim();
  const levelCell = String(level ?? '').trim();
  const rows = [];
  let pending = null;
  let pendingIsLabelled = false;

  const push = (clue, answer) => rows.push({
    row: rows.length + 1,
    values: { answer: cleanAnswer(answer), clue: cleanClue(clue), title: currentTitle, level: levelCell },
  });
  const flushPending = () => {
    // A clue that never got its answer still shows in the preview, with its error.
    if (pending !== null) push(pending, '');
    pending = null;
    pendingIsLabelled = false;
  };

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      flushPending();
      const heading = trimmed.replace(/^#+/, '').trim();
      if (heading) currentTitle = heading;
      continue;
    }
    const line = trimmed.replace(NUMBERING, '').trim();
    if (!line) continue;

    const clueLabel = line.match(CLUE_LABEL);
    if (clueLabel) {
      flushPending();
      pending = clueLabel[1].trim();
      pendingIsLabelled = true;
      continue;
    }
    const answerLabel = line.match(ANSWER_LABEL);
    if (answerLabel && pending !== null) {
      push(pending, answerLabel[1]);
      pending = null;
      pendingIsLabelled = false;
      continue;
    }

    const sides = splitLine(line, how);
    if (sides && pending === null) {
      const { clue, answer } = decide(sides[0].trim(), sides[1].trim(), how);
      push(clue, answer);
      continue;
    }

    if (pending === null) {
      pending = line;
      continue;
    }
    // Another question before the last one got its answer: that one stays unanswered.
    if (endsAsQuestion(line) && endsAsQuestion(pending)) {
      flushPending();
      pending = line;
      continue;
    }
    // Two lines make one question.
    const { clue, answer } = pendingIsLabelled ? { clue: pending, answer: line } : decide(pending, line, how);
    push(clue, answer);
    pending = null;
    pendingIsLabelled = false;
  }
  flushPending();

  if (!rows.length) return { error: 'No questions were found in the text.' };
  if (rows.length > MAX_IMPORT_ROWS) return { error: `At most ${MAX_IMPORT_ROWS} questions per import. Split the text.` };
  return { rows };
}
