/**
 * «النشر التلقائي»: at the times set on the panel (GMT), a picture question from
 * the game is drawn as «منشور اليوم» draws it and posted to the game's Facebook
 * Page and Instagram — a post and a story on each, as ticked.
 *
 * Each time is a slot. A slot's rows are written before anything is posted, so
 * a slot runs once however often the clock ticks or the server restarts; a slot
 * missed by more than `CATCH_UP_MINUTES` (the server was down) is skipped, not
 * posted late. The question is one players can already meet — in a published
 * level — with a credited picture, not posted before; once all have been, the
 * one posted longest ago goes again.
 */
import fs from 'node:fs';
import path from 'node:path';

import { captionFor, postFor } from './post-content.js';
import { TARGETS } from './meta-publish.js';

export const CATCH_UP_MINUTES = 30;
export const MAX_TIMES = 6;
const TICK_MS = 60_000;
/** Meta copies an image when it is posted; ours are kept a week for anyone checking. */
const KEEP_FILES_DAYS = 7;
const DAY_MS = 86_400_000;
const SETTING = 'autopost';
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DEFAULT_SCHEDULE = { enabled: false, times: ['18:00'], targets: Object.keys(TARGETS), showCredit: true };

/** "18:00, 9:30" → ["09:30", "18:00"], or `{ error }`. */
export function readTimes(raw) {
  const parts = String(raw ?? '').split(/[\s,،]+/).filter(Boolean);
  const times = [];
  for (const part of parts) {
    const padded = /^\d:\d\d$/.test(part) ? `0${part}` : part;
    if (!TIME.test(padded)) return { error: `«${part}» ليس وقتاً: اكتب الساعة هكذا 18:00.` };
    if (!times.includes(padded)) times.push(padded);
  }
  if (!times.length) return { error: 'اكتب وقتاً واحداً على الأقل، مثل 18:00.' };
  if (times.length > MAX_TIMES) return { error: `${MAX_TIMES} أوقات في اليوم على الأكثر.` };
  return { times: times.sort() };
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const slotDate = (day, time) => new Date(`${day}T${time}:00Z`);

/** The slots whose time has come and is less than CATCH_UP_MINUTES old at `now`. */
export function slotsDue(now, times) {
  const due = [];
  for (const day of [dayOf(new Date(now.getTime() - DAY_MS)), dayOf(now)]) {
    for (const time of times) {
      const at = slotDate(day, time).getTime();
      if (at <= now.getTime() && now.getTime() - at < CATCH_UP_MINUTES * 60_000) due.push(`${day} ${time}`);
    }
  }
  return due;
}

/** The next slot after `now`, as a Date. */
export function nextSlot(now, times) {
  if (!times.length) return null;
  for (const day of [dayOf(now), dayOf(new Date(now.getTime() + DAY_MS))]) {
    for (const time of times) {
      const at = slotDate(day, time);
      if (at > now) return at;
    }
  }
  return null;
}

export function createAutopost(db, {
  repo, account, client, render, siteSettings, siteBase, postsDir, imagesDir, log = console, now = () => new Date(),
}) {
  const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const writeSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  const claim = db.prepare('INSERT OR IGNORE INTO social_posts (slot, target, question_id) VALUES (?, ?, ?)');
  const finish = db.prepare(`UPDATE social_posts SET status = ?, remote_id = ?, link = ?, error = ?, finished_at = datetime('now')
    WHERE slot = ? AND target = ?`);
  const slotRows = db.prepare('SELECT COUNT(*) AS n FROM social_posts WHERE slot = ?');
  // Published, credited, and posted least recently (never first), at random among equals.
  const pick = db.prepare(`SELECT q.id FROM questions q
    WHERE q.image_file IS NOT NULL
      AND trim(IFNULL(q.image_author, '')) <> '' AND trim(IFNULL(q.image_licence, '')) <> ''
      AND EXISTS (SELECT 1 FROM level_words lw JOIN levels l ON l.id = lw.level_id WHERE lw.question_id = q.id AND l.published = 1)
    ORDER BY (SELECT MAX(sp.created_at) FROM social_posts sp WHERE sp.question_id = q.id AND sp.status = 'done') IS NOT NULL,
             (SELECT MAX(sp.created_at) FROM social_posts sp WHERE sp.question_id = q.id AND sp.status = 'done'),
             RANDOM()
    LIMIT 1`);
  const recent = db.prepare(`SELECT sp.*, q.title AS question_title, q.answer AS question_answer
    FROM social_posts sp LEFT JOIN questions q ON q.id = sp.question_id
    ORDER BY sp.id DESC LIMIT ?`);

  let running = false;

  function schedule() {
    const row = readSetting.get(SETTING);
    if (!row) return { ...DEFAULT_SCHEDULE };
    try {
      const saved = JSON.parse(row.value);
      return {
        enabled: Boolean(saved.enabled),
        times: Array.isArray(saved.times) ? saved.times.filter((t) => TIME.test(t)) : DEFAULT_SCHEDULE.times,
        targets: Array.isArray(saved.targets) ? saved.targets.filter((t) => t in TARGETS) : DEFAULT_SCHEDULE.targets,
        showCredit: saved.showCredit !== false,
      };
    } catch {
      return { ...DEFAULT_SCHEDULE };
    }
  }

  /** Saves the panel's form: `{ schedule }` or `{ error }`. */
  function saveSchedule({ enabled, times, targets, showCredit }) {
    const read = readTimes(times);
    if (read.error) return { error: read.error };
    const chosen = [targets].flat().filter((t) => t in TARGETS);
    if (enabled && !chosen.length) return { error: 'اختر أين يُنشر: منشور أو قصة على فيسبوك أو إنستغرام.' };
    const next = { enabled: Boolean(enabled), times: read.times, targets: chosen, showCredit: Boolean(showCredit) };
    writeSetting.run(SETTING, JSON.stringify(next));
    return { schedule: next };
  }

  /** Writes the images the targets need and returns their public URLs by size. */
  async function images(question, sizes, slot, showCredit) {
    const site = siteBase.replace(/^https?:\/\//, '');
    const post = postFor(question, { site, appStoreUrl: siteSettings.appStoreUrl() });
    fs.mkdirSync(postsDir, { recursive: true });
    const stamp = slot.replace(/[^0-9a-z]+/gi, '');
    const urls = {};
    for (const size of sizes) {
      const file = `${stamp}-${question.id}-${size}.jpg`;
      const jpeg = await render(post, size, { picturePath: path.join(imagesDir, path.basename(question.imageFile)), showCredit });
      fs.writeFileSync(path.join(postsDir, file), jpeg);
      urls[size] = `${siteBase}/media/posts/${file}`;
    }
    return urls;
  }

  /**
   * Posts one slot to `targets`. Rows are claimed first: a slot that already has
   * rows is not run again. Returns the rows' outcomes, or `{ error }`.
   */
  async function runSlot(slot, { targets, showCredit = true, questionId = null } = {}) {
    const credentials = account.load();
    if (!credentials) return { error: 'لم تُربط صفحة فيسبوك بعد.' };
    if (slotRows.get(slot).n) return { error: 'نُشر هذا الموعد من قبل.' };
    const id = questionId ?? pick.get()?.id;
    const question = id ? repo.questionForPost({ id }) : null;
    if (!question?.imageFile) return { error: 'لا سؤال بصورة موثّقة المصدر في لغز منشور ليُنشر.' };

    const claimed = db.transaction(() => targets.filter((target) => claim.run(slot, target, question.id).changes === 1))();
    if (!claimed.length) return { error: 'نُشر هذا الموعد من قبل.' };

    const site = siteBase.replace(/^https?:\/\//, '');
    const caption = captionFor(question, { site, appStoreUrl: siteSettings.appStoreUrl() });
    let urls;
    try {
      urls = await images(question, [...new Set(claimed.map((t) => TARGETS[t].size))], slot, showCredit);
    } catch (err) {
      log.error?.('Autopost render failed:', err);
      for (const target of claimed) finish.run('failed', null, null, `تعذّر رسم الصورة: ${err.message}`, slot, target);
      return { question, results: claimed.map((target) => ({ target, ok: false })) };
    }

    const results = [];
    for (const target of claimed) {
      try {
        const { remoteId, link } = await client.publish(target, credentials, { imageUrl: urls[TARGETS[target].size], caption });
        finish.run('done', remoteId ?? null, link ?? null, null, slot, target);
        results.push({ target, ok: true, link });
      } catch (err) {
        log.error?.(`Autopost ${target} failed:`, err.message);
        finish.run('failed', null, null, err.message, slot, target);
        results.push({ target, ok: false, error: err.message });
      }
    }
    return { question, results };
  }

  /** Posts now, by hand from the panel: the question given, or the next one due. */
  function postNow({ questionId = null, targets = schedule().targets, showCredit = schedule().showCredit } = {}) {
    const at = now().toISOString().slice(0, 19).replace('T', ' ');
    return runSlot(`now ${at}`, { targets, showCredit, questionId });
  }

  function removeOldFiles() {
    let names = [];
    try {
      names = fs.readdirSync(postsDir);
    } catch {
      return;
    }
    const cutoff = now().getTime() - KEEP_FILES_DAYS * DAY_MS;
    for (const name of names) {
      const file = path.join(postsDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        // Gone already.
      }
    }
  }

  /** One turn of the clock: runs the slots that are due. */
  async function tick() {
    if (running) return;
    running = true;
    try {
      removeOldFiles();
      const current = schedule();
      if (!current.enabled || !current.targets.length || !account.status().connected) return;
      for (const slot of slotsDue(now(), current.times)) {
        if (slotRows.get(slot).n) continue;
        const outcome = await runSlot(slot, { targets: current.targets, showCredit: current.showCredit });
        if (outcome.error) log.error?.(`Autopost ${slot}: ${outcome.error}`);
      }
    } catch (err) {
      log.error?.('Autopost tick failed:', err);
    } finally {
      running = false;
    }
  }

  function start() {
    tick();
    const timer = setInterval(tick, TICK_MS);
    // Must not hold the process open on shutdown.
    timer.unref?.();
    return timer;
  }

  const history = (limit = 40) => recent.all(limit);
  const upcoming = () => {
    const current = schedule();
    return current.enabled ? nextSlot(now(), current.times) : null;
  };

  return { schedule, saveSchedule, runSlot, postNow, tick, start, history, upcoming };
}
