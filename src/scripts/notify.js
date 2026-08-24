/**
 * Sends a message to every configured alert destination, from the shell.
 *
 *   node src/scripts/notify.js "Backup failed: pg_dump returned 1"
 *   echo "..." | node src/scripts/notify.js
 *
 * Exists so the shell scripts on this box - backups, the watchdog - reach the
 * same webhook and Telegram chat the panel configures, rather than each
 * growing its own copy of a URL that then has to be changed in four places.
 *
 * Exit codes: 0 delivered to at least one destination, 1 delivered to none.
 * A caller can therefore tell "nobody was told" from "told", which matters for
 * a cron job whose whole purpose is to tell someone.
 */
import 'dotenv/config';

import { notify } from '../alerts.js';
import { closePool, isDbEnabled } from '../db/pool.js';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const fromArgs = process.argv.slice(2).join(' ').trim();
  const text = fromArgs || (await readStdin());

  if (!text) {
    console.error('usage: node src/scripts/notify.js <message>   (or pipe it in)');
    process.exitCode = 1;
    return;
  }

  if (!isDbEnabled()) {
    // The destinations live in Postgres. Saying so beats exiting 1 with no
    // explanation, which a cron job would mail as a bare failure.
    console.error('No POSTGRES_URL - cannot read alert destinations.');
    process.exitCode = 1;
    return;
  }

  // Trimmed: Telegram rejects anything past 4096 characters, and a message
  // that fails to send is worse than one that is cut short.
  const delivered = await notify(text.slice(0, 3500));

  if (delivered > 0) {
    console.log(`delivered to ${delivered} destination(s)`);
  } else {
    console.error('delivered to nobody - is an alert destination configured?');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('notify failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
