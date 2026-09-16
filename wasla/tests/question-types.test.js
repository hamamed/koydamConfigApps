import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveType, emojiProblem, normalizeEmoji } from '../src/question-types.js';

test('the type follows the richest media a question has', () => {
  assert.equal(deriveType({ audioFile: 'a.mp3', imageFile: 'a.jpg', emoji: '🦁' }), 'audio');
  assert.equal(deriveType({ imageFile: 'a.jpg', emoji: '🦁' }), 'image');
  assert.equal(deriveType({ emoji: '🦁' }), 'emoji');
  assert.equal(deriveType({}), 'text');
});

test('emoji are stored without spaces', () => {
  assert.equal(normalizeEmoji(' 🦁 👑 '), '🦁👑');
  assert.equal(normalizeEmoji(''), '');
});

test('accepts one to eight emoji, including flags, keycaps and joined sequences', () => {
  assert.equal(emojiProblem('🦁'), null);
  assert.equal(emojiProblem('🇲🇦⚽'), null);
  assert.equal(emojiProblem('1️⃣👨‍👩‍👧'), null);
  assert.equal(emojiProblem('❤️🔥🌙⭐🍎🚗🏠📚'), null);
});

test('refuses letters, digits alone, and more than eight emoji', () => {
  assert.match(emojiProblem('🦁a'), /only emoji/);
  assert.match(emojiProblem('أسد'), /only emoji/);
  assert.match(emojiProblem('12'), /only emoji/);
  assert.match(emojiProblem('🦁🦁🦁🦁🦁🦁🦁🦁🦁'), /at most 8/);
  assert.match(emojiProblem(''), /at least one/);
});
