import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Bringing a sound in from a YouTube video, for the sound library.
 *
 * **Only a video its uploader licensed Creative Commons Attribution is taken.**
 * That is the licence that lets the clip be played inside the app and shipped
 * with it, and it is the same bar the project's pictures are held to. Every
 * other video — which is most of them — is refused, and the refusal names the
 * licence that was found so it is clear why.
 *
 * The video is never named to the shell: the id is pulled out of whatever URL
 * was pasted, checked against YouTube's own id shape, and a canonical watch
 * URL is built from it. Nothing the browser sends reaches a command.
 *
 * Only the asked-for seconds are fetched (`--download-sections`), so an eight
 * second clip does not pull a ten minute video down first.
 */

/** What YouTube calls the one licence that permits reuse. */
export const CC_BY = 'Creative Commons Attribution license (reuse allowed)';
/** What that licence is called where the app credits it. */
export const CC_BY_NAME = 'CC BY 3.0';
/** A video longer than this is a whole programme; the clip is still short, but refuse the daft ones. */
export const MAX_VIDEO_SECONDS = 4 * 60 * 60;

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id in a pasted URL — watch, youtu.be, shorts or embed — or a bare
 * id. Null for anything else, including another site's URL.
 */
export function readVideoId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (ID.test(text)) return text;
  let url;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  const candidate = host === 'youtu.be'
    ? url.pathname.slice(1)
    : (host === 'youtube.com' || host === 'youtube-nocookie.com')
      ? (url.searchParams.get('v') ?? url.pathname.replace(/^\/(shorts|embed|v|live)\//, ''))
      : '';
  const id = String(candidate).split('/')[0];
  return ID.test(id) ? id : null;
}

/** The only URL this module ever hands to yt-dlp. */
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

/**
 * Why yt-dlp could not read a video, in words that say what to do about it.
 *
 * YouTube blocks datacentre addresses, and a server sitting in one is told to
 * "sign in to confirm you're not a bot" however good the link is. Saying that
 * plainly matters: the alternative is the panel blaming the link, or the
 * install, for something neither of them did.
 */
export function reasonFor(err) {
  const said = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
  if (/Sign in to confirm|not a bot|cookies/i.test(said)) {
    return 'يوتيوب يحجب طلبات الخادم ويطلب تسجيل دخول للتأكد أنه ليس آلياً، فلا يمكن جلب هذا الفيديو من هنا.';
  }
  if (/ENOENT/i.test(said)) return 'yt-dlp غير مثبّت على الخادم.';
  if (/Private video|members-only|unavailable|not available/i.test(said)) return 'هذا الفيديو غير متاح.';
  return 'تعذّر قراءة الفيديو. تأكد من الرابط.';
}

export function createAudioImport({ tools = { run } } = {}) {
  /**
   * What the video is, without downloading it:
   * `{ video }` — `{ id, title, channel, channelUrl, licence, seconds, url }` —
   * or `{ error }`.
   */
  async function probe(rawUrl) {
    const id = readVideoId(rawUrl);
    if (!id) return { error: 'هذا ليس رابط فيديو يوتيوب.' };
    let info;
    try {
      const { stdout } = await tools.run('yt-dlp', [
        '--no-warnings', '--skip-download', '--dump-single-json', watchUrl(id),
      ], { maxBuffer: 64 * 1024 * 1024 });
      info = JSON.parse(stdout);
    } catch (err) {
      return { error: reasonFor(err) };
    }
    return {
      video: {
        id,
        title: String(info.title ?? '').trim(),
        channel: String(info.channel ?? info.uploader ?? '').trim(),
        channelUrl: String(info.channel_url ?? '').trim(),
        licence: String(info.license ?? '').trim(),
        seconds: Number(info.duration) || 0,
        url: watchUrl(id),
      },
    };
  }

  /** Whether a probed video may be used, with the reason when it may not. */
  function usable(video) {
    if (video.licence !== CC_BY) {
      return {
        error: video.licence
          ? `رخصة هذا الفيديو «${video.licence}» لا تسمح باستعماله. يُقبل فقط ما رخّصه صاحبه «${CC_BY}».`
          : `هذا الفيديو بالرخصة القياسية ليوتيوب، ولا تسمح باستعماله. يُقبل فقط ما رخّصه صاحبه «${CC_BY}».`,
      };
    }
    if (video.seconds > MAX_VIDEO_SECONDS) return { error: 'الفيديو أطول من أربع ساعات.' };
    return {};
  }

  /**
   * The piece asked for, as MP3 bytes: `{ audio, video }` or `{ error }`.
   * The licence is checked before a single byte of audio is fetched.
   */
  async function clip(rawUrl, { start = 0, seconds = 8 } = {}) {
    const found = await probe(rawUrl);
    if (found.error) return found;
    const refusal = usable(found.video);
    if (refusal.error) return refusal;

    const from = Math.max(0, Math.floor(Number(start) || 0));
    const length = Math.max(1, Math.floor(Number(seconds) || 0));
    if (found.video.seconds && from >= found.video.seconds) {
      return { error: 'بداية القص بعد نهاية الفيديو.' };
    }
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wasla-yt-'));
    try {
      const out = path.join(work, 'clip.%(ext)s');
      await tools.run('yt-dlp', [
        '--no-warnings', '--no-playlist',
        // Only the asked-for seconds leave YouTube, with a second of slack so
        // the re-cut below never runs off the end.
        '--download-sections', `*${from}-${from + length + 1}`,
        '--force-keyframes-at-cuts',
        '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
        '-o', out, watchUrl(found.video.id),
      ], { maxBuffer: 64 * 1024 * 1024 });
      const made = (await fs.readdir(work)).find((f) => f.endsWith('.mp3'));
      if (!made) return { error: 'لم ينتج المقطع. جرّب بداية أخرى.' };
      return { audio: await fs.readFile(path.join(work, made)), video: found.video };
    } catch (err) {
      return { error: reasonFor(err) };
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  return { probe, usable, clip };
}
