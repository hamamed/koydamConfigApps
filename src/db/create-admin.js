import bcrypt from 'bcryptjs';
import { db, migrate } from './index.js';

migrate();

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: npm run create-admin -- <username> <password>');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
  console.log(`Updated password for "${username}".`);
} else {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Created admin "${username}".`);
}
