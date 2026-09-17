/**
 * The level preview: the numbers the iOS app lays a level out with, for an
 * iPhone-sized frame in the panel. Sizes follow the app's TileSizing and
 * QuestionLayout for a 390 × 844 pt screen, so the preview is the app's
 * geometry, not an approximation of its look.
 */

import { cellsOf } from './layout.js';

export const SCREEN = { width: 390, height: 844, statusBar: 47, navBar: 44, homeIndicator: 34 };
/** The height the app's content gets under the navigation bar. */
export const CONTENT_HEIGHT = SCREEN.height - SCREEN.statusBar - SCREEN.navBar - SCREEN.homeIndicator;

const TILE = { spacing: 5, maxFullScreen: 62, min: 16 };
export const BANK_SIZE = 12;
export const FILLER_ALPHABET = [...'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'];
export const STARTING_COINS = 100;

/** The app's help order, what each costs, and its icon. */
export const HELPS = [
  { kind: 'revealLetter', title: 'كشف حرف', cost: 15, icon: 'magnifier' },
  { kind: 'removeLetters', title: 'حذف 3 أحرف', cost: 10, icon: 'trash' },
  { kind: 'solveWord', title: 'حل الكلمة', cost: 40, icon: 'lightbulb' },
  { kind: 'unzoomImage', title: 'تصغير الصورة', cost: 20, icon: 'shrink' },
  { kind: 'unblurImage', title: 'وضّح الصورة', cost: 20, icon: 'eye' },
  { kind: 'askFriend', title: 'اسأل صديق', cost: 0, icon: 'friends' },
];

const fit = (length, count, cap) => {
  if (count <= 0 || length <= 0) return TILE.min;
  const room = length - (count - 1) * TILE.spacing;
  return Math.max(TILE.min, Math.min(cap, Math.floor(room / count)));
};

/** TileSizing.tileSize(fitting:) for the board's room on this screen. */
export function tileSize(rows, cols) {
  const room = { width: Math.min(SCREEN.width, 600) - 32, height: Math.max(CONTENT_HEIGHT - 150, 120) };
  return Math.min(fit(room.width, cols, TILE.maxFullScreen), fit(room.height, rows, TILE.maxFullScreen));
}

/** QuestionStage.of: what the question page draws above the clue. */
export function stageOf(word) {
  if (word.type === 'audio' && word.audioFile) return 'audio';
  if (word.type === 'emoji' && word.emoji && word.emoji.trim()) return 'emoji';
  if (word.imageFile) return 'picture';
  return 'text';
}

/** QuestionLayout for this screen: the sizes of the question page. */
export function questionLayout({ stage, letterCount, hasTitle }) {
  const height = CONTENT_HEIGHT;
  const isCompact = height < 700;
  const spacing = isCompact ? 10 : 18;
  const outerPadding = isCompact ? 8 : 12;
  const cardPadding = isCompact ? 12 : 20;
  const panelPadding = isCompact ? 10 : 14;
  const keyRowSpacing = isCompact ? 8 : 12;
  const helpsHeight = isCompact ? 70 : 92;
  const clueFontSize = isCompact ? 20 : 24;
  const titleHeight = isCompact ? 26 : 30;
  const titleFontSize = isCompact ? 13 : 14;
  const keySpacing = 8;

  const contentWidth = Math.min(SCREEN.width, 480) - 32;
  const innerWidth = contentWidth - 24;
  const count = Math.max(letterCount, 1);
  const slotSide = Math.max(26, Math.min(isCompact ? 44 : 50, Math.floor((innerWidth - 8 * (count - 1)) / count)));

  const keySide = (contentWidth - panelPadding * 2 - keySpacing * 5) / 6;
  const keyboard = keySide * 2 + keyRowSpacing + 4;
  const panel = panelPadding * 2 + keyboard + (isCompact ? 10 : 16) + helpsHeight;
  const hasClueLine = stage !== 'text';
  const clueLine = hasClueLine ? clueFontSize * 1.5 + (isCompact ? 8 : 14) : 0;
  const titleLine = hasTitle ? titleHeight + 3 + (isCompact ? 8 : 14) : 0;
  const cardChrome = cardPadding * 2 + (isCompact ? 8 : 14) + 32 + clueLine + titleLine;
  const fixed = outerPadding * 2 + spacing * 2 + panel + slotSide + 4 + cardChrome;
  const room = height - fixed;
  const widthCap = Math.min(innerWidth - 12, 270);
  const preferred = stage === 'picture' ? Math.min(widthCap, room)
    : stage === 'text' ? Math.min(widthCap, room * 0.9)
      : Math.min(widthCap * 0.72, room);

  return {
    isCompact, spacing, outerPadding, cardPadding, panelPadding, keyRowSpacing, helpsHeight, clueFontSize,
    titleHeight, titleFontSize, slotSide, hasClueLine, keySide: Math.floor(keySide * 100) / 100,
    stage: Math.round(Math.max(96, preferred)),
  };
}

/** A small seeded generator, so a word's letter bank is the same on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** LetterBank.build: the answer's letters plus fillers up to 12, shuffled (seeded). */
export function letterBank(letters, seed) {
  const random = mulberry32(seed);
  const fillers = shuffled(FILLER_ALPHABET, random).slice(0, Math.max(0, BANK_SIZE - letters.length));
  return shuffled([...letters, ...fillers], random);
}

/** Everything the preview page draws for a level from `repo.getLevel`. */
export function previewLevel(level) {
  const cells = new Map();
  const words = level.words.map((word, index) => {
    const letters = [...word.playAnswer];
    const stage = stageOf(word);
    cellsOf({ ...word, answer: word.playAnswer }).forEach((cell) => {
      const key = `${cell.row},${cell.col}`;
      const entry = cells.get(key) ?? { row: cell.row, col: cell.col, letter: cell.letter, words: [] };
      entry.words.push(index);
      cells.set(key, entry);
    });
    const zoomed = stage === 'picture' && word.zoom > 1.001;
    const blurred = stage === 'picture' && word.blurred;
    return {
      index,
      id: word.id,
      answer: word.answer,
      letters,
      title: word.title,
      clue: word.clue,
      direction: word.direction,
      type: word.type,
      stage,
      emoji: word.emoji,
      imageFile: word.imageFile,
      audioFile: word.audioFile,
      zoom: word.zoom,
      focusX: word.focusX,
      focusY: word.focusY,
      blurred,
      bank: letterBank(letters, word.id),
      helps: HELPS.filter((h) => (h.kind === 'unzoomImage' ? zoomed : h.kind === 'unblurImage' ? blurred : true)),
      layout: questionLayout({ stage, letterCount: letters.length, hasTitle: Boolean(word.title) }),
    };
  });
  return {
    words,
    cells: [...cells.values()],
    tile: tileSize(level.rows, level.cols),
  };
}
