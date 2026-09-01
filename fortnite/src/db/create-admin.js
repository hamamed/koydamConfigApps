/**
 * Creates a local admin, or resets an existing one's password.
 *
 *   npm run create-admin -- <username> <password>
 *
 * Local accounts are the fallback for a standalone or development install. On the VPS the
 * panel authenticates against platform-api and these are not used.
 */
import bcrypt from 'bcryptjs';
import { db, migrate } from './index.js';

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('  Usage: npm run create-admin -- <username> <password>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('  Pick a password of at least 8 characters.');
  process.exit(1);
}

migrate();

const existing = db.prepare('SELECT id, platform_id FROM users WHERE username = ?').get(username);
const hash = bcrypt.hashSync(password, 12);

if (existing) {
  if (existing.platform_id != null) {
    // A mirror row is a foreign-key target for the audit log, not an account. Giving it a
    // password would create a second way in for someone the platform can disable.
    console.error(`  '${username}' is a single sign-on account. Change it at the platform.`);
    process.exit(1);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  console.log(`  Password reset for ${username}.`);
} else {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hash, 'admin');
  console.log(`  Created ${username}.`);
}
