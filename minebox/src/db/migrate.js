/**
 * Applies the schema, then creates the first admin if there is not one already.
 *
 * Run on every boot by the service unit and by hand after a pull. Both are safe: every
 * statement in schema.sql is `IF NOT EXISTS`, and the bootstrap admin is only created when
 * the users table is empty — so re-running migrations can never reset a live password.
 */
import bcrypt from 'bcryptjs';
import { db, migrate } from './index.js';
import { config } from '../config.js';

migrate();
console.log('  Schema applied.');

const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();

if (count > 0) {
  console.log(`  ${count} account${count === 1 ? '' : 's'} already exist; leaving them alone.`);
} else if (!config.bootstrapAdmin.password) {
  // Not an error. Under single sign-on this panel has no local accounts at all, and inventing
  // one with a guessable password would be worse than having none.
  console.log('  No ADMIN_PASSWORD set, so no local account was created.');
  console.log('  Sign in through config.hamaprojects.com, or run:');
  console.log('    npm run create-admin -- <username> <password>');
} else {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    config.bootstrapAdmin.username,
    bcrypt.hashSync(config.bootstrapAdmin.password, 12),
    'admin',
  );
  console.log(`  Created the first admin: ${config.bootstrapAdmin.username}`);
}
