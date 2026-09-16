import { createFileStore } from './file-store.js';

/**
 * Question sounds: MP3, M4A, AAC or WAV, recognised by their bytes — the four
 * AVFoundation plays without a codec of its own.
 */

export function sniffAudio(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // MP3 with an ID3 tag in front of the first frame.
  if (buffer.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  // An MP4 container: M4A from iTunes, Voice Memos and most encoders.
  if (buffer.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (buffer[0] === 0xff) {
    // Both start with an 11-bit frame sync. ADTS (raw AAC) sets the layer bits
    // to 00, which MPEG audio reserves; MP3 sets them to anything else.
    if ((buffer[1] & 0xf6) === 0xf0) return 'aac';
    if ((buffer[1] & 0xe0) === 0xe0 && ((buffer[1] >> 1) & 0x03) !== 0) return 'mp3';
  }
  return null;
}

export function createAudioStore(root, { maxBytes }) {
  return createFileStore(root, {
    maxBytes,
    sniff: sniffAudio,
    extensions: ['mp3', 'm4a', 'aac', 'wav'],
    noun: 'audio file',
    formats: 'MP3, M4A, AAC or WAV',
  });
}
