import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { db, migrate } from './index.js';
import { config } from '../config.js';

migrate();

// Make sure the storage tree exists before anything tries to write an upload into it.
for (const dir of ['templates', 'previews']) {
  fs.mkdirSync(path.join(config.storageDir, dir), { recursive: true });
}

// Create the first admin from the environment, but only when there are no users at all —
// so re-running migrations can never quietly reset a live password.
const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();

if (count === 0) {
  const { username, password } = config.bootstrapAdmin;

  if (!password) {
    console.warn(
      '\n  No users exist and ADMIN_PASSWORD is unset.\n' +
      '  Create the first admin with:  npm run create-admin -- <username> <password>\n'
    );
  } else if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  } else {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, bcrypt.hashSync(password, 12));
    console.log(`  Created admin user "${username}".`);
  }
}

console.log('  Migration complete.');
