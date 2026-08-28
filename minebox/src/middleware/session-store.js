import session from 'express-session';
import { db } from '../db/index.js';

const Store = session.Store;

/**
 * Session store backed by the same SQLite file as everything else.
 *
 * The default `MemoryStore` leaks and signs everyone out on restart; pulling in Redis for an
 * admin panel with a handful of users is disproportionate. This is ~40 lines and means the
 * whole application state is one file to back up.
 */
export class SqliteSessionStore extends Store {
  constructor({ cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();

    this.statements = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (@sid, @data, @expires)
         ON CONFLICT(sid) DO UPDATE SET data = @data, expires_at = @expires`
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };

    this.sweep();
    this.timer = setInterval(() => this.sweep(), cleanupIntervalMs);
    // Don't hold the process open just to expire sessions.
    this.timer.unref?.();
  }

  sweep() {
    this.statements.sweep.run(Date.now());
  }

  expiryFor(sess) {
    const maxAge = sess?.cookie?.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
  }

  get(sid, callback) {
    try {
      const row = this.statements.get.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        this.statements.destroy.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      this.statements.set.run({
        sid,
        data: JSON.stringify(sess),
        expires: this.expiryFor(sess),
      });
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.statements.touch.run(this.expiryFor(sess), sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.statements.destroy.run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }
}
