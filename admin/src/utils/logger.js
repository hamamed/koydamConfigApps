import { config } from '../config/index.js'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? (config.isTest ? LEVELS.error : LEVELS.info)

const emit = (level, message, meta) => {
  if (LEVELS[level] > activeLevel) return
  const line = { ts: new Date().toISOString(), level, message, ...(meta ? { meta } : {}) }
  const stream = level === 'error' ? console.error : console.log
  stream(config.isProduction ? JSON.stringify(line) : `[${line.ts}] ${level.toUpperCase()} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`)
}

export const logger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
  child: (prefix) => ({
    error: (message, meta) => emit('error', `${prefix} ${message}`, meta),
    warn: (message, meta) => emit('warn', `${prefix} ${message}`, meta),
    info: (message, meta) => emit('info', `${prefix} ${message}`, meta),
    debug: (message, meta) => emit('debug', `${prefix} ${message}`, meta),
  }),
}
