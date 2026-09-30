/**
 * «النشر التلقائي»: at the times set on the panel (GMT), a picture question from
 * the game is drawn as «منشور اليوم» draws it and posted to the game's Facebook
 * Page and Instagram — a post, a story and a reel (the story animated) on each,
 * as ticked.
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

/** One time of the day and where it posts. */
const slotOf = (time, targets) => ({ time, targets: Object.keys(TARGETS).filter((t) => targets.includes(t)) });

export const DEFAULT_SCHEDULE = Object.freeze({
  enabled: false, slots: [slotOf('18:00', Object.keys(TARGETS))], showCredit: true,
});

/** A schedule as the app reads it: its slots, and the times and places they add up to. */
function withTotals(schedule) {
  const slots = [...schedule.slots].sort((a, b) => a.time.localeCompare(b.time));
  const targets = Object.keys(TARGETS).filter((t) => slots.some((s) => s.targets.includes(t)));
  return { ...schedule, slots, times: slots.map((s) => s.time), targets };
}

/**
 * The panel's rows — `[{ time, targets }]`, a row with no time being one not
 * used — as slots, or `{ error }`. A time kept must post somewhere, and each
 * time once.
 */
export function readSlots(rows) {
  const slots = [];
  for (const row of rows) {
    const raw = String(row?.time ?? '').trim();
    if (!raw) continue;
    const read = readTimes(raw);
    if (read.error) return { error: read.error };
    const [time] = read.times;
    if (slots.some((s) => s.time === time)) return { error: `الوقت ${time} مكتوب مرتين.` };
    const targets = [row.targets ?? []].flat().filter((t) => t in TARGETS);
    if (!targets.length) return { error: `اختر أين يُنشر في ${time}: منشور أو قصة أو ريل.` };
    slots.push(slotOf(time, targets));
  }
  if (!slots.length) return { error: 'اكتب وقتاً واحداً على الأقل، مثل 18:00.' };
  if (slots.length > MAX_TIMES) return { error: `${MAX_TIMES} أوقات في اليوم على الأكثر.` };
  return { slots };
}

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
  repo, account, client, render, renderReel, siteSettings, siteBase, postsDir, imagesDir, log = console, now = () => new Date(),
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
    if (!row) return withTotals(DEFAULT_SCHEDULE);
    try {
      const saved = JSON.parse(row.value);
      // Saved before each time had places of its own: every time posts where the one list said.
      const slots = Array.isArray(saved.slots)
        ? saved.slots.filter((s) => TIME.test(s?.time)).map((s) => slotOf(s.time, Array.isArray(s.targets) ? s.targets : []))
        : (Array.isArray(saved.times) ? saved.times : []).filter((t) => TIME.test(t))
          .map((t) => slotOf(t, Array.isArray(saved.targets) ? saved.targets : Object.keys(TARGETS)));
      return withTotals({ enabled: Boolean(saved.enabled), slots, showCredit: saved.showCredit !== false });
    } catch {
      return withTotals(DEFAULT_SCHEDULE);
    }
  }

  /**
   * Saves the panel's form: `{ schedule }` or `{ error }`. Takes the rows
   * (`slots: [{ time, targets }]`), or one list of `times` all posting to the
   * same `targets`.
   */
  function saveSchedule({ enabled, slots, times, targets, showCredit }) {
    let rows = slots;
    if (!rows) {
      const read = readTimes(times);
      if (read.error) return { error: read.error };
      rows = read.times.map((time) => ({ time, targets }));
    }
    const read = readSlots(rows);
    if (read.error) return { error: read.error };
    const next = { enabled: Boolean(enabled), slots: read.slots, showCredit: Boolean(showCredit) };
    writeSetting.run(SETTING, JSON.stringify(next));
    return { schedule: withTotals(next) };
  }

  const picturePath = (question) => path.join(imagesDir, path.basename(question.imageFile));
  const postOf = (question) => postFor(question, { site: siteBase.replace(/^https?:\/\//, ''), appStoreUrl: siteSettings.appStoreUrl() });

  /** Writes the images (and the reel) the targets need and returns their public URLs by size. */
  async function media(question, sizes, slot, showCredit) {
    const post = postOf(question);
    fs.mkdirSync(postsDir, { recursive: true });
    const stamp = slot.replace(/[^0-9a-z]+/gi, '');
    const urls = {};
    for (const size of sizes) {
      const file = `${stamp}-${question.id}-${size}.${size === 'reel' ? 'mp4' : 'jpg'}`;
      if (size === 'reel') {
        await renderReel(post, path.join(postsDir, file), { picturePath: picturePath(question), showCredit });
      } else {
        fs.writeFileSync(path.join(postsDir, file), await render(post, size, { picturePath: picturePath(question), showCredit }));
      }
      urls[size] = `${siteBase}/media/posts/${file}`;
    }
    return urls;
  }

  /**
   * The reel of a question for the panel to watch or download, made once per
   * picture, credit choice and deploy (the drawing may have changed), and kept
   * with the posts' files for a week.
   */
  async function previewReel(questionId, { showCredit = true, version = '' } = {}) {
    const question = repo.questionForPost({ id: questionId });
    if (!question?.imageFile) return null;
    const post = postOf(question);
    const tag = `${path.parse(question.imageFile).name}-${showCredit ? 1 : 0}-${post.store ? 1 : 0}-${version}`.replace(/[^0-9a-z-]+/gi, '');
    const file = path.join(postsDir, `preview-${question.id}-${tag}.mp4`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(postsDir, { recursive: true });
      await renderReel(post, file, { picturePath: picturePath(question), showCredit });
    }
    return file;
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
      urls = await media(question, [...new Set(claimed.map((t) => TARGETS[t].size))], slot, showCredit);
    } catch (err) {
      log.error?.('Autopost render failed:', err);
      for (const target of claimed) finish.run('failed', null, null, `تعذّر رسم الصورة أو الريل: ${err.message}`, slot, target);
      return { question, results: claimed.map((target) => ({ target, ok: false })) };
    }

    const results = [];
    for (const target of claimed) {
      try {
        const url = urls[TARGETS[target].size];
        const { remoteId, link } = await client.publish(target, credentials, { imageUrl: url, videoUrl: url, caption });
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
      if (!current.enabled || !current.slots.length || !account.status().connected) return;
      for (const slot of slotsDue(now(), current.times)) {
        if (slotRows.get(slot).n) continue;
        // "2026-09-28 18:00": the places are the ones set for 18:00.
        const targets = current.slots.find((s) => s.time === slot.slice(11))?.targets ?? [];
        if (!targets.length) continue;
        const outcome = await runSlot(slot, { targets, showCredit: current.showCredit });
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

  return { schedule, saveSchedule, runSlot, postNow, tick, start, history, upcoming, previewReel };
}
