/**
 * The game's Facebook Page, connected on the panel's «النشر التلقائي» with a
 * Page access token — and through it the Instagram account linked to the Page.
 *
 * The token is a file under data/meta/ (mode 0600, directory 0700): data/ is
 * preserved by deploys and never in git. What it belongs to (the Page's id and
 * name, the Instagram id and handle) is kept in the settings table. Nothing
 * here returns the token to a page.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_FILE = 'page-token';
const MAX_TOKEN_LENGTH = 1000;
const TOKEN = /^[A-Za-z0-9]+$/;

const SETTING = {
  pageId: 'metaPageId', pageName: 'metaPageName', igUserId: 'metaIgUserId', igUsername: 'metaIgUsername', connectedAt: 'metaConnectedAt',
};

/** The token with stray spaces gone, or `{ error }`. */
export function checkToken(raw) {
  const token = String(raw ?? '').replace(/\s+/g, '');
  if (!token) return { error: 'الصق مفتاح الصفحة (Page access token).' };
  if (token.length > MAX_TOKEN_LENGTH || !TOKEN.test(token)) return { error: 'هذا لا يشبه مفتاح Meta: حروف وأرقام فقط، بلا مسافات.' };
  return { token };
}

export function createMetaAccount(db, { dir, client }) {
  const tokenPath = path.join(dir, TOKEN_FILE);

  const read = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  };
  const write = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  const drop = db.prepare('DELETE FROM settings WHERE key = ?');

  const hasToken = () => {
    try {
      return fs.statSync(tokenPath).isFile();
    } catch {
      return false;
    }
  };

  /** What the panel may show. Never the token. */
  function status() {
    const pageId = read(SETTING.pageId);
    return {
      connected: hasToken() && Boolean(pageId),
      pageId,
      pageName: read(SETTING.pageName) || '',
      igUserId: read(SETTING.igUserId),
      igUsername: read(SETTING.igUsername),
      connectedAt: read(SETTING.connectedAt),
    };
  }

  /** What a post needs, or null when no Page is connected. */
  function load() {
    const current = status();
    if (!current.connected) return null;
    return { pageId: current.pageId, igUserId: current.igUserId, token: fs.readFileSync(tokenPath, 'utf8').trim() };
  }

  /** Checks the token with Meta, then keeps it: `{ status }` or `{ error }`. */
  async function connect(raw) {
    const { token, error } = checkToken(raw);
    if (error) return { error };
    let found;
    try {
      found = await client.inspect(token);
    } catch (err) {
      return { error: `رفضت Meta المفتاح: ${err.message}` };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // Written beside the old one and renamed over it: a failed write never leaves half a token.
    const temp = path.join(dir, `.${TOKEN_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(temp, token, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, tokenPath);
    db.transaction(() => {
      write.run(SETTING.pageId, JSON.stringify(found.pageId));
      write.run(SETTING.pageName, JSON.stringify(found.pageName));
      write.run(SETTING.igUserId, JSON.stringify(found.igUserId));
      write.run(SETTING.igUsername, JSON.stringify(found.igUsername));
      write.run(SETTING.connectedAt, JSON.stringify(new Date().toISOString()));
    })();
    return { status: status() };
  }

  /** Forgets the token and the Page. */
  function disconnect() {
    fs.rmSync(tokenPath, { force: true });
    db.transaction(() => { for (const key of Object.values(SETTING)) drop.run(key); })();
  }

  return { status, load, connect, disconnect };
}
