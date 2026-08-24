/**
 * Resets a platform account's password, or creates the first owner.
 *
 *   node src/scripts/reset-password.js you@example.com
 *   node src/scripts/reset-password.js you@example.com 'a chosen password'
 *   node src/scripts/reset-password.js you@example.com 'short' --force
 *
 * With no password a strong one is generated and printed. Run it on the box:
 * it needs POSTGRES_URL, and it prints a credential, so it belongs in a root
 * shell rather than anywhere it might be logged.
 *
 * Why this exists: the first password is generated at install and printed once
 * to the journal. Journals rotate. Without this the only way back into the
 * dashboard is editing bcrypt hashes into Postgres by hand.
 */
import 'dotenv/config';

import { randomBytes } from 'node:crypto';

import { hashPassword } from '../auth.js';
import { closePool, isDbEnabled, query } from '../db/pool.js';

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.includes('--force');
const [emailArg, passwordArg] = args;

if (!emailArg) {
  console.error('usage: node src/scripts/reset-password.js <email> [password]');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();

if (!email.includes('@')) {
  console.error(`'${email}' does not look like an email address.`);
  process.exit(1);
}

// Long enough that it is not worth attacking, short enough to retype once.
const password = passwordArg || randomBytes(12).toString('base64url');

// Ten is the floor. Not a policy anyone has to agree with - but a weak
// password here opens the AdMob settings, the config every app fetches, and a
// panel that browses the database, so it should take a deliberate act rather
// than a typo to set one.
if (passwordArg && passwordArg.length < 10 && !force) {
  console.error(
    `That password is ${passwordArg.length} characters; the minimum is 10.
` +
      'Choose a longer one, or pass --force if you mean it.',
  );
  process.exit(1);
}

if (passwordArg && passwordArg.length < 10 && force) {
  console.warn(
    `
  Warning: setting a ${passwordArg.length}-character password. ` +
      'Anyone who signs in here can change what every app fetches.',
  );
}

async function main() {
  // query() returns null on failure rather than throwing, because serving
  // config must degrade instead of falling over. That is right for the server
  // and wrong here: without this check the script prints a password for a
  // write that never happened, and the account it names cannot sign in.
  if (!isDbEnabled()) {
    throw new Error('POSTGRES_URL is not set - nothing was changed');
  }

  const probe = await query('SELECT 1 AS ok');
  if (!probe?.rows?.length) {
    throw new Error('Could not reach the database - nothing was changed');
  }

  const hash = await hashPassword(password);

  const existing = await query(
    'SELECT id, role, disabled FROM users WHERE lower(email) = $1',
    [email],
  );
  const user = existing?.rows?.[0];

  if (user) {
    // Clearing the lockout too: someone resetting a password has usually just
    // finished failing to sign in eight times.
    const updated = await query(
      `UPDATE users
          SET password_hash = $2,
              failed_attempts = 0,
              locked_until = NULL,
              disabled = false
        WHERE id = $1
      RETURNING id`,
      [user.id, hash],
    );

    if (!updated?.rows?.length) {
      throw new Error('The password was not changed - nothing was written');
    }

    // Every existing session for this account is now stale. Leaving them alive
    // would mean a reset does not actually lock anyone out.
    const killed = await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);

    console.log(`\n  Reset the password for ${email} (role: ${user.role}).`);
    if (user.disabled) console.log('  The account was disabled and has been re-enabled.');
    if (killed?.rowCount) console.log(`  Signed out ${killed.rowCount} existing session(s).`);
  } else {
    const count = await query('SELECT COUNT(*)::int AS n FROM users');
    const first = (count?.rows?.[0]?.n ?? 0) === 0;

    const created = await query(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [email, 'Owner', hash, first ? 'owner' : 'admin'],
    );

    if (!created?.rows?.length) {
      throw new Error('The account was not created - nothing was changed');
    }

    console.log(`\n  Created ${email} as ${first ? 'owner' : 'admin'}.`);
    if (!first) {
      console.log('  Note: an owner already exists, so this account is an admin.');
    }
  }

  console.log(`\n  Password: ${password}\n`);
  console.log('  It is not stored anywhere in readable form. Copy it now.\n');
}

main()
  .catch((err) => {
    console.error('\n  Failed:', err.message);
    console.error('  Is POSTGRES_URL set, and has the database been migrated?\n');
    process.exitCode = 1;
  })
  .finally(closePool);
