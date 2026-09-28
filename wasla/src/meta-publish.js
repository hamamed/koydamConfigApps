/**
 * Posting to the game's own Facebook Page and the Instagram professional account
 * linked to it, through Meta's Graph API with a Page access token.
 *
 * Every call takes the image by public URL — Meta fetches it — so the picture
 * must already be served (under /media/posts) when a call is made.
 *
 *   Facebook post    POST /{page}/photos { url, caption }
 *   Facebook story   POST /{page}/photos { url, published: false } → POST /{page}/photo_stories { photo_id }
 *   Instagram post   POST /{ig}/media { image_url, caption } → POST /{ig}/media_publish { creation_id }
 *   Instagram story  POST /{ig}/media { image_url, media_type: STORIES } → media_publish
 *   Facebook reel    POST /{page}/video_reels { upload_phase: start } → rupload { file_url }
 *                    → POST /{page}/video_reels { upload_phase: finish, video_state: PUBLISHED }
 *   Instagram reel   POST /{ig}/media { video_url, media_type: REELS } → (processing) → media_publish
 *
 * https://developers.facebook.com/docs/graph-api/reference/page/photos/
 * https://developers.facebook.com/docs/page-stories-api/
 * https://developers.facebook.com/docs/instagram-platform/content-publishing/
 * https://developers.facebook.com/docs/video-api/guides/reels-publishing
 */

export const GRAPH_VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Where each post goes, in the order a slot posts them. */
export const TARGETS = {
  facebook_post: { network: 'facebook', size: 'square', label: 'منشور فيسبوك' },
  facebook_story: { network: 'facebook', size: 'story', label: 'قصة فيسبوك' },
  instagram_post: { network: 'instagram', size: 'square', label: 'منشور إنستغرام' },
  instagram_story: { network: 'instagram', size: 'story', label: 'قصة إنستغرام' },
  facebook_reel: { network: 'facebook', size: 'reel', label: 'ريل فيسبوك' },
  instagram_reel: { network: 'instagram', size: 'reel', label: 'ريل إنستغرام' },
};

/** A Graph API refusal, with Meta's own message. */
export class MetaError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'MetaError';
    this.code = code;
    this.status = status;
  }
}

/** How long an Instagram container gets to be ready, and how often it is asked: a picture is quick. */
const IMAGE_WAIT = { tries: 10, ms: 3000 };
/** A video is processed first; Meta asks for no more than five minutes of asking. */
const VIDEO_WAIT = { tries: 30, ms: 10_000 };
/** How long a Facebook reel is watched after publishing, for a processing failure to show. */
const FACEBOOK_REEL_WAIT = { tries: 12, ms: 10_000 };
const RUPLOAD = `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}`;
/** When the reel's post is whole: the frame Instagram shows as its cover (ms). */
export const REEL_COVER_MS = 6000;

export function createMetaClient({ fetch = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  async function call(method, pathname, token, params = {}) {
    const url = new URL(`${GRAPH}/${pathname}`);
    const body = new URLSearchParams({ ...params, access_token: token });
    let response;
    try {
      response = method === 'GET'
        ? await fetch(`${url}?${body}`, { method })
        : await fetch(url, { method, body });
    } catch (err) {
      throw new MetaError(`تعذّر الوصول إلى Meta: ${err.message}`);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A body that is not JSON is reported by status below.
    }
    if (!response.ok || data?.error) {
      const error = data?.error ?? {};
      throw new MetaError(error.message || `Meta refused the request (${response.status}).`, { code: error.code ?? null, status: response.status });
    }
    return data ?? {};
  }

  /**
   * Checks a Page token: the Page it belongs to and its linked Instagram account.
   * A user token reads as a person, not a Page, and is refused here.
   */
  async function inspect(token) {
    const me = await call('GET', 'me', token, { fields: 'id,name' });
    if (!me.id) throw new MetaError('Meta did not say which Page this key belongs to.');
    let page;
    try {
      page = await call('GET', me.id, token, { fields: 'instagram_business_account{id,username}' });
    } catch (err) {
      // Asked of a person, Meta answers that a User has no such field.
      if (/node type \(User\)/i.test(err.message)) {
        throw new MetaError('هذا مفتاح حسابك الشخصي، لا مفتاح الصفحة: خذ access_token الصفحة من /me/accounts.');
      }
      throw err;
    }
    const instagram = page.instagram_business_account ?? null;
    return { pageId: me.id, pageName: me.name ?? '', igUserId: instagram?.id ?? null, igUsername: instagram?.username ?? null };
  }

  async function facebookPost({ pageId, token }, { imageUrl, caption }) {
    const photo = await call('POST', `${pageId}/photos`, token, { url: imageUrl, caption });
    const id = photo.post_id || photo.id;
    return { remoteId: id, link: id ? `https://www.facebook.com/${id}` : null };
  }

  async function facebookStory({ pageId, token }, { imageUrl }) {
    // A story needs a photo of its own that was never published as a post.
    const photo = await call('POST', `${pageId}/photos`, token, { url: imageUrl, published: 'false' });
    if (!photo.id) throw new MetaError('Meta did not return the story photo.');
    const story = await call('POST', `${pageId}/photo_stories`, token, { photo_id: photo.id });
    return { remoteId: story.post_id || photo.id, link: null };
  }

  /** An Instagram container, published once Meta says it is ready. */
  async function instagramPublish({ igUserId, token }, params, patience = IMAGE_WAIT) {
    if (!igUserId) throw new MetaError('لا حساب إنستغرام مرتبط بالصفحة.');
    const container = await call('POST', `${igUserId}/media`, token, params);
    if (!container.id) throw new MetaError('Meta did not return an Instagram container.');
    for (let i = 0; i < patience.tries; i++) {
      const { status_code: status, status: detail } = await call('GET', container.id, token, { fields: 'status_code,status' });
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new MetaError(`Instagram could not take it (${status}${detail ? `: ${detail}` : ''}).`);
      if (i === patience.tries - 1) throw new MetaError('Instagram took too long to prepare it.');
      await wait(patience.ms);
    }
    const media = await call('POST', `${igUserId}/media_publish`, token, { creation_id: container.id });
    let link = null;
    try {
      ({ permalink: link = null } = await call('GET', media.id, token, { fields: 'permalink' }));
    } catch {
      // The post is up; only its link could not be read.
    }
    return { remoteId: media.id, link };
  }

  const instagramPost = (account, { imageUrl, caption }) => instagramPublish(account, { image_url: imageUrl, caption });
  const instagramStory = (account, { imageUrl }) => instagramPublish(account, { image_url: imageUrl, media_type: 'STORIES' });

  const instagramReel = (account, { videoUrl, caption }) => instagramPublish(account, {
    media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true', thumb_offset: String(REEL_COVER_MS),
  }, VIDEO_WAIT);

  /** Hands Meta the reel by URL: it fetches the file itself. */
  async function upload(videoId, token, fileUrl) {
    let response;
    try {
      response = await fetch(`${RUPLOAD}/${videoId}`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: fileUrl } });
    } catch (err) {
      throw new MetaError(`تعذّر الوصول إلى Meta: ${err.message}`);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new MetaError(data?.error?.message || data?.debug_info?.message || `Meta refused the reel upload (${response.status}).`, { status: response.status });
    }
  }

  async function facebookReel({ pageId, token }, { videoUrl, caption }) {
    const started = await call('POST', `${pageId}/video_reels`, token, { upload_phase: 'start' });
    if (!started.video_id) throw new MetaError('Meta did not start the reel.');
    await upload(started.video_id, token, videoUrl);
    await call('POST', `${pageId}/video_reels`, token, {
      upload_phase: 'finish', video_id: started.video_id, video_state: 'PUBLISHED', description: caption,
    });
    // Published, then processed: a failure to process shows here rather than never.
    for (let i = 0; i < FACEBOOK_REEL_WAIT.tries; i++) {
      const { status } = await call('GET', started.video_id, token, { fields: 'status' });
      const state = status?.video_status;
      if (state === 'error' || state === 'upload_failed' || state === 'expired'
        || status?.processing_phase?.status === 'error' || status?.publishing_phase?.status === 'error') {
        throw new MetaError(`Facebook could not process the reel (${state || 'error'}).`);
      }
      if (state === 'ready' || status?.publishing_phase?.status === 'completed') break;
      // Still processing when the watch ends is fine: it was accepted and will appear.
      if (i < FACEBOOK_REEL_WAIT.tries - 1) await wait(FACEBOOK_REEL_WAIT.ms);
    }
    return { remoteId: started.video_id, link: `https://www.facebook.com/reel/${started.video_id}` };
  }

  const publishers = {
    facebook_post: facebookPost, facebook_story: facebookStory, instagram_post: instagramPost, instagram_story: instagramStory,
    facebook_reel: facebookReel, instagram_reel: instagramReel,
  };

  /** Posts one target; `{ remoteId, link }` or throws a MetaError. */
  function publish(target, account, content) {
    const publisher = publishers[target];
    if (!publisher) throw new MetaError(`Unknown target: ${target}`);
    return publisher(account, content);
  }

  return { inspect, publish };
}
