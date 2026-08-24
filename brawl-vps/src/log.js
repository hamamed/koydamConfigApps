import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * Structured line logger. JSON in production so `journalctl`/`docker logs`
 * output is greppable and machine-parseable; human-readable in development.
 */
function emit(level, msg, fields = {}) {
  if (LEVELS[level] > threshold) return;

  if (config.env === 'production') {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...fields,
      })}\n`,
    );
    return;
  }

  const extra = Object.keys(fields).length
    ? ` ${Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')}`
    : '';
  process.stdout.write(
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`,
  );
}

export const log = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
};
