import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] > threshold) return;
  const extra = Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';
  process.stdout.write(
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`,
  );
}

export const log = {
  error: (m, f) => emit('error', m, f),
  warn: (m, f) => emit('warn', m, f),
  info: (m, f) => emit('info', m, f),
  debug: (m, f) => emit('debug', m, f),
};
